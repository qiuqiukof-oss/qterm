// @ts-check
// ============================================================
// Anthropic Stream — SSE streaming with tool_use support
//
// Handles Anthropic Messages API streaming with:
// - Multi-round tool calling (up to 50 rounds)
// - Content block stream parsing (text + tool_use)
// - Incremental JSON input accumulation
// - Cycle detection for repeated tool calls
// - 120s total execution timeout
// ============================================================

const { safeApiError, trimHistory, buildApiUrl } = require('./utils');
const { executeToolCall, toolRateLimiter } = require('./tools');
const { pruneToolContext } = require('./token-budget');
const { killDelegatePTY, abortDelegate } = require('../ai-tools/builtin/agent');

// 单轮 API 调用超时（毫秒）。对慢模型 / 长工具链路放宽到 3 分钟（P3-2）。
const API_FETCH_TIMEOUT_MS = 180_000;

/**
 * Convert internal message format to Anthropic Messages API format.
 * Handles both string content (initial messages) and content block arrays (tool rounds).
 * @param {Array<{role?:string, content?:string|Array}>} messages
 * @returns {Array<{role:string, content:any}>}
 */
function buildAnthropicConversation(messages) {
  return messages
    .filter(m => m.role !== 'system')
    .map(m => {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      if (Array.isArray(m.content)) {
        return { role, content: m.content };
      }
      return { role, content: m.content };
    });
}

/**
 * Parse Anthropic SSE stream, streaming text tokens to the client
 * and collecting tool_use content blocks.
 *
 * Anthropic SSE uses `event:` prefix + `data:` JSON lines:
 *   event: content_block_start
 *   data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_...","name":"get_weather","input":{}}}
 *
 * @param {Response} response - Fetch Response object with SSE body
 * @param {import('express').Response} res - Express response for forwarding tokens
 * @returns {Promise<{ toolCalls: Array<{id:string, name:string, input:object}>, assistantBlocks: Array, assistantContent: string, stopReason: string|null, usage: object|null }>}
 */
async function parseAnthropicStream(response, res) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  /** @type {Array<{type:string, text?:string, id?:string, name?:string, input?:object}>} */
  const assistantBlocks = [];
  /** @type {Array<{id:string, name:string, input:object}>} */
  const toolCalls = [];
  let assistantContent = '';
  let stopReason = null;
  /** @type {{input_tokens?:number, output_tokens?:number}|null} */
  let usage = null;
  let lastDataTime = Date.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) lastDataTime = Date.now();

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    let currentEvent = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('event: ')) {
        currentEvent = trimmed.slice(7).trim();
        continue;
      }

      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6);
        try {
          const parsed = JSON.parse(data);
          const type = parsed.type || currentEvent;

          if (type === 'message_start') {
            if (parsed.message?.usage) {
              usage = { ...usage, ...parsed.message.usage };
            }
          } else if (type === 'content_block_start') {
            const block = parsed.content_block;
            if (block.type === 'tool_use') {
              assistantBlocks.push({
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: block.input || {},
                _inputBuffer: '',
              });
            } else if (block.type === 'text') {
              assistantBlocks.push({ type: 'text', text: '' });
            }
          } else if (type === 'content_block_delta') {
            const delta = parsed.delta;
            if (delta.type === 'text_delta') {
              const text = delta.text || '';
              const lastBlock = assistantBlocks[assistantBlocks.length - 1];
              if (lastBlock?.type === 'text') {
                lastBlock.text += text;
              }
              assistantContent += text;
              res.write(`data: ${JSON.stringify({ type: 'token', content: text })}\n\n`);
            } else if (delta.type === 'input_json_delta') {
              const lastBlock = assistantBlocks[assistantBlocks.length - 1];
              if (lastBlock?.type === 'tool_use') {
                lastBlock._inputBuffer += delta.partial_json || '';
              }
            }
          } else if (type === 'content_block_stop') {
            const lastBlock = assistantBlocks[assistantBlocks.length - 1];
            if (lastBlock?.type === 'tool_use') {
              try {
                lastBlock.input = JSON.parse(lastBlock._inputBuffer || '{}');
              } catch {
                lastBlock.input = {};
              }
              delete lastBlock._inputBuffer;
              toolCalls.push({
                id: lastBlock.id,
                name: lastBlock.name,
                input: lastBlock.input,
              });
            }
          } else if (type === 'message_delta') {
            stopReason = parsed.delta?.stop_reason || null;
            if (parsed.usage) {
              usage = { ...(usage || {}), ...parsed.usage };
            }
          }
          // 'ping' and 'message_stop' events — ignored
        } catch {
          // Skip malformed JSON
        }
        currentEvent = '';
      }
    }

    if (Date.now() - lastDataTime > 60000) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Stream timeout - no data for 60s' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return { toolCalls: [], assistantBlocks: [], assistantContent: '', stopReason: null, usage: null };
    }
  }

  // Clean _inputBuffer from any remaining tool_use blocks
  for (const block of assistantBlocks) {
    if (block.type === 'tool_use' && '_inputBuffer' in block) {
      delete block._inputBuffer;
    }
  }

  const hasToolUse = toolCalls.length > 0 || stopReason === 'tool_use';

  if (hasToolUse) {
    return { toolCalls, assistantBlocks, assistantContent, stopReason, usage };
  }

  // No tool calls — finalize stream
  if (usage) {
    res.write(`data: ${JSON.stringify({ type: 'usage', usage })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
  return { toolCalls: [], assistantBlocks, assistantContent, stopReason, usage };
}

/**
 * Stream Anthropic completion with tool_use support and multi-round tool calling.
 * Mirrors streamOpenAIWithTools but uses Anthropic's content block format.
 *
 * @param {import('express').Response} res - SSE response stream
 * @param {Array<{role:string, content?:string|Array}>} messages - Chat messages
 * @param {string} apiKey - Anthropic API key
 * @param {string} [model] - Model name (default: claude-sonnet-4-20250514)
 * @param {string} [baseUrl] - Custom API base URL
 * @param {Array} [tools] - Tool definitions (OpenAI format, auto-converted)
 * @param {Function} [broadcastFn] - WebSocket broadcast for metrics
 * @param {import('express').Request} [req] - Incoming request (for client-disconnect detection)
 */
async function streamAnthropicWithTools(res, messages, apiKey, model, baseUrl, tools, broadcastFn, req) {
  const modelName = model || 'claude-sonnet-4-20250514';
  // 每请求隔离标识：用于限流桶归属（P2-3）
  const requestId = 'chat-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

  // Convert OpenAI-format tools to Anthropic format
  const anthropicTools = tools ? tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters || { type: 'object', properties: {} },
  })) : undefined;

  let currentMessages = [...messages];
  let toolCallCount = 0;
  const MAX_TOOL_ROUNDS = 50;
  // 单次请求「累计工具执行次数」硬上限：防止失控循环在瞬间打满 50 轮
  const MAX_TOTAL_TOOL_CALLS = 120;
  let totalToolCalls = 0;
  const MAX_TOTAL_DURATION = 300_000; // 放宽到 5 分钟，允许长任务 Agent 完整跑完
  const _toolChainStart = Date.now();
  let lastToolSignature = '';
  // 近期工具签名窗口：捕获「参数略有变化但调用模式重复」的循环
  const recentSigs = [];

  // ── SSE 保活心跳（同 stream-openai.js）──
  let toolRunning = false;
  let toolRunningName = '';
  let toolRunStart = 0;
  const heartbeat = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
      if (toolRunning) {
        const secs = Math.floor((Date.now() - toolRunStart) / 1000);
        res.write(`data: ${JSON.stringify({ type: 'status', message: `⏳ ${toolRunningName} 运行中…（已 ${secs}s）` })}\n\n`);
      }
    } catch { /* connection already closed */ }
  }, 15_000);
  const _finish = () => { try { clearInterval(heartbeat); } catch { /* ignore */ } };

  // ── 客户端断开（停止生成）检测：同 stream-openai.js ──
  // ⚠️ 必须监听 res('close') 而非 req('close')：POST 请求体在 body-parser 阶段即被
  // 读完，req 的 readable 侧随即关闭，Node 会在响应刚开始流式输出时（writableEnded=false）
  // 立刻触发 req 'close'，即使客户端仍在正常接收 → 误判中断 → 首轮工具后 break →
  // 误报「已达到最大工具调用次数(50轮)」。改用 res('close') + !writableEnded 守卫。
  let _aborted = false;
  const onClientClose = () => {
    if (res.writableEnded) return; // 正常收尾触发的 close，忽略
    _aborted = true;
    try { abortDelegate(); } catch { /* ignore */ }
  };
  if (res && typeof res.on === 'function') {
    res.on('close', onClientClose);
  }

  try {

  while (toolCallCount < MAX_TOOL_ROUNDS) {
    if (_aborted) {
      console.log('[chat] client disconnected (stop), aborting stream');
      break;
    }
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

    const systemMsg = currentMessages.find(m => m.role === 'system');
    const conversation = buildAnthropicConversation(currentMessages);

    const body = {
      model: modelName,
      messages: conversation,
      system: systemMsg?.content || undefined,
      max_tokens: 16384,
      stream: true,
    };

    if (anthropicTools) {
      body.tools = anthropicTools;
    }

    const url = buildApiUrl(baseUrl, 'https://api.anthropic.com/v1', '/messages');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(safeApiError(response, errBody, 'Anthropic API'));
    }

    const { toolCalls, assistantBlocks, usage } = await parseAnthropicStream(response, res);

    // 注意：usage 已由 parseAnthropicStream 在「无工具调用」终态分支中
    // 写入并紧接着 res.end()；此处不能再写，否则会出现「end 之后继续 write」，
    // 在真实 Express 响应上触发 write-after-end 且让 [DONE] 不再是流的最后字节。
    if (toolCalls.length === 0) {
      return;
    }

    // ── Cycle detection ──
    const sig = toolCalls.map(t => `${t.name}:${JSON.stringify(t.input)}`).join('|');
    if (sig === lastToolSignature && toolCallCount > 0) {
      res.write(`data: ${JSON.stringify({ type: 'status', message: '检测到重复工具调用，停止' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    // 近期签名窗口：捕获「参数略有变化但调用模式重复」的循环
    if (recentSigs.includes(sig)) {
      res.write(`data: ${JSON.stringify({ type: 'status', message: '检测到重复工具调用模式，停止' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    recentSigs.push(sig);
    if (recentSigs.length > 8) recentSigs.shift();
    lastToolSignature = sig;

    toolCallCount++;

    // Build assistant message with Anthropic content blocks
    const assistantMsg = {
      role: 'assistant',
      content: assistantBlocks.map(b => {
        if (b.type === 'tool_use') {
          return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
        }
        return { type: 'text', text: b.text || '' };
      }),
    };
    currentMessages.push(assistantMsg);

    const toolNames = [...new Set(toolCalls.map(t => t.name))];
    res.write(`data: ${JSON.stringify({ type: 'status', message: `正在查询 ${toolNames.join(', ')}...` })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'tool_call_start', names: toolNames })}\n\n`);

    // 标记工具执行中，心跳展示“运行中…（已 Xs）”
    toolRunning = true;
    toolRunningName = toolNames.join(', ');
    toolRunStart = Date.now();

    // Execute each tool — isolated so one failure doesn't break the chain
    const toolResultBlocks = [];
    for (const tc of toolCalls) {
      let args = {};
      try { args = tc.input || {}; } catch { /* use empty */ }
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

      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: tc.id,
        content: result || '[No result]',
      });
    }

    toolRunning = false; // 工具执行结束

    // Anthropic: tool results go in a user-role message with tool_result content blocks
    currentMessages.push({
      role: 'user',
      content: toolResultBlocks,
    });

    res.write(`data: ${JSON.stringify({ type: 'status', message: '正在生成回答...' })}\n\n`);

    toolRateLimiter.reset(requestId);
    currentMessages = pruneToolContext(currentMessages);
    currentMessages = trimHistory(currentMessages);
  }

  // 仅当真正达到轮次硬上限才提示；被中断(_aborted)时由 finally 静默补 [DONE]，
  // 避免把「用户停止/断连」误报成「已达到最大工具调用次数」。
  if (!_aborted) {
    res.write(`data: ${JSON.stringify({ type: 'token', content: '\n\n[已达到最大工具调用次数(50轮)，部分结果可能不完整]' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
  } finally {
    if (_aborted) {
      try {
        if (!res.writableEnded) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      } catch { /* ignore */ }
      try { killDelegatePTY(); } catch { /* ignore */ }
    }
    if (res && typeof res.removeListener === 'function') {
      res.removeListener('close', onClientClose);
    }
    _finish();
  }
}

module.exports = {
  streamAnthropicWithTools,
  parseAnthropicStream,
  buildAnthropicConversation,
};
