'use strict';
/**
 * readers/claude.js — Claude Code transcripts.
 *
 *   ~/.claude/projects/<project-slug>/<session>.jsonl
 *   ~/.claude/projects/<project-slug>/<session>/subagents/agent-<id>.jsonl
 *
 * With --archive, cclogsall's gzip mirror is read too:
 *
 *   ~/.cclogsall/projects/<same relative path>.jsonl.gz
 *
 * so metrics reach past Claude Code's cleanup (30 days by default). A session
 * still in the live directory is read from there only; the archive fills in
 * what the cleanup already deleted.
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
const zlib = require('zlib');
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
const W = require('../wire.js');
const COMMAND_RE = /<command-name>\/?([A-Za-z0-9_:\-/.]+)<\/command-name>/;
const ECHO_RE = D.RUNTIME_TAG;

function defaultDir() { return path.join(os.homedir(), '.claude', 'projects'); }

/**
 * Where cclogsall keeps its gzip mirror of ~/.claude/projects:
 * `<out>/projects/<same relative path>.jsonl.gz`, beside a manifest.json.
 * cclogsall's own default is ~/.cclogsall or $CCLOGSALL_OUT; so is this one.
 */
function defaultArchiveDir() { return process.env.CCLOGSALL_OUT || path.join(os.homedir(), '.cclogsall'); }

/** The archived transcripts under `archiveDir`, as {gz, rel} with rel the path the live file had. */
function listArchive(archiveDir) {
  const base = path.join(archiveDir, 'projects');
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl.gz')) out.push({ gz: full, rel: path.relative(base, full).slice(0, -3) });
    }
  };
  walk(base);
  return out;
}

/** True when `archiveDir` looks like a cclogsall archive (it has the projects/ mirror). */
function hasArchive(archiveDir) {
  try { return fs.statSync(path.join(archiveDir, 'projects')).isDirectory(); } catch (e) { return false; }
}

/** One key per transcript, the same for a live file and its archived copy. */
function sessionKey(file, baseDir) {
  const { id, parentId } = identify(file, baseDir);
  return `${parentId || ''}/${id}`;
}

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
  return parseText(text, file, baseDir);
}

/**
 * Parse one transcript's text. `file` names it for identify() (relative to
 * baseDir); `opts.source` is where it really came from when that differs
 * (an archived .gz), and `opts.archived` marks it as such.
 */
function parseText(text, file, baseDir, opts = {}) {
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
  return M.session({ agent: AGENT, id, file: opts.source || file, project: cwd || slug, parentId, entrypoint: entrypoint || 'unknown', autoSkills, events, archived: !!opts.archived });
}

/** Gunzip an archived transcript, or null when it cannot be read (skipped: undercount, never invent). */
function gunzipText(gz) {
  try { return zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8'); } catch (e) { return null; }
}

/**
 * Archived transcripts that are no longer live: a copy whose session still
 * sits in the live directory is skipped (live wins — it is the newer one),
 * judged against every live file, not only those the period selected, or an
 * old archived copy would stand in for a live file the mtime filter left out.
 * The .gz mtime is when cclogsall wrote it, never before the transcript's own
 * last write, so filtering on it can only keep too much, never drop a file.
 * @returns {{items: [{gz, rel, file}], duplicates}}
 */
function archiveItems(dir, archiveDir, sinceMs) {
  const live = new Set(listFiles(dir).map((f) => sessionKey(f, dir)));
  const items = [];
  let duplicates = 0;
  for (const a of listArchive(archiveDir)) {
    const file = path.join(dir, a.rel); // where it lived: identify() reads the id and parent from this
    if (live.has(sessionKey(file, dir))) { duplicates++; continue; }
    if (sinceMs && !M.modifiedSince(a.gz, sinceMs)) continue;
    items.push({ ...a, file });
  }
  return { items, duplicates };
}

/**
 * @param {{dir?, sinceMs?, archive?: string}} opts — `archive` is a cclogsall
 *   directory to read as well (opt-in: `--archive`).
 * @returns {{agent, dir, sessions: Session[], archive?: {dir, sessions, duplicates, unreadable}}}
 */
function read(opts = {}) {
  const dir = opts.dir || defaultDir();
  const sessions = [];
  for (const f of listFiles(dir)) {
    if (opts.sinceMs && !M.modifiedSince(f, opts.sinceMs)) continue;
    const s = parseFile(f, dir);
    if (s && s.events.length) sessions.push(s);
  }
  if (!opts.archive) return { agent: AGENT, dir, sessions };
  const { items, duplicates } = archiveItems(dir, opts.archive, opts.sinceMs);
  let added = 0, unreadable = 0;
  for (const a of items) {
    const text = gunzipText(a.gz);
    if (text == null) { unreadable++; continue; }
    const s = parseText(text, a.file, dir, { source: a.gz, archived: true });
    if (s && s.events.length) { sessions.push(s); added++; }
  }
  return { agent: AGENT, dir, sessions, archive: { dir: opts.archive, sessions: added, duplicates, unreadable } };
}

function detect(opts = {}) {
  const dir = opts.dir || defaultDir();
  try { return fs.statSync(dir).isDirectory(); } catch (e) { return !!(opts.archive && hasArchive(opts.archive)); }
}

// ---------------------------------------------------------------- sends

/** A tool_result block's text (strings, and the text parts of a list). */
function resultText(b) {
  const c = b && b.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && x.text) || '').join('\n');
  return '';
}

/** Content blocks of an entry, string content wrapped as one text block. */
function blocksOf(e) {
  const c = e && e.message && e.message.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c.filter((b) => b && typeof b === 'object') : [];
}

/**
 * What each request of one transcript sent (wire.js), ccsendstats' rules
 * verbatim so the numbers agree: a request is a main-loop assistant entry
 * with `usage`, de-duplicated by message.id (one response is split over
 * several lines, each repeating the usage); main loop means neither
 * isSidechain nor isMeta — so isMeta context lands in the invisible
 * remainder, as it does there. No timestamp is required, as there.
 */
function sendsOf(text, file, baseDir, opts = {}) {
  const { slug, id, parentId } = identify(file, baseDir);
  const tally = new W.Tally({ keepRequests: opts.keepRequests });
  const seen = new Set();
  let cwd = null, start = Infinity, end = -Infinity, model = '';
  let i = -1;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    const e = M.jsonLine(s);
    if (!e || typeof e !== 'object') continue;
    i++;
    const t = M.ms(e.timestamp);
    if (t != null) { if (t < start) start = t; if (t > end) end = t; }
    if (!cwd && typeof e.cwd === 'string' && e.cwd) cwd = e.cwd;
    if (e.isSidechain || e.isMeta) continue;
    if (e.type === 'user') {
      let said = '', results = false;
      for (const b of blocksOf(e)) {
        if (b.type === 'tool_result') { tally.add('toolResults', resultText(b)); results = true; }
        else if (b.type === 'text') said += tally.addUser(b.text);
      }
      tally.prompt(results ? null : said);
    } else if (e.type === 'assistant') {
      const m = e.message || {};
      const u = m.usage;
      if (u && typeof u === 'object') {
        const rid = m.id || e.uuid || String(i);
        if (!seen.has(rid)) {
          seen.add(rid);
          const uncached = u.input_tokens || 0, cacheRead = u.cache_read_input_tokens || 0, cacheWrite = u.cache_creation_input_tokens || 0;
          // cache_creation_input_tokens is the 1h + 5m sum; the split lives in
          // usage.cache_creation only — absent there, it was not recorded
          const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : {};
          const ttl = cc.ephemeral_1h_input_tokens != null || cc.ephemeral_5m_input_tokens != null;
          if (typeof m.model === 'string' && m.model !== '<synthetic>') model = m.model;
          tally.request({
            t, model: m.model || '', sent: uncached + cacheRead + cacheWrite, uncached, cacheRead, cacheWrite,
            cacheWrite1h: ttl ? cc.ephemeral_1h_input_tokens || 0 : null, cacheWrite5m: ttl ? cc.ephemeral_5m_input_tokens || 0 : null,
            out: u.output_tokens || 0,
          });
        }
      }
      for (const b of blocksOf(e)) {
        if (b.type === 'text') tally.add('assistantText', b.text);
        else if (b.type === 'thinking') tally.add('thinking', b.thinking);
        else if (b.type === 'tool_use') tally.add('toolInputs', JSON.stringify(b.input || {}));
      }
    }
  }
  return {
    agent: AGENT, id, file: opts.source || file, project: cwd || slug, parentId, automated: false, archived: !!opts.archived,
    start: Number.isFinite(start) ? start : null, end: Number.isFinite(end) ? end : null, model, ...tally.result(),
  };
}

/**
 * Sends records of the main sessions (subagents are left out: ccsendstats
 * never opens them, and their own isSidechain lines hold no main-loop
 * request). `match` is a session id prefix; `archive` as in read().
 */
function readSends(opts = {}) {
  const dir = opts.dir || defaultDir();
  const want = (file) => { const k = identify(file, dir); return k.parentId == null && (!opts.match || k.id.startsWith(opts.match)); };
  const sessions = [];
  for (const f of listFiles(dir)) {
    if (!want(f) || (opts.sinceMs && !M.modifiedSince(f, opts.sinceMs))) continue;
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    sessions.push(sendsOf(text, f, dir, opts));
  }
  if (!opts.archive) return { agent: AGENT, dir, sessions };
  const { items, duplicates } = archiveItems(dir, opts.archive, opts.sinceMs);
  let added = 0, unreadable = 0;
  for (const a of items) {
    if (!want(a.file)) continue;
    const text = gunzipText(a.gz);
    if (text == null) { unreadable++; continue; }
    sessions.push(sendsOf(text, a.file, dir, { ...opts, source: a.gz, archived: true })); added++;
  }
  return { agent: AGENT, dir, sessions, archive: { dir: opts.archive, sessions: added, duplicates, unreadable } };
}

const DAY_MS = 86400000;
const DEFAULT_CLEANUP_DAYS = 30;

/**
 * When Claude Code will delete what is here — a port of cclogsall's diagnose.
 * At every startup Claude Code deletes transcripts older than
 * `cleanupPeriodDays` (settings.json beside projects/, default 30): no
 * warning, no trash. Age is file mtime, as cclogsall measures it (close to,
 * not exactly, Claude Code's own bookkeeping); every transcript file counts,
 * subagents included, because each is deleted on its own.
 *
 * Only for a directory Claude Code actually cleans: the default one, or one
 * with a settings.json beside it (a config dir). A copy elsewhere is never
 * cleaned, and warning about it would be inventing a deadline. null then, or
 * when there is nothing to delete.
 */
function retention(opts = {}) {
  const dir = opts.dir || defaultDir();
  const settingsFile = path.join(path.dirname(dir), 'settings.json');
  const configured = fs.existsSync(settingsFile);
  if (path.resolve(dir) !== path.resolve(defaultDir()) && !configured) return null;
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {}; } catch (e) { settings = {}; }
  // cclogsall's rule verbatim: anything that is not a positive number is the default
  const set = Number(settings.cleanupPeriodDays);
  const periodDays = set || DEFAULT_CLEANUP_DAYS;
  const times = [];
  for (const f of listFiles(dir)) { try { times.push(fs.statSync(f).mtimeMs); } catch (e) { /* vanished */ } }
  if (!times.length) return null;
  const now = opts.now || Date.now();
  const oldest = Math.min(...times);
  return {
    periodDays,
    source: set ? 'settings' : 'default',
    settings: settingsFile,
    sessions: times.length,
    oldest: M.dayKey(oldest),
    deletesOn: M.dayKey(oldest + periodDays * DAY_MS),
    // ≤ 0: past the limit — deleted at the next Claude Code startup
    expiresInDays: Math.floor(periodDays - (now - oldest) / DAY_MS),
    expiringWithin7d: times.filter((t) => periodDays - (now - t) / DAY_MS <= 7).length,
    longRetention: periodDays >= 365,
  };
}

/** Raw text sources for the secret scanner: every transcript file. */
function rawSources(opts = {}) {
  const dir = opts.dir || defaultDir();
  return listFiles(dir).map((file) => ({ file, project: identify(file, dir).slug, scrubbable: true }));
}

module.exports = { AGENT, DEFAULT_CLEANUP_DAYS, retention, READ_ONLY, OUTBOUND, COMMAND_RE, ECHO_RE, defaultDir, defaultArchiveDir, listFiles, listArchive, hasArchive, sessionKey, archiveItems, gunzipText, identify, classify, textOf, parseFile, parseText, read, sendsOf, readSends, detect, rawSources };
