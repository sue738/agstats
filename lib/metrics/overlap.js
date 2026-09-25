'use strict';
/**
 * metrics/overlap.js — the same file written by two sessions close together.
 *
 * Running several agents on one checkout is normal now, and the failure mode
 * is quiet: session B edits a file session A is still mid-way through, one
 * of them commits the other's half-done change, and nothing says so until
 * the tests do. Every write carries a path and a time, so the collisions can
 * be listed instead of remembered.
 *
 * A collision = the same absolute path written by two different sessions
 * (any agent) within WINDOW_MIN minutes. Subagents count under their parent
 * session — a fan-out editing its own files is one session, not a collision.
 */
const WINDOW_MIN = 30;

/** Every write: {path, t, agent, session, tool} — session = the root session. */
function writes(sessions, from = -Infinity, to = Infinity) {
  const out = [];
  for (const s of sessions) {
    const root = s.parentId != null ? `${s.agent}:${s.parentId}` : `${s.agent}:${s.id}`;
    for (const e of s.events) {
      if (e.kind !== 'tool_call' || e.op !== 'write' || !e.input || !e.input.path) continue;
      if (e.t < from || e.t >= to) continue;
      out.push({ path: e.input.path, t: e.t, agent: s.agent, session: root, project: s.project, tool: e.tool });
    }
  }
  return out;
}

/**
 * Collisions grouped by file, worst first.
 * @returns {Array<{path, sessions: number, pairs: number, minGapMin, writes, examples: [{a, b, gapMin, t}]}>}
 */
function collisions(sessions, opts = {}) {
  const win = (opts.windowMin || WINDOW_MIN) * 60000;
  const byPath = new Map();
  for (const w of writes(sessions, opts.from, opts.to)) {
    if (!byPath.has(w.path)) byPath.set(w.path, []);
    byPath.get(w.path).push(w);
  }
  const out = [];
  for (const [p, ws] of byPath) {
    ws.sort((a, b) => a.t - b.t);
    const sessions = new Set(ws.map((w) => w.session));
    if (sessions.size < 2) continue;
    let pairs = 0, minGap = Infinity;
    const examples = [];
    // adjacent-in-time writes from different sessions inside the window
    for (let i = 1; i < ws.length; i++) {
      // look back over the window, not just the previous write
      for (let j = i - 1; j >= 0 && ws[i].t - ws[j].t <= win; j--) {
        if (ws[i].session === ws[j].session) continue;
        pairs++;
        const gap = ws[i].t - ws[j].t;
        if (gap < minGap) minGap = gap;
        if (examples.length < 3) examples.push({ a: ws[j], b: ws[i], gapMin: +(gap / 60000).toFixed(1), t: ws[i].t });
        break; // one pair per write is enough to count the write as colliding
      }
    }
    if (!pairs) continue;
    out.push({ path: p, sessions: sessions.size, pairs, minGapMin: +(minGap / 60000).toFixed(1), writes: ws.length, examples });
  }
  return out.sort((a, b) => b.pairs - a.pairs || a.minGapMin - b.minGapMin);
}

module.exports = { WINDOW_MIN, writes, collisions };
