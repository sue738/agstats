'use strict';
/**
 * metrics/hours.js — how long did the agents actually work?
 *
 * Ported from cchours (playground-tools/apps/cchours/lib/hours.js) with one
 * change: the input is normalised Sessions from any reader instead of Claude
 * Code files. The arithmetic is identical on purpose — the parity test in
 * test/test.js holds this metric to cchours' numbers on the same transcripts.
 *
 * The measurement is deliberately conservative — an hour count is only
 * interesting if it is honest, and the easy mistakes all inflate it:
 *
 *  - A turn is NOT "user asked → assistant finished". That span includes every
 *    minute the agent sat blocked on a permission prompt. Measured on a real
 *    session: naive spans said 10.97h, actual work was 4.39h.
 *  - Instead we sum the gaps *between consecutive entries* and drop any gap
 *    longer than IDLE_GAP_S. While an agent is genuinely working it writes
 *    every few seconds (measured: median 3.4s, p95 42s), so a minute of silence
 *    means it stopped — waiting on you, or dead.
 *  - Within one agent, overlapping activity is never counted twice.
 *
 * Parallel agents DO add up: two agents working the same minute is two
 * agent-minutes. That is the whole point — it is what a human team costs.
 * Wall-clock time (the union across agents) is reported alongside so the two
 * are never confused.
 */
const M = require('../model.js');

const IDLE_GAP_S = 60;       // silence longer than this = the agent stopped working
const HOURS_PER_PERSON_DAY = 8;
const DAYS_PER_PERSON_MONTH = 20;

/**
 * Busy intervals from a sorted stamp list: consecutive stamps closer than
 * idleGapS belong to the same interval. A lone stamp has zero duration — we
 * credit no time we cannot see, rather than guessing a "typical" turn length.
 * @returns {Array<[number, number]>} [startMs, endMs]
 */
function busyIntervals(stamps, idleGapS = IDLE_GAP_S) {
  const gapMs = idleGapS * 1000;
  const out = [];
  let start = null, prev = null;
  for (const t of stamps) {
    if (prev === null) { start = prev = t; continue; }
    if (t - prev > gapMs) {
      if (prev > start) out.push([start, prev]);
      start = t;
    }
    prev = t;
  }
  if (prev !== null && prev > start) out.push([start, prev]);
  return out;
}

/** Total seconds covered, merging overlaps (union). */
function unionSeconds(intervals) {
  if (!intervals.length) return 0;
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  let total = 0, [cs, ce] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s > ce) { total += ce - cs; cs = s; ce = e; }
    else if (e > ce) ce = e;
  }
  total += ce - cs;
  return total / 1000;
}

/** Clip intervals to [from, to); drops anything outside. */
function clipIntervals(intervals, from, to) {
  const out = [];
  for (const [s, e] of intervals) {
    const cs = Math.max(s, from), ce = Math.min(e, to);
    if (ce > cs) out.push([cs, ce]);
  }
  return out;
}

/** Split a day's ms range in local time. */
function dayRange(date) {
  const s = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return [s, s + 86400000];
}

function personUnits(hours) {
  const personDays = hours / HOURS_PER_PERSON_DAY;
  return { personDays, personMonths: personDays / DAYS_PER_PERSON_MONTH };
}

/**
 * Sessions → per-agent busy intervals. One record per Session; `root` groups
 * a main session with the subagents it spawned (the unit one run happens in).
 */
/** Merge overlapping / touching intervals into a sorted disjoint list. */
function mergeIntervals(intervals) {
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) { if (iv[1] > last[1]) last[1] = iv[1]; }
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

/**
 * A format that records [start, end] instead of a heartbeat of entries
 * (Cursor) has the exact naive-span problem this file's own header warns
 * against: end - start includes every minute the agent sat blocked on a
 * permission prompt. Measured on real Cursor data: 19.6% of turns ran over
 * 60s, and those uncapped tails alone inflated agentHours 7.7x. Since a
 * span carries no finer heartbeat to bridge gaps in, it gets the same
 * treatment a silence longer than idleGapS gets everywhere else in this
 * file — stop trusting it. This undercounts a genuinely long single turn
 * (no way to tell it apart from a long wait without finer data), which is
 * the intended tradeoff: undercount, never invent.
 */
function capSpans(spans, idleGapS) {
  const capMs = idleGapS * 1000;
  return spans.map(([start, end]) => [start, Math.min(end, start + capMs)]);
}

function fromSessions(sessions, idleGapS = IDLE_GAP_S) {
  const agents = [];
  for (const s of sessions) {
    const stamps = M.workStamps(s);
    const spans = M.workSpans(s);
    if (stamps.length < 2 && !spans.length) continue;
    // Stamp-derived intervals (the cchours rule) unioned with the spans a
    // format recorded explicitly, each capped to idleGapS (see capSpans).
    // With no spans this is exactly cchours.
    const intervals = spans.length ? mergeIntervals(busyIntervals(stamps, idleGapS).concat(capSpans(spans, idleGapS))) : busyIntervals(stamps, idleGapS);
    if (!intervals.length) continue;
    agents.push({
      agent: s.agent,
      file: s.file,
      isSubagent: s.parentId != null,
      // The unit one run happens in: a session plus the subagents it spawned.
      root: `${s.agent}:${s.parentId != null ? s.parentId : (s.id || s.file)}`,
      project: s.project,
      intervals,
      seconds: unionSeconds(intervals),
      firstMs: intervals[0][0],
      lastMs: intervals[intervals.length - 1][1],
    });
  }
  return agents;
}

/**
 * Most agents alive at any one instant. Ends sort before starts at an equal
 * timestamp, so intervals that merely touch are not counted as overlapping.
 */
function peakConcurrent(intervals) {
  const edges = [];
  for (const [s, e] of intervals) { edges.push([s, 1]); edges.push([e, -1]); }
  edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let live = 0, peak = 0;
  for (const [, d] of edges) { live += d; if (live > peak) peak = live; }
  return peak;
}

/**
 * Aggregate agents over a window.
 * agentHours: parallel work adds up (the headline number).
 * wallHours:  union across all agents — real elapsed time you spent.
 */
function summarize(agents, from, to) {
  let agentSec = 0, mainSec = 0, subSec = 0, longestSec = 0;
  const all = [];
  const byRoot = new Map();
  const projects = {};
  const byAgent = {};
  let mainCount = 0, subCount = 0;
  for (const a of agents) {
    const clipped = clipIntervals(a.intervals, from, to);
    if (!clipped.length) continue;
    const sec = unionSeconds(clipped);
    agentSec += sec;
    if (a.isSubagent) { subSec += sec; subCount++; } else { mainSec += sec; mainCount++; }
    projects[a.project] = (projects[a.project] || 0) + sec;
    const ba = byAgent[a.agent] || (byAgent[a.agent] = { seconds: 0, intervals: [], count: 0 });
    ba.seconds += sec; ba.count++; ba.intervals.push(...clipped);
    all.push(...clipped);
    const root = a.root != null ? a.root : `#${byRoot.size}`;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(...clipped);
  }
  // The longest stretch belongs to one piece of work, so it is measured over a
  // session and the subagents it spawned — merged, because the main loop
  // waiting on a subagent is the agent working. Merging everything instead
  // would splice unrelated sessions that merely overlapped in time.
  for (const ivs of byRoot.values()) {
    const merged = [];
    for (const iv of ivs.sort((x, y) => x[0] - y[0])) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1] + IDLE_GAP_S * 1000) last[1] = Math.max(last[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }
    for (const [s, e] of merged) if ((e - s) / 1000 > longestSec) longestSec = (e - s) / 1000;
  }
  const peak = peakConcurrent(all);
  let peakSession = 0;
  for (const ivs of byRoot.values()) {
    const p = peakConcurrent(ivs);
    if (p > peakSession) peakSession = p;
  }
  const wallSec = unionSeconds(all);
  const agentHours = agentSec / 3600;
  return {
    agentHours,
    wallHours: wallSec / 3600,
    mainHours: mainSec / 3600,
    subagentHours: subSec / 3600,
    parallelism: wallSec ? agentSec / wallSec : 0,
    peakParallel: peak,
    peakParallelSession: peakSession,
    longestRunHours: longestSec / 3600,
    agentCount: mainCount + subCount,
    mainCount,
    subCount,
    projects: Object.entries(projects)
      .map(([name, sec]) => ({ name, hours: sec / 3600 }))
      .sort((a, b) => b.hours - a.hours),
    agents: Object.entries(byAgent)
      .map(([name, b]) => ({ name, hours: b.seconds / 3600, wallHours: unionSeconds(b.intervals) / 3600, count: b.count }))
      .sort((a, b) => b.hours - a.hours),
    ...personUnits(agentHours),
  };
}

/** Month key (local) for a ms timestamp. */
function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Per-month rollup. Reports observed days and a 30-day-normalised rate, because
 * a raw month total is unreadable when the month is partial — or when an
 * agent's own cleanup already ate the start of it.
 */
function byMonth(agents, now) {
  const buckets = {};
  for (const a of agents) {
    for (const iv of a.intervals) {
      const k = monthKey(iv[0]);
      (buckets[k] = buckets[k] || { intervals: [], sub: 0, main: 0 }).intervals.push(iv);
      const sec = (iv[1] - iv[0]) / 1000;
      if (a.isSubagent) buckets[k].sub += sec; else buckets[k].main += sec;
    }
  }
  return Object.keys(buckets).sort().map((k) => {
    const b = buckets[k];
    let agentSec = 0, longest = 0;
    for (const [s, e] of b.intervals) { agentSec += (e - s) / 1000; if ((e - s) / 1000 > longest) longest = (e - s) / 1000; }
    const first = Math.min(...b.intervals.map((x) => x[0]));
    const last = Math.max(...b.intervals.map((x) => x[1]));
    const observedDays = Math.max(1, (last - first) / 86400000);
    const hours = agentSec / 3600;
    const per30 = hours / observedDays * 30;
    return {
      month: k, hours,
      wallHours: unionSeconds(b.intervals) / 3600,
      mainHours: b.main / 3600,
      subagentHours: b.sub / 3600,
      observedDays,
      hoursPer30Days: per30,
      longestRunHours: longest / 3600,
      personMonthsPerMonth: per30 / (HOURS_PER_PERSON_DAY * DAYS_PER_PERSON_MONTH),
      partial: monthKey(now || Date.now()) === k,
    };
  });
}

/** Seconds of agent work per hour-of-day (0-23), local time. */
function byClockHour(agents, from, to) {
  const hours = new Array(24).fill(0);
  for (const a of agents) {
    for (const [s, e] of clipIntervals(a.intervals, from, to)) {
      let t = s;
      while (t < e) {
        const d = new Date(t);
        const nextHour = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
        const end = Math.min(e, nextHour);
        hours[d.getHours()] += (end - t) / 1000;
        t = end;
      }
    }
  }
  return hours;
}

/** Day × hour matrix of agent-seconds: grid[dayIndex][hour], day 0 = the day containing `from`. */
function byDayHour(agents, from, to) {
  const days = Math.max(1, Math.ceil((to - from) / 86400000));
  const grid = Array.from({ length: days }, () => new Array(24).fill(0));
  const day0 = dayRange(new Date(from))[0];
  for (const a of agents) {
    for (const [s, e] of clipIntervals(a.intervals, from, to)) {
      let t = s;
      while (t < e) {
        const d = new Date(t);
        const nextHour = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
        const end = Math.min(e, nextHour);
        const di = Math.floor((dayRange(d)[0] - day0) / 86400000);
        if (di >= 0 && di < days) grid[di][d.getHours()] += (end - t) / 1000;
        t = end;
      }
    }
  }
  return grid;
}

/** Share of work done between `startH` and `endH` (e.g. 0–6 = while you were asleep). */
function nightShare(clockHours, startH = 0, endH = 6) {
  const total = clockHours.reduce((a, b) => a + b, 0);
  if (!total) return { seconds: 0, share: 0 };
  let night = 0;
  for (let h = startH; h < endH; h++) night += clockHours[h];
  return { seconds: night, share: night / total };
}

module.exports = {
  IDLE_GAP_S, HOURS_PER_PERSON_DAY, DAYS_PER_PERSON_MONTH,
  busyIntervals, unionSeconds, clipIntervals, dayRange, personUnits,
  mergeIntervals, capSpans, fromSessions, peakConcurrent, summarize, monthKey, byMonth, byClockHour, byDayHour, nightShare,
};
