// @ts-check
// ============================================================
// Chat Utilities — shared helpers extracted from routes/chat.js
//
// Contains: token estimation, message trimming, URL helpers,
// safe error parsing, and XML tool call parsing.
// ============================================================

/**
 * Estimate token count from message array (rough: ~2 chars per token for mixed content).
 * Handles both string content (OpenAI) and content block arrays (Anthropic tool rounds).
 * @param {Array<{role?:string, content?:string|Array<{type:string, text?:string}>}>} msgs
 * @returns {number}
 */
function estimateTokenCount(msgs) {
  const text = msgs.map(m => {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map(b => b.text || '').join('');
    return '';
  }).join('');
  return Math.ceil(text.length / 2);
}

/**
 * Trim conversation history to prevent context overflow.
 * Keeps the system prompt (if present) and the 20 most recent messages.
 * @param {Array<{role?:string, content?:any}>} msgs
 * @returns {Array<{role?:string, content?:any}>}
 */
function trimHistory(msgs) {
  const MAX_HISTORY_TOKENS = 100000;
  if (estimateTokenCount(msgs) <= MAX_HISTORY_TOKENS) return msgs;
  const systemMsg = msgs[0]?.role === 'system' ? msgs[0] : null;
  const tail = msgs.slice(-20);
  return systemMsg ? [systemMsg, ...tail] : tail;
}

/**
 * Safely parse an API error response, redacting any sensitive data.
 * Returns a safe error message without exposing API keys or request bodies.
 * @param {import('express').Response} resp - The fetch Response object
 * @param {string} body - Raw response body text
 * @param {string} label - Provider label (e.g. 'OpenAI API')
 * @returns {string}
 */
function safeApiError(resp, body, label) {
  try {
    const parsed = JSON.parse(body);
    // OpenAI format: { error: { message: "..." } }
    if (parsed.error?.message) return `${label} error: ${parsed.error.message}`;
    // Anthropic format: { error: { message: "..." } }
    // Generic format: { message: "..." }
    if (parsed.message) return `${label} error: ${parsed.message}`;
  } catch { /* non-JSON body */ }
  return `${label} error (HTTP ${resp.status})`;
}

/**
 * Parse a <tool_call> XML string into a tool call object.
 * Supports formats:
 *   <tool_call><function=NAME><parameter=KEY>VAL</parameter></function></tool_call>
 *   <tool_call><function>NAME</function><parameter name="KEY">VAL</parameter></tool_call>
 * @param {string} xml
 * @returns {{ id: string, name: string, arguments: string } | null}
 */
function parseTextToolCall(xml) {
  // Extract function name: <function=NAME> or <function>NAME</function>
  let name = '';
  const funcAttrMatch = xml.match(/<function\s*=\s*([^\s>\/]+)/);
  const funcTagMatch = xml.match(/<function>([^<]+)<\/function>/);
  if (funcAttrMatch) name = funcAttrMatch[1].trim();
  else if (funcTagMatch) name = funcTagMatch[1].trim();
  if (!name) return null;

  // Extract parameters: <parameter=KEY>VAL</parameter> or <parameter name="KEY">VAL</parameter>
  const params = {};
  const paramAttrRe = /<parameter\s*=\s*([^>]+?)>(.*?)<\/parameter\s*>/g;
  const paramNameRe = /<parameter\s+name\s*=\s*["']([^"']+)["']>(.*?)<\/parameter\s*>/g;
  let m;
  while ((m = paramAttrRe.exec(xml)) !== null) params[m[1].trim()] = m[2].trim();
  while ((m = paramNameRe.exec(xml)) !== null) params[m[1].trim()] = m[2].trim();

  return { id: `txtc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name, arguments: JSON.stringify(params) };
}

/**
 * Normalize a base URL for API calls.
 * Supports hostnames, IP addresses, localhost, and path-only inputs.
 * @param {string} url
 * @returns {string}
 */
function normalizeBaseUrl(url) {
  if (!url) return url;
  url = url.trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) {
    return 'http://localhost:11434' + url;
  }
  const isHostname = (
    /^localhost(?::\d+)?(\/|$)/i.test(url) ||
    /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?(\/|$)/.test(url) ||
    /^[\w-]+(?:\.\w{2,})+(?::\d+)?(\/|$)/.test(url) ||
    /^[\w.-]+:\d+(\/|$)/.test(url)
  );
  if (isHostname) {
    return 'http://' + url;
  }
  return 'http://localhost:11434/' + url;
}

/**
 * Build a full API URL from a base URL, default URL, and endpoint path.
 * @param {string} baseUrl - User-provided base URL (may be null/undefined)
 * @param {string} defaultUrl - Default API base (e.g. 'https://api.openai.com/v1')
 * @param {string} endpoint - Endpoint path (e.g. '/chat/completions')
 * @returns {string}
 */
function buildApiUrl(baseUrl, defaultUrl, endpoint) {
  const normalized = normalizeBaseUrl(baseUrl) || defaultUrl;
  const clean = normalized.replace(/\/+$/, '');
  if (/\/v1(\/|$)/i.test(clean)) {
    return clean + endpoint;
  }
  return clean + '/v1' + endpoint;
}

/**
 * Get the internal API base URL for Hesi.
 * @returns {string}
 */
function getApiBase() {
  return `http://127.0.0.1:${process.env.PORT || 3001}/api`;
}

module.exports = {
  estimateTokenCount,
  trimHistory,
  safeApiError,
  parseTextToolCall,
  normalizeBaseUrl,
  buildApiUrl,
  getApiBase,
};
