'use strict';
/**
 * metrics/blast.js — what did the agents do that you cannot take back?
 *
 * Ported from ccblast. Everyone is building gates: policy engines, approval
 * layers, permission prompts. Nobody measures what already happened. This
 * gates nothing. It reads the transcripts the agents already wrote and
 * answers one question:
 *
 *     Of everything the agents did, how much escaped your safety net?
 *
 * The distinction that makes the number honest is the safety net itself.
 * Counting "irreversible operations" naively gives tens of thousands and means
 * nothing: a file edit inside a git repo is undone with one checkout. What
 * matters is the small set of actions that no local safety net can undo — a
 * push to a remote, a publish, a message someone already read, a file written
 * where nothing tracks it.
 *
 * Agent-agnostic through the reader's `op` (read/write/shell/outbound/other)
 * and `input` ({command, path}); the rules below never look at a tool name.
 */
const fs = require('fs');
const path = require('path');
const { dayKey } = require('../model.js');

const DAY_MS = 86400000;

/**
 * Shell commands whose effect no local safety net undoes. Ordered by how the
 * result reads to a human, not by regex convenience. The first match wins, so
 * the more severe reading of the same command comes first: `git push --force`
 * is a history rewrite, not an ordinary push. (from ccblast)
 *
 * Each rule is anchored to the start of one simple command (see
 * `simpleCommands`): `grep -rn "npm publish" docs/` searches for a publish,
 * it does not do one. Matching anywhere in the string counted those.
 */
const ESCAPED_COMMANDS = [
  { key: 'force', label: 'rewrote published history', re: /^git\s+push\b.*\s--force|^git\s+(filter-branch|reset\s+--hard)\b/ },
  { key: 'push', label: 'pushed to a remote', re: /^git\s+push\b/ },
  { key: 'publish', label: 'published a package', re: /^(npm|yarn|pnpm|cargo)\s+publish\b|^twine\s+upload\b|^gem\s+push\b/ },
  { key: 'repo', label: 'created or deleted a repository', re: /^gh\s+repo\s+(create|delete|archive)\b/ },
  { key: 'release', label: 'cut a release or a PR', re: /^gh\s+(release|pr)\s+(create|merge|delete)\b/ },
  { key: 'destroy', label: 'deleted recursively', re: /^rm\s+(.*\s)?(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)(\s|$)/ },
  // The verb is a whole word among the subcommand words before any flag.
  // `run` counts only for kubectl: in `gcloud run services list` it names
  // the product, not an action.
  { key: 'deploy', label: 'deployed or changed infrastructure', re: /^(gcloud|aws|az|kubectl|terraform|flyctl|vercel|netlify)((\s+[^\s-]\S*)*?)\s+(deploy|apply|create|delete|destroy|set|update)(\s|$)|^kubectl\s+run\s/ },
  { key: 'system', label: 'changed system configuration', re: /^(launchctl|systemsetup|systemctl)\b|^crontab\b(?!\s+-l\b)|^defaults\s+write\b/ },
  { key: 'network', label: 'wrote to a remote service', re: /^curl\b.*\s-X\s*['"]?(POST|PUT|PATCH|DELETE|post|put|patch|delete)\b|^curl\b.*\s(--data(-[a-z]+)?|-d|-F|--form)(\s|=|$)|^wget\b.*\s--post/ },
  { key: 'install', label: 'installed globally', re: /^(npm|pnpm|yarn)\s+(i|install|add)\b.*\s(-g|--global)\b|^brew\s+(install|uninstall)\b|^pip3?\s+install\b/ },
];

/** Words that run the command after them (`sudo git push`) and shell keywords that precede one. */
const PREFIX = /^(sudo(\s+-\S+)*|env|nohup|time|exec|command|builtin|xargs(\s+-\S+)*|timeout(\s+-\S+)*\s+\d\S*|then|else|do|if|while|until|!|[A-Za-z_][A-Za-z0-9_]*=('[^']*'|"[^"]*"|\S*))\s+/;

/**
 * Split a command line into its simple commands: on `&&`, `||`, `;`, `|`,
 * `&`, newlines, parentheses and backticks — outside quotes only, so
 * `echo "a; curl -X POST x"` stays one echo. Leading prefixes (`sudo`, `env`,
 * `VAR=1`, `then`) and the program's directory are dropped so each piece
 * starts at the name of the program it runs.
 * A heredoc body is data, not commands, and is skipped whole — an
 * apostrophe inside one would otherwise flip the quoting for the rest of the
 * line. Quoted text is never searched: a `bash -c "git push"` goes uncounted, which
 * undercounts rather than invents.
 */
function simpleCommands(cmd) {
  const out = [];
  let cur = '', q = null, heredoc = null;
  const flush = () => {
    let s = cur.trim();
    for (let prev = null; s && s !== prev;) { prev = s; s = s.replace(PREFIX, ''); }
    s = s.replace(/^[^\s'"]*\//, ''); // /usr/local/bin/gcloud → gcloud
    if (s) out.push(s);
    cur = '';
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) { if (ch === q) q = null; else if (ch === '\\' && q === '"') { cur += ch + (cmd[i + 1] || ''); i++; continue; } cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '\\') { cur += ch + (cmd[i + 1] || ''); i++; continue; }
    if (ch === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(cmd.slice(i));
      if (m) { heredoc = m[2]; i += m[0].length - 1; continue; }
    }
    if (ch === '\n' && heredoc) {
      // skip to the line that is exactly the delimiter (or to the end)
      const lines = cmd.slice(i + 1).split('\n');
      let k = 0, skip = 0;
      for (; k < lines.length && lines[k].trim() !== heredoc; k++) skip += lines[k].length + 1;
      i += skip + (k < lines.length ? lines[k].length + 1 : 0);
      heredoc = null;
      flush();
      continue;
    }
    if (';|&\n()`{}'.includes(ch)) { flush(); continue; }
    cur += ch;
  }
  flush();
  return out;
}

/** Temp roots whose contents nobody expects to keep. */
function tempRoots() {
  const roots = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/'];
  const t = process.env.TMPDIR;
  if (t && t.startsWith('/')) roots.push(t.endsWith('/') ? t : t + '/');
  return roots;
}

/**
 * True when every target of an `rm -rf` sits under a temp directory
 * (`/tmp/x`, `$TMPDIR/x`): deleting scratch is not a loss. A bare temp root
 * (`rm -rf /tmp`) is not scratch, and neither is anything relative.
 */
function rmTargetsEphemeral(simple) {
  const words = simple.split(/\s+/).slice(1).map((w) => w.replace(/^(['"])(.*)\1$/, '$2'));
  const targets = words.filter((w) => !w.startsWith('-'));
  if (!targets.length) return false;
  const roots = tempRoots();
  return targets.every((w) => {
    if (/^("?)\$\{?TMPDIR\}?\/[^/\s]/.test(w) || /^\$\{?TMPDIR\}?"?\/[^/\s]/.test(w)) return true;
    return roots.some((r) => w.startsWith(r) && w.length > r.length && !w.includes('/../'));
  });
}

/**
 * Where a write lands decides whether it can be undone. The test runs at
 * scan time, not at write time, so a path that no longer exists says nothing
 * about then: a removed worktree has lost its .git, and calling every old
 * write in it "escaped" would invent. Gone → unknown (undercount).
 */
function classifyPath(p, isTracked, exists = fs.existsSync) {
  if (!p) return 'unknown';
  if (/^\/(private\/)?(tmp|var\/folders)\//.test(p) || /\/scratchpad\//.test(p)) return 'ephemeral';
  if (isTracked(p)) return 'contained';
  return exists(p) ? 'escaped' : 'unknown';
}

/** Cached "is this path inside a git repo" — the safety-net test. */
function makeGitCheck() {
  const cache = new Map();
  return (file) => {
    let dir = path.dirname(file);
    const seen = [];
    while (dir && dir !== '/' && dir.length > 1) {
      if (cache.has(dir)) {
        const v = cache.get(dir);
        for (const d of seen) cache.set(d, v);
        return v;
      }
      seen.push(dir);
      let hit = false;
      try { hit = fs.existsSync(path.join(dir, '.git')); } catch (e) { hit = false; }
      if (hit) { for (const d of seen) cache.set(d, true); return true; }
      dir = path.dirname(dir);
    }
    for (const d of seen) cache.set(d, false);
    return false;
  };
}

/**
 * Classify one tool_call event.
 * @returns {{kind:'readonly'|'contained'|'ephemeral'|'escaped', key?:string, label?:string, detail?:string}}
 */
function classifyCall(e, isTracked, exists) {
  const input = e.input || {};
  if (e.op === 'read') return { kind: 'readonly' };
  if (e.op === 'outbound') return { kind: 'escaped', key: 'outbound', label: 'sent something outside this machine', detail: e.tool };
  if (e.op === 'write') {
    const p = input.path;
    const where = classifyPath(p, isTracked, exists);
    if (where === 'escaped') return { kind: 'escaped', key: 'untracked', label: 'wrote where nothing tracks it', detail: p };
    return { kind: where === 'ephemeral' ? 'ephemeral' : 'contained', detail: p };
  }
  if (e.op === 'shell') {
    const cmd = input.command || '';
    if (!cmd) return { kind: 'contained' };
    let scratch = false;
    for (const simple of simpleCommands(cmd)) {
      for (const rule of ESCAPED_COMMANDS) {
        if (!rule.re.test(simple)) continue;
        if (rule.key === 'destroy' && rmTargetsEphemeral(simple)) { scratch = true; break; }
        return { kind: 'escaped', key: rule.key, label: rule.label, detail: cmd.slice(0, 160) };
      }
    }
    return { kind: scratch ? 'ephemeral' : 'contained', detail: cmd.slice(0, 160) };
  }
  // Unknown tool: assume contained rather than inflate the headline number.
  return { kind: 'contained', detail: e.tool };
}

/**
 * Total it up over [from, to).
 * @param {Session[]} sessions
 */
function summarize(sessions, from = -Infinity, to = Infinity, opts = {}) {
  const isTracked = opts.isTracked || makeGitCheck();
  const exists = opts.exists || fs.existsSync;
  const totals = { actions: 0, readonly: 0, contained: 0, ephemeral: 0, escaped: 0 };
  const byKey = new Map();
  const samples = new Map();
  const byDay = new Map();
  const byAgent = {};
  let firstTs = null, lastTs = null;

  for (const s of sessions) {
    for (const e of s.events) {
      if (e.kind !== 'tool_call' || e.t < from || e.t >= to) continue;
      totals.actions++;
      if (!firstTs || e.t < firstTs) firstTs = e.t;
      if (!lastTs || e.t > lastTs) lastTs = e.t;
      const c = classifyCall(e, isTracked, exists);
      totals[c.kind]++;
      const a = byAgent[s.agent] || (byAgent[s.agent] = { actions: 0, readonly: 0, contained: 0, ephemeral: 0, escaped: 0 });
      a.actions++; a[c.kind]++;
      if (c.kind !== 'escaped') continue;
      byKey.set(c.key, (byKey.get(c.key) || 0) + 1);
      if (!samples.has(c.key)) samples.set(c.key, []);
      const arr = samples.get(c.key);
      if (arr.length < 3 && c.detail) arr.push({ detail: c.detail, ts: e.t, label: c.label, agent: s.agent });
      const day = dayKey(e.t);
      byDay.set(day, (byDay.get(day) || 0) + 1);
    }
  }
  const categories = [...byKey.entries()]
    .map(([key, count]) => ({ key, count, label: (samples.get(key) && samples.get(key)[0] && samples.get(key)[0].label) || key, samples: samples.get(key) || [] }))
    .sort((a, b) => b.count - a.count);
  for (const a of Object.values(byAgent)) {
    const n = a.contained + a.ephemeral;
    a.containment = n + a.escaped ? n / (n + a.escaped) : 1;
  }
  const netted = totals.contained + totals.ephemeral;
  return {
    ...totals,
    // The headline is not "you are reckless" — it is how much the net caught.
    containment: netted + totals.escaped ? netted / (netted + totals.escaped) : 1,
    categories,
    byAgent,
    busiestDay: [...byDay.entries()].sort((a, b) => b[1] - a[1])[0] || null,
    firstTs, lastTs,
    days: firstTs && lastTs ? Math.max(1, Math.round((lastTs - firstTs) / DAY_MS)) : 1,
  };
}

module.exports = { DAY_MS, ESCAPED_COMMANDS, simpleCommands, rmTargetsEphemeral, classifyPath, makeGitCheck, classifyCall, summarize };
