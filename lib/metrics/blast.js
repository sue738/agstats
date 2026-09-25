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

const DAY_MS = 86400000;

/**
 * Shell commands whose effect no local safety net undoes. Ordered by how the
 * result reads to a human, not by regex convenience. The first match wins, so
 * the more severe reading of the same command comes first: `git push --force`
 * is a history rewrite, not an ordinary push. (verbatim from ccblast)
 */
const ESCAPED_COMMANDS = [
  { key: 'force', label: 'rewrote published history', re: /\bgit\s+push\b[^|;]*--force|\bgit\s+(filter-branch|reset\s+--hard)\b/ },
  { key: 'push', label: 'pushed to a remote', re: /\bgit\s+push\b/ },
  { key: 'publish', label: 'published a package', re: /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b/ },
  { key: 'repo', label: 'created or deleted a repository', re: /\bgh\s+repo\s+(create|delete|archive)\b/ },
  { key: 'release', label: 'cut a release or a PR', re: /\bgh\s+(release|pr)\s+(create|merge|delete)\b/ },
  { key: 'destroy', label: 'deleted recursively', re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-rf|-fr)\b/ },
  { key: 'deploy', label: 'deployed or changed infrastructure', re: /\b(gcloud|aws|az|kubectl|terraform|flyctl|vercel|netlify)\s+\S*\s*(deploy|apply|create|delete|run|set|update)\b/ },
  { key: 'system', label: 'changed system configuration', re: /\blaunchctl\b|\bdefaults\s+write\b|\bsystemsetup\b|\bcrontab\b|\bsystemctl\b/ },
  { key: 'network', label: 'wrote to a remote service', re: /\bcurl\b[^|;]*-X\s*(POST|PUT|PATCH|DELETE)|\bcurl\b[^|;]*--data|\bwget\b[^|;]*--post/i },
  { key: 'install', label: 'installed globally', re: /\b(npm|pnpm|yarn)\s+(i|install|add)\b[^|;]*(-g|--global)|\bbrew\s+(install|uninstall)\b|\bpip3?\s+install\b/ },
];

/** Where a write lands decides whether it can be undone. */
function classifyPath(p, isTracked) {
  if (!p) return 'unknown';
  if (/^\/(private\/)?(tmp|var\/folders)\//.test(p) || /\/scratchpad\//.test(p)) return 'ephemeral';
  return isTracked(p) ? 'contained' : 'escaped';
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
function classifyCall(e, isTracked) {
  const input = e.input || {};
  if (e.op === 'read') return { kind: 'readonly' };
  if (e.op === 'outbound') return { kind: 'escaped', key: 'outbound', label: 'sent something outside this machine', detail: e.tool };
  if (e.op === 'write') {
    const p = input.path;
    const where = classifyPath(p, isTracked);
    if (where === 'escaped') return { kind: 'escaped', key: 'untracked', label: 'wrote where nothing tracks it', detail: p };
    return { kind: where === 'ephemeral' ? 'ephemeral' : 'contained', detail: p };
  }
  if (e.op === 'shell') {
    const cmd = input.command || '';
    if (!cmd) return { kind: 'contained' };
    for (const rule of ESCAPED_COMMANDS) {
      if (rule.re.test(cmd)) return { kind: 'escaped', key: rule.key, label: rule.label, detail: cmd.slice(0, 160) };
    }
    return { kind: 'contained', detail: cmd.slice(0, 160) };
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
      const c = classifyCall(e, isTracked);
      totals[c.kind]++;
      const a = byAgent[s.agent] || (byAgent[s.agent] = { actions: 0, readonly: 0, contained: 0, ephemeral: 0, escaped: 0 });
      a.actions++; a[c.kind]++;
      if (c.kind !== 'escaped') continue;
      byKey.set(c.key, (byKey.get(c.key) || 0) + 1);
      if (!samples.has(c.key)) samples.set(c.key, []);
      const arr = samples.get(c.key);
      if (arr.length < 3 && c.detail) arr.push({ detail: c.detail, ts: e.t, label: c.label, agent: s.agent });
      const day = new Date(e.t).toISOString().slice(0, 10);
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

module.exports = { DAY_MS, ESCAPED_COMMANDS, classifyPath, makeGitCheck, classifyCall, summarize };
