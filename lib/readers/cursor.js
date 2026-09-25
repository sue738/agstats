'use strict';
/**
 * readers/cursor.js — Cursor's agent/chat threads.
 *
 *   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb   (macOS)
 *   ~/.config/Cursor/User/globalStorage/state.vscdb                        (Linux)
 *   %APPDATA%/Cursor/User/globalStorage/state.vscdb                        (Windows)
 *
 * SQLite table `cursorDiskKV` (key TEXT, value BLOB/TEXT of JSON):
 *   composerData:<composerId>              one thread  {composerId, createdAt(ms), unifiedMode}
 *   bubbleId:<composerId>:<bubbleId>       one message {type: 1 user | 2 assistant,
 *                                          createdAt?(ISO), timingInfo?{clientRpcSendTime,
 *                                          clientEndTime}, toolFormerData?{name, params, status}}
 *
 * Cursor does not write a heartbeat of entries the way CLI agents do: a user
 * bubble carries the whole turn's span (rpc send → end), assistant bubbles
 * often carry no time at all. So the reader emits the span as `end` on the
 * user event and hours unions it in — otherwise a five-minute turn would read
 * as two lone stamps and count for nothing.
 *
 * Opened read-only through node:sqlite (Node ≥ 22.5). Never writes.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const M = require('../model.js');
const D = require('../dialogue.js');

const AGENT = 'cursor';

const READ = new Set(['read_file', 'list_dir', 'grep_search', 'codebase_search', 'file_search', 'web_search', 'fetch_rules', 'read_lints']);
const WRITE = new Set(['edit_file', 'search_replace', 'reapply', 'delete_file', 'create_file']);

function defaultDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage');
  return path.join(home, '.config', 'Cursor', 'User', 'globalStorage');
}

function dbPath(dir) { return path.join(dir, 'state.vscdb'); }

/** A stored value as text: TEXT comes back as string, BLOB as Uint8Array, and some rows are NULL. */
function valueText(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  try { return Buffer.from(v).toString('utf8'); } catch (e) { return null; }
}

function openDb(file) {
  let sqlite;
  try { sqlite = require('node:sqlite'); } catch (e) { return { error: 'node:sqlite is not available (Node ≥ 22.5 required)' }; }
  try { return { db: new sqlite.DatabaseSync(file, { readOnly: true }) }; } catch (e) { return { error: e.message }; }
}

function classify(name, params) {
  const n = String(name || '');
  let a = {};
  if (typeof params === 'string') { try { a = JSON.parse(params) || {}; } catch (e) { a = {}; } }
  else if (params && typeof params === 'object') a = params;
  if (n === 'run_terminal_cmd') return { op: 'shell', input: M.toolInput({ command: a.command }) };
  if (WRITE.has(n)) return { op: 'write', input: M.toolInput({ path: a.relativeWorkspacePath || a.target_file }) };
  if (READ.has(n)) return { op: 'read', input: {} };
  if (/^mcp/.test(n)) return { op: 'outbound', input: {} };
  return { op: 'other', input: {} };
}

/** Parse one bubble JSON into events. */
function bubbleEvents(b, events) {
  if (!b || typeof b !== 'object') return;
  const ti = b.timingInfo && typeof b.timingInfo === 'object' ? b.timingInfo : null;
  let t = M.ms(b.createdAt);
  if (t == null && ti) t = M.ms(ti.clientRpcSendTime);
  if (t == null) return; // no time, no evidence
  const kind = b.type === 1 ? 'user' : 'assistant';
  const ev = { t, kind };
  const txt = typeof b.text === 'string' ? b.text : '';
  if (b.type === 1) { ev.human = true; ev.chars = txt.trim().length; const k = D.askKind(txt); if (k) ev.ask = k; }
  else if (txt) { ev.chars = txt.length; if (D.isSelfFix(txt)) ev.fix = true; }
  if (ti) {
    const end = M.ms(ti.clientEndTime) || M.ms(ti.clientSettleTime);
    if (end != null && end > t) ev.end = end;
  }
  if (b.tokenCount && typeof b.tokenCount === 'object') {
    ev.tokens = { in: b.tokenCount.inputTokens || 0, out: b.tokenCount.outputTokens || 0, cacheRead: 0, cacheWrite: 0 };
  }
  events.push(ev);
  const tf = b.toolFormerData;
  if (tf && typeof tf === 'object' && tf.name) {
    const c = classify(tf.name, tf.params);
    const callId = tf.toolCallId || b.bubbleId;
    events.push({ t, kind: 'tool_call', tool: String(tf.name), callId, op: c.op, input: c.input });
    if (tf.status) {
      const ok = !/^(error|failed|cancelled)$/i.test(String(tf.status));
      const r = { t, kind: 'tool_result', callId, ok };
      if (!ok) r.text = M.errorText(tf.result || tf.status);
      events.push(r);
    }
  }
}

function read(opts = {}) {
  const dir = opts.dir || defaultDir();
  const file = dbPath(dir);
  const { db, error } = openDb(file);
  if (!db) return { agent: AGENT, dir, sessions: [], error };
  const sessions = [];
  try {
    const threads = new Map();
    for (const row of db.prepare("select key, value from cursorDiskKV where key like 'composerData:%'").all()) {
      const id = String(row.key).slice('composerData:'.length);
      let d = null;
      try { d = JSON.parse(valueText(row.value)); } catch (e) { d = null; }
      const events = [];
      const t = d ? M.ms(d.createdAt) : null;
      if (t != null) events.push({ t, kind: 'meta' });
      threads.set(id, { events, mode: d && d.unifiedMode });
    }
    for (const row of db.prepare("select key, value from cursorDiskKV where key like 'bubbleId:%'").all()) {
      const parts = String(row.key).split(':');
      const composer = parts[1];
      if (!composer) continue;
      let b = null;
      try { b = JSON.parse(valueText(row.value)); } catch (e) { b = null; }
      if (!threads.has(composer)) threads.set(composer, { events: [] });
      bubbleEvents(b, threads.get(composer).events);
    }
    for (const [id, th] of threads) {
      const s = M.session({ agent: AGENT, id, file: `${file}#${id}`, project: th.mode ? `cursor:${th.mode}` : 'cursor', parentId: null, events: th.events });
      if (s.events.length) sessions.push(s);
    }
  } finally {
    db.close();
  }
  return { agent: AGENT, dir, sessions };
}

function detect(opts = {}) {
  const dir = opts.dir || defaultDir();
  try { return fs.statSync(dbPath(dir)).isFile(); } catch (e) { return false; }
}

/**
 * Raw text for the secret scanner: every stored value. Not scrubbable — this
 * tool never writes to another program's database.
 */
function rawSources(opts = {}) {
  const dir = opts.dir || defaultDir();
  const file = dbPath(dir);
  return [{
    file, project: 'cursor', scrubbable: false,
    chunks() {
      const { db } = openDb(file);
      if (!db) return [];
      try {
        return db.prepare("select key, value from cursorDiskKV where key like 'bubbleId:%' or key like 'composerData:%'").all()
          .map((r) => valueText(r.value)).filter((t) => t != null);
      } finally { db.close(); }
    },
  }];
}

module.exports = { AGENT, defaultDir, dbPath, classify, bubbleEvents, read, detect, rawSources };
