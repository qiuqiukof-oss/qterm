#!/usr/bin/env bash
# ============================================================
# Hesi USB Agent Packager (macOS / Linux)
# Build a portable, offline-capable USB edition ONCE on a machine
# with internet access. Copy the resulting 'hesi' folder to a USB stick
# and run on air-gapped / GFW-affected machines.
#
# Strategy: download portable Node.js + pre-install agents into
# offline-cache/ so the end user's one-click install needs NO network.
# ============================================================
set -euo pipefail

NODE_VER="22.14.0"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/hesi"
NODE_DIR="$OUT/node"
CACHE="$OUT/offline-cache"

echo "[1/7] Preparing output directory: $OUT"
[ -d "$OUT" ] && { echo "  - existing hesi detected, removing stale build..."; rm -rf "$OUT"; }
mkdir -p "$OUT" "$NODE_DIR" "$CACHE"

echo "[2/7] Copying app source into $OUT ..."
for d in routes public lib scripts agents-src packaging; do
  [ -d "$ROOT/$d" ] && cp -R "$ROOT/$d" "$OUT/"
done
for f in server.js package.json package-lock.json .env.example README.md; do
  [ -f "$ROOT/$f" ] && cp "$ROOT/$f" "$OUT/"
done

echo "[3/7] Portable Node.js (${NODE_VER}) ..."
case "$(uname)" in
  Darwin) NODE_TAR="node-v${NODE_VER}-darwin-x64.tar.gz" ;;
  Linux)  NODE_TAR="node-v${NODE_VER}-linux-x64.tar.xz" ;;
  *) echo "Unsupported platform: $(uname)"; exit 1 ;;
esac
NODE_URL="https://nodejs.org/dist/v${NODE_VER}/${NODE_TAR}"
if [ -x "$NODE_DIR/bin/node" ]; then
  echo "  - already present, skip download"
else
  echo "  - downloading $NODE_URL"
  TMP="$(mktemp -d)"
  curl -fSL "$NODE_URL" -o "$TMP/$NODE_TAR"
  echo "  - extracting to $NODE_DIR"
  mkdir -p "$TMP/extract"
  tar -xf "$TMP/$NODE_TAR" -C "$TMP/extract" --strip-components=1
  cp -R "$TMP/extract/." "$NODE_DIR/"
  rm -rf "$TMP"
  chmod +x "$NODE_DIR/bin/node" 2>/dev/null || true
fi

echo "[4/7] Installing Hesi dependencies (portable npm) ..."
if [ -f "$OUT/package-lock.json" ]; then
  "$NODE_DIR/bin/npm" ci --prefix "$OUT" || "$NODE_DIR/bin/npm" install --prefix "$OUT"
else
  "$NODE_DIR/bin/npm" install --prefix "$OUT"
fi

echo "[5/7] Building frontend bundle (public/bundle.js) ..."
"$NODE_DIR/bin/npm" --prefix "$OUT" run build || echo "  - build failed, check esbuild"

echo "[6/7] Pre-installing agents into offline-cache (offline one-click later) ..."
"$NODE_DIR/bin/node" "$OUT/scripts/build-offline-cache.js" --out "$CACHE" --npm "$NODE_DIR/bin/npm"

echo "[7/7] Generating launcher scripts ..."
cat > "$OUT/start.sh" <<'EOF'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
export QCLI_PORTABLE="$DIR"
export PATH="$DIR/node/bin:$PATH"
"$DIR/node/bin/node" "$DIR/server.js"
EOF

cat > "$OUT/opencode.sh" <<'EOF'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
export QCLI_PORTABLE="$DIR"
export PATH="$DIR/node/bin:$PATH"
"$DIR/offline-cache/opencode/bin/opencode" "$@"
EOF

cat > "$OUT/oma.sh" <<'EOF'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
export QCLI_PORTABLE="$DIR"
export PATH="$DIR/node/bin:$PATH"
"$DIR/offline-cache/ohmyopenagent/bin/oma" "$@"
EOF

cat > "$OUT/codex.sh" <<'EOF'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
export QCLI_PORTABLE="$DIR"
export PATH="$DIR/node/bin:$PATH"
"$DIR/offline-cache/codex/bin/codex" "$@"
EOF
chmod +x "$OUT/start.sh" "$OUT/opencode.sh" "$OUT/oma.sh" "$OUT/codex.sh"

echo "[8/8] Copying config template ..."
[ -f "$OUT/.env" ] || [ -f "$ROOT/.env.example" ] && cp "$ROOT/.env.example" "$OUT/.env" 2>/dev/null || true

echo
echo "Done. Copy the entire '$OUT' folder to a USB stick."
echo "On the target machine, run ./start.sh (no sudo required)."
echo "Open http://127.0.0.1:4264 — the welcome page shows one-click install"
echo "that uses the offline-cache (no internet needed)."
