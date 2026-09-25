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

module.exports = { AGENT, AUTOMATED_IDS, defaultDir, listFiles, classify, readHeader, isAutomated, parseChat, parseLegacy, read, detect, rawSources };
