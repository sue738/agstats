'use strict';
/**
 * metrics/timeline.js — a year of work, in the terminal.
 *
 * Ported from cctimeline. Not analytics — a picture: the weeks you were deep
 * in something, the weeks you weren't, the 3am sessions, the streak you
 * didn't know you had. Days are weighted by tokens where the agent records
 * them, otherwise by work stamps, so an agent that never reports usage
 * (Cursor) still shows up on the calendar.
 */
const M = require('../model.js');

const BLOCKS = ' ▁▂▃▄▅▆▇█';
const HEAT = ['·', '░', '▒', '▓', '█'];

function dayKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return dayKey(dt);
}

/** One sample per token-bearing event (or per work stamp when the agent has no usage). */
function samplesOf(sessions, from = -Infinity, to = Infinity) {
  const out = [];
  for (const s of sessions) {
    let any = false;
    for (const e of s.events) {
      if (e.tokens && e.t >= from && e.t < to) {
        any = true;
        out.push({ ts: e.t, tokens: e.tokens.in + e.tokens.out + e.tokens.cacheRead + e.tokens.cacheWrite, session: s.id, project: s.project, agent: s.agent });
      }
    }
    if (!any) for (const t of M.workStamps(s)) if (t >= from && t < to) out.push({ ts: t, tokens: 0, stamp: 1, session: s.id, project: s.project, agent: s.agent });
  }
  return out;
}

/** Bucket samples into days: day → {tokens, stamps, sessions:Set, projects:Set} */
function byDay(samples) {
  const days = new Map();
  for (const s of samples || []) {
    const d = dayKey(new Date(s.ts));
    if (!days.has(d)) days.set(d, { tokens: 0, stamps: 0, sessions: new Set(), projects: new Set() });
    const b = days.get(d);
    b.tokens += s.tokens || 0; b.stamps += s.stamp || 0;
    if (s.session) b.sessions.add(s.session);
    if (s.project) b.projects.add(s.project);
  }
  return days;
}

/** A day's weight: tokens when any agent reported them, else work stamps. */
function weight(b) { return b ? (b.tokens || b.stamps) : 0; }

/**
 * A GitHub-style calendar: 7 rows (weekdays) × N columns (weeks), log scaled —
 * one enormous day would otherwise flatten a whole year.
 */
function calendar(days, endKey, weeks) {
  weeks = weeks || 26;
  const end = endKey || dayKey(new Date());
  const [ey, em, ed] = end.split('-').map(Number);
  const endDate = new Date(ey, em - 1, ed);
  const start = addDays(end, -(weeks * 7 + endDate.getDay()));
  const max = Math.max(...[...days.values()].map(weight), 1);
  const level = (v) => {
    if (!v) return 0;
    const t = Math.log10(v + 1) / Math.log10(max + 1);
    return Math.min(HEAT.length - 1, Math.max(1, Math.round(t * (HEAT.length - 1))));
  };
  const grid = [];
  for (let row = 0; row < 7; row++) {
    let line = '';
    for (let col = 0; col <= weeks; col++) {
      const key = addDays(start, col * 7 + row);
      if (key > end) { line += ' '; continue; }
      line += HEAT[level(weight(days.get(key)))];
    }
    grid.push(line);
  }
  return { grid, start, end, max };
}

function monthAxis(start, weeks) {
  let line = '';
  let lastMonth = null;
  for (let col = 0; col <= weeks; col++) {
    const key = addDays(start, col * 7);
    const m = key.slice(5, 7);
    if (m !== lastMonth) {
      const label = String(Number(m));
      if (line.length + label.length <= col) { line = line.padEnd(col, ' ') + label; lastMonth = m; }
    }
  }
  return line;
}

function hourBars(samples) {
  const hours = new Array(24).fill(0);
  for (const s of samples || []) hours[new Date(s.ts).getHours()] += (s.tokens || s.stamp || 0);
  const max = Math.max(...hours, 1);
  return hours.map((v) => BLOCKS[Math.min(BLOCKS.length - 1, Math.round((v / max) * (BLOCKS.length - 1)))]).join('');
}

/** Consecutive-day streaks. `today` is injectable for tests. */
function streaks(days, today) {
  const keys = [...days.keys()].sort();
  if (!keys.length) return { longest: 0, current: 0 };
  let longest = 1, run = 1;
  for (let i = 1; i < keys.length; i++) {
    run = addDays(keys[i - 1], 1) === keys[i] ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  const t = today || dayKey(new Date());
  let cur = days.has(t) ? t : (days.has(addDays(t, -1)) ? addDays(t, -1) : null);
  let current = 0;
  while (cur && days.has(cur)) { current++; cur = addDays(cur, -1); }
  return { longest, current };
}

module.exports = { HEAT, BLOCKS, dayKey, addDays, samplesOf, byDay, weight, calendar, monthAxis, hourBars, streaks };
