// @ts-check
// Automatic summary compaction. Replaces the legacy trimHistory truncation:
// when a session grows past the working window / token threshold, the oldest
// messages are summarized (via llm-bridge) and rolled into `summary`, and the
// raw old segment is dropped. Degrades to "keep raw" when no LLM is available.
'use strict';

const config = require('./config');
const session = require('./session');
const archive = require('./archive');
const indexStore = require('./index-store');
const llm = require('./llm-bridge');
const embed = require('./embed');

// Decide whether compaction should run for a session.
function shouldCompact(s, now = Date.now()) {
  if (!s) return false;
  if (s.tokenEstimate > config.COMPACT_THRESHOLD) return true;
  // Idle trigger: summary is old, but the session was recently active.
  if (
    s.summaryUpdatedAt &&
    now - s.summaryUpdatedAt > config.IDLE_COMPACT_MS &&
    now - s.updatedAt < config.IDLE_COMPACT_MS
  ) {
    return true;
  }
  return false;
}

async function compactIfNeeded(sessionId, opts = {}) {
  if (!config.MEMORY_ENABLED) return { skipped: true, reason: 'disabled' };
  const s = session.load(sessionId);
  if (!s) return { skipped: true, reason: 'no-session' };
  if (s.messages.length <= s.workingWindow) return { skipped: true, reason: 'within-window' };
  if (!shouldCompact(s) && s.messages.length <= s.workingWindow + 4) {
    // Small overflow that hasn't crossed a real trigger — leave it.
    return { skipped: true, reason: 'below-threshold' };
  }

  const oldSeg = s.messages.slice(0, s.messages.length - s.workingWindow);
  const oldSegText = oldSeg.map((m) => `[${m.role}] ${m.content || ''}`).join('\n');

  const summary = await llm.summarize(oldSegText, s.summary || '', opts);
  if (!summary) {
    // LLM unavailable → do not compress; keep the raw messages (legacy fallback).
    return { degraded: true, reason: 'llm-unavailable' };
  }

  await session.applySummary(sessionId, summary);

  // Refresh this session's retrieval index entry (summary changed).
  const updated = session.load(sessionId);
  if (updated) {
    const doc = archive.sessionDoc(updated);
    if (embed.enabled()) doc.vec = await embed.embed(doc.text);
    indexStore.upsert(doc);
  }
  return { compacted: true, dropped: oldSeg.length, summaryLength: summary.length };
}

module.exports = { shouldCompact, compactIfNeeded };
