'use strict';
/**
 * readers/gemini.js — Gemini CLI chats.
 *
 *   ~/.gemini/tmp/<project>/chats/session-<stamp>-<id>.jsonl
 *
 * Line 1 is a header {sessionId, projectHash, startTime, lastUpdated, kind}.
 * Following lines are patches: {"$set": {"messages": [...]}} or
 * {"$push": {"messages": {...}}} — each message {id, timestamp, type, content,
 * toolCalls?}. `type` is 'user' or 'gemini'. Every message is work evidence.
 *
 * The same directory collects sessions written by non-interactive callers:
 * on the author's machine every one of 28,974 chat files carries
 * sessionId "a2a-server" and not one was typed by a person. Those are
 * flagged `automated` from the header alone (one line read, the rest of the
 * file skipped) and every metric leaves them out unless told otherwise.
 *
 * The older logs.json (an array of user messages with timestamps) is read too,
 * so history from before the chats/ layout still counts.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const M = require('../model.js');
const D = require('../dialogue.js');
const W = require('../wire.js');

const AGENT = 'gemini';

const READ = new Set(['read_file', 'read_many_files', 'list_directory', 'glob', 'search_file_content', 'google_web_search', 'web_fetch']);
const WRITE = new Set(['write_file', 'replace', 'edit']);

/** Header sessionIds that name a program, not a person. */
const AUTOMATED_IDS = /^(a2a-server|a2a|mcp|cron|batch|headless)/i;

function defaultDir() { return path.join(os.homedir(), '.gemini', 'tmp'); }

function listFiles(baseDir) {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(baseDir, { withFileTypes: true }); } catch (e) { return out; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const pdir = path.join(baseDir, p.name);
    const chats = path.join(pdir, 'chats');
    let files = [];
    try { files = fs.readdirSync(chats); } catch (e) { files = []; }
    for (const f of files) if (f.endsWith('.jsonl')) out.push({ file: path.join(chats, f), project: p.name, legacy: false });
    const legacy = path.join(pdir, 'logs.json');
    if (fs.existsSync(legacy)) out.push({ file: legacy, project: p.name, legacy: true });
  }
  return out;
}

function classify(name, args) {
  const n = String(name || '');
  const a = args && typeof args === 'object' ? args : {};
  if (n === 'run_shell_command') return { op: 'shell', input: M.toolInput({ command: a.command }) };
  if (WRITE.has(n)) return { op: 'write', input: M.toolInput({ path: a.file_path }) };
  if (READ.has(n)) return { op: 'read', input: {} };
  return { op: 'other', input: {} };
}

function messageEvents(m, events) {
  if (!m || typeof m !== 'object') return;
  const t = M.ms(m.timestamp);
  if (t == null) return;
  const kind = m.type === 'user' ? 'user' : 'assistant';
  const ev = { t, kind };
  const txt = Array.isArray(m.content) ? m.content.map((c) => (c && typeof c.text === 'string') ? c.text : '').join('\n') : String(m.content || m.message || '');
  if (kind === 'user') {
    if (/^\s*<session_context\b/.test(txt) || D.isSystemText(txt)) ev.injected = true;
    else { ev.human = true; ev.chars = txt.trim().length; const k = D.askKind(txt); if (k) ev.ask = k; }
  } else if (txt) { ev.chars = txt.length; if (D.isSelfFix(txt)) ev.fix = true; }
  events.push(ev);
  const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
  for (const c of calls) {
    if (!c || typeof c !== 'object') continue;
    const name = String(c.name || (c.request && c.request.name) || '');
    const callId = c.id || (c.request && c.request.callId);
    const args = c.args || (c.request && c.request.args);
    const cl = classify(name, args);
    events.push({ t, kind: 'tool_call', tool: name, callId, op: cl.op, input: cl.input });
    if (c.status || c.result !== undefined) {
      const ok = !(c.status === 'error' || c.status === 'failed');
      const r = { t, kind: 'tool_result', callId, ok };
      if (!ok) r.text = M.errorText(c.result || c.error || c.status);
      events.push(r);
    }
  }
}

/** Read just the header line (the first ~1 KB) — enough to know who wrote the file. */
function readHeader(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1024);
    const n = fs.readSync(fd, buf, 0, 1024, 0);
    const text = buf.toString('utf8', 0, n);
    const nl = text.indexOf('\n');
    return M.jsonLine(nl === -1 ? text : text.slice(0, nl));
  } catch (e) { return null; } finally { if (fd != null) fs.closeSync(fd); }
}

function isAutomated(header) {
  if (!header || typeof header.sessionId !== 'string') return false;
  return AUTOMATED_IDS.test(header.sessionId);
}

/**
 * @param {object} entry {file, project}
 * @param {{includeAutomated?: boolean}} opts — when false (default) an automated
 *   session is returned as a stub (header only, no events parsed) so it can be
 *   counted and shown without paying to read it.
 */
function parseChat(entry, opts = {}) {
  const header = readHeader(entry.file);
  const automated = isAutomated(header);
  const id = path.basename(entry.file, '.jsonl'); // unique; header.sessionId is not
  const events = [];
  const t0 = header ? M.ms(header.startTime) : null;
  if (t0 != null) events.push({ t: t0, kind: 'meta' });
  if (automated && !opts.includeAutomated) {
    return M.session({ agent: AGENT, id, file: entry.file, project: entry.project, parentId: null, automated, events });
  }
  let text;
  try { text = fs.readFileSync(entry.file, 'utf8'); } catch (e) { return null; }
  for (const line of text.split('\n')) {
    const e = M.jsonLine(line);
    if (!e) continue;
    if (typeof e.sessionId === 'string' && !e.$set && !e.$push) continue; // header, already read
    for (const op of ['$set', '$push']) {
      const patch = e[op];
      if (!patch || typeof patch !== 'object') continue;
      let msgs = patch.messages;
      if (msgs == null) continue;
      if (!Array.isArray(msgs)) msgs = [msgs];
      for (const m of msgs) messageEvents(m, events);
    }
  }
  return M.session({ agent: AGENT, id, file: entry.file, project: entry.project, parentId: null, automated, events });
}

function parseLegacy(entry) {
  let arr;
  try { arr = JSON.parse(fs.readFileSync(entry.file, 'utf8')); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  const bySession = new Map();
  for (const m of arr) {
    if (!m || typeof m !== 'object') continue;
    const sid = String(m.sessionId || 'legacy');
    if (!bySession.has(sid)) bySession.set(sid, []);
    messageEvents(m, bySession.get(sid));
  }
  const out = [];
  for (const [sid, events] of bySession) {
    out.push(M.session({ agent: AGENT, id: `${entry.file}#${sid}`, file: entry.file, project: entry.project, parentId: null, automated: AUTOMATED_IDS.test(sid), events }));
  }
  return out;
}

/** A message's text: a string, or the text parts of a list. */
function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x.text === 'string') ? x.text : (typeof x === 'string' ? x : '')).join('\n');
  return c == null ? '' : String(c);
}

/**
 * What each request of one chat sent (wire.js). `$set` replaces the message
 * list and `$push` appends to it, so the final list is rebuilt first and read
 * once — reading every patch would count a rewritten history twice.
 *
 * Usage: gemini-cli's chat recorder puts `tokens {input, output, cached,
 * thoughts, tool, total}` on a gemini message; `input` (promptTokenCount)
 * includes `cached`. No chat on the author's machine carries it (every one
 * there was written by the a2a server), so this follows the recorder's
 * format, not a sample — and a chat without it reads "not recorded". Gemini
 * reports no cache write.
 */
function sendsOfMessages(msgs, tally) {
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const t = M.ms(m.timestamp);
    if (m.type === 'user') {
      const txt = contentText(m.content != null ? m.content : m.message);
      if (/^\s*<session_context\b/.test(txt) || D.isSystemText(txt)) tally.add('injected', txt);
      else tally.prompt(tally.addUser(txt));
      continue;
    }
    if (m.type !== 'gemini') continue;
    const k = m.tokens;
    if (k && typeof k === 'object' && k.input > 0) {
      const cached = k.cached || 0;
      tally.request({ t, model: typeof m.model === 'string' ? m.model : '', sent: k.input, cacheRead: cached, uncached: Math.max(0, k.input - cached), out: k.output || 0 });
    }
    tally.add('assistantText', contentText(m.content));
    if (Array.isArray(m.thoughts)) tally.add('thinking', m.thoughts.map((x) => (x && typeof x === 'object') ? `${x.subject || ''} ${x.description || ''}` : String(x || '')).join('\n'));
    for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
      if (!c || typeof c !== 'object') continue;
      const args = c.args || (c.request && c.request.args);
      if (args != null) tally.add('toolInputs', typeof args === 'string' ? args : JSON.stringify(args));
      if (c.result != null) { tally.add('toolResults', typeof c.result === 'string' ? c.result : JSON.stringify(c.result)); tally.prompt(null); }
    }
  }
}

function readSends(opts = {}) {
  const dir = opts.dir || defaultDir();
  const sessions = [];
  const record = (id, file, project, msgs, automated) => {
    const tally = new W.Tally({ keepRequests: opts.keepRequests });
    sendsOfMessages(msgs, tally);
    let start = Infinity, end = -Infinity, model = '';
    for (const m of msgs) {
      const t = m && M.ms(m.timestamp);
      if (t != null) { if (t < start) start = t; if (t > end) end = t; }
      if (m && typeof m.model === 'string') model = m.model;
    }
    const s = { agent: AGENT, id, file, project, parentId: null, automated, start: Number.isFinite(start) ? start : null, end: Number.isFinite(end) ? end : null, model, ...tally.result() };
    if (!opts.match || s.id.startsWith(opts.match)) sessions.push(s);
  };
  for (const entry of listFiles(dir)) {
    if (opts.sinceMs && !M.modifiedSince(entry.file, opts.sinceMs)) continue;
    if (entry.legacy) {
      let arr;
      try { arr = JSON.parse(fs.readFileSync(entry.file, 'utf8')); } catch (e) { continue; }
      if (!Array.isArray(arr)) continue;
      const bySession = new Map();
      for (const m of arr) {
        if (!m || typeof m !== 'object') continue;
        const sid = String(m.sessionId || 'legacy');
        if (!bySession.has(sid)) bySession.set(sid, []);
        bySession.get(sid).push(m);
      }
      for (const [sid, msgs] of bySession) {
        const automated = AUTOMATED_IDS.test(sid);
        if (!automated || opts.includeAutomated) record(`${entry.file}#${sid}`, entry.file, entry.project, msgs, automated);
      }
      continue;
    }
    // an automated chat is known from its header and not read further, as in read()
    const header = readHeader(entry.file);
    const automated = isAutomated(header);
    if (automated && !opts.includeAutomated) continue;
    let text;
    try { text = fs.readFileSync(entry.file, 'utf8'); } catch (e) { continue; }
    let msgs = [];
    for (const line of text.split('\n')) {
      const e = M.jsonLine(line);
      if (!e) continue;
      if (e.$set && typeof e.$set === 'object' && Array.isArray(e.$set.messages)) msgs = e.$set.messages.slice();
      else if (e.$set && typeof e.$set === 'object' && e.$set.messages && typeof e.$set.messages === 'object') msgs.push(e.$set.messages);
      if (e.$push && typeof e.$push === 'object' && e.$push.messages != null) msgs.push(...(Array.isArray(e.$push.messages) ? e.$push.messages : [e.$push.messages]));
    }
    record(path.basename(entry.file, '.jsonl'), entry.file, entry.project, msgs, automated);
  }
  return { agent: AGENT, dir, sessions };
}

function read(opts = {}) {
  const dir = opts.dir || defaultDir();
  const sessions = [];
  for (const entry of listFiles(dir)) {
    if (opts.sinceMs && !M.modifiedSince(entry.file, opts.sinceMs)) continue;
    if (entry.legacy) { for (const s of parseLegacy(entry)) if (s.events.length) sessions.push(s); continue; }
    const s = parseChat(entry, opts);
    if (s && (s.events.length || s.automated)) sessions.push(s);
  }
  return { agent: AGENT, dir, sessions };
}

function detect(opts = {}) {
  const dir = opts.dir || defaultDir();
  try { return fs.statSync(dir).isDirectory(); } catch (e) { return false; }
}

function rawSources(opts = {}) {
  const dir = opts.dir || defaultDir();
  return listFiles(dir).map((e) => ({ file: e.file, project: e.project, scrubbable: !e.legacy }));
}

module.exports = { AGENT, AUTOMATED_IDS, defaultDir, listFiles, classify, readHeader, isAutomated, parseChat, parseLegacy, read, sendsOfMessages, readSends, detect, rawSources };
