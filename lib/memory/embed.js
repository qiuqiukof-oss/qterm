// @ts-check
// Optional local vector recall (M7). This is a plugin: when HESI_MEMORY_EMBED
// is unset (default) or no model binary is configured, every call returns null
// and the system stays on pure BM25 — no errors, no hard dependency.
// If a local embedding model is later wired in, `embed()` returns a vector,
// docs get a `vec` field at index time, and recall reranks by cosine.
'use strict';

const config = require('./config');

const _model = null; // lazily-loaded embedding backend (kept pluggable)

function enabled() {
  return config.EMBED_ENABLED;
}

// Returns a numeric vector for text, or null when embedding is disabled / no
// model is available / anything fails. Defensive by design.
async function embed(text) {
  if (!enabled()) return null;
  if (!config.EMBED_MODEL_PATH) return null; // configured but no model binary
  try {
    if (!_model) {
      // No hard dependency baked in. A real local embedder would be required
      // and assigned here. Until then, degrade to null (BM25 only).
      return null;
    }
    return _model.embed(String(text || ''));
  } catch {
    return null;
  }
}

// Cosine similarity; returns 0 on length mismatch / zero vectors.
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

module.exports = { enabled, embed, cosine };
