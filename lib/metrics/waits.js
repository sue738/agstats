'use strict';
/**
 * metrics/waits.js — who waited for whom.
 *
 * `hours` drops every gap over 60 seconds as "not work". This metric picks
 * those gaps up and asks whose they were:
 *
 *   you waited     from a human turn to the agent's first entry after it —
 *                  the time you sat looking at a spinner
 *   agent waited   from the agent's last entry to your next human turn —
 *                  the time it sat waiting on you, capped at CAP_H hours
 *                  (past that you were not waiting, you had left)
 *   tool waited    from a tool call to its result when that took over
 *                  TOOL_WAIT_S — a permission prompt, or a slow tool; the
 *                  transcript cannot tell the two apart, so it is named for
 *                  what it is
 *
 * Main loop, human turns only — subagents and headless runs never wait on
 * a person.
 */
const CAP_H = 6;
const TOOL_WAIT_S = 60;

function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function blank() {
  return { youWaitedS: 0, youWaits: 0, youLongestS: 0, agentWaitedS: 0, agentWaits: 0, agentLongestS: 0, toolWaitedS: 0, toolWaits: 0, toolLongestS: 0 };
}

/**
 * Per-day (or per-agent with keyOf) waits over [from, to).
 */
function summarize(sessions, { from = -Infinity, to = Infinity, capH = CAP_H, toolWaitS = TOOL_WAIT_S, keyOf = dayKey } = {}) {
  const cap = capH * 3600000;
  const rows = new Map();
  const total = blank();
  const get = (k) => { if (!rows.has(k)) rows.set(k, blank()); return rows.get(k); };
  const add = (k, who, ms) => {
    const sec = ms / 1000;
    for (const r of [get(k), total]) {
      r[`${who}WaitedS`] += sec; r[`${who}Waits`] += 1;
      if (sec > r[`${who}LongestS`]) r[`${who}LongestS`] = sec;
    }
  };
  for (const s of sessions) {
    if (s.parentId != null || s.entrypoint === 'sdk-cli' || s.entrypoint === 'github-action' || s.automated) continue;
    const ev = s.events.filter((e) => e.kind !== 'meta');
    let seenHuman = false;
    let agentSince = null;         // t of the agent's last entry after the last human turn
    const pending = new Map();     // callId → t of the call
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      const inWindow = e.t >= from && e.t < to;
      if (e.kind === 'tool_call' && e.callId != null) pending.set(e.callId, e.t);
      if (e.kind === 'tool_result' && e.callId != null) {
        const t0 = pending.get(e.callId);
        pending.delete(e.callId);
        if (t0 != null && inWindow && e.t - t0 > toolWaitS * 1000 && e.t - t0 <= cap) add(keyOf(t0, s), 'tool', e.t - t0);
      }
      if (e.kind === 'user' && e.human) {
        if (agentSince != null && inWindow) {
          const gap = e.t - agentSince;
          if (gap > 0 && gap <= cap) add(keyOf(agentSince, s), 'agent', gap);
        }
        seenHuman = true; agentSince = null;
        const next = ev[i + 1];
        if (inWindow && next && next.t > e.t && next.t - e.t <= cap) add(keyOf(e.t, s), 'you', next.t - e.t);
      } else if (seenHuman) {
        agentSince = e.t;
      }
    }
  }
  const list = [...rows.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([key, r]) => ({ key, ...r }));
  return { rows: list, total };
}

module.exports = { CAP_H, TOOL_WAIT_S, dayKey, summarize };
