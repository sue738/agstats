'use strict';
/**
 * readers/claude.js — Claude Code transcripts.
 *
 *   ~/.claude/projects/<project-slug>/<session>.jsonl
 *   ~/.claude/projects/<project-slug>/<session>/subagents/agent-<id>.jsonl
 *
 * Each line: {type, timestamp, cwd?, isMeta?, isSidechain?, entrypoint?,
 * attributionSkill?, toolUseResult?, message:{role, model?, usage?, content}}.
 *
 * Work evidence is `type` user/assistant — the same rule cchours uses, so
 * hours stay identical. Tool calls are `tool_use` blocks inside assistant
 * messages and `tool_result` blocks inside user messages; those are emitted
 * as separate events at the same timestamp so tool metrics can pair them
 * (hours de-duplicates stamps, so nothing is counted twice).
 *
 * Dialogue is a different question from work. A user line is a person
 * speaking only when it is not a tool-result turn, not a turn the runtime
 * wrote under a tag (slash-command echoes, `<task-notification>`, bash-mode
 * output — dialogue.js RUNTIME_TAG) and not runtime context (`isMeta`). That is `human: true`, the
 * cctranscript `kindOf() === 'prompt'` rule.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const M = require('../model.js');

const AGENT = 'claude';

/** Tools that only observe. They cannot leave a mark. (verbatim from ccblast) */
const READ_ONLY = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'TodoWrite', 'TodoRead',
  'WebFetch', 'WebSearch', 'Task', 'AskUserQuestion', 'ExitPlanMode',
]);
/** Tools that always reach outside this machine — the recipient already saw it. */
const OUTBOUND = /^(SendMessage|SendUserFile|Artifact|PushNotification|mcp__|Slack|Gmail|Notion)/;
const WRITE = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);
const SHELL = new Set(['Bash', 'BashOutput']);

const D = require('../dialogue.js');
const COMMAND_RE = /<command-name>\/?([A-Za-z0-9_:\-/.]+)<\/command-name>/;
const ECHO_RE = D.RUNTIME_TAG;

function defaultDir() { return path.join(os.homedir(), '.claude', 'projects'); }

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

/**
 * Session id and parent from the path. The parent of a subagent is whatever
 * directory sits right above `subagents/` — located by name, not by depth, so
 * a transcript tree copied without its project directory (or nested deeper)
 * still pairs each subagent with its own session. Pairing by fixed depth once
 * merged every subagent in a flattened copy under one parent, which turned the
 * longest run from 1.9h into 3.9h.
 */
function identify(file, baseDir) {
  const rel = path.relative(baseDir, file);
  const parts = rel.split(path.sep);
  const slug = parts.length > 1 ? parts[0] : '';
  const id = path.basename(file, '.jsonl');
  const k = parts.lastIndexOf('subagents');
  if (k > 0 && k < parts.length - 1) return { slug, id, parentId: parts[k - 1] };
  return { slug, id, parentId: null };
}

/** Normalise one tool_use block into op + input. */
function classify(name, input) {
  const n = String(name || '');
  const i = input && typeof input === 'object' ? input : {};
  if (n === 'Skill') return { op: 'read', input: { skill: typeof i.skill === 'string' ? i.skill : undefined } };
  if (READ_ONLY.has(n)) return { op: 'read', input: {} };
  if (OUTBOUND.test(n)) return { op: 'outbound', input: {} };
  if (WRITE.has(n)) return { op: 'write', input: M.toolInput({ path: i.file_path || i.notebook_path }) };
  if (SHELL.has(n)) return { op: 'shell', input: M.toolInput({ command: i.command }) };
  return { op: 'other', input: {} };
}

/** Text of an entry's content blocks (strings and text blocks only). */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  return parts.join('\n');
}

function entrypointName(v) {
  if (v === 'cli') return 'cli';
  if (v === 'sdk-cli') return 'sdk-cli';
  if (v === 'claude-code-github-action') return 'github-action';
  return v ? String(v) : null;
}

function parseFile(file, baseDir) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  const { slug, id, parentId } = identify(file, baseDir);
  const events = [];
  let cwd = null, entrypoint = null;
  const autoSeen = new Map();
  for (const line of text.split('\n')) {
    const e = M.jsonLine(line);
    if (!e) continue;
    const t = M.ms(e.timestamp);
    if (t == null) continue;
    if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
    if (!entrypoint && e.entrypoint) entrypoint = entrypointName(e.entrypoint);
    if (typeof e.attributionSkill === 'string' && e.attributionSkill && !autoSeen.has(e.attributionSkill)) autoSeen.set(e.attributionSkill, t);
    if (e.type !== 'user' && e.type !== 'assistant') {
      const m = { t, kind: 'meta' };
      if (e.type === 'system' && e.subtype === 'compact_boundary') m.sub = 'compact';
      events.push(m);
      continue;
    }
    const msg = e.message || {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    const injected = !!(e.isMeta || e.isSidechain);
    const ev = { t, kind: e.type };
    if (injected) ev.injected = true;
    if (e.type === 'assistant') {
      if (typeof msg.model === 'string' && msg.model !== '<synthetic>') ev.model = msg.model;
      const said = textOf(msg.content);
      if (said) { ev.chars = said.length; if (D.isSelfFix(said)) ev.fix = true; }
      const u = msg.usage;
      if (u && typeof u === 'object') {
        ev.tokens = {
          in: u.input_tokens || 0, out: u.output_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
        };
      }
    } else {
      const onlyResults = content.length > 0 && content.every((b) => b && b.type === 'tool_result');
      if (!onlyResults) {
        const txt = textOf(msg.content).trimStart();
        const cm = COMMAND_RE.exec(txt);
        if (cm) ev.command = cm[1];
        if (!injected && !ECHO_RE.test(txt)) {
          // Not every user line is a person: continuation summaries, hook
          // bounces and pasted context are user turns too. dialogue.js knows.
          if (D.isSystemText(txt)) ev.injected = true;
          else { ev.human = true; ev.chars = txt.trim().length; const k = D.askKind(txt); if (k) ev.ask = k; }
        }
      }
    }
    events.push(ev);
    // the patch a Write/Edit result carries: lines are a truer measure than touches
    const r = e.toolUseResult;
    // Write reports type 'create' when there was no file before it — the
    // only evidence a transcript gives that a file is new.
    let created = !!(r && typeof r === 'object' && r.type === 'create');
    let lines = null;
    if (r && typeof r === 'object' && Array.isArray(r.structuredPatch)) {
      lines = { added: 0, removed: 0 };
      for (const hunk of r.structuredPatch) for (const l of (hunk && hunk.lines) || []) {
        if (typeof l !== 'string') continue;
        if (l[0] === '+') lines.added++; else if (l[0] === '-') lines.removed++;
      }
    }
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') {
        const c = classify(b.name, b.input);
        const call = { t, kind: 'tool_call', tool: String(b.name || ''), callId: b.id, op: c.op, input: c.input };
        if (injected) call.injected = true;
        events.push(call);
      } else if (b.type === 'tool_result') {
        const rr = { t, kind: 'tool_result', callId: b.tool_use_id, ok: !b.is_error };
        if (injected) rr.injected = true;
        if (b.is_error) rr.text = M.errorText(b.content);
        if (lines) { rr.lines = lines; lines = null; }
        if (created) { rr.created = true; created = false; }
        events.push(rr);
      }
    }
  }
  const autoSkills = [...autoSeen].map(([name, t]) => ({ name, t }));
  // A headless run (`claude -p` from launchd, a CI job) has a "user" turn too:
  // the prompt the program passed in. It is work, not a person speaking —
  // on this machine 2,071 such runs landed on one day and would have read as
  // 2,071 conversations. They keep their hours; they lose the human flag.
  if (entrypoint === 'sdk-cli' || entrypoint === 'github-action') {
    for (const ev of events) if (ev.human) { delete ev.human; ev.scripted = true; }
  }
  return M.session({ agent: AGENT, id, file, project: cwd || slug, parentId, entrypoint: entrypoint || 'unknown', autoSkills, events });
}

/** @returns {{agent, dir, sessions: Session[]}} */
function read(opts = {}) {
  const dir = opts.dir || defaultDir();
  const sessions = [];
  for (const f of listFiles(dir)) {
    if (opts.sinceMs && !M.modifiedSince(f, opts.sinceMs)) continue;
    const s = parseFile(f, dir);
    if (s && s.events.length) sessions.push(s);
  }
  return { agent: AGENT, dir, sessions };
}

function detect(opts = {}) {
  const dir = opts.dir || defaultDir();
  try { return fs.statSync(dir).isDirectory(); } catch (e) { return false; }
}

/** Raw text sources for the secret scanner: every transcript file. */
function rawSources(opts = {}) {
  const dir = opts.dir || defaultDir();
  return listFiles(dir).map((file) => ({ file, project: identify(file, dir).slug, scrubbable: true }));
}

module.exports = { AGENT, READ_ONLY, OUTBOUND, COMMAND_RE, ECHO_RE, defaultDir, listFiles, identify, classify, textOf, parseFile, read, detect, rawSources };
