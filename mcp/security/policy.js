// ============================================================
// Policy — command and filesystem security policy engine
//
// Loads optional .cli-q-policy.json from project root or
// QCLI_POLICY_PATH. Provides:
// - Command allowlist/blocklist
// - Filesystem path sandbox
// - Session limits
// ============================================================
const fs = require("fs");
const path = require("path");
const config = require("../config");

// ── Default policy ──
// SECURITY: the engine defaults to `blocklist` mode with a curated set of
// destructive commands. Previously the default was `permissive` (allow-all),
// which meant the policy layer was effectively a no-op unless an operator
// hand-wrote a policy file. Now a fresh install blocks the most dangerous
// operations out of the box; operators can still opt into `permissive` or
// `allowlist` mode (or trim the blocklist) via .cli-q-policy.json.
//
// Blocklist entries are matched two ways:
//   1. Plain token  -> exact command name, or `command.startsWith(entry + ' ')`
//   2. /regex/ form -> `new RegExp(inner, 'i').test(command)` (substring match)
const DEFAULT_POLICY = {
  commands: {
    allowlist: [],
    blocklist: [
      // Disk / partition destruction
      'mkfs', 'mkfs.ext2', 'mkfs.ext3', 'mkfs.ext4', 'mkfs.xfs', 'mkfs.vfat', 'mkfs.ntfs',
      'dd', 'shred', 'wipefs', 'parted', 'fdisk', 'cfdisk', 'sfdisk', 'mkswap', 'swapon',
      // Power / init
      'shutdown', 'reboot', 'halt', 'poweroff', 'init',
      // Windows disk format
      'format',
      // Recursive forced deletes of root / wildcards / home
      '/^rm\\s+-rf\\s+\\//',
      '/^rm\\s+-rf\\s+\\*\\/?/',
      '/^rm\\s+-rf\\s+~\\/?/',
      // Raw device writes via redirection
      '/>\\s*\\/dev\\//',
      // Fork bomb
      '/:\\(\\)\\s*\\{.*\\};/',
      // World-unreadable chmod/chown -R 0
      '/^chmod\\s+-R\\s+0+\\s/',
      '/^chown\\s+-R\\s+0+\\s/',
    ],
    mode: "blocklist", // 'permissive' | 'allowlist' | 'blocklist'
  },
  filesystem: {
    allowedPaths: ["."],
    blockExtensions: [],
  },
  sessions: {
    maxSessions: config.maxSessions,
    sessionTtlMs: config.sessionTtlMs,
  },
};

/**
 * Match a single allow/block entry against a command string.
 * @param {string} entry — plain token or `/regex/` form
 * @param {string} command — full command string
 * @returns {boolean}
 */
function matchesEntry(entry, command) {
  if (entry.startsWith('/') && entry.endsWith('/') && entry.length > 2) {
    try {
      return new RegExp(entry.slice(1, -1), 'i').test(command);
    } catch {
      return false;
    }
  }
  const cmdName = command.trim().split(/\s+/)[0];
  return cmdName === entry || command === entry || command.startsWith(entry + ' ');
}

// ── AI-exec command blocklist (stricter than the terminal profile) ──
// Used by routes/tools.js and the AI terminal tool, where a (potentially
// autonomous) agent runs commands. These are destructive / reconnaissance /
// abuse patterns an AI should never be allowed to invoke, independent of the
// operator-customizable terminal policy. Entries use the same token and
// `/regex/` (with `(^|\s)` anchoring) forms as the terminal policy so the
// matching algorithm is shared via matchesEntry(). NOTE: regex entries must
// NOT include a trailing flag — matchesEntry() applies the 'i' flag itself
// and only recognizes `/.../` (not `/.../i`) as a regex.
const AI_EXEC_BLOCKLIST = [
  // File deletion / move / rename (any flags)
  '/(^|\\s)(rm\\s+-|rmdir\\s+|rd\\s+|del\\s+\\/|deltree\\s+)/',
  '/(^|\\s)(mv\\s+-[a-z]|ren\\s|rename\\s)/',
  'rm', 'rmdir', 'mv', 'del', 'rd', 'ren', 'rename',
  // Disk / partition
  '/(^|\\s)(format|diskpart|fdisk)\\b/',
  '/(^|\\s)cipher\\s+\\/w/',
  // Power / init
  '/(^|\\s)(shutdown|reboot|halt|poweroff|init\\s+(0|6))\\b/',
  // Windows privilege / registry / ownership
  '/(^|\\s)taskkill\\s+\\/f/',
  '/(^|\\s)reg\\s+(delete|add|import)\\s/',
  '/(^|\\s)(takeown|icacls|cacls|attrib)\\s/',
  // Unix destructive
  '/(^|\\s)dd\\s+if=/',
  '/(^|\\s)mkfs\\./',
  '/(^|\\s)chmod\\s+777/',
  '/(^|\\s)chown\\s/',
  '/(^|\\s)kill\\s+-9\\s/',
  '/(^|\\s)pkill\\s+-9/',
  // Network reconnaissance
  '/(^|\\s)(nmap|masscan|zmap)\\s/',
  // Cryptominer / suspicious downloads
  '/(^|\\s)wget\\s+.*(?:miner|coin|crypt)/',
  '/(^|\\s)curl\\s+.*(?:miner|coin|crypt)/',
];

let _policy = null;

/**
 * Load policy from disk. Falls back to defaults.
 *
 * NOTE: Reads QCLI_POLICY_PATH from process.env directly (not from
 * config.policyPath) so that tests can change the env var at runtime
 * and the policy engine picks it up correctly on each call to loadPolicy().
 */
function loadPolicy() {
  if (_policy) return _policy;

  const envPath = process.env.QCLI_POLICY_PATH;
  const policyPath = (envPath || config.policyPath) || path.join(process.cwd(), ".cli-q-policy.json");

  try {
    if (fs.existsSync(policyPath)) {
      const raw = fs.readFileSync(policyPath, "utf-8");
      const parsed = JSON.parse(raw);
      _policy = {
        ...DEFAULT_POLICY,
        ...parsed,
        commands: { ...DEFAULT_POLICY.commands, ...(parsed.commands || {}) },
        filesystem: { ...DEFAULT_POLICY.filesystem, ...(parsed.filesystem || {}) },
        sessions: { ...DEFAULT_POLICY.sessions, ...(parsed.sessions || {}) },
      };
      console.error(`[Policy] Loaded from ${policyPath}`);
      return _policy;
    }
  } catch (err) {
    console.error(`[Policy] Failed to load ${policyPath}: ${err.message}`);
  }

  _policy = { ...DEFAULT_POLICY };
  return _policy;
}

/**
 * Check if a command is allowed by policy.
 * @param {string} command - The full command string
 * @param {{ profile?: 'aiExec' }} [options] - 'aiExec' selects the stricter
 *        AI-agent blocklist (used by routes/tools.js and the AI terminal tool).
 *        Omit for the operator-customizable terminal policy.
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkCommand(command, options = {}) {
  const policy = loadPolicy();
  if (!policy.commands || policy.commands.mode === "permissive") {
    return { allowed: true };
  }

  // ── AI-exec profile: stricter, self-contained blocklist ──
  // Autonomous agents must never run destructive ops, regardless of the
  // terminal policy an operator configures.
  if (options && options.profile === "aiExec") {
    const trimmed = (command || "").trim();
    if (!trimmed) {
      return { allowed: false, reason: "Empty command" };
    }
    const blocked = AI_EXEC_BLOCKLIST.some((b) => matchesEntry(b, trimmed));
    if (blocked) {
      const cmdName = trimmed.split(/\s+/)[0];
      return { allowed: false, reason: `Command '${cmdName}' is blocked by AI-exec security policy` };
    }
    return { allowed: true };
  }

  const cmdName = command.trim().split(/\s+/)[0];

  if (policy.commands.mode === "allowlist") {
    const allowed = policy.commands.allowlist.some((a) => matchesEntry(a, command));
    if (!allowed) {
      return { allowed: false, reason: `Command '${cmdName}' is not in the allowlist` };
    }
  }

  if (policy.commands.mode === "blocklist") {
    const blocked = policy.commands.blocklist.some((b) => matchesEntry(b, command));
    if (blocked) {
      return { allowed: false, reason: `Command '${cmdName}' is blocked by security policy` };
    }
  }

  return { allowed: true };
}

/**
 * Check if a file path is allowed for read/write.
 * @param {string} filePath - Absolute or relative file path
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkFilePath(filePath) {
  const policy = loadPolicy();
  if (!policy.filesystem || policy.filesystem.allowedPaths.length === 0) {
    return { allowed: true };
  }

  const resolved = path.resolve(filePath);
  const projectRoot = process.cwd();

  // Must be within project root
  if (!resolved.startsWith(projectRoot)) {
    return { allowed: false, reason: `File '${filePath}' is outside the project root` };
  }

  // Check block extensions
  const ext = path.extname(resolved).toLowerCase();
  if (policy.filesystem.blockExtensions.includes(ext)) {
    return { allowed: false, reason: `File extension '${ext}' is blocked by policy` };
  }

  return { allowed: true };
}

/**
 * Reload policy from disk (for hot-reload).
 */
function reloadPolicy() {
  _policy = null;
  return loadPolicy();
}

// Initialize on load
loadPolicy();

module.exports = { checkCommand, checkFilePath, loadPolicy, reloadPolicy, matchesEntry };
