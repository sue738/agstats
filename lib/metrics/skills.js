'use strict';
/**
 * metrics/skills.js — which of your skills actually fire?
 *
 * Ported from ccskillstats. A skill only earns its place if something invokes
 * it, and "invoked" is written to the transcript in three unrelated shapes:
 *
 *   tool   the model calls the Skill tool        → the description matched
 *   typed  the person types /name                → they already knew the name
 *   auto   the runtime ran it on its own (Claude's attributionSkill, once per
 *          session — it tags every entry while the skill runs, so counting
 *          entries would be off by two orders of magnitude)
 *
 * Reading only the tool calls undercounts by 4× (measured). The name merely
 * appearing in a transcript is not a signal: the agent talks about skills,
 * greps for them, reads their SKILL.md.
 *
 * Only Claude Code records skill invocations today; the readers for other
 * agents emit none, so their rows are simply absent (not zero).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/** Built-in CLI commands: a typed name in this set is a command, not a skill. (verbatim from ccskillstats) */
const BUILTIN_COMMANDS = new Set([
  'model', 'login', 'logout', 'clear', 'compact', 'mcp', 'permissions', 'agents',
  'help', 'config', 'cost', 'doctor', 'status', 'resume', 'vim', 'terminal-setup',
  'bug', 'release-notes', 'pr-comments', 'add-dir', 'memory', 'export', 'hooks',
  'ide', 'install-github-app', 'migrate-installer', 'upgrade', 'privacy-settings',
  'rewind', 'usage', 'context', 'todos', 'output-style', 'sandbox', 'statusline',
  'feedback', 'rename', 'worktree', 'fast', 'plan', 'exit', 'quit',
]);

const SKILL_ROOTS = [
  path.join(os.homedir(), '.claude', 'skills'),
  path.join(os.homedir(), '.claude', 'plugins'),
];

// Cloud-synced user folders can block readdirSync indefinitely (iCloud
// "Desktop & Documents"); checkouts never live there. Skipped on purpose.
const SKIP_HOME_SUBDIRS = new Set(['Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures', 'Public', 'Dropbox', 'OneDrive', 'Google Drive', 'Box', 'iCloud Drive']);

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => path.join(dir, e.name));
  } catch (e) { return []; }
}

function walk(dir, test, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === 'node_modules' || e.name === '.git') continue; walk(full, test, out); }
    else if (e.isFile() && test(e.name)) out.push(full);
  }
  return out;
}

/**
 * Skill names on disk: every cwd the sessions ran in (exact, any machine),
 * plus checkouts one and two levels under home. Used only to answer "installed
 * and never fired" — never to decide whether an invocation counts.
 */
function installedSkills(sessions, extraRoots = []) {
  const roots = new Set(SKILL_ROOTS.concat(extraRoots));
  for (const s of sessions) if (s.project && s.project.startsWith('/')) roots.add(path.join(s.project, '.claude', 'skills'));
  const home = os.homedir();
  let homeDev = null;
  try { homeDev = fs.statSync(home).dev; } catch (e) { homeDev = null; }
  for (const lvl1 of subdirs(home)) {
    if (SKIP_HOME_SUBDIRS.has(path.basename(lvl1))) continue;
    try { if (homeDev !== null && fs.statSync(lvl1).dev !== homeDev) continue; } catch (e) { continue; }
    roots.add(path.join(lvl1, '.claude', 'skills'));
    for (const lvl2 of subdirs(lvl1)) roots.add(path.join(lvl2, '.claude', 'skills'));
  }
  const names = new Set();
  for (const root of roots) for (const f of walk(root, (n) => n === 'SKILL.md')) names.add(path.basename(path.dirname(f)));
  return names;
}

/** Every invocation across sessions: [{name, source, t, entrypoint, agent}]. */
function invocations(sessions) {
  const out = [];
  for (const s of sessions) {
    const ep = s.entrypoint || 'unknown';
    for (const e of s.events) {
      if (e.kind === 'tool_call' && e.input && e.input.skill) out.push({ name: e.input.skill, source: 'tool', t: e.t, entrypoint: ep, agent: s.agent });
      else if (e.kind === 'user' && e.command) out.push({ name: e.command, source: 'typed', t: e.t, entrypoint: ep, agent: s.agent });
    }
    for (const a of s.autoSkills || []) out.push({ name: a.name, source: 'auto', t: a.t, entrypoint: ep, agent: s.agent });
  }
  return out;
}

/** Roll invocations up per name over [from, to). */
function summarize(invs, known, { from = -Infinity, to = Infinity } = {}) {
  const rows = new Map();
  for (const iv of invs) {
    if (iv.t < from || iv.t >= to) continue;
    let r = rows.get(iv.name);
    if (!r) {
      r = { name: iv.name, tool: 0, typed: 0, auto: 0, total: 0, interactive: 0, headless: 0, ci: 0, firstMs: null, lastMs: null, onDisk: known.has(iv.name), isCommand: false };
      rows.set(iv.name, r);
    }
    r[iv.source]++; r.total++;
    if (iv.entrypoint === 'sdk-cli') r.headless++; else if (iv.entrypoint === 'github-action') r.ci++; else r.interactive++;
    if (r.firstMs === null || iv.t < r.firstMs) r.firstMs = iv.t;
    if (r.lastMs === null || iv.t > r.lastMs) r.lastMs = iv.t;
  }
  // A Skill tool_use is by definition a skill; only the typed side is ambiguous.
  for (const r of rows.values()) r.isCommand = r.tool === 0 && r.auto === 0 && BUILTIN_COMMANDS.has(r.name);
  return [...rows.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/** Installed skills with no invocation at all — the point of the exercise. */
function neverFired(rows, known) {
  const fired = new Set(rows.filter((r) => r.total > 0).map((r) => r.name));
  return [...known].filter((n) => !fired.has(n)).sort();
}

module.exports = { BUILTIN_COMMANDS, SKILL_ROOTS, SKIP_HOME_SUBDIRS, installedSkills, invocations, summarize, neverFired };
