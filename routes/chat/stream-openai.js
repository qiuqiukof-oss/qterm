// @ts-check
// ============================================================
// OpenAI Stream — SSE streaming with tool support
//
// Handles OpenAI API streaming chat completions with:
// - Multi-round tool calling (up to 50 rounds)
// - Native and XML-based tool call detection
// - SSE stream parsing and token forwarding
// - Cycle detection for repeated tool calls
// - 120s total execution timeout
// - 60s stream inactivity timeout
// ============================================================

const { safeApiError, parseTextToolCall, trimHistory, buildApiUrl } = require('./utils');
const { QCLI_TOOLS, executeToolCall, toolRateLimiter } = require('./tools');
const { pruneToolContext } = require('./token-budget');
const { killDelegatePTY, abortDelegate } = require('../ai-tools/builtin/agent');

// 单轮 API 调用超时（毫秒）。对慢模型 / 长工具链路放宽到 3 分钟（P3-2）。
const API_FETCH_TIMEOUT_MS = 180_000;

/**
 * Stream OpenAI completion with optional Q-CLI tool use.
 * When the model calls a tool, the function executes it,
 * sends a status event, then loops back with tools still
 * enabled for chained tool calls.
 *
 * @param {import('express').Response} res - SSE response stream
 * @param {Array<{role:string, content?:string}>} messages - Chat messages
 * @param {string} apiKey - OpenAI API key
 * @param {string} [model] - Model name (default: gpt-4o-mini)
 * @param {string} [baseUrl] - Custom API base URL
 * @param {Array} [tools] - Tool definitions
 * @param {Function} [broadcastFn] - WebSocket broadcast for metrics
 * @param {import('express').Request} [req] - Incoming request (for client-disconnect detection)
 */
async function streamOpenAIWithTools(res, messages, apiKey, model, baseUrl, tools, broadcastFn, req) {
  const modelName = model || 'gpt-4o-mini';
  const url = buildApiUrl(baseUrl, 'https://api.openai.com/v1', '/chat/completions');
  // 每请求隔离标识：用于限流桶归属（P2-3），避免多会话共享全局单例相互饿死
  const requestId = 'chat-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

  let currentMessages = [...messages];
  let toolCallCount = 0;
  const MAX_TOOL_ROUNDS = 50;
  // 单次请求「累计工具执行次数」硬上限：防止失控循环在瞬间打满 50 轮（即用户反馈的
  // "一瞬间达到最大工具调用次数"）。与 MAX_TOOL_ROUNDS（LLM 轮次上限）互为补充。
  const MAX_TOTAL_TOOL_CALLS = 120;
  let totalToolCalls = 0;
  const MAX_TOTAL_DURATION = 300_000; // 放宽到 5 分钟，允许长任务 Agent（如 agent_delegate 最多 300s）完整跑完
  const _toolChainStart = Date.now();
  let lastToolSignature = '';
  // 近期工具签名窗口：捕获「参数略有变化但调用模式重复」的循环（原仅查连续完全相同）
  const recentSigs = [];

  // ── SSE 保活心跳：长工具/Agent 执行期间 SSE 可能数分钟无数据，
  //    必须周期性写入，否则 socket 空闲超时会杀掉连接（前端“调用工具被断开”）。──
  let toolRunning = false;
  let toolRunningName = '';
  let toolRunStart = 0;
  const heartbeat = setInterval(() => {
    try {
      res.write(': keepalive\n\n'); // SSE 注释行，对前端不可见，仅用于保活
      if (toolRunning) {
        const secs = Math.floor((Date.now() - toolRunStart) / 1000);
        res.write(`data: ${JSON.stringify({ type: 'status', message: `⏳ ${toolRunningName} 运行中…（已 ${secs}s）` })}\n\n`);
      }
    } catch { /* connection already closed */ }
  }, 15_000);
  const _finish = () => { try { clearInterval(heartbeat); } catch { /* ignore */ } };

  // ── 客户端断开（停止生成）检测 ──
  // 前端点击「停止」会 abort fetch，浏览器侧 socket 关闭。后端若不感知，
  // 仍会继续跑 LLM 流 + 工具循环（含 agent PTY 子进程），既浪费资源又让
  // 前端卡在「生成中」无法恢复。
  //
  // ⚠️ 关键坑（实测复现）：绝不能监听 **req**('close')。POST /chat 的请求体在
  // body-parser 阶段就被完整读取，readable 侧随即关闭 → Node 会在**响应刚开始
  // 流式输出时**（writableEnded=false）立刻触发 req 'close'，即使客户端仍在正常
  // 接收。旧实现据此置 _aborted=true，导致「首轮工具跑完 → 下一轮开头 break →
  // 落到『已达到最大工具调用次数(50轮)』」的误报（用户反馈的“一瞬间打满上限”）。
  // 正确做法：监听 **res**('close')，且仅当响应尚未正常结束（!res.writableEnded）
  // 时才视为真正的客户端断开——res 'close' 在正常收尾时 writableEnded 已为 true，
  // 会被下面的守卫忽略，只有真实断连才会 writableEnded=false。
  let _aborted = false;
  const onClientClose = () => {
    if (res.writableEnded) return; // 响应已正常结束的 close，非中断，忽略
    _aborted = true;
    // 立即中断正在执行的 agent_delegate（其 executeAgent 在 await PTY，不会自然返回）
    try { abortDelegate(); } catch { /* ignore */ }
  };
  if (res && typeof res.on === 'function') {
    res.on('close', onClientClose);
  }

  try {

  while (toolCallCount < MAX_TOOL_ROUNDS) {
    // 客户端已断开（用户点停止或刷新/关闭）→ 立即中断整条流，避免孤儿进程与卡死
    if (_aborted) {
      console.log('[chat] client disconnected (stop), aborting stream');
      break;
    }

    // ── Total timeout check ──
    if (Date.now() - _toolChainStart > MAX_TOTAL_DURATION) {
      res.write(`data: ${JSON.stringify({ type: 'status', message: '工具调用总超时（5 分钟），停止继续调用' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // ── 累计工具执行次数硬上限（防失控循环瞬间打满 50 轮）──
    if (totalToolCalls >= MAX_TOTAL_TOOL_CALLS) {
      res.write(`data: ${JSON.stringify({ type: 'status', message: '已达单次请求工具调用安全上限，停止以避免失控' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const body = {
      model: modelName,
      messages: currentMessages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 16384,
    };

    if (tools) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(safeApiError(response, errBody, 'OpenAI API'));
    }

    // Parse the streaming response
    const { toolCalls, assistantContent, usage } = await parseStreamAndCollectTools(response, res);

    if (toolCalls.length === 0) {
      // No tool calls — already sent [DONE] + res.end() in parser
      return;
    }

    // ── Cycle detection: same tool+args as last round → break ──
    const sig = toolCalls.map(t => `${t.name}:${t.arguments}`).join('|');
    if (sig === lastToolSignature && toolCallCount > 0) {
      res.write(`data: ${JSON.stringify({ type: 'status', message: '检测到重复工具调用，停止' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    // 近期签名窗口：捕获「参数略有变化但调用模式重复」的循环（原仅查连续完全相同）
    if (recentSigs.includes(sig)) {
      res.write(`data: ${JSON.stringify({ type: 'status', message: '检测到重复工具调用模式，停止' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    recentSigs.push(sig);
    if (recentSigs.length > 8) recentSigs.shift();
    lastToolSignature = sig;

    // ── Tool calls detected — execute them ──
    toolCallCount++;

    // Build assistant message
    const assistantMsg = { role: 'assistant', content: assistantContent || null };
    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    currentMessages.push(assistantMsg);

    // Send status + tool_call_start event to client
    const toolNames = [...new Set(toolCalls.map(t => t.name))];
    res.write(`data: ${JSON.stringify({ type: 'status', message: `正在查询 ${toolNames.join(', ')}...` })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'tool_call_start', names: toolNames })}\n\n`);

    // 标记工具执行中，心跳会据此向前端展示“运行中…（已 Xs）”以减少“卡住”错觉
    toolRunning = true;
    toolRunningName = toolNames.join(', ');
    toolRunStart = Date.now();

    // Execute each tool — isolated so one failure doesn't break the chain
    for (const tc of toolCalls) {
      let args = {};
      try { args = JSON.parse(tc.arguments); } catch { /* use empty */ }
      const tcStart = Date.now();
      let result, tcError;
      try {
        result = await executeToolCall(tc.name, args, broadcastFn, requestId);
      } catch (unexpectedErr) {
        result = `[Tool Error] ${unexpectedErr.message}`;
        tcError = unexpectedErr.message;
      }
      totalToolCalls++; // 累计工具执行次数（含失败），用于硬上限防失控
      const tcDur = Date.now() - tcStart;

      res.write(`data: ${JSON.stringify({
        type: 'tool_call_end',
        name: tc.name,
        durMs: tcDur,
        truncated: result && result.length > 500,
        error: tcError || undefined,
      })}\n\n`);

      currentMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result || '[No result]',
      });
    }

    toolRunning = false; // 工具执行结束，停止“运行中”心跳提示

    // Send "continuing" status
    res.write(`data: ${JSON.stringify({ type: 'status', message: '正在生成回答...' })}\n\n`);

    // ── Reset token bucket for next round (per-request 隔离) ──
    toolRateLimiter.reset(requestId);
    // ── 跨轮工具结果压缩：合并重复 agent_poll 增量、压低 token（不影响功能）──
    currentMessages = pruneToolContext(currentMessages);
    // ── Trim history to prevent context overflow ──
    currentMessages = trimHistory(currentMessages);
  }

  // 走到这里只有两种可能：① 真正达到轮次硬上限(toolCallCount>=MAX_TOOL_ROUNDS)；
  // ② 被客户端中断(_aborted break)。只有 ① 才提示「已达上限」，② 交由 finally 静默
  // 补发 [DONE]，避免把「用户主动停止/断连」误报成「已达到最大工具调用次数」。
  if (!_aborted) {
    res.write(`data: ${JSON.stringify({ type: 'token', content: '\n\n[已达到最大工具调用次数(50轮)，部分结果可能不完整]' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
  } finally {
    // 客户端中断时，确保流能正常结束（发 [DONE]），让前端 onDone 触发、UI 恢复可交互
    if (_aborted) {
      try {
        if (!res.writableEnded) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      } catch { /* ignore */ }
    }
    // 清理可能仍在跑的 agent_delegate 游离 PTY，防止孤儿进程
    if (_aborted) {
      try { killDelegatePTY(); } catch { /* ignore */ }
    }
    if (res && typeof res.removeListener === 'function') {
      res.removeListener('close', onClientClose);
    }
    _finish();
  }
}

/**
 * Parse an OpenAI SSE stream, sending text tokens to the client
 * and collecting tool_calls. Returns when the stream ends or
 * when finish_reason is 'tool_calls'.
 *
 * @param {Response} response - Fetch Response object with SSE body
 * @param {import('express').Response} res - Express response for forwarding tokens
 * @returns {Promise<{ toolCalls: Array<{id:string, name:string, arguments:string}>, assistantContent: string, usage: object|null }>}
 */
async function parseStreamAndCollectTools(response, res) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  let assistantContent = '';
  /** @type {Array<{id:string, name:string, arguments:string}>} */
  const toolCalls = [];
  let finishReason = null;
  let streamEnded = false;
  /** @type {{prompt_tokens?:number, completion_tokens?:number, total_tokens?:number}|null} */
  let usage = null;

  // Text tool call state (for <tool_call> XML filtering across chunks)
  let tcBuffer = '';

  // ── Stream timeout protection ──
  let lastDataTime = Date.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) { streamEnded = true; break; }
    if (value) lastDataTime = Date.now();

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') { streamEnded = true; break; }

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;
        finishReason = parsed.choices?.[0]?.finish_reason;

        if (parsed.usage) {
          usage = parsed.usage;
        }

        if (delta) {
          // ── Content streaming with <tool_call> XML filtering ──
          if (delta.content) {
            tcBuffer += delta.content;
            let cleanPart = '';

            while (tcBuffer.length > 0) {
              const tcStart = tcBuffer.indexOf('<tool_call>');
              if (tcStart === -1) {
                cleanPart += tcBuffer;
                tcBuffer = '';
                break;
              }
              cleanPart += tcBuffer.slice(0, tcStart);
              const tcEnd = tcBuffer.indexOf('</tool_call>', tcStart);
              if (tcEnd === -1) {
                tcBuffer = tcBuffer.slice(tcStart);
                break;
              }
              const tcXml = tcBuffer.slice(tcStart, tcEnd + '</tool_call>'.length);
              const parsedTc = parseTextToolCall(tcXml);
              if (parsedTc) toolCalls.push(parsedTc);
              tcBuffer = tcBuffer.slice(tcEnd + '</tool_call>'.length);
            }

            if (cleanPart) {
              assistantContent += cleanPart;
              res.write(`data: ${JSON.stringify({ type: 'token', content: cleanPart })}\n\n`);
            }
          }

          // ── Native tool_calls ──
          if (delta.tool_calls) {
            for (const tcDelta of delta.tool_calls) {
              const idx = tcDelta.index;
              if (!toolCalls[idx]) {
                toolCalls[idx] = { id: tcDelta.id || '', name: '', arguments: '' };
              }
              if (tcDelta.id) toolCalls[idx].id = tcDelta.id;
              if (tcDelta.function?.name) toolCalls[idx].name += tcDelta.function.name;
              if (tcDelta.function?.arguments) toolCalls[idx].arguments += tcDelta.function.arguments;
            }
          }
        }

        if (finishReason === 'tool_calls') {
          streamEnded = true;
          break;
        }
      } catch {
        // Skip malformed JSON lines
      }
    }

    if (Date.now() - lastDataTime > 60000) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Stream timeout - no data for 60s' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return { toolCalls: [], assistantContent: '', usage: null };
    }

    if (streamEnded) break;
  }

  // Flush any remaining clean text in tcBuffer
  if (tcBuffer && !tcBuffer.startsWith('<tool_call>')) {
    assistantContent += tcBuffer;
    res.write(`data: ${JSON.stringify({ type: 'token', content: tcBuffer })}\n\n`);
  }

  const allToolCalls = toolCalls.filter(Boolean);

  if (finishReason === 'tool_calls' || allToolCalls.length > 0) {
    return { toolCalls: allToolCalls, assistantContent, usage };
  }

  // No tool calls — done; send usage before [DONE]
  if (usage) {
    res.write(`data: ${JSON.stringify({ type: 'usage', usage })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
  return { toolCalls: [], assistantContent, usage };
}

/**
 * Legacy OpenAI plain streaming (no tool support).
 * @param {import('express').Response} res
 * @param {Array<{role:string, content:string}>} messages
 * @param {string} apiKey
 * @param {string} [model]
 * @param {string} [baseUrl]
 */
async function streamOpenAI(res, messages, apiKey, model, baseUrl) {
  const modelName = model || 'gpt-4o-mini';
  const url = buildApiUrl(baseUrl, 'https://api.openai.com/v1', '/chat/completions');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelName,
      messages,
      stream: true,
      max_tokens: 16384,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(safeApiError(response, errBody, 'OpenAI API'));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content || '';
        if (content) {
          res.write(`data: ${JSON.stringify({ type: 'token', content })}\n\n`);
        }
      } catch {
        // Skip malformed JSON lines
      }
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

module.exports = {
  streamOpenAIWithTools,
  parseStreamAndCollectTools,
  streamOpenAI,
};
