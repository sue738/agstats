'use strict';
/**
 * metrics/tools.js — which tools the agents use, and which ones silently fail.
 *
 * Ported from cctoolstat. A failing tool is invisible in normal use: the agent
 * retries, works around it, and you never learn that your test command errors
 * 40% of the time. This pairs every tool_call with its tool_result by callId
 * and counts what happened.
 *
 * Pairing is per session, so a result never attaches to a call from another
 * transcript. A result whose call was never seen counts under 'unknown'
 * rather than being dropped — a failure with no name is still a failure.
 */

/** Strip instance-specific bits (ids, numbers) so the same failure clusters. (verbatim from cctoolstat) */
function signatureOf(text) {
  const s = String(text || '');
  try {
    const j = JSON.parse(s);
    if (j && typeof j === 'object') {
      if (j.code) return String(j.code).slice(0, 100);
      if (j.name) return String(j.name).slice(0, 100);
    }
  } catch (e) { /* not JSON */ }
  const m = s.match(/"message"\s*:\s*"([^"]{0,120})/);
  const base = m ? m[1] : s;
  return base.slice(0, 100)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\d+/g, '<n>');
}

function cluster(errors) {
  const groups = new Map();
  for (const e of errors) {
    const sig = signatureOf(e.text);
    if (!groups.has(sig)) groups.set(sig, { signature: sig, count: 0, sample: String(e.text || '').slice(0, 200) });
    groups.get(sig).count++;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/**
 * Count calls and errors per (agent, tool) over [from, to).
 * A call is in the window by its own time; its error is charged to the call's
 * bucket even when the result landed after `to` (a call at 23:59 whose result
 * comes at 00:01 is one failed call, not one call and one orphan error).
 *
 * `scope: 'main'` (default, matches cctoolstat) drops calls a subagent made
 * on its own (Event.injected) — without it a session with subagents can
 * look ~4x busier than what the main loop actually did. `scope: 'both'`
 * counts everything.
 */
function summarize(sessions, from = -Infinity, to = Infinity, opts = {}) {
  const mainOnly = opts.scope !== 'both';
  const stats = new Map(); // key agent\0tool → {agent, tool, calls, errors}
  const errors = [];
  const bump = (agent, tool) => {
    const k = agent + '\0' + tool;
    if (!stats.has(k)) stats.set(k, { agent, tool, calls: 0, errors: 0 });
    return stats.get(k);
  };
  for (const s of sessions) {
    const pending = new Map();
    for (const e of s.events) {
      if (mainOnly && e.injected) continue;
      if (e.kind === 'tool_call') {
        const inWindow = e.t >= from && e.t < to;
        const tool = e.tool || 'unknown';
        if (inWindow) bump(s.agent, tool).calls++;
        if (e.callId != null) pending.set(e.callId, { tool, inWindow });
      } else if (e.kind === 'tool_result') {
        const p = e.callId != null ? pending.get(e.callId) : null;
        if (e.callId != null) pending.delete(e.callId);
        if (e.ok !== false) continue;
        const inWindow = p ? p.inWindow : (e.t >= from && e.t < to);
        if (!inWindow) continue;
        const tool = p ? p.tool : 'unknown';
        bump(s.agent, tool).errors++;
        errors.push({ agent: s.agent, tool, text: e.text || '' });
      }
    }
  }
  const rows = [...stats.values()].map((r) => ({ ...r, errorRate: r.calls ? +((r.errors / r.calls) * 100).toFixed(1) : 0 }))
    .sort((a, b) => b.calls - a.calls);
  const total = rows.reduce((a, r) => a + r.calls, 0);
  const totalErr = rows.reduce((a, r) => a + r.errors, 0);
  const byAgent = {};
  for (const r of rows) {
    const b = byAgent[r.agent] || (byAgent[r.agent] = { calls: 0, errors: 0 });
    b.calls += r.calls; b.errors += r.errors;
  }
  for (const a of Object.values(byAgent)) a.errorRate = a.calls ? +((a.errors / a.calls) * 100).toFixed(1) : 0;
  return { rows, total, totalErr, errorRate: total ? +((totalErr / total) * 100).toFixed(1) : 0, byAgent, errors };
}

/** Tools past the thresholds, each with its failures clustered by type. */
function suggest(summary, opts = {}) {
  const minCalls = opts.minCalls || 5;
  const minRate = opts.minRate || 20;
  const byTool = new Map();
  for (const e of summary.errors) {
    const k = e.agent + '\0' + e.tool;
    if (!byTool.has(k)) byTool.set(k, []);
    byTool.get(k).push(e);
  }
  return summary.rows
    .filter((r) => r.calls >= minCalls && r.errorRate >= minRate)
    .map((r) => ({ ...r, clusters: cluster(byTool.get(r.agent + '\0' + r.tool) || []) }))
    .sort((a, b) => b.errorRate - a.errorRate);
}

function bar(n, max, w) {
  const filled = max ? Math.round((n / max) * w) : 0;
  return '█'.repeat(filled) + '·'.repeat(Math.max(0, w - filled));
}

// ------------------------------------------------------------------ relapse (ported from ccflaky)
//
// A guard (a PreToolUse hook, a rule) only pays off when the failure is one
// cause and that cause is visible before the call. Order matters: quota and
// auth messages often contain "invalid", and calling them input errors would
// promise a guard that cannot work.

const INPUT_MARKERS = ['must be', 'invalid arguments', 'inputvalidationerror', 'validation_error', 'is required', 'unrecognized key', 'required parameter', 'expected ', 'did not match the expected schema', 'unexpected parameter'];
const QUOTA_MARKERS = ['tool call limit', 'rate limit', 'quota', 'upgrade your', 'too many requests'];
const AUTH_MARKERS = ['session expired', 'unauthorized', 'not authenticated', 'invalid token', 'forbidden'];
const STATE_MARKERS = ['does not match any elements', 'no such file', 'enoent', 'not found', 'could not resolve', 'timed out', 'timeout'];

/** What kind of failure a cluster is, and whether a guard before the call could stop it. */
function classifyFailure(cluster) {
  const t = String((cluster && (cluster.sample || cluster.signature)) || '').toLowerCase();
  const hit = (list) => list.find((m) => t.includes(m));
  let m;
  if ((m = hit(QUOTA_MARKERS))) return { kind: 'quota', guardable: false, marker: m };
  if ((m = hit(AUTH_MARKERS))) return { kind: 'auth', guardable: false, marker: m };
  if ((m = hit(STATE_MARKERS))) return { kind: 'state', guardable: false, marker: m };
  if ((m = hit(INPUT_MARKERS))) return { kind: 'input', guardable: true, marker: m };
  return { kind: 'unknown', guardable: false, marker: null };
}

/** Share of failures in the top cluster: a guard is worth it only when one cause dominates. */
function dominance(clusters) {
  const total = clusters.reduce((s, c) => s + c.count, 0);
  if (!total) return { total: 0, top: null, share: 0 };
  const top = clusters.reduce((a, b) => (b.count > a.count ? b : a));
  return { total, top, share: top.count / total };
}

/** Guard candidate: one cause ≥ minShare of failures, and that cause is an input error. */
function guardCandidate(tool, opts = {}) {
  const minShare = opts.minShare != null ? opts.minShare : 0.8;
  const d = dominance(tool.clusters || []);
  if (!d.top) return { candidate: false, dominance: d, reason: 'no failures' };
  const c = classifyFailure(d.top);
  if (d.share < minShare) return { candidate: false, dominance: d, classification: c, reason: `causes only ${(d.share * 100).toFixed(0)}% converged (need ${minShare * 100}%)` };
  if (!c.guardable) return { candidate: false, dominance: d, classification: c, reason: `${c.kind} failure — not visible before the call` };
  return { candidate: true, dominance: d, classification: c, reason: `input error ("${c.marker}") — a PreToolUse check can stop it` };
}

module.exports = { signatureOf, cluster, summarize, suggest, bar, classifyFailure, dominance, guardCandidate };
