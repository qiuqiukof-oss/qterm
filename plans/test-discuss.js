#!/usr/bin/env node
// @ts-check
// ============================================================
// plans/test-discuss.js
// ------------------------------------------------------------
// Regression for the AI discussion coordinator (routes/chat/discuss.js).
//
// This module is a PUBLIC integration entry point consumed by the chat
// router. A refactor must not silently break its export shape, so this
// script guards the contract with 7 real assertions:
//   1. module loads without throwing (its deps resolve)
//   2. exports an object
//   3. exports exactly the single documented public function `runDiscussion`
//   4. `runDiscussion` is a function
//   5. `runDiscussion` is async (AsyncFunction)
//   6. `runDiscussion` arity === 2 (res, options)
//   7. re-require returns the same cached export object
//
// It intentionally does NOT run a live discussion — that needs an LLM, the
// agent pool, and an SSE stream. Behavioural coverage belongs in integration
// tests; this guards only the module's public surface.
// ============================================================
'use strict';

const assert = require('node:assert');

let checks = 0;
function check(name, fn) {
  fn();
  checks++;
  console.log(`  ✓ ${name}`);
}

const mod = require('../routes/chat/discuss');

check('module loads without throwing', () => { assert.ok(mod); });
check('exports an object', () => { assert.strictEqual(typeof mod, 'object'); });
check('exports exactly { runDiscussion }', () => {
  assert.deepStrictEqual(Object.keys(mod).sort(), ['runDiscussion']);
});
check('runDiscussion is a function', () => {
  assert.strictEqual(typeof mod.runDiscussion, 'function');
});
check('runDiscussion is async', () => {
  assert.strictEqual(mod.runDiscussion.constructor.name, 'AsyncFunction');
});
check('runDiscussion arity === 2', () => {
  assert.strictEqual(mod.runDiscussion.length, 2);
});
check('re-require returns same export', () => {
  const again = require('../routes/chat/discuss');
  assert.strictEqual(again, mod);
});

console.log(`\n✅ test-discuss.js: ${checks} checks passed`);
