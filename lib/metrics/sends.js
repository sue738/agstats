'use strict';
/**
 * sends — what each request actually sent. Port of ccsendstats' transcript
 * analysis; the records come from each reader's readSends() (lib/wire.js).
 *
 * Per session: the latest request's real total and its cache split, the
 * estimated breakdown of what the transcript shows, the invisible remainder
 * (system prompt, tool definitions — never written down), and what went out
 * before your first message. Across sessions, per agent: the same numbers as
 * medians, which is the comparison no single-agent tool can make.
 *
 * A format that records no usage yields null, and null prints as "not
 * recorded" — a missing figure never reads as zero.
 */

/** Median of a list of numbers (unsorted is fine), or null for none. */
/** Fewer sessions than this that recorded usage, and a row shows no medians: five sessions are an anecdote. */
const MIN_SESSIONS = 20;

function median(xs) {
  const v = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const share = (part, whole) => (part == null || !whole ? null : part / whole);

/** Cache split of one request (or of summed requests), as shares of what was sent — null parts were not recorded. */
function cacheSplit(r) {
  if (!r || r.sent == null) return null;
  return {
    read: share(r.cacheRead, r.sent), write: share(r.cacheWrite, r.sent), uncached: share(r.uncached, r.sent),
    // the write's 1h / 5m parts, as shares of the whole input (ccsendstats --cache)
    write1h: share(r.cacheWrite1h, r.sent), write5m: share(r.cacheWrite5m, r.sent),
  };
}

/**
 * One session's numbers, ccsendstats' analyze(): `baseline` is the first
 * request's real total less your first message's estimate; `invisible` is
 * the latest request's real total less what the transcript shows before it.
 */
function analyze(rec) {
  const last = rec.last, first = rec.first;
  // A reader that cannot say what one recorded figure covers sets
  // `breakdownNa` (its reason): the totals stay, but setting them against the
  // transcript — the category split, the invisible remainder, the overhead
  // before your first message — would compare unlike things, so none is made.
  const na = typeof rec.breakdownNa === 'string' && rec.breakdownNa ? rec.breakdownNa : null;
  const visible = na ? null : last ? rec.visibleAtLast : rec.visible;
  const invisible = !na && last ? Math.max(0, last.sent - visible.total) : null;
  const baseline = !na && first ? Math.max(0, first.sent - (rec.firstPrompt ? rec.firstPrompt.est : 0)) : null;
  return {
    agent: rec.agent, session: rec.id, project: rec.project, file: rec.file, archived: !!rec.archived,
    headless: !!rec.headless,
    model: (last && last.model) || rec.model || '',
    start: rec.start, end: rec.end,
    usage: rec.usage, requests: rec.requests, totalOnly: rec.totalOnly,
    last, first,
    cache: cacheSplit(last),
    breakdown: na ? 'n/a' : 'estimated', ...(na ? { breakdownNote: na } : {}),
    visible, invisible, invisibleShare: invisible != null ? share(invisible, last.sent) : null,
    baseline, firstPrompt: rec.firstPrompt,
    totals: { ...rec.sums, cache: cacheSplit(rec.sums) },
    ...(rec.list ? { list: rec.list } : {}),
  };
}

/** The latest session (by its last entry), optionally only those ending in [from, to). */
function latest(recs, from = -Infinity, to = Infinity) {
  let best = null;
  for (const r of recs) {
    if (r.end == null || r.end < from || r.end >= to) continue;
    if (!best || r.end > best.end) best = r;
  }
  return best;
}

/**
 * Per agent across the sessions that started in [from, to): how many, how
 * many recorded usage, and the medians — first-request overhead, invisible
 * share of the latest request, size of the latest request — plus the cache
 * mix over every request that recorded one. `found` is sendsAll()'s output,
 * so a missing agent stays "not installed".
 *
 * Interactive and headless sessions are separate rows (`mode`). A headless
 * run (`claude -p`, `codex exec`, CI) is typically one request: nothing but
 * overhead and a prompt, so its invisible share is near 100% — on the
 * author's machine those runs outnumber the interactive sessions and drove
 * Claude's median to 98%. The agent's own row is the interactive one; a
 * headless row follows only when there are headless sessions. A session
 * whose breakdown is n/a (Cursor) adds no invisible share or baseline, so
 * its medians are null, never zero.
 */
function compare(found, from = -Infinity, to = Infinity, { minSessions = MIN_SESSIONS } = {}) {
  const rows = [];
  for (const f of found) {
    if (!f.installed) { rows.push({ agent: f.agent, installed: false }); continue; }
    const all = f.sessions.filter((r) => r.start != null && r.start >= from && r.start < to).map(analyze);
    const heads = all.filter((s) => s.headless);
    rows.push(row(f.agent, 'interactive', all.filter((s) => !s.headless), minSessions));
    if (heads.length) rows.push(row(f.agent, 'headless', heads, minSessions));
  }
  return rows;
}

/** One row of compare(): the sessions `ss` of `agent` in one `mode`. */
function row(agent, mode, ss, minSessions = MIN_SESSIONS) {
  const rec = ss.filter((s) => s.usage === 'recorded');
  const sum = { sent: 0, cacheRead: null, cacheWrite: null, uncached: null, cacheWrite1h: null, cacheWrite5m: null };
  let splitSent = 0, ttlSent = 0;
  for (const s of rec) {
    const t = s.totals;
    if (t.cacheRead != null) {
      splitSent += t.sent;
      for (const k of ['cacheRead', 'cacheWrite', 'uncached']) if (t[k] != null) sum[k] = (sum[k] || 0) + t[k];
    }
    if (t.cacheWrite1h != null) {
      ttlSent += t.sent;
      sum.cacheWrite1h = (sum.cacheWrite1h || 0) + t.cacheWrite1h;
      sum.cacheWrite5m = (sum.cacheWrite5m || 0) + (t.cacheWrite5m || 0);
    }
    sum.sent += t.sent;
  }
  const na = rec.length > 0 && rec.every((s) => s.breakdown === 'n/a');
  const thin = rec.length > 0 && rec.length < minSessions;
  const med = (xs) => (thin ? null : median(xs));
  return {
    agent, mode, installed: true,
    sessions: ss.length, recorded: rec.length,
    totalOnly: ss.filter((s) => s.usage === 'total-only').length,
    notRecorded: ss.filter((s) => s.usage === 'none').length,
    requests: rec.reduce((a, s) => a + s.requests, 0),
    medianBaseline: med(rec.map((s) => s.baseline)),
    medianInvisibleShare: med(rec.map((s) => s.invisibleShare)),
    medianLastSent: med(rec.map((s) => s.last.sent)),
    medianFirstPromptEst: med(rec.map((s) => (s.firstPrompt ? s.firstPrompt.est : null))),
    sent: rec.length ? sum.sent : null,
    // shares of the input of the sessions that recorded each split
    cache: splitSent ? { read: share(sum.cacheRead, splitSent), write: share(sum.cacheWrite, splitSent), uncached: share(sum.uncached, splitSent) } : null,
    ttl: ttlSent ? { write1h: share(sum.cacheWrite1h, ttlSent), write5m: share(sum.cacheWrite5m, ttlSent) } : null,
    thin,
    breakdown: na ? 'n/a' : 'estimated', ...(na ? { breakdownNote: rec[0].breakdownNote } : {}),
  };
}

module.exports = { MIN_SESSIONS, median, cacheSplit, analyze, latest, compare, row };
