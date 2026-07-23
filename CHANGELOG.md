# Changelog

All notable changes to **Hesi（合思）** are documented here. This project follows
a lightweight [Keep a Changelog](https://keepachangelog.com/) convention; versions
use `vMAJOR.MINOR.PATCH-<tag>`.

---

## [v0.2.0] — 2026-07-23

Two headline features land on top of v0.1.0-optimized: the **cross-session long-term
memory subsystem** and the **Agnes AI plugin**.

### Added
- **Cross-session long-term memory subsystem** (`lib/memory/*`, `routes/memory/*`, `public/memory/*`)
  - Server-side per-session persistence in `data/memory/` — survives refresh / restart, no longer depends on browser `localStorage`
  - Auto summary compaction (`<session_summary>`) replacing naive truncation; degrades to raw history when the LLM is unavailable
  - BM25 recall injecting a `<memory>` block into the AI context (zero-dependency, local, offline)
  - Layer-A auto profile + facts (`profile.md` / `facts.json`), viewable and forgettable in the 🧠 memory drawer
  - Frontend: left-panel session list (new / resume / search / rename / delete), session recovery on refresh, soft-delete **trash / recycle bin**
  - Legacy `localStorage['qcli-chat-history']` auto-migrated into the first session; `scripts/memory-migrate.js` for offline import
  - Master kill-switch `HESI_MEMORY_ENABLED=0` — whole subsystem off, chat falls back to `localStorage`, zero behavior change
  - 25-case memory test suite (`test/memory-*.test.js`)
- **Agnes AI plugin** (`plugins/agnes-ai/`) — an in-panel workbench (chat / image / video / storyboard) wired through a Hesi backend proxy
  - API key stored **server-side** (`data/plugin-data/agnes-ai/config.json`), never exposed to the browser
  - CORS solved by the Node proxy; streaming (SSE) piped through transparently
  - **Zero new dependencies** — reuses Hesi's existing Node + express; no Python, no extra npm packages
  - Skills square shipped as an external link (skills.sh) in v0.2.0

### Changed
- `npm run check:server` now also syntax-checks `lib/memory/*` and `routes/memory/*`
- `package.json` `files` already includes `plugins/` — the plugin ships with the package

### Verification
- `npm test`: 92 pass / 0 fail (incl. 25 memory cases)
- `npm run check:server`: 0 errors
- Agnes plugin verified live: `/api/plugins` lists `agnes-ai`; proxy returns 400 until a key is configured; config + static assets served correctly

---

## [v0.1.0-optimized] — 2026-07-21

Optimization plan (Phase 0–4) landing: engineering health, local security, and
frontend governance — done without bloating monolithic files or introducing regressions.

### Added
- **Engineering health**
  - GitHub Actions CI (`build` + `node --test` + `plans/` regression) — `.github/workflows/ci.yml`
  - ESLint flat config (`eslint.config.js`), `no-undef` = error
  - husky pre-commit scaffold + `lint-staged` config
  - 9 unit tests: `access-auth`, `asset-hash`, `cli-headless`, `digital-employee-worker`, `escape`, `orchestrator-concurrency`, `rate-limiter`, `ring-buffer`, `terminal-clean`
  - `lib/asset-hash.js` — content hash for `bundle.js` / `lazy-bundle.js` (`?v=` cache-busting)
- **Feature gaps**
  - Digital-employee round-table now really executes — `ws/digital-employee-worker.js` (reuses `agentPool`, runs real tasks)
  - Headless completion — `lib/cli-headless.js` ships 4 verified descriptors (`opencode` / `claude` / `codex` / `aider`), all **stdin-injected, never concatenated into argv**; Windows `shell:true` re-tokenization covered by `test/cli-headless.test.js`
  - `ws/orchestrator.js` supports single-ws concurrent workflows (TUI preserved)
  - Tray / USB packaging scripts (`scripts/build-tray-exe.bat`, `scripts/package-usb.bat`)
- **Local security**
  - `localOriginGuard` in `server.js` — rejects non-loopback Origin state-changing requests (drive-by / CSRF defense for a `127.0.0.1` local tool)
  - `requireToken` hardened on `/api/tools/exec` and upload routes
- **Frontend governance**
  - Consolidated 17 duplicate `escapeHtml` definitions onto `public/escape.js` (single source of truth, attribute-safe, 5-char map)
  - AI API key moved out of `localStorage` → `sessionStorage` (`lib/storage.js` `makeSafeStore` factory; no code path re-persists the secret)
  - XSS scheme allowlist `safeImageUrl()` + field escaping in `multi-media.js` / `digital-employees.js`
- **Docs**
  - README / README_en / SECURE_DEPLOY / AGENTS / CLAUDE aligned to the local-run positioning; README_en synced with the headless + architecture-tree updates

### Changed
- Architecture tree in README reflects `digital-employee.js`, `digital-employee-worker.js`, `asset-hash.js`, and the concurrent orchestrator

### Deferred (P2)
- `window.QCLI` global-singleton convergence (~85 files reference it, ~40 assign it directly) — deferred as P2 due to init-order coupling risk. Planned incrementally: introduce a DI container, replace in batches, run the full test suite after each batch.

### Verification
- `npm test`: 66 pass / 0 fail
- `npm run lint`: 0 errors (pre-existing warnings are non-blocking)
- `npm run plans`: 2/2 pass
- `npm run build`: succeeded (bundle.js 875.5kb, lazy-bundle.js 237.3kb)

---

## Previous releases

Earlier tagged releases (`v1.0.0`, `v1.1.0`) are tracked on the
[GitHub Releases page](https://github.com/qiuqiukof-oss/Hesi/releases). This
`CHANGELOG.md` starts from the optimization drop above.
