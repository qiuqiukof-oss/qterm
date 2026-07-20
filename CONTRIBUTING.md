# Contributing to Hesi

Thanks for your interest! This document explains how to set up the project and propose changes.

## Development Setup
1. Requirements: **Node.js >= 18**.
2. Install dependencies: `npm install`
3. (Optional) Build the frontend bundle: `npm run build` (uses esbuild).
4. Start the server: `npm start` → open <http://127.0.0.1:4264>

## Project Layout (quick)
- `server.js`, `routes/`, `ws/` — backend (Express + WebSocket + node-pty).
- `lib/` — shared helpers (`terminal-clean`, `cli-headless` descriptors, `env-filter`).
- `public/` — frontend (ES modules, bundled by esbuild into `bundle.js` / `lazy-bundle.js`).
- `cli-discovery.js` + `cli-registry.json` — CLI Agent registry.
- `mcp/` — Model Context Protocol server.
- `tray/` — optional desktop tray launcher (reuses the bundled portable Node).

## Before Opening a PR
- Run `npm run check:server` (syntax checks across the backend).
- Run `npm run build` to refresh `public/bundle.js` if you changed frontend code.
- Run `npm run lint` / `npm run format` to match the style.
- Keep `node/`, `data/`, `offline-cache/`, `.workbuddy/` out of commits (git-ignored).
- **Never commit secrets** (`.env`, `.mcp.json`). Only `.env.example` is tracked.

## Coding Style
- ESLint + Prettier are configured.
- Prefer small, focused commits with clear messages.

## Adding a CLI Agent
- Register it in `cli-registry.json`.
- If it needs non-TTY (headless) execution for discussions, add a descriptor in
  `lib/cli-headless.js` so the AI discussion coordinator can drive it without TUI pollution.

## License
By contributing, you agree your contributions are licensed under the MIT License.
