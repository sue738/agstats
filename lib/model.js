'use strict';
/**
 * model.js — the one shape every reader produces.
 *
 * Readers translate their native format into Session/Event and nothing else;
 * metrics consume Session/Event and never look at a native format. That is the
 * whole contract: adding an agent means adding a reader, not touching metrics.
 *
 * Event {
 *   t       ms since epoch (required)
 *   kind    'user' | 'assistant' | 'tool_call' | 'tool_result' | 'meta'
 *   end     ms — optional busy span [t, end] when the format records a turn's
 *           duration instead of a heartbeat of entries (Cursor). Hours unions
 *           it with the stamp-derived intervals.
 *   tool    tool name (tool_call / tool_result)
 *   callId  pairs a call with its result
 *   op      tool_call only — what the tool does, normalised across agents:
 *           'read' | 'write' | 'shell' | 'outbound' | 'other'
 *   input   tool_call only — {command?, path?}: the shell command (≤ 2000
 *           chars) or the file path the call touches. Nothing else is kept,
 *           so a million calls fit in memory.
 *   ok      tool_result only — did it succeed
 *   text    tool_result only, when ok is false — the error text (≤ 200 chars)
 *   model   assistant only, when the format says
 *   tokens  {in, out, cacheRead, cacheWrite} when the format says
 *   human   user only — true when a person typed it: not a tool-result turn,
 *           not a slash-command echo, not runtime-injected context, and not
 *           the prompt a headless run (`claude -p`, CI) was started with
 *   scripted  user only — that headless prompt; work, not dialogue
 *   chars   user/assistant — length of what was said (the text itself is not kept)
 *   ask     user only — 'status' | 'approve' | 'nudge' when a short human turn
 *           carried no new intent (see dialogue.js)
 *   fix     assistant only — the reply retracts a previous one (dialogue.js)
 *   injected  the runtime wrote it on the person's behalf (Claude's isMeta /
 *           isSidechain); counted as work, not as dialogue. On tool_call/
 *           tool_result it flags a subagent's own tool use, so a metric
 *           that wants "what did the main loop do" can filter on it —
 *           without it, a session with subagents looks ~4x busier
 *   command user only — the slash command a person typed (Claude's
 *           <command-name>), without the slash
 *   lines   tool_result only — {added, removed} when the format records the
 *           patch (Claude's structuredPatch)
 *   created tool_result only — the write found no file there before it
 *           (Claude's Write result type 'create'); absent = cannot tell
 *   sub     meta only — 'compact' when the session compacted its context
 * }
 *
 * Session also carries `entrypoint` ('cli' | 'sdk-cli' | 'github-action' |
 * 'unknown': who started it) and `autoSkills` ([{name, t}]: skills the runtime
 * ran on its own, one per session — Claude's attributionSkill).
 */

const KINDS = new Set(['user', 'assistant', 'tool_call', 'tool_result', 'meta']);
const OPS = new Set(['read', 'write', 'shell', 'outbound', 'other']);

/** Work-evidence kinds: the ones that prove the agent was doing something. */
const WORK_KINDS = new Set(['user', 'assistant', 'tool_call', 'tool_result']);

const MAX_COMMAND = 2000;
const MAX_TEXT = 200;

/**
 * Build a Session, sorting events by time and dropping malformed ones. Never
 * throws on bad input — a reader that hit garbage should still return what it
 * could parse (undercount, never invent).
 */
function session(o) {
  const events = [];
  for (const e of o.events || []) {
    if (!e || !Number.isFinite(e.t) || !KINDS.has(e.kind)) continue;
    if (e.end != null && !(Number.isFinite(e.end) && e.end >= e.t)) delete e.end;
    if (e.op != null && !OPS.has(e.op)) e.op = 'other';
    events.push(e);
  }
  events.sort((a, b) => a.t - b.t);
  return {
    agent: String(o.agent),
    // The id must be unique per agent: hours groups a session with its
    // subagents by it. A reader whose native id is shared (Gemini's a2a
    // server writes every file with the same sessionId) falls back to the
    // file, or 28,000 sessions merge into one 85-hour "longest run".
    id: String(o.id || o.file || ''),
    file: String(o.file || ''),
    project: String(o.project || ''),
    parentId: o.parentId == null ? null : String(o.parentId),
    // Written by a non-interactive caller (an a2a server, a cron job). Kept
    // and shown, but excluded from every metric unless asked for.
    automated: !!o.automated,
    entrypoint: o.entrypoint ? String(o.entrypoint) : 'unknown',
    autoSkills: Array.isArray(o.autoSkills) ? o.autoSkills : [],
    events,
  };
}

/**
 * Sorted, de-duplicated ms stamps of work evidence — the input to hours.
 * De-duplicated so a line that yields several events at one instant (an
 * assistant message plus its tool_use blocks) counts as one stamp, exactly
 * as cchours counts the line.
 */
function workStamps(s) {
  const out = [];
  let prev = null;
  for (const e of s.events) {
    if (!WORK_KINDS.has(e.kind) || e.t === prev) continue;
    out.push(e.t); prev = e.t;
  }
  return out; // events are already sorted
}

/** Explicit busy spans [t, end] the format recorded (Cursor turns). */
function workSpans(s) {
  const out = [];
  for (const e of s.events) if (WORK_KINDS.has(e.kind) && e.end != null && e.end > e.t) out.push([e.t, e.end]);
  return out;
}

/** Normalise a tool_call input down to what metrics need. */
function toolInput(o) {
  const out = {};
  if (o && typeof o.command === 'string' && o.command) out.command = o.command.slice(0, MAX_COMMAND);
  if (o && typeof o.path === 'string' && o.path) out.path = o.path;
  return out;
}

/** Error text for a failed tool_result, flattened and capped. */
function errorText(v) {
  let s = '';
  if (typeof v === 'string') s = v;
  else if (Array.isArray(v)) s = v.map((x) => (x && typeof x === 'object' && typeof x.text === 'string') ? x.text : (typeof x === 'string' ? x : '')).join(' ');
  else if (v && typeof v === 'object') { try { s = JSON.stringify(v); } catch (e) { s = ''; } }
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

/** Parse an ISO timestamp (or ms number) to ms, or null. */
function ms(iso) {
  if (iso == null) return null;
  if (typeof iso === 'number') return Number.isFinite(iso) ? iso : null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Local calendar day 'YYYY-MM-DD' of a ms timestamp. Every day label goes
 * through this: days are bucketed in local time (H.dayRange), and a label
 * from toISOString() names the UTC day instead — east of UTC, work done
 * before 9:00 in Tokyo was printed under the day before.
 */
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local 'YYYY-MM-DD HH:MM' of a ms timestamp. */
function minuteKey(ms) {
  const d = new Date(ms);
  return `${dayKey(ms)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** ISO 8601 with the local offset ('2026-09-20T00:00:00+09:00'): the same instant as toISOString(), readable as the local day. */
function localIso(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${dayKey(ms)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${sign}${pad2(Math.floor(Math.abs(off) / 60))}:${pad2(Math.abs(off) % 60)}`;
}

/** True when the file was modified at or after sinceMs (stat only; unreadable → false). */
function modifiedSince(file, sinceMs) {
  try { return require('fs').statSync(file).mtimeMs >= sinceMs; } catch (e) { return false; }
}

/** Parse one JSONL line, or null. */
function jsonLine(line) {
  if (!line) return null;
  try { return JSON.parse(line); } catch (e) { return null; }
}

module.exports = { KINDS, OPS, WORK_KINDS, MAX_COMMAND, MAX_TEXT, session, workStamps, workSpans, toolInput, errorText, modifiedSince, ms, jsonLine, dayKey, minuteKey, localIso };
