// @ts-check
// ============================================================
// AI 讨论协调器（Discuss Coordinator）
//
// 让「AI 助手（聊天 LLM）」与「某个 CLI Agent（opencode/codex/aider…）」
// 按回合交替发言，把整段来回过程通过 SSE 实时推给前端，供用户「看见讨论过程」。
//
// 设计要点：
// - 前端拨动「🤝 AI 讨论」开关并选定 partner 后，POST /api/chat 带
//   { discuss:true, partner, maxTurns } 进入本协调器（不进入普通工具循环）。
// - 每轮：① AI 助手基于「用户原题 + 至今讨论记录」产出一段发言（流式）；
//         ② 把该发言交给 CLI Agent（每次新开一个 session，task 含完整记录，
//            保证无状态也可连续讨论），轮询其输出作为 CLI 发言（流式）。
// - 通过 discuss_start / token / discuss_end / status 事件让前端按 speaker 渲染气泡。
// - 复用普通流里的 _aborted 中断语义（res.on('close') + writableEnded 守卫）：
//   用户点停止 → res close → _aborted=true → 干净收尾。
// - 兼容 OpenAI / Anthropic 两种 provider 的 SSE 解析。
// ============================================================

const { agentPool } = require('../ai-tools/agent-pool');
const { loadRegistry } = require('../../cli-discovery');
// 流式终端字节清洗：跨 poll delta 边界缓存未完成的转义序列（详见 lib/terminal-clean.js）
const { createStreamCleaner } = require('../../lib/terminal-clean');

// ── 单轮 LLM 调用超时（与主线一致放宽到 3 分钟）──
const API_FETCH_TIMEOUT_MS = 180_000;
// CLI Agent 单次轮询总预算（防止某 agent 卡死把讨论拖垮）
const AGENT_TURN_TIMEOUT_MS = 180_000;
const AGENT_POLL_INTERVAL_MS = 1000;

// ── 角色设定 ──
const AI_SYSTEM_PROMPT = `你正在参与一场与另一个 CLI AI 编程助手（如 opencode）的**协作讨论**。
用户的原始问题是：「{QUESTION}」。

你扮演「AI 助手」一方，对方扮演「CLI Agent」一方。规则：
1. 你只输出**自己这一轮**的发言，不要替对方作答，不要写总结（最后一轮由专门步骤汇总）。
2. 针对上一轮对方的观点，给出你的补充、质疑、修正或新的子问题；若你是首轮，请先给出你的分析框架/初步方案。
3. 语言精炼、有信息量，避免空话。可直接引用对方原话要点。
4. 若你认为讨论已可收敛，可在结尾写一行 [CONVERGE]，表示准备进入汇总。`;

const CLI_TASK_PROMPT = (question, transcript, round) => `你正在与「AI 助手」协作讨论下面这个用户问题（第 ${round} 轮）：

【用户原问题】
${question}

【至今的讨论记录】
${transcript || '（尚无，这是你的第一轮）'}

请作为「CLI Agent」一方，针对上面 AI 助手的最后一段发言，给出你的独立观点、方案、代码思路或反问。
只输出你这一轮的内容，不要替对方总结。语言精炼、言之有物。`;

const SUMMARY_SYSTEM_PROMPT = `你是一场「AI 助手 ↔ CLI Agent」协作讨论的**主持/汇总者**。
请基于下面的完整讨论记录，产出一份结构化结论：

【用户原问题】
{QUESTION}

【完整讨论记录】
{TRANSCRIPT}

要求：
1. 先一句话给出最终结论；
2. 用要点列出双方达成共识的部分；
3. 用要点列出仍有分歧或待验证的部分；
4. 若适用，给出可立即执行的下一步建议。`;

// ── SSE 辅助 ──
function sse(res, obj) {
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* closed */ }
}

// ── provider 解析（与 routes/chat/index.js 保持一致）──
function resolveConfig({ apiKey, provider, baseUrl, model }) {
  const p = provider || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai');
  const key = apiKey || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  const url = baseUrl || (p === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');
  const m = model || (p === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o-mini');
  return { p, key, url, m };
}

function buildApiUrl(base, def, path) {
  let u = base && base.trim() ? base : def;
  if (u.endsWith('/')) u = u.slice(0, -1);
  return u + path;
}

// ── 解析 OpenAI SSE，逐 token 回调 ──
async function streamOpenAI(url, apiKey, model, messages, onToken, onUsage) {
  const body = { model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: 16384 };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`OpenAI API ${resp.status}: ${await resp.text().catch(() => '')}`);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') return;
      let j; try { j = JSON.parse(data); } catch { continue; }
      // 末片携带 usage（stream_options.include_usage=true）：精确统计 token
      if (j.usage) {
        onUsage?.({ input_tokens: j.usage.prompt_tokens || 0, output_tokens: j.usage.completion_tokens || 0 });
        continue;
      }
      const delta = j.choices?.[0]?.delta?.content;
      if (delta) onToken(delta);
    }
  }
}

// ── 解析 Anthropic SSE，逐 token 回调 ──
async function streamAnthropic(url, apiKey, model, systemText, messages, onToken, onUsage) {
  const body = {
    model,
    system: [{ type: 'text', text: systemText }],
    messages,
    stream: true,
    max_tokens: 16384,
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Anthropic API ${resp.status}: ${await resp.text().catch(() => '')}`);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      let j; try { j = JSON.parse(data); } catch { continue; }
      // token 统计：message_start 给输入 token，message_delta 给累计输出 token
      if (j.type === 'message_start' && j.message?.usage) {
        onUsage?.({ input_tokens: j.message.usage.input_tokens || 0, output_tokens: 0 });
      } else if (j.type === 'message_delta' && j.usage) {
        onUsage?.({ input_tokens: 0, output_tokens: j.usage.output_tokens || 0 });
      } else if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') {
        onToken(j.delta.text);
      }
    }
  }
}

// 跑一轮 AI 助手发言，返回完整文本
async function runAiTurn({ p, key, url, m }, question, transcript, onToken, onUsage) {
  const sysText = AI_SYSTEM_PROMPT.replace('{QUESTION}', question);
  const userContent =
    `【用户原问题】${question}\n\n【至今讨论记录】\n${transcript || '（首轮，请先给分析框架/初步方案）'}\n\n请输出你这一轮的发言：`;
  let full = '';
  const collect = (tk) => { full += tk; onToken(tk); };
  if (p === 'anthropic') {
    await streamAnthropic(buildApiUrl(url, 'https://api.anthropic.com', '/v1/messages'), key, m, sysText,
      [{ role: 'user', content: userContent }], collect, onUsage);
  } else {
    await streamOpenAI(buildApiUrl(url, 'https://api.openai.com/v1', '/chat/completions'), key, m,
      [{ role: 'system', content: sysText }, { role: 'user', content: userContent }], collect, onUsage);
  }
  return full.trim();
}

// 跑一轮 CLI Agent 发言：每次新开 session（task 含完整记录），轮询到完成
async function runCliTurn({ partner }, question, transcript, round, onToken, shouldAbort) {
  const task = CLI_TASK_PROMPT(question, transcript, round);
  const started = JSON.parse(await agentPool.start(partner, task, '', null));
  if (!started.ok) {
    onToken(`（无法启动 CLI Agent「${partner}」：${started.error}）`);
    return `（无法启动 CLI Agent「${partner}」：${started.error}）`;
  }
  const sid = started.sessionId;
  const deadline = Date.now() + AGENT_TURN_TIMEOUT_MS;
  let full = '';
  let lastDelta = '';
  // 流式清洗器：跨多次 poll 的增量 delta 缓存被边界切断的转义序列，
  // 确保喂给 AI 与聊天气泡的都是纯净文本（同 PTY 层一致强度，外加 \r）。
  const cleaner = createStreamCleaner();
  try {
    while (Date.now() < deadline) {
      if (shouldAbort && shouldAbort()) break;
      const r = JSON.parse(await agentPool.poll(sid));
      if (!r.ok) { onToken(`（轮询失败：${r.error}）`); break; }
      const delta = r.output || '';
      if (delta && delta !== lastDelta) {
        // 仅推送新增增量，避免重复；增量先清洗终端协议字节再上屏/喂给 AI
        const addedRaw = delta.startsWith(lastDelta) ? delta.slice(lastDelta.length) : delta;
        const added = cleaner(addedRaw).replace(/\r/g, '');
        if (added) { full += added; onToken(added); }
        // lastDelta 保留「原始」delta 用于去重比对，避免清洗改变长度后误判重复/漏推
        lastDelta = delta;
      }
      if (r.status === 'done' || r.status === 'error') break;
      if (r.pendingCallbackCount > 0) {
        // CLI Agent 通过 <cliq:ask> 反向提问：把问题交给 AI（下一轮自然会看到）
        onToken(`\n\n> CLI Agent 反问：${(r.pendingCallbacks || []).map(c => c.question).join('; ')}`);
        break;
      }
      await new Promise(r => setTimeout(r, AGENT_POLL_INTERVAL_MS));
    }
  } finally {
    try { await agentPool.cancel(sid); } catch { /* ignore */ }
  }
  return full.trim() || '（CLI Agent 未产出内容）';
}

// 汇总
async function runSummary({ p, key, url, m }, question, transcript, onToken, onUsage) {
  const sysText = SUMMARY_SYSTEM_PROMPT.replace('{QUESTION}', question).replace('{TRANSCRIPT}', transcript);
  let full = '';
  const collect = (tk) => { full += tk; onToken(tk); };
  if (p === 'anthropic') {
    await streamAnthropic(buildApiUrl(url, 'https://api.anthropic.com', '/v1/messages'), key, m, sysText,
      [{ role: 'user', content: '请汇总上面的讨论。' }], collect, onUsage);
  } else {
    await streamOpenAI(buildApiUrl(url, 'https://api.openai.com/v1', '/chat/completions'), key, m,
      [{ role: 'system', content: sysText }, { role: 'user', content: '请汇总上面的讨论。' }], collect, onUsage);
  }
  return full.trim();
}

/**
 * 主入口：运行一次完整的 AI ↔ 多个 CLI Agent 圆桌讨论，全程 SSE 推流。
 * 支持 partners（数组，多选）；旧版单 partner 仍兼容。
 * @param {import('express').Response} res
 * @param {object} opts
 */
const MAX_DISCUSS_AGENTS = 4; // 同时参与讨论的 CLI Agent 上限（控成本/防失控）

async function runDiscussion(res, { message, partner, partners, maxTurns = 6, apiKey, provider, baseUrl, model }) {
  const cfg = resolveConfig({ apiKey, provider, baseUrl, model });
  if (!cfg.key) {
    sse(res, { type: 'error', message: '未配置 API Key（OPENAI/ANTHROPIC），无法运行 AI 讨论。' });
    sse(res, { type: '[DONE]' });
    res.end();
    return;
  }

  // 解析参与讨论的 CLI Agent 列表（多选兼容单选）
  let agents = (Array.isArray(partners) && partners.length) ? partners.slice() : (partner ? [partner] : []);
  if (agents.length === 0) {
    sse(res, { type: 'error', message: '讨论模式需要至少选择一个 CLI Agent（partners）。' });
    sse(res, { type: '[DONE]' });
    res.end();
    return;
  }
  if (agents.length > MAX_DISCUSS_AGENTS) agents = agents.slice(0, MAX_DISCUSS_AGENTS);

  // CLI Agent 显示名映射（让气泡标签更友好；找不到回退到 id）
  let labelOf = (id) => id;
  try {
    const reg = loadRegistry();
    const map = new Map();
    for (const c of (reg.clis || [])) { map.set(c.id, c.displayName || c.name); map.set(c.name, c.displayName || c.name); }
    labelOf = (id) => map.get(id) || id;
  } catch { /* ignore */ }

  // SSE 头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setTimeout(0);

  // 中断检测：监听 res close（writableEnded 守卫），同主线。
  let _aborted = false;
  const onClose = () => { if (!res.writableEnded) _aborted = true; };
  res.on('close', onClose);

  const question = message;
  const transcriptLines = [];
  let cleanFinish = true;

  // ── token 统计（让圆桌 vs 单模型的成本可被实测）──
  let aiInputTokens = 0;   // AI 助手 + 汇总，来自 API usage（精确）
  let aiOutputTokens = 0;
  let cliOutputChars = 0;  // 各 CLI Agent 输出字符数（其内部消耗不在本服务账上）
  const recordAi = (u) => { aiInputTokens += (u.input_tokens || 0); aiOutputTokens += (u.output_tokens || 0); };

  try {
    const agentLabels = agents.map(a => labelOf(a)).join(' / ');
    sse(res, { type: 'status', message: `🤝 圆桌讨论开始：AI 助手 ↔ ${agentLabels}（最多 ${maxTurns} 轮，已开启 token 统计）` });

    for (let round = 1; round <= maxTurns; round++) {
      if (_aborted) { cleanFinish = false; break; }
      sse(res, { type: 'status', message: `讨论进行中… 第 ${round}/${maxTurns} 轮` });

      // ① AI 助手发言（看到全部 Agent 上一轮观点）
      sse(res, { type: 'discuss_start', speaker: 'ai', label: 'AI 助手', round });
      const aiText = await runAiTurn(cfg, question, transcriptLines.join('\n'), (tk) => sse(res, { type: 'token', content: tk }), recordAi);
      sse(res, { type: 'discuss_end', speaker: 'ai' });
      if (aiText) transcriptLines.push(`【第${round}轮 · AI 助手】\n${aiText}`);
      if (_aborted) { cleanFinish = false; break; }

      // ② 每个 CLI Agent 依次发言（圆桌：每位都看到 AI 与前面 Agent 的观点）
      for (const p of agents) {
        if (_aborted) { cleanFinish = false; break; }
        sse(res, { type: 'discuss_start', speaker: 'cli', label: labelOf(p), round });
        const cliText = await runCliTurn({ partner: p }, question, transcriptLines.join('\n'), round,
          (tk) => sse(res, { type: 'token', content: tk }), () => _aborted);
        sse(res, { type: 'discuss_end', speaker: 'cli' });
        if (cliText) { transcriptLines.push(`【第${round}轮 · ${labelOf(p)}】\n${cliText}`); cliOutputChars += cliText.length; }
      }
      if (_aborted) { cleanFinish = false; break; }

      // 早停：AI 表示收敛
      if (/\[CONVERGE\]/i.test(aiText) && round >= 2) break;
    }

    if (!_aborted) {
      // ③ 汇总
      sse(res, { type: 'status', message: '📋 生成讨论结论…' });
      sse(res, { type: 'discuss_start', speaker: 'summary', label: '📋 结论汇总', round: maxTurns + 1 });
      await runSummary(cfg, question, transcriptLines.join('\n'), (tk) => sse(res, { type: 'token', content: tk }), recordAi);
      sse(res, { type: 'discuss_end', speaker: 'summary' });

      // ④ token 消耗报告（圆桌成本可见）
      const cliEstTokens = Math.ceil(cliOutputChars / 4);
      sse(res, {
        type: 'discuss_stats',
        stats: {
          aiInputTokens, aiOutputTokens,
          cliOutputChars, cliEstTokens,
          agents: agents.length, rounds: maxTurns,
        },
      });
    }
  } catch (err) {
    cleanFinish = false;
    sse(res, { type: 'error', message: err.message || '讨论执行出错' });
  } finally {
    res.removeListener('close', onClose);
    sse(res, { type: 'status', message: cleanFinish ? '✅ 讨论完成' : '⏹ 讨论已停止' });
    sse(res, { type: '[DONE]' });
    res.end();
  }
}

module.exports = { runDiscussion };
