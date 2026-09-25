'use strict';
/**
 * metrics/guards.js — did the guard you installed actually stop the failure?
 *
 * Ported from ccflaky's relapse module. Tools that count failures exist, and
 * tools that install hooks exist; what nobody measures is whether the hook
 * worked. Without that, adding a rule feels like fixing — and on this machine
 * a rule that "had been written since the day before and never fired" is on
 * record. Measured the other way, a static PreToolUse check on
 * ScheduleWakeup took its failure rate from 29.8% (25/84) to 0.6% (1/176)
 * while calls doubled — so the drop was not "stopped using it".
 *
 * A guard is a line in ~/.agentanalytics/guards.json: {tool, since, signature?,
 * note?}. `guards` prints, for each, calls and failure rate before and after
 * `since`, and a verdict that refuses to call a thin sample a success.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { NAME } = require('../brand.js');
const Tools = require('./tools.js');

function confPath() {
  return process.env[`${NAME.toUpperCase()}_GUARDS`] || path.join(os.homedir(), `.${NAME}`, 'guards.json');
}
function readGuards(file) { try { const g = JSON.parse(fs.readFileSync(file || confPath(), 'utf8')); return Array.isArray(g) ? g : []; } catch (e) { return []; } }
function writeGuards(g, file) { const f = file || confPath(); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(g, null, 2) + '\n'); }

/** Every paired tool call as {t, agent, tool, ok, text}. */
function calls(sessions) {
  const out = [];
  for (const s of sessions) {
    const pending = new Map();
    for (const e of s.events) {
      if (e.kind === 'tool_call') {
        const rec = { t: e.t, agent: s.agent, tool: e.tool || 'unknown', ok: true, text: '' };
        out.push(rec);
        if (e.callId != null) pending.set(e.callId, rec);
      } else if (e.kind === 'tool_result' && e.callId != null) {
        const rec = pending.get(e.callId);
        pending.delete(e.callId);
        if (rec && e.ok === false) { rec.ok = false; rec.text = e.text || ''; }
      }
    }
  }
  return out;
}

/**
 * Failure rates before / after the cutoff for one tool. With `signature`,
 * only failures of that type count in the numerator; the denominator stays
 * the tool's calls, because calls cannot be attributed to a type.
 */
function ratesAround(events, { tool, signature, cutoffMs }) {
  const acc = { before: { calls: 0, errors: 0 }, after: { calls: 0, errors: 0 } };
  for (const e of events) {
    if (e.tool !== tool) continue;
    const bucket = e.t < cutoffMs ? acc.before : acc.after;
    bucket.calls++;
    if (e.ok) continue;
    if (signature && Tools.signatureOf(e.text) !== signature) continue;
    bucket.errors++;
  }
  const rate = (b) => (b.calls ? (b.errors / b.calls) * 100 : null);
  return { before: { ...acc.before, rate: rate(acc.before) }, after: { ...acc.after, rate: rate(acc.after) } };
}

/** The verdict. A thin sample says "not yet", never "fixed": zero out of three is not a result. */
function verdict(rates, opts = {}) {
  const minAfterCalls = opts.minAfterCalls != null ? opts.minAfterCalls : 20;
  const { before, after } = rates;
  if (before.calls === 0) return { verdict: 'no-baseline', note: 'no calls before the guard — nothing to compare against' };
  if (after.calls < minAfterCalls) return { verdict: 'insufficient', note: `only ${after.calls} call(s) since (need ${minAfterCalls}) — zero failures in a thin sample proves nothing` };
  const b = before.rate, a = after.rate;
  if (a === 0) return { verdict: 'fixed', note: `${b.toFixed(1)}% → 0% (0 of ${after.calls})` };
  if (a <= b / 2) return { verdict: 'improved', note: `${b.toFixed(1)}% → ${a.toFixed(1)}% (at least halved)` };
  if (a >= b) return { verdict: 'worse', note: `${b.toFixed(1)}% → ${a.toFixed(1)}% — the guard did not bite; the diagnosis may be wrong` };
  return { verdict: 'unchanged', note: `${b.toFixed(1)}% → ${a.toFixed(1)}% — within noise` };
}

/** Evaluate every registered guard against the sessions. */
function evaluate(guards, sessions, opts = {}) {
  const ev = calls(sessions);
  return guards.map((g) => {
    const cutoffMs = Date.parse(g.since);
    const rates = ratesAround(ev, { tool: g.tool, signature: g.signature, cutoffMs });
    return { ...g, rates, ...verdict(rates, opts) };
  });
}

module.exports = { confPath, readGuards, writeGuards, calls, ratesAround, verdict, evaluate };
