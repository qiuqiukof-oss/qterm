// @ts-check
// Tests for automatic compaction (M5) and the chat-injection contract (M4):
//   - compactIfNeeded summarizes the old segment and trims raw messages
//   - degrades to "keep raw" when the LLM is unavailable
//   - after compaction, getSummaryBlock + recall surface the summary
// Uses an injected fake LLM so no network/API key is needed.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate to a temp dir + reset require cache for lib/memory.
process.env.HESI_MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hesi-mem-comp-'));
for (const k of Object.keys(require.cache)) {
  if (k.includes('lib' + path.sep + 'memory')) delete require.cache[k];
}
const MemoryStore = require('../lib/memory');
const llm = require('../lib/memory/llm-bridge');
const compaction = require('../lib/memory/compaction');

function makeMessages(n) {
  const ms = [];
  for (let i = 0; i < n; i++) {
    ms.push({ id: 'm_' + i, role: i % 2 === 0 ? 'user' : 'assistant', content: '消息内容 ' + i + ' '.repeat(40) });
  }
  return ms;
}

test('compaction: summarizes old segment and trims raw messages', async () => {
  let calls = 0;
  llm.setLLMCaller(async (system, user) => {
    calls++;
    return '【摘要】这是压缩后的会话摘要，保留了关键决策与用户偏好。';
  });
  try {
    const id = 's_comp_' + Date.now().toString(36);
    MemoryStore.ensure(id, { title: '长会话' });
    await MemoryStore.append(id, makeMessages(40)); // > WORKING_WINDOW(24)
    const before = MemoryStore.get(id);
    assert.ok(before.messages.length > before.workingWindow, 'session exceeds working window');

    const result = await compaction.compactIfNeeded(id, {});
    assert.strictEqual(result.compacted, true, 'should report compacted');
    assert.strictEqual(calls, 1, 'LLM should be called exactly once');

    const after = MemoryStore.get(id);
    assert.strictEqual(after.messages.length, after.workingWindow, 'raw messages trimmed to window');
    assert.ok(after.summary.includes('摘要'), 'summary stored');

    // getSummaryBlock now yields a <session_summary> system block
    const sb = MemoryStore.getSummaryBlock(id);
    assert.ok(sb && sb.role === 'system' && sb.content.includes('<session_summary>'));

    // recall should surface the summary text for a related query
    const block = MemoryStore.recall('会话 摘要', { topK: 3 });
    assert.ok(block && block.content.includes('摘要'), 'recall surfaces summary');
  } finally {
    llm.setLLMCaller(null);
  }
});

test('compaction: degrades to keep-raw when LLM unavailable', async () => {
  llm.setLLMCaller(null); // force real path → no api key → null
  const id = 's_deg_' + Date.now().toString(36);
  MemoryStore.ensure(id, { title: '无LLM' });
  await MemoryStore.append(id, makeMessages(40));
  const result = await compaction.compactIfNeeded(id, {}); // no apiKey → llm returns null
  assert.strictEqual(result.degraded, true, 'should report degraded (llm-unavailable)');
  const s = MemoryStore.get(id);
  assert.strictEqual(s.messages.length, 40, 'raw messages preserved on degrade');
  assert.strictEqual(s.summary, '', 'no summary written on degrade');
});

test('compaction: no-op when session is within working window', async () => {
  llm.setLLMCaller(null);
  const id = 's_small_' + Date.now().toString(36);
  MemoryStore.ensure(id, { title: '短会话' });
  await MemoryStore.append(id, makeMessages(10));
  const result = await compaction.compactIfNeeded(id, {});
  assert.strictEqual(result.skipped, true, 'should skip without compaction');
});
