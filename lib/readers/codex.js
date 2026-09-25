'use strict';
/**
 * readers/codex.js — OpenAI Codex CLI rollouts.
 *
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl
 *
 * Each line: {timestamp, ordinal, type, payload}. Types seen on disk:
 *   session_meta   {session_id, cwd, cli_version, originator}         → meta
 *   turn_context   {cwd, model, approval_policy, sandbox_policy}      → meta
 *   response_item  payload.type: message{role} | reasoning |
 *                  function_call{name, call_id, arguments} |
 *                  function_call_output{call_id, output} |
 *                  custom_tool_call{name, call_id, input} | custom_tool_call_output
 *   event_msg      payload.type: task_started | task_complete | item_completed |
 *                  token_count{info.last_token_usage} | turn_aborted …
 *
 * Work evidence: response_item only — the model's messages, reasoning, tool
 * calls and their outputs. That is the same footprint cchours counts for
 * Claude Code (whose user/assistant lines carry the tool calls and results).
 * event_msg (task_started, item_completed, token_count, turn_aborted …) and
 * session_meta / turn_context are the runtime's own bookkeeping and are
 * meta; measured on 1,008 rollouts they moved hours by under 1%, but counting
 * turn_aborted as work would be counting an interruption. Codex has no
 * subagent transcripts on disk (parentId is always null).
 *
 * Rollout replays duplicate lines: 15.7% of message payloads on the author's
 * machine repeat verbatim within one file. Tool calls are de-duplicated by
 * call_id and messages by their exact bytes, so counts stay honest.
 *
 * Tool names seen on disk (2025-09 → 2026-09): shell, exec_command, js,
 * update_plan, write_stdin, view_image, request_user_input_async, wait, and
 * the custom tools exec (a JS snippet calling tools.exec_command) and
 * apply_patch (a unified "*** Update File:" patch).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const M = require('../model.js');
const D = require('../dialogue.js');

const AGENT = 'codex';

function defaultDir() { return path.join(os.homedir(), '.codex', 'sessions'); }

function listFiles(baseDir) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(baseDir);
  return out;
}

function parseJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

/** function_call_output.output is a JSON string with {output, metadata:{exit_code}} for shell; other tools vary. */
function outputOk(payload) {
  const raw = payload.output;
  if (typeof raw !== 'string') return true;
  const o = parseJson(raw);
  if (o && o.metadata && typeof o.metadata.exit_code === 'number') return o.metadata.exit_code === 0;
  return !/^(error|Error|failed|Failed)\b/.test(raw);
}

function outputText(payload) {
  const raw = payload.output;
  const o = typeof raw === 'string' ? parseJson(raw) : null;
  return M.errorText(o && typeof o.output === 'string' ? o.output : raw);
}

/** First file path named in an apply_patch body, made absolute against cwd. */
function patchPath(input, cwd) {
  const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(String(input || ''));
  if (!m) return undefined;
  const p = m[1].trim();
  return path.isAbsolute(p) || !cwd ? p : path.join(cwd, p);
}

/** Normalise one call into op + input. */
function classify(name, args, cwd) {
  const n = String(name || '');
  const a = typeof args === 'string' ? (parseJson(args) || {}) : (args && typeof args === 'object' ? args : {});
  if (n === 'shell') {
    const c = Array.isArray(a.command) ? a.command.join(' ') : a.command;
    return { op: 'shell', input: M.toolInput({ command: typeof c === 'string' ? c : '' }) };
  }
  if (n === 'exec_command') return { op: 'shell', input: M.toolInput({ command: a.cmd }) };
  if (n === 'exec') {
    // custom tool: JS calling tools.exec_command({cmd:"..."}); pull the cmd string
    const m = /cmd\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(String(args || ''));
    return { op: 'shell', input: M.toolInput({ command: m ? m[1].replace(/\\"/g, '"') : '' }) };
  }
  if (n === 'apply_patch') return { op: 'write', input: M.toolInput({ path: patchPath(args, cwd) }) };
  if (n === 'view_image' || n === 'update_plan' || n === 'wait' || n === 'request_user_input_async') return { op: 'read', input: {} };
  return { op: 'other', input: {} };
}

function parseFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  const events = [];
  let id = path.basename(file, '.jsonl');
  let cwd = null, model = null, entrypoint = null;
  const seenCalls = new Set(), seenOutputs = new Set(), seenLines = new Set();
  for (const line of text.split('\n')) {
    const e = M.jsonLine(line);
    if (!e) continue;
    const t = M.ms(e.timestamp);
    if (t == null) continue;
    const p = e.payload && typeof e.payload === 'object' ? e.payload : {};
    if (e.type === 'response_item') {
      if ((p.type === 'function_call' || p.type === 'custom_tool_call') && p.call_id) {
        if (seenCalls.has(p.call_id)) continue; seenCalls.add(p.call_id);
      } else if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && p.call_id) {
        if (seenOutputs.has(p.call_id)) continue; seenOutputs.add(p.call_id);
      } else {
        const key = line.length > 4000 ? `${line.length}:${line.slice(0, 4000)}` : line;
        if (seenLines.has(key)) continue; seenLines.add(key);
      }
    }
    if (e.type === 'session_meta') {
      if (typeof p.session_id === 'string') id = p.session_id; else if (typeof p.id === 'string') id = p.id;
      if (typeof p.cwd === 'string') cwd = p.cwd;
      // originator / source seen on disk: "Codex Desktop"/vscode, codex_cli_rs/vscode,
      // codex-tui/cli, codex_exec/exec. Only exec is a program driving it.
      entrypoint = (p.originator === 'codex_exec' || p.source === 'exec') ? 'sdk-cli' : 'cli';
      events.push({ t, kind: 'meta' });
    } else if (e.type === 'turn_context') {
      if (!cwd && typeof p.cwd === 'string') cwd = p.cwd;
      if (typeof p.model === 'string') model = p.model;
      events.push({ t, kind: 'meta' });
    } else if (e.type === 'response_item') {
      if (p.type === 'message') {
        // developer / system messages are injected instructions, not work
        if (p.role !== 'user' && p.role !== 'assistant') { events.push({ t, kind: 'meta' }); continue; }
        const ev = { t, kind: p.role };
        if (p.role === 'assistant' && model) ev.model = model;
        const txt = Array.isArray(p.content) ? p.content.map((c) => (c && typeof c.text === 'string') ? c.text : '').join('\n') : String(p.content || '');
        if (p.role === 'user') {
          // the CLI injects <environment_context> / <user_instructions> as user
          // messages; Codex Desktop also carries Claude Code's runtime tags
          if (/^\s*<(environment_context|user_instructions|turn_aborted|permissions_instructions|recommended_plugins|in-app-browser-context)\b/.test(txt)
            || D.RUNTIME_TAG.test(txt.trimStart()) || D.isSystemText(txt)) ev.injected = true;
          else { ev.human = true; ev.chars = txt.trim().length; const k = D.askKind(txt); if (k) ev.ask = k; }
        } else if (txt) { ev.chars = txt.length; if (D.isSelfFix(txt)) ev.fix = true; }
        events.push(ev);
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        const c = classify(p.name, p.type === 'function_call' ? p.arguments : p.input, cwd);
        events.push({ t, kind: 'tool_call', tool: String(p.name || ''), callId: p.call_id, op: c.op, input: c.input });
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const ok = outputOk(p);
        const r = { t, kind: 'tool_result', callId: p.call_id, ok };
        if (!ok) r.text = outputText(p);
        events.push(r);
      } else {
        // reasoning etc.: the model was working
        events.push({ t, kind: 'assistant', model: model || undefined });
      }
    } else if (e.type === 'event_msg') {
      // runtime bookkeeping: not work evidence, but token_count carries the
      // usage figures, kept on the meta event for token metrics
      const ev = { t, kind: 'meta' };
      if (p.type === 'token_count' && p.info && p.info.last_token_usage) {
        const u = p.info.last_token_usage;
        ev.model = model || undefined;
        ev.tokens = {
          in: (u.input_tokens || 0) - (u.cached_input_tokens || 0), out: u.output_tokens || 0,
          cacheRead: u.cached_input_tokens || 0, cacheWrite: u.cache_write_input_tokens || 0,
        };
      }
      events.push(ev);
    } else {
      events.push({ t, kind: 'meta' });
    }
  }
  if (entrypoint === 'sdk-cli') for (const ev of events) if (ev.human) { delete ev.human; ev.scripted = true; }
  return M.session({ agent: AGENT, id, file, project: cwd || '', parentId: null, entrypoint: entrypoint || 'unknown', events });
}

function read(opts = {}) {
  const dir = opts.dir || defaultDir();
  const sessions = [];
  for (const f of listFiles(dir)) {
    if (opts.sinceMs && !M.modifiedSince(f, opts.sinceMs)) continue;
    const s = parseFile(f);
    if (s && s.events.length) sessions.push(s);
  }
  return { agent: AGENT, dir, sessions };
}

function detect(opts = {}) {
  const dir = opts.dir || defaultDir();
  try { return fs.statSync(dir).isDirectory(); } catch (e) { return false; }
}

function rawSources(opts = {}) {
  const dir = opts.dir || defaultDir();
  return listFiles(dir).map((file) => ({ file, project: path.relative(dir, file).split(path.sep).slice(0, 3).join('/'), scrubbable: true }));
}

module.exports = { AGENT, defaultDir, listFiles, classify, patchPath, parseFile, read, detect, rawSources };
