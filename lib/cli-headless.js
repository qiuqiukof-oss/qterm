// ============================================================
// CLI Headless Mode — non-TTY invocation descriptors
//
// Some CLI agents (e.g. opencode) are full-screen TUIs. When launched inside a
// PTY (a real TTY) they render ASCII-art / status frames, and that rendered
// chrome pollutes the text we feed back to the AI assistant during discussions
// (the "rendering problem"). We therefore prefer a *headless* invocation for
// these agents: spawn them through child_process (a pipe, NOT a TTY) so the TUI
// is never drawn.
//
// opencode's headless entry is `opencode run`. When invoked with NO positional
// message it reads the prompt from stdin — which cleanly handles multi-line
// prompts without any shell argv-quoting hazards (newlines would otherwise be
// re-tokenized by the shell).
//
// Descriptor shape:
//   { subcommand: string, useStdin?: boolean, args?: (prompt) => string[] }
//     - subcommand: headless subcommand (e.g. "run"); ignored if `args` given
//     - useStdin:   pipe the prompt to the child's stdin (recommended for
//                   multi-line prompts)
//     - args:       custom argv builder, e.g. (p) => ['-p', p]
// ============================================================

// Verified headless agents. Extend this map as others are confirmed.
const HEADLESS = {
  opencode: { subcommand: 'run', useStdin: true },
  // Well-known headless-capable agents (argv form, single-line prompts).
  // Uncomment / extend once verified in your environment:
  // aider:  { args: (p) => ['--message', p, '--no-auto-commits', '--yes'] },
  // claude: { args: (p) => ['-p', p] },
  // codex:  { args: (p) => ['exec', p] },
};

/**
 * Resolve the headless descriptor for a CLI registry entry.
 * @param {{id?:string, name?:string}} cliEntry
 * @returns {object|null}
 */
function getHeadlessDescriptor(cliEntry) {
  if (!cliEntry) return null;
  return HEADLESS[cliEntry.id] || HEADLESS[cliEntry.name] || null;
}

module.exports = { HEADLESS, getHeadlessDescriptor };
