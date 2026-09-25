'use strict';
/**
 * metrics/attention.js — how much of your attention did the agents consume?
 *
 * Ported from ccattention. Measuring an agent by its hours or tool count
 * misses what you actually pay: how many times you have to speak to get one
 * errand through. Measured on the author's machine over 14 days: 1,098
 * utterances for 177 errands — 6.2 per errand, and only 16% of them carried
 * a new intent. The rest were restating, correcting, nudging.
 *
 * So the headline is utterances per session-day (the errand unit: a session
 * a person actually spoke in, on that day — a time-gap threshold was tried
 * and it invented boundaries that were not there). The agent's own verbosity
 * (replies, characters) is secondary: if it drops but utterances per errand
 * do not, your load did not fall.
 *
 * Main loop, human turns only. Subagents never talk to you.
 */

const { dayKey } = require('../model.js');

function weekKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const dow = (d.getDay() + 6) % 7; // Monday-start
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
  return `${m.getFullYear()}-${p(m.getMonth() + 1)}-${p(m.getDate())}`;
}

function blank() {
  return { sessions: 0, you: 0, youChars: 0, agent: 0, agentChars: 0, status: 0, approve: 0, nudge: 0, bursts: 0, fixes: 0 };
}

/**
 * Per-period rows over [from, to). keyOf = dayKey | weekKey.
 * @returns {Array<{key, sessions, you, agent, perSession, youChars, agentChars, status, approve, nudge, bursts, fixes}>}
 */
function summarize(sessions, { from = -Infinity, to = Infinity, keyOf = dayKey } = {}) {
  const rows = new Map();
  const get = (k) => { if (!rows.has(k)) rows.set(k, blank()); return rows.get(k); };
  for (const s of sessions) {
    if (s.parentId != null) continue;
    const spokeOn = new Set();
    let run = 0;               // assistant replies since the last human turn
    let lastHumanKey = null;
    for (const e of s.events) {
      if (e.t < from || e.t >= to) continue;
      if (e.kind === 'user' && e.human) {
        const k = keyOf(e.t);
        const r = get(k);
        const dk = dayKey(e.t);
        if (!spokeOn.has(dk)) { spokeOn.add(dk); r.sessions++; }
        if (run >= 4 && lastHumanKey) get(lastHumanKey).bursts++;
        run = 0;
        lastHumanKey = k;
        r.you++; r.youChars += e.chars || 0;
        if (e.ask === 'status') r.status++; else if (e.ask === 'nudge') r.nudge++; else if (e.ask === 'approve') r.approve++;
      } else if (e.kind === 'assistant' && !e.injected && e.chars && lastHumanKey) {
        const r = get(lastHumanKey);
        r.agent++; r.agentChars += e.chars;
        if (e.fix) r.fixes++;
        run++;
      }
    }
  }
  return [...rows.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, r]) => ({
    key, ...r,
    perSession: r.sessions ? +(r.you / r.sessions).toFixed(1) : 0,
    newIntentShare: r.you ? +(((r.you - r.status - r.approve - r.nudge) / r.you) * 100).toFixed(0) : 0,
    fixShare: r.agent ? +((r.fixes / r.agent) * 100).toFixed(1) : 0,
  }));
}

module.exports = { dayKey, weekKey, summarize };
