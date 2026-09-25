'use strict';
/**
 * metrics/stats.js — working habits, from the transcripts.
 *
 * Ported from ccstats. Not a cost report. It answers: when do I actually work
 * with the agents, how long are my sessions, how hard do I lean on tools, and
 * how much of the token bill is context being re-served.
 *
 * Dialogue counts are main-loop and human only: a prompt is a user event
 * with `human`, a reply is an assistant event that carried no tool call.
 * Subagent sessions are left out of the dialogue counts (they are the agent
 * talking to itself) but their tokens are counted — they are still spent.
 */

/** Short model family: claude-opus-5 → opus; anything else stays as written. */
function family(model) {
  const m = String(model || '');
  if (!m) return null;
  for (const fam of ['fable', 'opus', 'sonnet', 'haiku']) if (m.includes(fam)) return fam;
  return m;
}

function summarize(sessions, from = -Infinity, to = Infinity) {
  const acc = {
    sessions: 0, prompts: 0, replies: 0, toolCalls: 0,
    byHour: new Array(24).fill(0), byDow: new Array(7).fill(0),
    byProject: {}, byModel: {}, byAgent: {},
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    spans: [], compactions: 0, linesAdded: 0, linesRemoved: 0,
  };
  for (const s of sessions) {
    const a = acc.byAgent[s.agent] || (acc.byAgent[s.agent] = { sessions: 0, prompts: 0, replies: 0, toolCalls: 0, tokens: 0 });
    let first = null, last = null;
    let lastAssistant = null;
    const main = s.parentId == null;
    for (const e of s.events) {
      if (e.t < from || e.t >= to) continue;
      if (e.kind !== 'meta') { if (first === null) first = e.t; last = e.t; }
      // tokens ride on assistant events (Claude, Cursor) or on meta events
      // (Codex's token_count); both are spend
      if (e.tokens) {
        const t = e.tokens;
        acc.tokens.in += t.in; acc.tokens.out += t.out; acc.tokens.cacheRead += t.cacheRead; acc.tokens.cacheWrite += t.cacheWrite;
        const total = t.in + t.out + t.cacheRead + t.cacheWrite;
        acc.tokens.total += total; a.tokens += total;
        const f = family(e.model);
        if (f) acc.byModel[f] = (acc.byModel[f] || 0) + total;
      }
      if (e.kind === 'meta') { if (e.sub === 'compact' && main) acc.compactions++; }
      else if (e.kind === 'user') {
        if (main && e.human) {
          acc.prompts++; a.prompts++;
          const d = new Date(e.t);
          acc.byHour[d.getHours()]++; acc.byDow[d.getDay()]++;
          if (s.project) acc.byProject[s.project] = (acc.byProject[s.project] || 0) + 1;
        }
      } else if (e.kind === 'assistant') {
        if (main && !e.injected) { lastAssistant = e; lastAssistant._reply = true; }
      } else if (e.kind === 'tool_call') {
        if (main) { acc.toolCalls++; a.toolCalls++; }
        if (lastAssistant && lastAssistant.t === e.t) lastAssistant._reply = false;
      } else if (e.kind === 'tool_result' && e.lines) {
        acc.linesAdded += e.lines.added; acc.linesRemoved += e.lines.removed;
      }
    }
    // replies: assistant turns that carried no tool call (decided after the pass)
    for (const e of s.events) if (e.kind === 'assistant' && e._reply) { acc.replies++; a.replies++; delete e._reply; }
    for (const e of s.events) if (e._reply === false) delete e._reply;
    if (first !== null) { acc.sessions++; a.sessions++; if (last > first && main) acc.spans.push(last - first); }
  }
  // No prompts, no peak: indexOf(max of zeros) would report midnight on Sunday.
  const any = acc.byHour.some((x) => x > 0);
  const peakHour = any ? acc.byHour.indexOf(Math.max(...acc.byHour)) : null;
  const peakDow = any ? acc.byDow.indexOf(Math.max(...acc.byDow)) : null;
  const avgSessionMin = acc.spans.length ? Math.round(acc.spans.reduce((x, y) => x + y, 0) / acc.spans.length / 60000) : 0;
  return {
    sessions: acc.sessions, prompts: acc.prompts, replies: acc.replies, toolCalls: acc.toolCalls,
    toolsPerPrompt: acc.prompts ? +(acc.toolCalls / acc.prompts).toFixed(1) : 0,
    peakHour, peakDow, avgSessionMin,
    topProjects: Object.entries(acc.byProject).sort((x, y) => y[1] - x[1]).slice(0, 5),
    byModel: acc.byModel, byAgent: acc.byAgent, tokens: acc.tokens,
    cacheShare: acc.tokens.total ? +((acc.tokens.cacheRead / acc.tokens.total) * 100).toFixed(1) : 0,
    byHour: acc.byHour, byDow: acc.byDow, compactions: acc.compactions,
    lines: { added: acc.linesAdded, removed: acc.linesRemoved },
  };
}

function sparkline(values) {
  const bars = '▁▂▃▄▅▆▇█';
  const max = Math.max(...values, 1);
  return values.map((v) => bars[Math.min(bars.length - 1, Math.round((v / max) * (bars.length - 1)))]).join('');
}

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

module.exports = { family, summarize, sparkline, fmt };
