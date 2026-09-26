/** test.js — zero-dep tests. Run: node test/test.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const M = require('../lib/model.js');
const H = require('../lib/metrics/hours.js');
const Claude = require('../lib/readers/claude.js');
const Codex = require('../lib/readers/codex.js');
const Gemini = require('../lib/readers/gemini.js');
const Cursor = require('../lib/readers/cursor.js');
const Readers = require('../lib/readers/index.js');
const Tools = require('../lib/metrics/tools.js');
const Blast = require('../lib/metrics/blast.js');
const Leaks = require('../lib/metrics/leaks.js');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n); } };
const T = (s) => new Date(2026, 0, 1, 12, 0, s).getTime(); // 12:00:00 + s seconds, local
const iso = (s) => new Date(T(s)).toISOString();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agstats-'));
// The default cclogsall archive is looked up by `agents`; point it (and every
// child process) at nothing so a real ~/.cclogsall never enters a test.
process.env.CCLOGSALL_OUT = path.join(tmp, 'no-cclogsall');
const mk = (o) => JSON.stringify(o);
function writeFile(p, lines) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, lines.join('\n') + '\n'); }

// ------------------------------------------------------------------ hours core (ported from cchours, must not drift)
console.log('== busyIntervals (the guard against inflated hours) ==');
ok('consecutive stamps form one interval', H.busyIntervals([T(0), T(5), T(10)]).length === 1);
ok('interval length = last - first', H.busyIntervals([T(0), T(5), T(10)])[0][1] - H.busyIntervals([T(0), T(5), T(10)])[0][0] === 10000);
ok('★ silence over 60s splits (a permission wait is not work)', H.busyIntervals([T(0), T(10), T(300), T(310)]).length === 2);
ok('★ the 290s between are not credited', Math.round(H.unionSeconds(H.busyIntervals([T(0), T(10), T(300), T(310)]))) === 20);
ok('boundary: exactly 60s continues', H.busyIntervals([T(0), T(60)]).length === 1);
ok('boundary: 61s splits', H.busyIntervals([T(0), T(61)]).length === 0);
ok('★ a lone stamp is zero seconds (no guessed turn length)', H.unionSeconds(H.busyIntervals([T(0)])) === 0);
ok('idle gap override works', H.busyIntervals([T(0), T(100)], 120).length === 1);

console.log('== capSpans (a format that records [start,end] gets the same idle-gap rule as everyone else) ==');
ok('a short span (under idleGapS) is untouched', JSON.stringify(H.capSpans([[T(0), T(30)]], 60)) === JSON.stringify([[T(0), T(30)]]));
ok('exactly idleGapS is untouched', JSON.stringify(H.capSpans([[T(0), T(60)]], 60)) === JSON.stringify([[T(0), T(60)]]));
ok('★ a long span (a permission wait sitting inside it) is capped at idleGapS, not counted in full', JSON.stringify(H.capSpans([[T(0), T(300)]], 60)) === JSON.stringify([[T(0), T(60)]]));
ok('cap is relative to each span\'s own start, not absolute time', H.capSpans([[T(100), T(500)]], 60)[0][1] === T(160));

console.log('== unionSeconds ==');
ok('overlaps merge', H.unionSeconds([[T(0), T(100)], [T(50), T(150)]]) === 150);
ok('disjoint add', H.unionSeconds([[T(0), T(10)], [T(100), T(120)]]) === 30);
ok('empty', H.unionSeconds([]) === 0);

// ------------------------------------------------------------------ model
console.log('== model ==');
{
  const s = M.session({ agent: 'x', id: 'a', events: [{ t: 5, kind: 'user' }, { t: 1, kind: 'assistant' }, { t: NaN, kind: 'user' }, { t: 3, kind: 'nope' }] });
  ok('events sorted', s.events[0].t === 1 && s.events[1].t === 5);
  ok('malformed events dropped', s.events.length === 2);
  ok('parentId defaults to null', s.parentId === null);
  ok('workStamps excludes meta', M.workStamps(M.session({ agent: 'x', events: [{ t: 1, kind: 'meta' }, { t: 2, kind: 'user' }] })).length === 1);
  ok('ms() handles ISO and numbers', M.ms('2026-01-01T00:00:00.000Z') === Date.UTC(2026, 0, 1) && M.ms(5) === 5 && M.ms('junk') === null);
}

// ------------------------------------------------------------------ claude reader
console.log('== claude reader ==');
{
  const base = path.join(tmp, 'claude');
  const sess = '11111111-1111-1111-1111-111111111111';
  writeFile(path.join(base, '-Users-me-proj', `${sess}.jsonl`), [
    mk({ type: 'user', timestamp: iso(0), cwd: '/Users/me/proj', message: { role: 'user', content: 'hi' } }),
    mk({ type: 'assistant', timestamp: iso(5), message: { role: 'assistant', model: 'claude-x', usage: { input_tokens: 10, output_tokens: 2 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] } }),
    mk({ type: 'user', timestamp: iso(8), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true }] } }),
    mk({ type: 'mode', timestamp: iso(9) }),
    mk({ type: 'assistant' }),
    '{"broken',
  ]);
  writeFile(path.join(base, '-Users-me-proj', sess, 'subagents', 'agent-abc.jsonl'), [
    mk({ type: 'user', timestamp: iso(20) }), mk({ type: 'assistant', timestamp: iso(30) }),
  ]);
  const r = Claude.read({ dir: base });
  ok('two sessions (main + subagent)', r.sessions.length === 2);
  const main = r.sessions.find((s) => s.parentId === null), sub = r.sessions.find((s) => s.parentId !== null);
  ok('project is the cwd when present', main.project === '/Users/me/proj');
  ok('★ subagent paired with its parent by the directory above subagents/', sub.parentId === sess);
  ok('work stamps: user/assistant lines only (3), meta and broken lines excluded', M.workStamps(main).filter((t, i, a) => a.indexOf(t) === i).length === 3);
  ok('tool_call emitted with name', main.events.some((e) => e.kind === 'tool_call' && e.tool === 'Bash' && e.callId === 'tu1'));
  ok('tool_result carries ok=false for is_error', main.events.some((e) => e.kind === 'tool_result' && e.callId === 'tu1' && e.ok === false));
  ok('model and tokens on assistant', main.events.some((e) => e.kind === 'assistant' && e.model === 'claude-x' && e.tokens && e.tokens.in === 10));
  ok('meta line kept as meta', main.events.some((e) => e.kind === 'meta'));

  // ★ flattened layout (a copy made without the project directory) must still pair correctly
  const flat = path.join(tmp, 'claude-flat');
  writeFile(path.join(flat, `${sess}.jsonl`), [mk({ type: 'user', timestamp: iso(0) }), mk({ type: 'assistant', timestamp: iso(5) })]);
  writeFile(path.join(flat, sess, 'subagents', 'agent-abc.jsonl'), [mk({ type: 'user', timestamp: iso(20) }), mk({ type: 'assistant', timestamp: iso(30) })]);
  const rf = Claude.read({ dir: flat });
  ok('★ flattened layout: parentId is the session, not "subagents"', rf.sessions.find((s) => s.parentId !== null).parentId === sess);
  const ag = H.fromSessions(rf.sessions);
  ok('main and subagent share one root', ag[0].root === ag[1].root);
}

// ------------------------------------------------------------------ codex reader
console.log('== codex reader ==');
{
  const base = path.join(tmp, 'codex');
  writeFile(path.join(base, '2026', '01', '01', 'rollout-2026-01-01T12-00-00-abc.jsonl'), [
    mk({ timestamp: iso(0), type: 'session_meta', payload: { session_id: 'sid-1', cwd: '/w/p', originator: 'codex_cli_rs' } }),
    mk({ timestamp: iso(1), type: 'turn_context', payload: { cwd: '/w/p', model: 'gpt-x' } }),
    mk({ timestamp: iso(2), type: 'response_item', payload: { type: 'message', role: 'user', content: [] } }),
    mk({ timestamp: iso(4), type: 'response_item', payload: { type: 'reasoning' } }),
    mk({ timestamp: iso(5), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{}' } }),
    mk({ timestamp: iso(6), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: '', metadata: { exit_code: 2 } }) } }),
    mk({ timestamp: iso(7), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 5 } } } }),
    mk({ timestamp: iso(8), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } }),
  ]);
  const r = Codex.read({ dir: base });
  ok('one session', r.sessions.length === 1);
  const s = r.sessions[0];
  ok('id from session_meta', s.id === 'sid-1');
  ok('project from cwd', s.project === '/w/p');
  ok('session_meta / turn_context / event_msg are meta', s.events.filter((e) => e.kind === 'meta').length === 3);
  ok('work stamps: response_item only (5)', M.workStamps(s).length === 5);
  ok('shell exit_code≠0 → ok=false', s.events.some((e) => e.kind === 'tool_result' && e.callId === 'c1' && e.ok === false));
  ok('tool name', s.events.some((e) => e.kind === 'tool_call' && e.tool === 'shell'));
  ok('tokens: cached split out', s.events.some((e) => e.tokens && e.tokens.in === 40 && e.tokens.cacheRead === 60));
  ok('model from turn_context', s.events.some((e) => e.kind === 'assistant' && e.model === 'gpt-x'));
}

// ------------------------------------------------------------------ gemini reader
console.log('== gemini reader ==');
{
  const base = path.join(tmp, 'gemini');
  writeFile(path.join(base, 'projA', 'chats', 'session-2026-01-01T12-00-x.jsonl'), [
    mk({ sessionId: 'g-1', projectHash: 'h', startTime: iso(0), lastUpdated: iso(0), kind: 'main' }),
    mk({ $set: { messages: [{ id: 'm1', timestamp: iso(1), type: 'user', content: [] }] } }),
    mk({ $push: { messages: { id: 'm2', timestamp: iso(4), type: 'gemini', content: [], toolCalls: [{ id: 't1', name: 'run_shell_command', status: 'error' }] } } }),
  ]);
  writeFile(path.join(base, 'projA', 'logs.json'), [JSON.stringify([
    { sessionId: 'old-1', messageId: 0, type: 'user', message: 'x', timestamp: iso(100) },
    { sessionId: 'old-1', messageId: 1, type: 'user', message: 'y', timestamp: iso(105) },
  ])]);
  const r = Gemini.read({ dir: base });
  ok('chat + legacy = 2 sessions', r.sessions.length === 2);
  const chat = r.sessions.find((s) => s.id === 'session-2026-01-01T12-00-x');
  ok('header startTime is meta', chat.events.some((e) => e.kind === 'meta'));
  ok('$set and $push both read (2 work messages)', chat.events.filter((e) => e.kind === 'user' || e.kind === 'assistant').length === 2);
  ok('toolCalls → tool_call + failed tool_result', chat.events.some((e) => e.kind === 'tool_call' && e.tool === 'run_shell_command') && chat.events.some((e) => e.kind === 'tool_result' && e.ok === false));
  ok('legacy logs.json grouped by sessionId', r.sessions.find((s) => s.id.endsWith('#old-1')).events.length === 2);
}

// ------------------------------------------------------------------ registry + CLI
console.log('== registry / CLI ==');
{
  const dirs = { claude: path.join(tmp, 'claude'), codex: path.join(tmp, 'codex'), gemini: path.join(tmp, 'nope'), cursor: path.join(tmp, 'nope') };
  const all = Readers.readAll({ dirs });
  ok('missing agent reported as not installed, never as zero sessions of an installed one',
    all.find((a) => a.agent === 'gemini').installed === false && all.find((a) => a.agent === 'claude').installed === true);
  const bin = path.join(__dirname, '..', 'bin', 'agstats.js');
  const dirArgs = Object.entries(dirs).flatMap(([k, v]) => ['--dir', `${k}=${v}`]);
  const run = (args, opts) => execFileSync('node', [bin, ...args, ...dirArgs], { encoding: 'utf8', ...opts });
  const agents = JSON.parse(run(['agents', '--json']));
  ok('agents --json lists every reader', agents.length === Readers.NAMES.length);
  ok('agents --json: gemini not installed', agents.find((a) => a.agent === 'gemini').installed === false);
  const hours = JSON.parse(run(['hours', '--json', '--all']));
  // claude main 0..8s (8s) + subagent 20..30s (10s) + codex 2..8s (6s) = 24s of agent time
  ok('★ hours --json total equals the hand-computed 24 seconds', Math.round(hours.agentHours * 3600) === 24);
  ok('per-agent split present', hours.agents.length === 2 && Math.round(hours.agents.find((a) => a.name === 'claude').hours * 3600) === 18);
  ok('subagent hours = 10s', Math.round(hours.subagentHours * 3600) === 10);
  const text = run(['hours', '--all']);
  ok('multi-agent table has an agent column per found agent', /\bclaude\b/.test(text) && /\bcodex\b/.test(text));
  const only = JSON.parse(run(['hours', '--json', '--all', '--agent', 'codex']));
  ok('--agent narrows', Math.round(only.agentHours * 3600) === 6);

  // tools / blast / leaks through the CLI on the same fixtures
  const tools = JSON.parse(run(['tools', '--json', '--all']));
  ok('tools: claude Bash 1 call 1 error, codex shell 1 call 1 error', tools.total === 2 && tools.totalErr === 2
    && tools.rows.some((r) => r.agent === 'claude' && r.tool === 'Bash' && r.errors === 1)
    && tools.rows.some((r) => r.agent === 'codex' && r.tool === 'shell' && r.errors === 1));
  const blast = JSON.parse(run(['blast', '--json', '--all']));
  ok('blast: two shell calls with no command text are contained', blast.actions === 2 && blast.contained === 2 && blast.escaped === 0);
  let leaksOut = '', leaksCode = 0;
  try { leaksOut = run(['leaks']); } catch (e) { leaksOut = e.stdout; leaksCode = e.status; }
  ok('leaks: clean fixtures exit 0', leaksCode === 0 && /clean/.test(leaksOut));
}

// ------------------------------------------------------------------ tools metric
console.log('== tools metric ==');
{
  const s = M.session({ agent: 'x', id: 's', events: [
    { t: T(0), kind: 'tool_call', tool: 'Bash', callId: 'a' },
    { t: T(1), kind: 'tool_result', callId: 'a', ok: false, text: 'exit 1: file 12 not found' },
    { t: T(2), kind: 'tool_call', tool: 'Bash', callId: 'b' },
    { t: T(3), kind: 'tool_result', callId: 'b', ok: true },
    { t: T(4), kind: 'tool_call', tool: 'Read', callId: 'c' },
    { t: T(5), kind: 'tool_result', callId: 'c', ok: false, text: 'exit 1: file 99 not found' },
    { t: T(6), kind: 'tool_result', callId: 'zzz', ok: false, text: 'orphan' },
  ] });
  const r = Tools.summarize([s]);
  const bash = r.rows.find((x) => x.tool === 'Bash');
  ok('calls and errors paired by callId', bash.calls === 2 && bash.errors === 1 && bash.errorRate === 50);
  ok('★ a result whose call was never seen counts as unknown, not dropped', r.rows.some((x) => x.tool === 'unknown' && x.errors === 1));
  ok('totals', r.total === 3 && r.totalErr === 3);
  // window: call at T(0) inside, result at T(1) outside → still one failed call in the window
  const w = Tools.summarize([s], T(0), T(1));
  ok('★ error charged to the call\'s window even when the result lands after it', w.rows.find((x) => x.tool === 'Bash').errors === 1 && w.total === 1);
  ok('signatureOf folds numbers', Tools.signatureOf('exit 1: file 12 not found') === Tools.signatureOf('exit 1: file 99 not found'));
  const sug = Tools.suggest(r, { minCalls: 1, minRate: 20 });
  // unknown has errors but 0 calls → below minCalls; Bash (50%) and Read (100%) qualify
  ok('suggest clusters failures by signature', sug.length === 2 && sug.find((x) => x.tool === 'Bash').clusters[0].count === 1);
}

// ------------------------------------------------------------------ blast metric
console.log('== blast metric ==');
{
  const isTracked = (p) => p.startsWith('/repo/');
  const c = (e) => Blast.classifyCall(e, isTracked).kind;
  ok('read op is readonly', c({ op: 'read' }) === 'readonly');
  ok('outbound op escapes', c({ op: 'outbound', tool: 'SendMessage' }) === 'escaped');
  ok('write inside a git repo is contained', c({ op: 'write', input: { path: '/repo/a.js' } }) === 'contained');
  ok('write to /tmp is ephemeral', c({ op: 'write', input: { path: '/tmp/x' } }) === 'ephemeral');
  ok('★ write where nothing tracks it escapes', Blast.classifyCall({ op: 'write', input: { path: '/home/me/notes.md' } }, isTracked, () => true).kind === 'escaped');
  ok('plain shell is contained', c({ op: 'shell', input: { command: 'ls -la' } }) === 'contained');
  ok('git push escapes', Blast.classifyCall({ op: 'shell', input: { command: 'git push origin main' } }, isTracked).key === 'push');
  ok('★ force push is read as a history rewrite, not a push', Blast.classifyCall({ op: 'shell', input: { command: 'git push --force origin main' } }, isTracked).key === 'force');
  ok('npm publish escapes', Blast.classifyCall({ op: 'shell', input: { command: 'npm publish' } }, isTracked).key === 'publish');
  ok('unknown op assumed contained (undercount, never inflate)', c({ op: 'other', tool: 'Weird' }) === 'contained');
  const s = M.session({ agent: 'x', id: 's', events: [
    { t: T(0), kind: 'tool_call', tool: 'Bash', op: 'shell', input: { command: 'git push' } },
    { t: T(1), kind: 'tool_call', tool: 'Write', op: 'write', input: { path: '/repo/a' } },
    { t: T(2), kind: 'tool_call', tool: 'Read', op: 'read' },
  ] });
  const r = Blast.summarize([s], -Infinity, Infinity, { isTracked });
  ok('containment = contained / (contained + escaped)', r.actions === 3 && r.readonly === 1 && r.escaped === 1 && r.contained === 1 && r.containment === 0.5);
  ok('categories carry samples', r.categories[0].key === 'push' && r.categories[0].samples.length === 1);
}

// ------------------------------------------------------------------ leaks metric
console.log('== leaks metric ==');
{
  const key = 'ghp_' + 'A'.repeat(36);
  const f1 = path.join(tmp, 'leaks', 'a.jsonl');
  const f2 = path.join(tmp, 'leaks', 'b.jsonl');
  writeFile(f1, [mk({ type: 'user', message: `token ${key} here` }), mk({ type: 'assistant', message: 'ok' })]);
  writeFile(f2, [mk({ type: 'user', message: `again ${key}` })]);
  const r = Leaks.scan([{ agent: 'a', file: f1, project: 'p', scrubbable: true }, { agent: 'b', file: f2, project: 'p', scrubbable: true }]);
  ok('one distinct secret across two files', r.findings.length === 1 && r.findings[0].occurrences === 2 && r.findings[0].fileCount === 2);
  ok('★ the raw secret is never in the display field', !r.findings[0].masked.includes('AAAAAAAA'));
  ok('agents that saw it are listed', r.findings[0].agents.join() === 'a,b');
  const chunks = Leaks.scan([{ agent: 'c', file: 'db', project: 'p', scrubbable: false, chunks: () => [`x ${key} y`] }]);
  ok('chunk sources (databases) are scanned too', chunks.findings.length === 1);
  const sc = Leaks.scrubContent(fs.readFileSync(f1, 'utf8'), Leaks.RULES);
  ok('scrub keeps JSON valid and removes the secret', sc.changed && !sc.content.includes(key) && sc.content.split('\n').filter(Boolean).every((l) => JSON.parse(l)));
  ok('scrubbed content re-scans clean', Leaks.scanText(sc.content).length === 0);
  ok('isActive: 1 minute old is live, 1 hour old is not', Leaks.isActive(Date.now() - 60000) && !Leaks.isActive(Date.now() - 3600000));
}

// ------------------------------------------------------------------ cursor reader
console.log('== cursor reader ==');
{
  let sqlite = null;
  try { sqlite = require('node:sqlite'); } catch (e) { sqlite = null; }
  if (!sqlite) { console.log('  (node:sqlite unavailable — cursor reader tests skipped)'); }
  else {
    const dir = path.join(tmp, 'cursor');
    fs.mkdirSync(dir, { recursive: true });
    const db = new sqlite.DatabaseSync(path.join(dir, 'state.vscdb'));
    db.exec('create table cursorDiskKV (key text primary key, value blob)');
    const ins = db.prepare('insert into cursorDiskKV values (?, ?)');
    ins.run('composerData:c1', JSON.stringify({ composerId: 'c1', createdAt: T(0), unifiedMode: 'agent' }));
    ins.run('bubbleId:c1:b1', JSON.stringify({ type: 1, timingInfo: { clientRpcSendTime: T(10), clientEndTime: T(310) } }));
    ins.run('bubbleId:c1:b2', JSON.stringify({ type: 2, createdAt: iso(320), toolFormerData: { name: 'run_terminal_cmd', params: '{"command":"git push"}', status: 'completed' } }));
    ins.run('bubbleId:c1:b3', JSON.stringify({ type: 2 })); // no time → no evidence
    db.close();
    const r = Cursor.read({ dir });
    ok('one thread', r.sessions.length === 1);
    const s = r.sessions[0];
    ok('★ user turn carries its span as end', s.events.some((e) => e.kind === 'user' && e.end === T(310)));
    ok('bubble without time is dropped', s.events.filter((e) => e.kind === 'assistant').length === 1);
    ok('tool call classified as shell with command', s.events.some((e) => e.kind === 'tool_call' && e.op === 'shell' && e.input.command === 'git push'));
    const ag = H.fromSessions(r.sessions);
    // span 10..310 (300s) is capped to idleGapS (60s, same rule a stamp gap
    // gets) ∪ stamps 10, 320 (gap 310s → nothing) → 60s, not the naive 300s
    ok('★ hours cap a recorded span at idleGapS, not the naive full 300s', Math.round(ag[0].seconds) === 60);
    ok('detect() true on the db file', Cursor.detect({ dir }) === true);
    const raw = Cursor.rawSources({ dir });
    ok('rawSources yields chunks and is not scrubbable', raw[0].scrubbable === false && raw[0].chunks().length === 4);
  }
}

// ------------------------------------------------------------------ review findings, pinned
console.log('== automated sessions (gemini a2a) ==');
{
  const base = path.join(tmp, 'gemini-auto');
  writeFile(path.join(base, 'proj', 'chats', 'session-a.jsonl'), [
    mk({ sessionId: 'a2a-server', projectHash: 'h', startTime: iso(0), kind: 'main' }),
    mk({ $set: { messages: [{ id: 'm1', timestamp: iso(1), type: 'user', content: [] }, { id: 'm2', timestamp: iso(30), type: 'gemini', content: [] }] } }),
  ]);
  writeFile(path.join(base, 'proj', 'chats', 'session-b.jsonl'), [
    mk({ sessionId: 'a2a-server', projectHash: 'h', startTime: iso(100), kind: 'main' }),
    mk({ $set: { messages: [{ id: 'm1', timestamp: iso(101), type: 'user', content: [] }, { id: 'm2', timestamp: iso(130), type: 'gemini', content: [] }] } }),
  ]);
  writeFile(path.join(base, 'proj', 'chats', 'session-c.jsonl'), [
    mk({ sessionId: 'f0e1-real-person', projectHash: 'h', startTime: iso(200), kind: 'main' }),
    mk({ $set: { messages: [{ id: 'm1', timestamp: iso(201), type: 'user', content: [] }, { id: 'm2', timestamp: iso(230), type: 'gemini', content: [] }] } }),
  ]);
  const r = Gemini.read({ dir: base });
  ok('★ a2a-server files are flagged automated and not parsed past the header', r.sessions.filter((s) => s.automated).length === 2 && r.sessions.filter((s) => s.automated).every((s) => s.events.length === 1));
  ok('a real session is not flagged and is fully parsed', r.sessions.find((s) => !s.automated).events.filter((e) => e.kind !== 'meta').length === 2);
  ok('★ id is the file, not the shared sessionId', new Set(r.sessions.map((s) => s.id)).size === 3);
  const all = Readers.readAll({ dirs: { gemini: base, claude: path.join(tmp, 'nope'), codex: path.join(tmp, 'nope'), cursor: path.join(tmp, 'nope') } });
  const g = all.find((a) => a.agent === 'gemini');
  ok('★ readAll leaves automated sessions out of metrics but reports the count', g.sessions.length === 1 && g.automated === 2);
  const inc = Readers.readAll({ dirs: { gemini: base }, only: ['gemini'], includeAutomated: true });
  ok('--include-automated brings them back, fully parsed', inc[0].sessions.length === 3 && inc[0].sessions.every((s) => s.events.length >= 2));
  const rIn = Gemini.read({ dir: base, includeAutomated: true });
  const ag = H.fromSessions(rIn.sessions);
  ok('★ three sessions with the same native id stay three roots (no 85-hour merge)', new Set(ag.map((a) => a.root)).size === 3);
  ok('longest run is one session (29s), not the span of all three', Math.round(H.summarize(ag, -Infinity, Infinity).longestRunHours * 3600) === 29);
}

console.log('== codex work evidence ==');
{
  const base = path.join(tmp, 'codex2');
  writeFile(path.join(base, 'r.jsonl'), [
    mk({ timestamp: iso(0), type: 'session_meta', payload: { session_id: 'x', cwd: '/w' } }),
    mk({ timestamp: iso(1), type: 'response_item', payload: { type: 'message', role: 'developer', content: [] } }),
    mk({ timestamp: iso(2), type: 'response_item', payload: { type: 'message', role: 'user', content: [] } }),
    mk({ timestamp: iso(3), type: 'event_msg', payload: { type: 'task_started' } }),
    mk({ timestamp: iso(4), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":["ls"]}' } }),
    mk({ timestamp: iso(4), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":["ls"]}' } }), // replayed duplicate
    mk({ timestamp: iso(5), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: '{"output":"","metadata":{"exit_code":0}}' } }),
    mk({ timestamp: iso(6), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } }),
    mk({ timestamp: iso(6), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } }), // replayed duplicate
    mk({ timestamp: iso(90), type: 'event_msg', payload: { type: 'turn_aborted' } }),
  ]);
  const s = Codex.read({ dir: base }).sessions[0];
  ok('★ event_msg (task_started, turn_aborted) is meta, not work', s.events.filter((e) => e.kind !== 'meta').every((e) => e.t !== T(3) && e.t !== T(90)));
  ok('developer message is meta', s.events.find((e) => e.t === T(1)).kind === 'meta');
  ok('★ replayed duplicate tool call counted once', s.events.filter((e) => e.kind === 'tool_call').length === 1);
  ok('★ replayed duplicate message counted once', s.events.filter((e) => e.kind === 'assistant').length === 1);
  ok('shell command joined from the array form', s.events.find((e) => e.kind === 'tool_call').input.command === 'ls');
  const ag = H.fromSessions([s]);
  ok('hours span the work only: 2s..6s = 4s (the 90s abort is not counted)', Math.round(ag[0].seconds) === 4);
}

console.log('== parity with cchours on fixtures ==');
{
  let CC = null;
  for (const p of [path.join(os.homedir(), 'private', 'playground-tools', 'apps', 'cchours', 'lib', 'hours.js'), path.join(os.homedir(), 'private', 'cchours', 'lib', 'hours.js')]) {
    try { CC = require(p); break; } catch (e) { CC = null; }
  }
  if (!CC) console.log('  (cchours not on this machine — parity test skipped)');
  else {
    // a richer fixture: two sessions, one with a subagent, tool blocks, a permission wait
    const base = path.join(tmp, 'parity');
    const s1 = 'aaaaaaaa-0000-0000-0000-000000000001', s2 = 'aaaaaaaa-0000-0000-0000-000000000002';
    const lines = (offset) => [
      mk({ type: 'user', timestamp: iso(offset + 0), cwd: '/p', message: { role: 'user', content: 'go' } }),
      mk({ type: 'assistant', timestamp: iso(offset + 3), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x' + offset, name: 'Bash', input: { command: 'ls' } }] } }),
      mk({ type: 'user', timestamp: iso(offset + 4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' + offset }] } }),
      mk({ type: 'assistant', timestamp: iso(offset + 5), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
      mk({ type: 'user', timestamp: iso(offset + 400), message: { role: 'user', content: 'after a long wait' } }),
      mk({ type: 'assistant', timestamp: iso(offset + 402), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
      mk({ type: 'mode', timestamp: iso(offset + 403) }),
    ];
    writeFile(path.join(base, '-p', `${s1}.jsonl`), lines(0));
    writeFile(path.join(base, '-p', s1, 'subagents', 'agent-1.jsonl'), lines(2));
    writeFile(path.join(base, '-p', `${s2}.jsonl`), lines(1000));
    const from = T(-10), to = T(5000);
    const cc = CC.summarize(CC.scan({ baseDir: base }).agents, from, to);
    const mine = H.summarize(H.fromSessions(Claude.read({ dir: base }).sessions), from, to);
    for (const k of ['agentHours', 'wallHours', 'mainHours', 'subagentHours', 'longestRunHours', 'agentCount', 'mainCount', 'subCount']) {
      ok(`★ parity: ${k} (${(cc[k] * (k.endsWith('Hours') ? 3600 : 1)).toFixed(2)})`, Math.abs(cc[k] - mine[k]) < 1e-9);
    }
    if ('peakParallel' in cc) ok('★ parity: peakParallel / peakParallelSession', cc.peakParallel === mine.peakParallel && cc.peakParallelSession === mine.peakParallelSession);
    ok('parity: monthly rollup hours', Math.abs(CC.byMonth(CC.scan({ baseDir: base }).agents, T(0))[0].hours - H.byMonth(H.fromSessions(Claude.read({ dir: base }).sessions), T(0))[0].hours) < 1e-9);
  }
}

console.log('== CLI guards ==');
{
  const bin = path.join(__dirname, '..', 'bin', 'agstats.js');
  const dirArgs = ['--dir', `claude=${path.join(tmp, 'claude')}`, '--dir', `codex=${path.join(tmp, 'nope')}`, '--dir', `gemini=${path.join(tmp, 'nope')}`, '--dir', `cursor=${path.join(tmp, 'nope')}`];
  const code = (args) => { try { execFileSync('node', [bin, ...args, ...dirArgs], { encoding: 'utf8', stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
  ok('★ malformed --since exits 2 instead of silently widening the window', code(['hours', '--since', '2026-7-1']) === 2);
  ok('★ malformed --until exits 2 instead of silently emptying the window', code(['hours', '--until', 'yesterday']) === 2);
  ok('impossible date (2026-02-30) exits 2', code(['hours', '--since', '20260230']) === 2);
  ok('--days 0 exits 2', code(['hours', '--days', '0']) === 2);
  ok('well-formed dates pass', code(['hours', '--since', '2026-01-01', '--until', '20260102', '--json']) === 0);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const { NAME } = require('../lib/brand.js');
  ok('★ brand: package name, bin key and bin filename agree with lib/brand.js', pkg.name === NAME && Object.keys(pkg.bin)[0] === NAME && fs.existsSync(path.join(__dirname, '..', 'bin', `${NAME}.js`)));
  ok('package.json files all exist', pkg.files.every((f) => fs.existsSync(path.join(__dirname, '..', f))));
}

// ------------------------------------------------------------------ stats / timeline / quota / diff / skills
console.log('== stats metric ==');
{
  const Stats = require('../lib/metrics/stats.js');
  const s = M.session({ agent: 'claude', id: 's1', project: '/p', events: [
    { t: T(0), kind: 'user', human: true },
    { t: T(1), kind: 'assistant', model: 'claude-opus-5', tokens: { in: 10, out: 5, cacheRead: 85, cacheWrite: 0 } },
    { t: T(1), kind: 'tool_call', tool: 'Bash', callId: 'a', op: 'shell', input: { command: 'ls' } },
    { t: T(2), kind: 'user' },                                  // tool-result turn: not a prompt
    { t: T(3), kind: 'assistant', model: 'claude-opus-5', tokens: { in: 10, out: 5, cacheRead: 0, cacheWrite: 0 } },
    { t: T(4), kind: 'user', injected: true },                 // runtime context: not a prompt
    { t: T(5), kind: 'user', command: 'model' },               // slash echo: not a prompt (no human flag)
    { t: T(6), kind: 'meta', sub: 'compact' },
  ] });
  const sub = M.session({ agent: 'claude', id: 'sub', parentId: 's1', events: [
    { t: T(0), kind: 'user', human: true }, { t: T(1), kind: 'assistant', tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 } },
  ] });
  const r = Stats.summarize([s, sub]);
  ok('★ prompts count only human main-loop user turns (1)', r.prompts === 1);
  ok('★ replies exclude assistant turns that carried a tool call (1)', r.replies === 1);
  ok('tool calls main loop only', r.toolCalls === 1);
  ok('tokens include the subagent (117)', r.tokens.total === 117);
  ok('cache share', r.cacheShare === +((85 / 117) * 100).toFixed(1));
  ok('model family', r.byModel.opus === 115);
  ok('compaction counted', r.compactions === 1);
  ok('sessions = 2 (main + sub)', r.sessions === 2);
  ok('no _reply residue left on events', s.events.every((e) => !('_reply' in e)));
}

console.log('== timeline metric ==');
{
  const TL = require('../lib/metrics/timeline.js');
  const day = (d) => new Date(2026, 0, d, 12).getTime();
  const s = M.session({ agent: 'x', id: 'a', project: '/p', events: [
    { t: day(1), kind: 'assistant', tokens: { in: 100, out: 0, cacheRead: 0, cacheWrite: 0 } },
    { t: day(2), kind: 'assistant', tokens: { in: 1000000, out: 0, cacheRead: 0, cacheWrite: 0 } },
    { t: day(3), kind: 'assistant', tokens: { in: 100, out: 0, cacheRead: 0, cacheWrite: 0 } },
  ] });
  const noTok = M.session({ agent: 'cursor', id: 'b', project: '/q', events: [{ t: day(10), kind: 'user', human: true }, { t: day(10) + 5000, kind: 'assistant' }] });
  const samples = TL.samplesOf([s, noTok]);
  const days = TL.byDay(samples);
  ok('★ an agent without token usage still lands on the calendar (by stamps)', days.has('2026-01-10') && days.get('2026-01-10').stamps === 2);
  const cal = TL.calendar(days, '2026-01-12', 2);
  const joined = cal.grid.join('');
  ok('★ log scale: the 100-token days are still visible next to the 1M day', (joined.match(/[░▒▓█]/g) || []).length >= 4);
  ok('streaks: 3-day run', TL.streaks(days, '2026-01-12').longest === 3);
  ok('current streak counts from today/yesterday only', TL.streaks(days, '2026-01-12').current === 0 && TL.streaks(days, '2026-01-10').current === 1);
}

console.log('== quota metric ==');
{
  const Q = require('../lib/metrics/quota.js');
  const now = new Date(2026, 0, 16, 12).getTime(); // mid-January
  const mk2 = (proj, t, tok) => M.session({ agent: 'x', id: proj + t, project: proj, events: [{ t, kind: 'assistant', tokens: { in: tok, out: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const sessions = [mk2('/w/main', new Date(2026, 0, 5).getTime(), 300), mk2('/w/side', new Date(2026, 0, 6).getTime(), 700), mk2('/w/old', new Date(2025, 11, 30).getTime(), 9999)];
  const u = Q.usageByProject(sessions, 'month', now);
  ok('only this period counts', u.total === 1000 && !u.by.has('old'));
  ok('project display name is the last path segment', u.by.get('main') === 300);
  const r = Q.assess(u, { main: 60, side: 20 }, Q.periodProgress('month', now));
  ok('★ side at 70% share vs 20% budget is over; main 30% vs 60% is under', r.rows[0].name === 'side' && r.rows[0].status === 'over' && r.rows.find((x) => x.name === 'main').status === 'under');
  ok('budgets over 100% flagged', !Q.validateBudgets({ a: 70, b: 40 }).valid);
  ok('period progress mid-month ≈ 0.5', Math.abs(Q.periodProgress('month', now) - 0.5) < 0.02);
}

console.log('== diff metric ==');
{
  const D = require('../lib/metrics/diff.js');
  const s = M.session({ agent: 'claude', id: 'd1', project: '/repo', events: [
    { t: T(0), kind: 'tool_call', tool: 'Write', callId: 'w1', op: 'write', input: { path: '/repo/a.js' } },
    { t: T(1), kind: 'tool_result', callId: 'w1', ok: true, created: true, lines: { added: 10, removed: 0 } },
    { t: T(2), kind: 'tool_call', tool: 'Edit', callId: 'e1', op: 'write', input: { path: '/repo/a.js' } },
    { t: T(3), kind: 'tool_result', callId: 'e1', ok: true, lines: { added: 2, removed: 6 } },
    { t: T(4), kind: 'tool_call', tool: 'Bash', callId: 'b1', op: 'shell', input: { command: 'npm   test' } },
    { t: T(5), kind: 'tool_call', tool: 'Read', callId: 'r1', op: 'read' },
    { t: T(6), kind: 'tool_call', tool: 'Edit', callId: 'e2', op: 'write', input: { path: '/repo/b.js' } },
  ] });
  const r = D.collectChanges(s);
  ok('files sorted by touches', r.files[0].path === '/repo/a.js' && r.files[0].touches === 2 && r.files[0].created === true);
  ok('lines paired to the file through callId', r.files[0].added === 12 && r.files[0].removed === 6);
  ok('self-undo ratio', Math.abs(r.lines.selfUndo - 0.5) < 1e-9);
  ok('commands collected and whitespace-normalised; reads ignored', r.commands.length === 1 && r.commands[0].command === 'npm test');
  const older = M.session({ agent: 'claude', id: 'd0', events: [{ t: T(-100), kind: 'user', human: true }] });
  ok('pickSession: most recent by default, prefix match on id', D.pickSession([older, s]).id === 'd1' && D.pickSession([older, s], { id: 'd0' }).id === 'd0');
}

console.log('== skills metric ==');
{
  const S = require('../lib/metrics/skills.js');
  const a = M.session({ agent: 'claude', id: 'k1', entrypoint: 'cli', autoSkills: [{ name: 'digest', t: T(9) }], events: [
    { t: T(0), kind: 'user', human: true, command: 'triage' },
    { t: T(1), kind: 'tool_call', tool: 'Skill', callId: 's1', op: 'read', input: { skill: 'triage' } },
    { t: T(2), kind: 'user', command: 'model' },
    { t: T(3), kind: 'user', command: 'status' },
  ] });
  const b = M.session({ agent: 'claude', id: 'k2', entrypoint: 'sdk-cli', autoSkills: [{ name: 'digest', t: T(20) }], events: [] });
  const invs = S.invocations([a, b]);
  ok('three shapes collected: typed, tool, auto', invs.filter((i) => i.source === 'typed').length === 3 && invs.filter((i) => i.source === 'tool').length === 1 && invs.filter((i) => i.source === 'auto').length === 2);
  const rows = S.summarize(invs, new Set(['triage', 'never-used']));
  const tri = rows.find((r) => r.name === 'triage');
  ok('★ tool and typed summed per name (2)', tri.total === 2 && tri.tool === 1 && tri.typed === 1);
  ok('★ /model typed with no Skill call is a command; /status likewise', rows.find((r) => r.name === 'model').isCommand && rows.find((r) => r.name === 'status').isCommand);
  const dig = rows.find((r) => r.name === 'digest');
  ok('auto once per session, split by entrypoint', dig.auto === 2 && dig.interactive === 1 && dig.headless === 1);
  ok('a skill not on disk still counts (bundled skills have no SKILL.md)', dig.onDisk === false && dig.total === 2);
  ok('neverFired lists installed-but-silent', S.neverFired(rows, new Set(['triage', 'never-used'])).join() === 'never-used');
}

console.log('== claude reader: dialogue flags ==');
{
  const base = path.join(tmp, 'claude-dialogue');
  const sess = '22222222-2222-2222-2222-222222222222';
  writeFile(path.join(base, '-p', `${sess}.jsonl`), [
    mk({ type: 'user', timestamp: iso(0), cwd: '/p', entrypoint: 'cli', message: { role: 'user', content: 'hello' } }),
    mk({ type: 'user', timestamp: iso(1), isMeta: true, message: { role: 'user', content: '<system-reminder>x</system-reminder>' } }),
    mk({ type: 'user', timestamp: iso(2), message: { role: 'user', content: '<command-name>/model</command-name>' } }),
    mk({ type: 'user', timestamp: iso(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' }] }, toolUseResult: { filePath: '/p/a', structuredPatch: [{ lines: ['+a', '+b', '-c', ' d'] }] } }),
    mk({ type: 'assistant', timestamp: iso(4), attributionSkill: 'digest', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'tool_use', id: 'k', name: 'Skill', input: { skill: 'triage' } }] } }),
    mk({ type: 'system', timestamp: iso(5), subtype: 'compact_boundary' }),
  ]);
  const s = Claude.read({ dir: base }).sessions[0];
  ok('human prompt flagged; injected and echo are not', s.events.filter((e) => e.kind === 'user' && e.human).length === 1);
  ok('isMeta → injected', s.events.find((e) => e.t === T(1)).injected === true);
  ok('slash command captured without the slash', s.events.find((e) => e.t === T(2)).command === 'model');
  ok('structuredPatch → lines on the tool_result', s.events.find((e) => e.kind === 'tool_result').lines.added === 2 && s.events.find((e) => e.kind === 'tool_result').lines.removed === 1);
  ok('Skill tool call carries the skill name', s.events.find((e) => e.kind === 'tool_call').input.skill === 'triage');
  ok('<synthetic> model dropped', !s.events.find((e) => e.kind === 'assistant').model);
  ok('attributionSkill → autoSkills once', s.autoSkills.length === 1 && s.autoSkills[0].name === 'digest');
  ok('entrypoint from the entry', s.entrypoint === 'cli');
  ok('compact boundary → meta sub', s.events.some((e) => e.kind === 'meta' && e.sub === 'compact'));
  ok('chars recorded, text not kept', s.events.find((e) => e.human).chars === 5 && !('text' in s.events.find((e) => e.human)));
  // a headless run: its prompt is scripted, not human
  const hb = path.join(tmp, 'claude-headless');
  writeFile(path.join(hb, '-p', `${sess}.jsonl`), [
    mk({ type: 'user', timestamp: iso(0), cwd: '/p', entrypoint: 'sdk-cli', message: { role: 'user', content: 'run the digest' } }),
    mk({ type: 'assistant', timestamp: iso(1), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
  ]);
  const hs = Claude.read({ dir: hb }).sessions[0];
  ok('★ a headless run\'s prompt is scripted, not human', hs.events.filter((e) => e.human).length === 0 && hs.events.some((e) => e.scripted) && hs.entrypoint === 'sdk-cli');
  ok('… but still work: two stamps', M.workStamps(hs).length === 2);
}

console.log('== dialogue heuristics / attention ==');
{
  const D = require('../lib/dialogue.js');
  const A = require('../lib/metrics/attention.js');
  ok('askKind: status / approve / nudge / null', D.askKind('進んでる？') === 'status' && D.askKind('ok') === 'approve' && D.askKind('yes') === 'approve' && D.askKind('なんで止まってるの') === 'nudge' && D.askKind('lab の CI を直して') === null);
  ok('approve only when short', D.askKind('ok so what I want is a much longer request that explains things') === null);
  ok('isSelfFix ja/en', D.isSelfFix('先ほどの数字は誤りでした') && D.isSelfFix('I was wrong about that') && !D.isSelfFix('done'));
  ok('isSystemText: continuation summaries are not a person', D.isSystemText('This session is being continued from a previous conversation') && !D.isSystemText('hi'));
  const d1 = new Date(2026, 0, 5, 10).getTime(), d2 = new Date(2026, 0, 6, 10).getTime();
  const s = M.session({ agent: 'claude', id: 'a', events: [
    { t: d1, kind: 'user', human: true, chars: 20 },
    { t: d1 + 1000, kind: 'assistant', chars: 100 },
    { t: d1 + 2000, kind: 'assistant', chars: 100, fix: true },
    { t: d1 + 3000, kind: 'assistant', chars: 100 },
    { t: d1 + 4000, kind: 'assistant', chars: 100 },
    { t: d1 + 5000, kind: 'user', human: true, chars: 2, ask: 'approve' },
    { t: d1 + 6000, kind: 'assistant', chars: 50 },
    { t: d2, kind: 'user', human: true, chars: 30, ask: 'status' },
    { t: d2 + 1000, kind: 'user', injected: true },
  ] });
  const sub = M.session({ agent: 'claude', id: 'b', parentId: 'a', events: [{ t: d1, kind: 'user', human: true, chars: 9 }] });
  const rows = A.summarize([s, sub]);
  ok('two days, subagent ignored', rows.length === 2 && rows[0].key === '2026-01-05');
  ok('★ errand unit = session-day: 1 session, 2 utterances → 2.0 per session', rows[0].sessions === 1 && rows[0].you === 2 && rows[0].perSession === 2);
  ok('new-intent share excludes approvals', rows[0].newIntentShare === 50);
  ok('★ a 4-reply run before your next turn is a burst', rows[0].bursts === 1);
  ok('replies and self-fix attributed to the day you spoke', rows[0].agent === 5 && rows[0].fixes === 1 && rows[0].fixShare === 20);
  ok('status check counted', rows[1].status === 1 && rows[1].you === 1);
  ok('weekKey is Monday-start', A.weekKey(new Date(2026, 0, 7).getTime()) === '2026-01-05');
}

console.log('== tools: relapse classification ==');
{
  const c = (s) => Tools.classifyFailure({ sample: s });
  ok('quota beats input wording', c('rate limit: invalid arguments retry later').kind === 'quota');
  ok('auth', c('session expired, please login').kind === 'auth');
  ok('state (not guardable)', c('ENOENT: no such file or directory').guardable === false);
  ok('input (guardable)', c('InputValidationError: x must be a string').guardable === true);
  const g = Tools.guardCandidate({ clusters: [{ count: 9, sample: 'InputValidationError: must be' }, { count: 1, sample: 'timeout' }] });
  ok('★ guard candidate when one input cause dominates ≥80%', g.candidate === true);
  const g2 = Tools.guardCandidate({ clusters: [{ count: 5, sample: 'must be' }, { count: 5, sample: 'timeout' }] });
  ok('not a candidate when causes are split', g2.candidate === false && /converged/.test(g2.reason));
}

console.log('== guards (did it work?) ==');
{
  const G = require('../lib/metrics/guards.js');
  const cut = T(1000);
  const ev = (t, ok, text) => ({ t, agent: 'x', tool: 'Bash', ok, text: text || '' });
  const before = [ev(T(0), false, 'must be a string'), ev(T(1), false, 'must be a string'), ev(T(2), true), ev(T(3), true)];
  const afterFixed = Array.from({ length: 25 }, (_, i) => ev(T(2000 + i), true));
  const r = G.ratesAround(before.concat(afterFixed), { tool: 'Bash', cutoffMs: cut });
  ok('rates before/after', r.before.calls === 4 && r.before.rate === 50 && r.after.calls === 25 && r.after.rate === 0);
  ok('★ fixed only with ≥20 calls after', G.verdict(r).verdict === 'fixed');
  const thin = G.ratesAround(before.concat(afterFixed.slice(0, 3)), { tool: 'Bash', cutoffMs: cut });
  ok('★ 0 of 3 is "insufficient", not fixed', G.verdict(thin).verdict === 'insufficient');
  const worse = G.ratesAround(before.concat(Array.from({ length: 25 }, (_, i) => ev(T(2000 + i), i % 3 === 0, 'x'))), { tool: 'Bash', cutoffMs: cut });
  ok('worse when the rate rose (50% → 64%)', G.verdict(worse).verdict === 'worse');
  const same = G.ratesAround(before.concat(Array.from({ length: 25 }, (_, i) => ev(T(2000 + i), i % 2 === 0, 'x'))), { tool: 'Bash', cutoffMs: cut });
  ok('unchanged when within noise (50% → 48%)', G.verdict(same).verdict === 'unchanged');
  const sig = G.ratesAround(before.concat([ev(T(3000), false, 'timeout')].concat(afterFixed)), { tool: 'Bash', cutoffMs: cut, signature: Tools.signatureOf('must be a string') });
  ok('signature narrows the numerator, not the denominator', sig.after.errors === 0 && sig.after.calls === 26);
  ok('no baseline when nothing came before', G.verdict(G.ratesAround(afterFixed, { tool: 'Bash', cutoffMs: cut })).verdict === 'no-baseline');
  // from sessions: calls() pairs results to calls
  const s = M.session({ agent: 'x', id: 's', events: [
    { t: T(0), kind: 'tool_call', tool: 'Bash', callId: 'a' }, { t: T(1), kind: 'tool_result', callId: 'a', ok: false, text: 'boom' },
    { t: T(2), kind: 'tool_call', tool: 'Bash', callId: 'b' }, { t: T(3), kind: 'tool_result', callId: 'b', ok: true },
  ] });
  const c = G.calls([s]);
  ok('calls() pairs by callId', c.length === 2 && c[0].ok === false && c[0].text === 'boom' && c[1].ok === true);
  const file = path.join(tmp, 'guards.json');
  G.writeGuards([{ tool: 'Bash', since: new Date(cut).toISOString(), note: 'hook' }], file);
  ok('guards file round-trips', G.readGuards(file)[0].tool === 'Bash');
  const evald = G.evaluate(G.readGuards(file), [s]);
  ok('evaluate() attaches rates and a verdict', evald[0].rates.before.calls === 2 && evald[0].verdict === 'no-baseline' || evald[0].verdict === 'insufficient');
}

console.log('== advise (findings must be re-measurable) ==');
{
  const A = require('../lib/metrics/advise.js');
  // a tool failing 60% with one input cause, over 25 calls
  const ev = [];
  for (let i = 0; i < 25; i++) {
    ev.push({ t: T(i * 2), kind: 'tool_call', tool: 'mcp__x__y', callId: 'c' + i, op: 'outbound' });
    ev.push({ t: T(i * 2 + 1), kind: 'tool_result', callId: 'c' + i, ok: i >= 10, text: i >= 10 ? '' : 'Invalid arguments: x must be a string' });
  }
  const s = M.session({ agent: 'claude', id: 'a', entrypoint: 'cli', events: ev });
  const f = A.findings([s]);
  const g = f.find((x) => x.id === 'guard:mcp__x__y');
  ok('★ guard finding emitted with threshold, artifact and re-measure command', !!g && /≥15%/.test(g.threshold) && /PreToolUse/.test(g.artifact) && /guards/.test(g.remeasure));
  ok('severity ordering: high first', f[0].severity === 'high');
  ok('every finding carries a re-measure command', f.every((x) => x.remeasure));
  // the same tool failing on timeouts is not a guard candidate
  const ev2 = ev.map((e) => (e.kind === 'tool_result' && !e.ok ? { ...e, text: 'request timed out' } : e));
  const f2 = A.findings([M.session({ agent: 'claude', id: 'b', events: ev2 })]);
  ok('★ state failures get a flaky finding, no hook artifact', !f2.some((x) => x.id.startsWith('guard:')) && f2.some((x) => x.id === 'flaky:mcp__x__y' && !x.artifact));
  // model self-fix comparison
  const mk3 = (model, fixes, n) => Array.from({ length: n }, (_, i) => ({ t: T(5000 + i), kind: 'assistant', model, chars: 10, ...(i < fixes ? { fix: true } : {}) }));
  const ms = M.session({ agent: 'claude', id: 'm', events: mk3('claude-sonnet-5', 10, 60).concat(mk3('claude-opus-5', 1, 60)) });
  const mf = A.modelFixRates([ms], -Infinity, Infinity);
  ok('model fix rates computed per family', mf[0].model === 'sonnet' && mf[0].rate === 16.7 && mf[1].rate === 1.7);
  ok('★ self-fix finding when one model is ≥2× the other', A.findings([ms]).some((x) => x.id === 'models:self-fix'));
  ok('quiet data → no findings (that is a result)', A.findings([M.session({ agent: 'x', id: 'q', events: [{ t: T(0), kind: 'user', human: true }] })]).length === 0);
}

console.log('== overlap (two sessions, one file) ==');
{
  const O = require('../lib/metrics/overlap.js');
  const w = (t, p) => ({ t, kind: 'tool_call', tool: 'Edit', op: 'write', input: { path: p }, callId: 'c' + t });
  const a = M.session({ agent: 'claude', id: 'A', entrypoint: 'cli', events: [w(T(0), '/r/x.js'), w(T(100), '/r/y.js')] });
  const b = M.session({ agent: 'codex', id: 'B', entrypoint: 'cli', events: [w(T(600), '/r/x.js')] });
  const sub = M.session({ agent: 'claude', id: 'A-sub', parentId: 'A', events: [w(T(30), '/r/y.js')] });
  const far = M.session({ agent: 'claude', id: 'C', events: [w(T(5000), '/r/x.js')] });
  const cols = O.collisions([a, b, sub, far], { windowMin: 30 });
  ok('★ x.js written by A then B 10 min later is one collision', cols.length === 1 && cols[0].path === '/r/x.js' && cols[0].pairs === 1 && cols[0].minGapMin === 10);
  ok('★ a subagent writing its parent\'s file is not a collision', !cols.some((c) => c.path === '/r/y.js'));
  ok('a write 80 min later is outside a 30-min window', cols[0].sessions === 3 && cols[0].pairs === 1);
  ok('wider window catches it', O.collisions([a, b, sub, far], { windowMin: 120 })[0].pairs === 2);
  ok('examples name both sessions and the gap', cols[0].examples[0].a.session === 'claude:A' && cols[0].examples[0].b.session === 'codex:B');
}

console.log('== waits (who waited for whom) ==');
{
  const W = require('../lib/metrics/waits.js');
  const s = M.session({ agent: 'claude', id: 'w', entrypoint: 'cli', events: [
    { t: T(0), kind: 'user', human: true },            // you speak
    { t: T(20), kind: 'assistant' },                    // you waited 20 s
    { t: T(25), kind: 'assistant' },
    { t: T(25), kind: 'tool_call', tool: 'Bash', callId: 'p' },
    { t: T(300), kind: 'user' },                        // the result, 275 s later: a permission prompt or a slow tool
    { t: T(300), kind: 'tool_result', callId: 'p', ok: true },
    { t: T(301), kind: 'assistant' },                   // the reply
    { t: T(325), kind: 'user', human: true },           // agent waited 24 s for you
    { t: T(330), kind: 'assistant' },                   // you waited 5 s
    { t: T(30000), kind: 'user', human: true },         // 8h later: capped out, not counted
  ] });
  const head = M.session({ agent: 'claude', id: 'h', entrypoint: 'sdk-cli', events: [{ t: T(0), kind: 'user', human: true }, { t: T(50), kind: 'assistant' }] });
  const r = W.summarize([s, head]);
  ok('★ you waited 20 s + 5 s over two turns', Math.round(r.total.youWaitedS) === 25 && r.total.youWaits === 2 && Math.round(r.total.youLongestS) === 20);
  ok('★ the agent waited 24 s for your next turn, once', Math.round(r.total.agentWaitedS) === 24 && r.total.agentWaits === 1);
  ok('★ the tool call that took 275 s to come back is a tool wait', Math.round(r.total.toolWaitedS) === 275 && r.total.toolWaits === 1);
  ok('gaps over the cap are not waits (you had left)', r.total.agentWaits === 1);
  ok('headless sessions never wait on a person', r.rows.length === 1);
  const byAgent = W.summarize([s], { keyOf: (t, sess) => sess.agent });
  ok('keyOf can group by agent', byAgent.rows[0].key === 'claude');
}

console.log('== a locked Cursor database ==');
{
  let sqlite = null;
  try { sqlite = require('node:sqlite'); } catch (e) { sqlite = null; }
  if (!sqlite) console.log('  (node:sqlite unavailable — skipped)');
  else {
    const dir = path.join(tmp, 'cursor-locked');
    fs.mkdirSync(dir, { recursive: true });
    const db = new sqlite.DatabaseSync(path.join(dir, 'state.vscdb'));
    db.exec('create table cursorDiskKV (key text primary key, value blob)');
    db.prepare('insert into cursorDiskKV values (?, ?)').run('composerData:c1', JSON.stringify({ createdAt: T(0) }));
    db.exec("BEGIN EXCLUSIVE; insert into cursorDiskKV values ('composerData:c2', '{}');"); // held, as Cursor does mid-write
    const bin = path.join(__dirname, '..', 'bin', 'agstats.js');
    const dirArgs = ['--dir', `claude=${path.join(tmp, 'claude')}`, '--dir', `codex=${path.join(tmp, 'nope')}`, '--dir', `gemini=${path.join(tmp, 'nope')}`, '--dir', `cursor=${dir}`];
    const run = (args) => { try { return { code: 0, out: execFileSync('node', [bin, ...args, ...dirArgs], { encoding: 'utf8', stdio: 'pipe' }) }; } catch (e) { return { code: e.status, out: e.stdout, err: e.stderr }; } };
    const ag = run(['agents', '--json']);
    const rows = ag.code === 0 ? JSON.parse(ag.out) : [];
    ok('★ locked Cursor DB: agents exits 0 and reports the lock as cursor\'s error', ag.code === 0 && /locked/.test((rows.find((r) => r.agent === 'cursor') || {}).error || ''));
    ok('★ locked Cursor DB: the other agents are still reported', (rows.find((r) => r.agent === 'claude') || {}).sessions === 2);
    ok('locked Cursor DB: hours still measures claude', run(['hours', '--json', '--all']).code === 0);
    const lk = run(['leaks', '--json']);
    ok('★ locked Cursor DB: leaks exits 3 (incomplete), not 1 (findings), and names the unread source', lk.code === 3 && JSON.parse(lk.out).unreadable.length === 1);
    db.exec('ROLLBACK');
    db.close();
  }
}

console.log('== day labels are local, like the buckets (TZ=Asia/Tokyo) ==');
{
  // 2026-09-19 20:00 UTC = 2026-09-20 05:00 in Tokyo: every label must say the 20th.
  const base = path.join(tmp, 'tz', 'claude');
  const at = (s) => new Date(Date.UTC(2026, 8, 19, 20, 0, s)).toISOString();
  const line = (type, s, content, extra) => mk({ type, timestamp: at(s), cwd: '/work/p', entrypoint: 'cli', message: { role: type, content }, ...extra });
  const use = (id, name, input) => [{ type: 'tool_use', id, name, input }];
  writeFile(path.join(base, '-work-p', 'aaaaaaaa-0000-0000-0000-000000000001.jsonl'), [
    line('user', 0, 'ship it'),
    line('assistant', 5, use('t1', 'Bash', { command: 'git push origin main' })),
    line('assistant', 10, use('t2', 'Write', { file_path: '/work/p/a.txt', content: 'x' })),
  ]);
  writeFile(path.join(base, '-work-p', 'aaaaaaaa-0000-0000-0000-000000000002.jsonl'), [
    line('user', 300, 'again'),
    line('assistant', 305, use('t3', 'Write', { file_path: '/work/p/a.txt', content: 'y' })),
  ]);
  const bin = path.join(__dirname, '..', 'bin', 'agstats.js');
  const nope = path.join(tmp, 'nope');
  const env = { ...process.env, TZ: 'Asia/Tokyo', AGSTATS_GUARDS: path.join(tmp, 'tz', 'guards.json') };
  const run = (args) => execFileSync('node', [bin, ...args, '--dir', `claude=${base}`, '--dir', `codex=${nope}`, '--dir', `gemini=${nope}`, '--dir', `cursor=${nope}`], { encoding: 'utf8', env });
  const ag = JSON.parse(run(['agents', '--json'])).find((a) => a.agent === 'claude');
  ok('★ TZ: agents first/last name the local day', ag.first === '2026-09-20' && ag.last === '2026-09-20');
  ok('★ TZ: hours --json daily[].date is the local day', JSON.parse(run(['hours', '--json', '--all'])).daily.map((d) => d.date).join() === '2026-09-20');
  ok('TZ: hours daily table row is the local day', /2026-09-20/.test(run(['hours', '--all'])) && !/2026-09-19/.test(run(['hours', '--all'])));
  ok('★ TZ: blast busiestDay is the local day', JSON.parse(run(['blast', '--json', '--all'])).busiestDay[0] === '2026-09-20');
  ok('TZ: blast --list example dates are local', /2026-09-20\s+claude/.test(run(['blast', '--all', '--list'])));
  ok('TZ: overlap example timestamp is local', /2026-09-20 05:0\d/.test(run(['overlap', '--all', '--window', '30'])));
  const added = run(['guards', 'add', 'Bash', '--since', '20260920']);
  const g = JSON.parse(fs.readFileSync(env.AGSTATS_GUARDS, 'utf8'))[0];
  ok('★ TZ: guards add --since 20260920 says and stores the 20th, at local midnight', /since 2026-09-20/.test(added) && g.since.startsWith('2026-09-20') && Date.parse(g.since) === Date.UTC(2026, 8, 19, 15));
}

console.log('== runtime-written user turns are not prompts ==');
{
  const tags = ['<task-notification>\n<status>completed</status>\n</task-notification>', '<bash-input>git status</bash-input>',
    '<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>', '<local-command-stdout>ok</local-command-stdout>', '<command-message>draft</command-message>\n<command-name>/draft</command-name>'];
  const cbase = path.join(tmp, 'inj', 'claude');
  writeFile(path.join(cbase, '-p', 'aaaaaaaa-0000-0000-0000-00000000000a.jsonl'), [
    mk({ type: 'user', timestamp: iso(0), cwd: '/p', entrypoint: 'cli', message: { role: 'user', content: 'please fix the bug' } }),
    ...tags.map((txt, i) => mk({ type: 'user', timestamp: iso(1 + i), cwd: '/p', entrypoint: 'cli', message: { role: 'user', content: txt } })),
  ]);
  const cs = Claude.read({ dir: cbase }).sessions[0];
  ok('★ claude: task-notification / bash-* / command echoes are not human turns', cs.events.filter((e) => e.human).length === 1);
  ok('claude: the slash command is still recorded', cs.events.some((e) => e.command === 'draft'));
  const xbase = path.join(tmp, 'inj', 'codex');
  const msg = (s, text) => mk({ timestamp: iso(s), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  writeFile(path.join(xbase, '2026', '01', '01', 'rollout-2026-01-01T12-00-00-cccccccc-0000-0000-0000-00000000000a.jsonl'), [
    mk({ timestamp: iso(0), type: 'session_meta', payload: { id: 'cccccccc-0000-0000-0000-00000000000a', cwd: '/p', originator: 'Codex Desktop' } }),
    msg(1, 'please fix the bug'),
    ...tags.map((txt, i) => msg(2 + i, txt)),
  ]);
  const xs = Codex.read({ dir: xbase }).sessions[0];
  ok('★ codex: the same runtime tags are injected, not human', xs.events.filter((e) => e.human).length === 1 && xs.events.filter((e) => e.injected).length === tags.length);
}

console.log('== --json with nothing to report is still JSON ==');
{
  const bin = path.join(__dirname, '..', 'bin', 'agstats.js');
  const nope = path.join(tmp, 'nope');
  const env = { ...process.env, AGSTATS_GUARDS: path.join(tmp, 'empty-guards.json') };
  const dirArgs = ['--dir', `claude=${nope}`, '--dir', `codex=${nope}`, '--dir', `gemini=${nope}`, '--dir', `cursor=${nope}`];
  const isJson = (args) => { try { JSON.parse(execFileSync('node', [bin, ...args, '--json', ...dirArgs], { encoding: 'utf8', env })); return true; } catch (e) { return false; } };
  for (const args of [['hours'], ['hours', '--card'], ['hours', '--monthly'], ['hours', '--by-project'], ['hours', '--caps'], ['timeline'], ['guards']]) {
    ok(`★ empty data: ${args.join(' ')} --json parses as JSON`, isJson(args));
  }
}

console.log('== --agent / --dir are validated ==');
{
  const bin = path.join(__dirname, '..', 'bin', 'agstats.js');
  const nope = path.join(tmp, 'nope');
  const res = (args) => { try { execFileSync('node', [bin, ...args], { encoding: 'utf8', stdio: 'pipe' }); return { code: 0, err: '' }; } catch (e) { return { code: e.status, err: e.stderr }; } };
  const base = ['hours', '--json', '--dir', `claude=${nope}`, '--dir', `codex=${nope}`, '--dir', `gemini=${nope}`, '--dir', `cursor=${nope}`];
  const typo = res([...base, '--agent', 'claud']);
  ok('★ --agent with an unknown name exits 2 and lists the valid names', typo.code === 2 && Readers.NAMES.every((x) => typo.err.includes(x)));
  ok('--agent with an empty value exits 2', res([...base, '--agent', '']).code === 2);
  ok('★ --dir without "=" exits 2', res([...base, '--dir', 'claude']).code === 2);
  ok('★ --dir with an unknown agent exits 2', res([...base, '--dir', `nope=${nope}`]).code === 2);
  ok('--dir with an empty path exits 2', res([...base, '--dir', 'claude=']).code === 2);
  let threw = false;
  try { Readers.readAll({ only: ['claud'], dirs: { claude: nope } }); } catch (e) { threw = /unknown agent/.test(e.message); }
  ok('library: readAll refuses an unknown agent name', threw);
}

console.log('== blast matches the command, not text that mentions it ==');
{
  const k = (command) => { const r = Blast.classifyCall({ op: 'shell', input: { command } }, () => true); return r.key || r.kind; };
  ok('★ gcloud run services list is not a deploy', k('gcloud run services list --project p') === 'contained');
  ok('★ grep for "npm publish" is not a publish', k('grep -rn "npm publish" docs/') === 'contained');
  ok('★ grep for crontab is not a system change', k('grep -rn crontab .') === 'contained');
  ok('★ echoing a curl POST into a file is not a network write', k('echo "curl -X POST https://x" > notes.md') === 'contained');
  ok('★ rm -rf under /tmp is ephemeral, not destroy', k('rm -rf /tmp/scratch') === 'ephemeral' && k('rm -rf "$TMPDIR/scratch"') === 'ephemeral');
  ok('rm -rf of /tmp itself, or of anything outside it, still destroys', k('rm -rf /tmp') === 'destroy' && k('rm -rf /tmp/a /Users/me/b') === 'destroy' && k('rm -rf build') === 'destroy');
  ok('a heredoc body is data: its text is not a command', k("cat > x.yml <<'EOF'\nrun: gh pr merge --squash; it's fine\nEOF\nls") === 'contained');
  ok('still caught after &&, ;, |, sudo, VAR=, timeout and a full path',
    k('cd x && git push origin main') === 'push' && k('make; npm publish') === 'publish' && k('ls | xargs rm -rf') === 'destroy'
    && k('sudo npm install -g x') === 'install' && k('FOO=1 timeout 60 git push') === 'push' && k('/opt/sdk/bin/gcloud beta run services update s') === 'deploy');
  ok('real infra verbs still count, with any number of subcommand words', k('gcloud run deploy svc --image i') === 'deploy' && k('gcloud iam service-accounts create sa') === 'deploy' && k('kubectl run nginx --image=nginx') === 'deploy');
  ok('curl -D (dump headers) is not --data; -d and -X POST are', k('curl -s -D - https://x') === 'contained' && k('curl -d a=1 https://x') === 'network' && k('curl -X POST https://x') === 'network');
}

console.log('== blast: a path that is gone is unknown, not escaped ==');
{
  // A worktree removed after the session: no .git any more, and no file either.
  const gone = '/nonexistent-agstats/repo-worktrees/feature/src/a.js';
  const kept = __filename; // exists; treated as untracked below
  const s = M.session({ agent: 'x', id: 's', events: [
    { t: T(0), kind: 'tool_call', tool: 'Write', op: 'write', input: { path: gone } },
    { t: T(1), kind: 'tool_call', tool: 'Write', op: 'write', input: { path: kept } },
  ] });
  const r = Blast.summarize([s], -Infinity, Infinity, { isTracked: () => false });
  ok('★ a write to a path that no longer exists is not counted as escaped', r.escaped === 1 && r.contained === 1);
  ok('an untracked file that still exists still escapes', r.categories[0].samples[0].detail === kept);
}

console.log('== leaks: scan and scrub agree on secrets after an escaped newline ==');
{
  const pat = 'ghp_' + 'B'.repeat(36), akid = 'AKIA' + 'C'.repeat(16);
  const f = path.join(tmp, 'leak-escaped.jsonl');
  writeFile(f, [mk({ type: 'user', message: { content: `first line\n${pat}` } }), mk({ type: 'assistant', message: { content: `key\t${akid}` } })]);
  const scanned = Leaks.scan([{ agent: 'claude', file: f, project: 'p', scrubbable: true }]).findings;
  const scrubbed = Leaks.scrubContent(fs.readFileSync(f, 'utf8'), Leaks.RULES).hits;
  ok('★ a secret right after \\n or \\t in raw JSONL is found by scan', scanned.length === 2);
  ok('★ scan and scrub report the same secrets', scanned.map((x) => x.rule).sort().join() === scrubbed.map((x) => x.ruleId).sort().join());
}

console.log('== period flags are honoured or refused, never ignored ==');
{
  const bin = path.join(__dirname, '..', 'bin', 'agstats.js');
  const nope = path.join(tmp, 'nope');
  // two sessions on two local days: 2026-03-01 and 2026-03-10
  const base = path.join(tmp, 'period', 'claude');
  const at = (d, s) => new Date(2026, 2, d, 12, 0, s).toISOString();
  for (const d of [1, 10]) {
    writeFile(path.join(base, '-p', `aaaaaaaa-0000-0000-0000-0000000000${String(d).padStart(2, '0')}.jsonl`), [
      mk({ type: 'user', timestamp: at(d, 0), cwd: '/p', message: { role: 'user', content: 'go' } }),
      mk({ type: 'assistant', timestamp: at(d, 5), message: { role: 'assistant', content: [] } }),
    ]);
  }
  const dirArgs = ['--dir', `claude=${base}`, '--dir', `codex=${nope}`, '--dir', `gemini=${nope}`, '--dir', `cursor=${nope}`];
  const run = (args) => { try { return { code: 0, out: execFileSync('node', [bin, ...args, ...dirArgs], { encoding: 'utf8', stdio: 'pipe' }) }; } catch (e) { return { code: e.status, out: e.stdout }; } };
  const days = (args) => JSON.parse(run(['timeline', '--json', ...args]).out).days.map((d) => d.day).join();
  ok('★ timeline --since leaves out earlier days', days(['--since', '20260305']) === '2026-03-10');
  ok('★ timeline --until leaves out later days', days(['--until', '20260305']) === '2026-03-01');
  ok('timeline without a period still shows everything', days([]) === '2026-03-01,2026-03-10');
  ok('★ --since after --until exits 2', run(['hours', '--since', '20260310', '--until', '20260301']).code === 2);
  ok('★ negative --weeks / --window / --idle-gap exit 2', run(['timeline', '--weeks', '-3']).code === 2 && run(['overlap', '--window', '-1']).code === 2 && run(['hours', '--idle-gap', '-5']).code === 2);
  // leaks: a file last modified long ago is outside --since; --until cannot be honoured per file
  const lk = path.join(tmp, 'period-leaks', 'claude');
  const old = path.join(lk, '-p', 'bbbbbbbb-0000-0000-0000-000000000001.jsonl');
  writeFile(old, [mk({ type: 'user', message: { content: 'ghp_' + 'D'.repeat(36) } })]);
  const past = new Date(2026, 0, 1).getTime() / 1000;
  fs.utimesSync(old, past, past);
  const lkArgs = ['--dir', `claude=${lk}`, '--dir', `codex=${nope}`, '--dir', `gemini=${nope}`, '--dir', `cursor=${nope}`];
  const lcode = (args) => { try { execFileSync('node', [bin, 'leaks', ...args, ...lkArgs], { stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
  ok('★ leaks --since skips files untouched since then', lcode(['--since', '20260201']) === 0 && lcode(['--since', '20251201']) === 1);
  ok('★ leaks --until is refused (exit 2), not ignored', lcode(['--until', '20260201']) === 2);
}

console.log('== hours --svg ==');
{
  const bin = path.join(__dirname, '..', 'bin', 'agstats.js');
  const nope = path.join(tmp, 'nope');
  const cwd = path.join(tmp, 'svg');
  fs.mkdirSync(cwd, { recursive: true });
  const dirArgs = ['--dir', `claude=${path.join(tmp, 'claude')}`, '--dir', `codex=${nope}`, '--dir', `gemini=${nope}`, '--dir', `cursor=${nope}`];
  const run = (args) => { try { return { code: 0, out: execFileSync('node', [bin, ...args, ...dirArgs], { encoding: 'utf8', stdio: 'pipe', cwd }) }; } catch (e) { return { code: e.status, out: e.stdout, err: e.stderr }; } };
  const missing = run(['hours', '--svg', path.join(cwd, 'no-such-dir', 'card.svg')]);
  ok('★ --svg into a missing directory: clean message, exit 2, no stack trace', missing.code === 2 && /does not exist/.test(missing.err) && !/\n\s+at /.test(missing.err));
  const isDir = run(['hours', '--svg', cwd]);
  ok('★ --svg onto a directory: clean message, exit 2', isDir.code === 2 && /is a directory/.test(isDir.err) && !/\n\s+at /.test(isDir.err));
  const pos = run(['--svg', 'hours']);
  ok('★ `--svg hours` keeps hours as the command and writes the default file', pos.code === 0 && fs.existsSync(path.join(cwd, 'agstats.svg')) && !fs.existsSync(path.join(cwd, 'hours')));
  const both = run(['hours', '--svg', 'x.svg', '--json']);
  ok('★ --svg with --json writes the file and prints JSON', both.code === 0 && fs.existsSync(path.join(cwd, 'x.svg')) && JSON.parse(both.out).svg === 'x.svg');
}

console.log('== guards keep the user note; rm needs a tool ==');
{
  const G = require('../lib/metrics/guards.js');
  const s = M.session({ agent: 'claude', id: 'g', events: [{ t: T(0), kind: 'tool_call', tool: 'Bash', callId: 'a' }] });
  const r = G.evaluate([{ tool: 'Bash', since: iso(10), note: 'added a PreToolUse hook' }], [s])[0];
  ok('★ evaluate keeps the registered note and puts the verdict text in its own field', r.note === 'added a PreToolUse hook' && /call/.test(r.reason));
  const bin = path.join(__dirname, '..', 'bin', 'agstats.js');
  const file = path.join(tmp, 'guards-rm.json');
  fs.writeFileSync(file, JSON.stringify([{ tool: 'Bash', since: iso(0) }]));
  const before = fs.readFileSync(file, 'utf8');
  let code = 0, out = '';
  try { out = execFileSync('node', [bin, 'guards', 'rm', '--dir', `claude=${path.join(tmp, 'nope')}`], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, AGSTATS_GUARDS: file } }); } catch (e) { code = e.status; out = e.stdout; }
  ok('★ guards rm without a tool exits 2, prints no "for null", and leaves the file alone', code === 2 && !/null/.test(out) && fs.readFileSync(file, 'utf8') === before);
}

console.log('== diff: "new" needs evidence, self-undo cannot pass 100% ==');
{
  const D = require('../lib/metrics/diff.js');
  // A Write over an existing 200-line file with 5 lines, then an edit: the
  // 200 removed lines were never this session's.
  const s = M.session({ agent: 'claude', id: 'd2', project: '/repo', events: [
    { t: T(0), kind: 'tool_call', tool: 'Write', callId: 'w', op: 'write', input: { path: '/repo/old.js' } },
    { t: T(1), kind: 'tool_result', callId: 'w', ok: true, lines: { added: 5, removed: 200 } },
    { t: T(2), kind: 'tool_call', tool: 'Write', callId: 'n', op: 'write', input: { path: '/repo/new.js' } },
    { t: T(3), kind: 'tool_result', callId: 'n', ok: true, created: true, lines: { added: 10, removed: 0 } },
    { t: T(4), kind: 'tool_call', tool: 'Edit', callId: 'e', op: 'write', input: { path: '/repo/new.js' } },
    { t: T(5), kind: 'tool_result', callId: 'e', ok: true, lines: { added: 1, removed: 4 } },
  ] });
  const r = D.collectChanges(s);
  ok('★ a Write with no creation evidence is not "new"', r.files.find((f) => f.path === '/repo/old.js').created === false);
  ok('a Write the result calls a create is new', r.files.find((f) => f.path === '/repo/new.js').created === true);
  ok('★ self-undo counts only removals from files it created, never over 100%', Math.abs(r.lines.selfUndo - 4 / 16) < 1e-9);
  const base = path.join(tmp, 'diff-claude');
  writeFile(path.join(base, '-repo', 'dddddddd-0000-0000-0000-000000000001.jsonl'), [
    mk({ type: 'assistant', timestamp: iso(0), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/repo/a.js' } }, { type: 'tool_use', id: 'w2', name: 'Write', input: { file_path: '/repo/b.js' } }] } }),
    mk({ type: 'user', timestamp: iso(1), toolUseResult: { type: 'create', filePath: '/repo/a.js', structuredPatch: [] }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1' }] } }),
    mk({ type: 'user', timestamp: iso(2), toolUseResult: { type: 'update', filePath: '/repo/b.js', structuredPatch: [] }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w2' }] } }),
  ]);
  const res = Claude.read({ dir: base }).sessions[0].events.filter((e) => e.kind === 'tool_result');
  ok('claude reader: Write result type create → created, update → not', res.find((e) => e.callId === 'w1').created === true && !res.find((e) => e.callId === 'w2').created);
}

console.log('== tools: long names stay distinct ==');
{
  const a = 'mcp__claude-in-chrome__tabs_context_mcp', b = 'mcp__claude-in-chrome__tabs_create_mcp';
  const base = path.join(tmp, 'longnames', 'claude');
  writeFile(path.join(base, '-p', 'eeeeeeee-0000-0000-0000-000000000001.jsonl'), [
    mk({ type: 'assistant', timestamp: iso(0), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x1', name: a, input: {} }, { type: 'tool_use', id: 'x2', name: b, input: {} }] } }),
  ]);
  const bin = path.join(__dirname, '..', 'bin', 'agstats.js');
  const nope = path.join(tmp, 'nope');
  const out = execFileSync('node', [bin, 'tools', '--all', '--dir', `claude=${base}`, '--dir', `codex=${nope}`, '--dir', `gemini=${nope}`, '--dir', `cursor=${nope}`], { encoding: 'utf8' });
  const rows = out.split('\n').filter((l) => l.includes('mcp__')).map((l) => l.split('│')[1].trim());
  ok('★ two tools sharing a long prefix print as two different names', rows.length === 2 && rows[0] !== rows[1]);
}

console.log('== nothing installed / nothing said: say so ==');
{
  const bin = path.join(__dirname, '..', 'bin', 'agstats.js');
  const nope = path.join(tmp, 'nope');
  const none = ['--dir', `claude=${nope}`, '--dir', `codex=${nope}`, '--dir', `gemini=${nope}`, '--dir', `cursor=${nope}`];
  const run = (args, dirArgs = none) => { try { return execFileSync('node', [bin, ...args, ...dirArgs], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { return e.stdout; } };
  ok('★ advise with no agents says there was nothing to read, not "nothing crossed a threshold"', /nothing to read/.test(run(['advise'])) && !/threshold/.test(run(['advise'])));
  ok('★ leaks with no agents says there was nothing to scan, not "clean"', /nothing to scan/.test(run(['leaks'])) && !/clean/.test(run(['leaks'])));
  // a session with replies but no human prompt
  const base = path.join(tmp, 'noprompt', 'claude');
  writeFile(path.join(base, '-p', 'ffffffff-0000-0000-0000-000000000001.jsonl'), [
    mk({ type: 'assistant', timestamp: iso(0), message: { role: 'assistant', content: [] } }),
    mk({ type: 'assistant', timestamp: iso(5), message: { role: 'assistant', content: [] } }),
  ]);
  const st = run(['stats', '--all'], ['--dir', `claude=${base}`, '--dir', `codex=${nope}`, '--dir', `gemini=${nope}`, '--dir', `cursor=${nope}`]);
  ok('★ stats with 0 prompts prints no "peak: 0:00 / Sun"', /prompts 0/.test(st) && !/peak:/.test(st));
  const Stats = require('../lib/metrics/stats.js');
  ok('stats: peakHour / peakDow are null with no prompts', Stats.summarize([M.session({ agent: 'x', id: 'y', events: [{ t: T(0), kind: 'assistant' }] })]).peakHour === null);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  ok('package.json points at the GitHub repository', /github\.com\/sue738\/agstats/.test(pkg.repository.url) && /sue738\/agstats/.test(pkg.homepage) && /sue738\/agstats\/issues/.test(pkg.bugs.url));
  const help = run(['--help']);
  ok('★ --help names every writer', ['hours --svg', 'quota --set', 'guards add', 'leaks scrub'].every((w) => help.includes(w)));
}

console.log('== cclogsall archive (--archive) ==');
{
  const zlib = require('zlib');
  const live = path.join(tmp, 'arch', 'live');
  const arch = path.join(tmp, 'arch', 'cclogsall');
  const s1 = 'bbbbbbbb-0000-0000-0000-000000000001', s2 = 'bbbbbbbb-0000-0000-0000-000000000002';
  const turn = (a, b) => [
    mk({ type: 'user', timestamp: iso(a), cwd: '/p', message: { role: 'user', content: 'go' } }),
    mk({ type: 'assistant', timestamp: iso(b), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
  ];
  const gz = (rel, lines) => { const f = path.join(arch, 'projects', rel + '.gz'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, zlib.gzipSync(lines.join('\n') + '\n')); };
  // s1 is live (0..10s) and also archived as an older, shorter copy (0..4s): live must win
  writeFile(path.join(live, '-p', `${s1}.jsonl`), turn(0, 10));
  gz(`-p/${s1}.jsonl`, turn(0, 4));
  // s2 and its subagent exist only in the archive: Claude Code already deleted them
  gz(`-p/${s2}.jsonl`, turn(100, 120));
  gz(`-p/${s2}/subagents/agent-z.jsonl`, turn(105, 111));
  // a truncated archive file is skipped, not a crash
  fs.writeFileSync(path.join(arch, 'projects', '-p', 'cccccccc-0000-0000-0000-000000000003.jsonl.gz'), Buffer.from([0x1f, 0x8b, 0x08, 0x00, 1, 2]));
  fs.writeFileSync(path.join(arch, 'manifest.json'), '{"version":1,"entries":{}}');

  ok('without an archive: only the live session', Claude.read({ dir: live }).sessions.length === 1);
  const r = Claude.read({ dir: live, archive: arch });
  const one = r.sessions.find((x) => x.id === s1), two = r.sessions.find((x) => x.id === s2), sub = r.sessions.find((x) => x.id === 'agent-z');
  ok('with the archive: live + the archived session + its subagent', r.sessions.length === 3 && two && sub);
  ok('★ live wins: the session in both is read from the live file, not the older copy', one && !one.archived && one.events[one.events.length - 1].t === T(10) && r.archive.duplicates === 1);
  ok('archived sessions are flagged and keep their .gz as file', two.archived && two.file.endsWith('.jsonl.gz') && sub.archived);
  ok('★ an archived subagent pairs with its archived parent', sub.parentId === s2);
  ok('an unreadable .gz is counted and skipped', r.archive.unreadable === 1 && r.archive.sessions === 2);
  ok('project comes from the archived transcript itself', two.project === '/p');

  const bin = path.join(__dirname, '..', 'bin', 'agstats.js');
  const nope = path.join(tmp, 'nope');
  const dirArgs = ['--dir', `claude=${live}`, '--dir', `codex=${nope}`, '--dir', `gemini=${nope}`, '--dir', `cursor=${nope}`];
  const run = (args, env = {}) => { try { return { code: 0, out: execFileSync('node', [bin, ...args, ...dirArgs], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env } }) }; } catch (e) { return { code: e.status, out: e.stdout, err: e.stderr }; } };
  const h0 = JSON.parse(run(['hours', '--json', '--all']).out), h1 = JSON.parse(run(['hours', '--json', '--all', '--archive', arch]).out);
  // live s1: 10s. archive adds s2 100..120 (20s) + its subagent 105..111 (6s)
  ok('★ hours --archive adds exactly the archived sessions (10s → 36s)', Math.round(h0.agentHours * 3600) === 10 && Math.round(h1.agentHours * 3600) === 36);
  const a0 = JSON.parse(run(['agents', '--json'], { CCLOGSALL_OUT: arch }).out).find((x) => x.agent === 'claude');
  ok('★ agents mentions an archive that exists but is not being read', a0.archive && a0.archive.read === false && a0.archive.files === 4 && a0.sessions === 1);
  ok('agents text says how to read it', /not being read — --archive/.test(run(['agents'], { CCLOGSALL_OUT: arch }).out));
  const a1 = JSON.parse(run(['agents', '--json', '--archive'], { CCLOGSALL_OUT: arch }).out).find((x) => x.agent === 'claude');
  ok('★ bare --archive reads the default archive; agents reports what it added', a1.archive.read === true && a1.archive.sessions === 2 && a1.archive.duplicates === 1 && a1.sessions === 3);
  ok('no archive anywhere: agents says nothing about one', JSON.parse(run(['agents', '--json']).out).find((x) => x.agent === 'claude').archive === null);
  ok('`--archive hours` is the default archive plus the command', run(['--archive', 'hours', '--json', '--all'], { CCLOGSALL_OUT: arch }).code === 0);
  ok('★ --archive at a directory with no archive exits 2 instead of reading nothing', run(['hours', '--archive', path.join(tmp, 'no-such-archive')]).code === 2);
  ok('--archive with --agent that leaves claude out is refused', run(['hours', '--archive', arch, '--agent', 'codex']).code === 2);
  ok('leaks --archive is refused (scrub cannot rewrite gzip)', run(['leaks', '--archive', arch]).code === 2);
  ok('the archive is read, never written', fs.readdirSync(path.join(arch, 'projects', '-p')).length === 4 && fs.readFileSync(path.join(arch, 'manifest.json'), 'utf8') === '{"version":1,"entries":{}}');
}

console.log('== retention: when Claude Code deletes what is here (cclogsall diagnose) ==');
{
  const home = path.join(tmp, 'ret', 'home');
  const projects = path.join(home, 'projects');
  const now = Date.now(), day = 86400000;
  const put = (rel, ageDays) => { const f = path.join(projects, rel); writeFile(f, [mk({ type: 'user', timestamp: new Date(now - ageDays * day).toISOString(), message: { content: 'x' } })]); const t = (now - ageDays * day) / 1000; fs.utimesSync(f, t, t); };
  put('-p/a.jsonl', 28.5); put('-p/b.jsonl', 25); put('-p/b/subagents/agent-1.jsonl', 24); put('-p/c.jsonl', 1);
  fs.writeFileSync(path.join(home, 'settings.json'), '{"theme":"dark"}');
  const r = Claude.retention({ dir: projects, now });
  ok('★ default 30 days when settings.json does not set it', r.periodDays === 30 && r.source === 'default');
  ok('★ oldest (28.5 days old) is deleted in 1 day', r.expiresInDays === 1 && r.oldest === M.dayKey(now - 28.5 * day) && r.deletesOn === M.dayKey(now - 28.5 * day + 30 * day));
  ok('★ 3 files (subagent included) expire within 7 days, the fresh one does not', r.expiringWithin7d === 3 && r.sessions === 4);
  fs.writeFileSync(path.join(home, 'settings.json'), '{"cleanupPeriodDays":10}');
  const past = Claude.retention({ dir: projects, now });
  ok('cleanupPeriodDays from settings.json; past the limit reads as ≤ 0', past.periodDays === 10 && past.source === 'settings' && past.expiresInDays <= 0 && past.expiringWithin7d === 3);
  fs.writeFileSync(path.join(home, 'settings.json'), '{"cleanupPeriodDays":3650}');
  ok('long retention is flagged', Claude.retention({ dir: projects, now }).longRetention === true);
  fs.writeFileSync(path.join(home, 'settings.json'), '{not json');
  ok('unreadable settings.json falls back to the default, as cclogsall does', Claude.retention({ dir: projects, now }).periodDays === 30);
  ok('★ a copy with no settings.json beside it gets no deadline (Claude Code never cleans it)', Claude.retention({ dir: path.join(tmp, 'claude'), now }) === null);

  fs.writeFileSync(path.join(home, 'settings.json'), '{}');
  const bin = path.join(__dirname, '..', 'bin', 'agstats.js');
  const nope = path.join(tmp, 'nope');
  const dirArgs = ['--dir', `claude=${projects}`, '--dir', `codex=${path.join(tmp, 'codex')}`, '--dir', `gemini=${nope}`, '--dir', `cursor=${nope}`];
  const run = (args) => execFileSync('node', [bin, ...args, ...dirArgs], { encoding: 'utf8' });
  const js = JSON.parse(run(['agents', '--json']));
  const c = js.find((x) => x.agent === 'claude');
  ok('★ agents --json carries the claude retention', c.retention && c.retention.periodDays === 30 && c.retention.expiresInDays === 1 && c.retention.expiringWithin7d === 3);
  ok('★ agents without a documented cleanup carry no retention key at all', !('retention' in js.find((x) => x.agent === 'codex')) && !('retention' in js.find((x) => x.agent === 'gemini')));
  const txt = run(['agents']);
  ok('agents text: when the oldest goes and how many within 7 days', /cleanupPeriodDays=30 \(default\) — the oldest session \(\S+\) is deleted in 1 day\(s\), on \S+; 3 session\(s\) expire within 7 days/.test(txt));
}

console.log('== sends: what each request sent (ccsendstats port) ==');
{
  const Wire = require('../lib/wire.js');
  const Sends = require('../lib/metrics/sends.js');
  ok('estTokens: bytes / 4, rounded', Wire.estTokens('abcd'.repeat(10)) === 10 && Wire.estTokens('') === 0 && Wire.estTokens('あ') === 1);
  const sp = Wire.splitInjected('hi <system-reminder>x</system-reminder> there');
  ok('splitInjected moves runtime tags out of your words', sp.injected === '<system-reminder>x</system-reminder>' && sp.rest === 'hi  there');
  ok('★ splitInjected: task reports, bash-mode and caveats are runtime text too (ccsendstats\' pattern)', ['<task-notification><task-id>t</task-id>done</task-notification>', '<bash-input>ls</bash-input>', '<bash-stdout>x</bash-stdout><bash-stderr></bash-stderr>', '<local-command-caveat>c</local-command-caveat>']
    .every((t) => Wire.splitInjected(t).rest === '' && Wire.splitInjected(t).injected === t));
  ok('median of an even list is the mean of the middle two; empty is null', Sends.median([4, 1, 3, 2]) === 2.5 && Sends.median([]) === null);

  // ---- claude: numbers computed by hand
  const base = path.join(tmp, 'sends', 'claude');
  const sid = 'dddddddd-0000-0000-0000-000000000001';
  const claudeLines = [
    // 40 bytes typed (10 tok) + a 58-byte reminder (14.5 → 15 tok)
    mk({ type: 'user', timestamp: iso(0), cwd: '/p', message: { role: 'user', content: 'a'.repeat(40) + '<system-reminder>' + 'r'.repeat(23) + '</system-reminder>' } }),
    mk({ type: 'assistant', timestamp: iso(1), message: { id: 'm1', role: 'assistant', model: 'claude-x', usage: { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_1h_input_tokens: 150, ephemeral_5m_input_tokens: 50 }, output_tokens: 10 },
      content: [{ type: 'thinking', thinking: 't'.repeat(80) }, { type: 'tool_use', id: 'u1', name: 'Bash', input: { cmd: 'ls' } }] } }),
    // the same response continued on a second line, usage repeated: not a second request
    mk({ type: 'assistant', timestamp: iso(1), message: { id: 'm1', role: 'assistant', model: 'claude-x', usage: { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 10 }, content: [{ type: 'text', text: 'y'.repeat(40) }] } }),
    mk({ type: 'user', timestamp: iso(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'z'.repeat(400) }] } }),
    // runtime context and a sidechain request: outside the main loop, as in ccsendstats
    mk({ type: 'user', timestamp: iso(3), isMeta: true, message: { role: 'user', content: 'q'.repeat(400) } }),
    mk({ type: 'assistant', timestamp: iso(3), isSidechain: true, message: { id: 'side', role: 'assistant', usage: { input_tokens: 99999 }, content: [] } }),
    mk({ type: 'assistant', timestamp: iso(4), message: { id: 'm2', role: 'assistant', model: 'claude-x', usage: { input_tokens: 5, cache_read_input_tokens: 1300, cache_creation_input_tokens: 400, output_tokens: 3 }, content: [{ type: 'text', text: 'w'.repeat(8) }] } }),
    '{"broken',
  ];
  writeFile(path.join(base, '-p', `${sid}.jsonl`), claudeLines);
  writeFile(path.join(base, '-p', sid, 'subagents', 'agent-s.jsonl'), [
    mk({ type: 'assistant', timestamp: iso(9), message: { id: 's1', role: 'assistant', usage: { input_tokens: 7 }, content: [] } }),
  ]);
  const cr = Claude.readSends({ dir: base });
  ok('claude: subagent transcripts are left out', cr.sessions.length === 1 && cr.sessions[0].id === sid);
  const a = Sends.analyze(cr.sessions[0]);
  ok('★ claude: 2 requests (one response over two lines is one; sidechain is none)', a.requests === 2);
  ok('★ claude: real totals = input + cache read + cache creation', a.first.sent === 1300 && a.last.sent === 1705);
  ok('★ claude: visible before the latest request, by category', a.visible.userText === 10 && a.visible.injected === 15 && a.visible.thinking === 20
    && a.visible.toolInputs === 3 && a.visible.assistantText === 10 && a.visible.toolResults === 100 && a.visible.total === 158);
  ok('★ claude: invisible = latest real total − visible (1705 − 158)', a.invisible === 1547 && Math.abs(a.invisibleShare - 1547 / 1705) < 1e-12);
  ok('★ claude: first-request overhead = first real total − your first message (1300 − 10)', a.baseline === 1290 && a.firstPrompt.chars === 40 && a.firstPrompt.est === 10);
  ok('claude: cache split of the latest request', Math.abs(a.cache.read - 1300 / 1705) < 1e-12 && Math.abs(a.cache.write - 400 / 1705) < 1e-12 && Math.abs(a.cache.uncached - 5 / 1705) < 1e-12);
  ok('★ claude: an unsplit cache write has no 1h/5m — not recorded, not filed under 5m', a.last.cacheWrite1h === null && a.last.cacheWrite5m === null && a.cache.write1h === null);
  ok('claude: the recorded 1h/5m split is kept', a.first.cacheWrite1h === 150 && a.first.cacheWrite5m === 50);
  ok('claude: session totals', a.totals.sent === 3005 && a.totals.cacheRead === 2300 && a.totals.cacheWrite === 600 && a.totals.cacheWrite1h === 150);

  // ---- claude attachment lines (newer Claude Code writes injected context as its own line)
  {
    const att = Claude.sendsOf([
      mk({ type: 'user', timestamp: iso(0), message: { role: 'user', content: 'hi' } }),
      // 818 B → 204.5 → 205 tok; each rendered item is its own block
      mk({ type: 'attachment', timestamp: iso(0), attachment: { type: 'skill_listing', content: 'x'.repeat(5000) }, rendered: [{ content: '<system-reminder>' + 's'.repeat(783) + '</system-reminder>' }, { content: 'd'.repeat(400) }] }),
      // no `rendered`: client-side state (the system prompt's copy) or a version before rendered — not counted
      mk({ type: 'attachment', timestamp: iso(0), attachment: { type: 'prompt_snapshot', systemPrompt: ['p'.repeat(40000)], tools: [] } }),
      mk({ type: 'attachment', timestamp: iso(0), attachment: { type: 'skill_listing', content: 'o'.repeat(4000) } }),
      mk({ type: 'attachment', timestamp: iso(0), isMeta: true, attachment: { type: 'date' }, rendered: [{ content: 'q'.repeat(4000) }] }),
      mk({ type: 'assistant', timestamp: iso(1), message: { id: 'r1', role: 'assistant', model: 'claude-x', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000, output_tokens: 1 }, content: [{ type: 'text', text: 'ok' }] } }),
    ].join('\n'), path.join(base, '-a', 'aaaa.jsonl'), base);
    const aa = Sends.analyze(att);
    ok('★ claude: a rendered attachment is injected context, item by item (205 + 100)', aa.visible.injected === 305);
    ok('★ claude: an attachment without rendered, or outside the main loop, is not counted', aa.visible.total === 305 + 1);
    ok('★ claude: invisible drops by what the attachments sent (1010 − 306)', aa.invisible === 704 && aa.firstPrompt.chars === 2);
    ok('claude: attachmentTexts reads string and text-block content', JSON.stringify(Claude.attachmentTexts({ type: 'attachment', rendered: [{ content: 'a' }, { content: [{ type: 'text', text: 'b' }, { type: 'image' }] }, {}] })) === '["a","b\\n"]'
      && Claude.attachmentTexts({ type: 'attachment', attachment: {} }).length === 0);
  }

  // ---- parity with ccsendstats, when it is on this machine
  let CS = null, CT = null;
  for (const d of [path.join(os.homedir(), 'private', 'ccsendstats', 'lib'), path.join(os.homedir(), 'private', 'playground-tools', 'apps', 'ccsendstats', 'lib')]) {
    try { CS = require(path.join(d, 'sendstats.js')); CT = require(path.join(d, 'vendor', 'transcript.js')); break; } catch (e) { CS = null; CT = null; }
  }
  if (!CS) console.log('  (ccsendstats not on this machine — sends parity test skipped)');
  else {
    // a second transcript with the shapes ccsendstats special-cases: array tool
    // results, a command echo, an injected-only first turn, no usage on a line
    const f2 = path.join(base, '-q', 'dddddddd-0000-0000-0000-000000000002.jsonl');
    writeFile(f2, [
      mk({ type: 'user', timestamp: iso(0), message: { role: 'user', content: [{ type: 'text', text: '<command-name>/model</command-name><command-args></command-args>' }] } }),
      mk({ type: 'user', timestamp: iso(1), message: { role: 'user', content: [{ type: 'text', text: '  日本語で答えて ' }, { type: 'text', text: '<local-command-stdout>ok</local-command-stdout>more' }] } }),
      mk({ type: 'assistant', timestamp: iso(2), message: { id: 'p1', model: 'claude-y', usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 2048, cache_creation: { ephemeral_1h_input_tokens: 2048, ephemeral_5m_input_tokens: 0 }, output_tokens: 9 },
        content: [{ type: 'tool_use', id: 'k', name: 'Read', input: { file_path: '/x/y' } }, { type: 'text', text: 'reading' }] } }),
      mk({ type: 'user', timestamp: iso(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'k', content: [{ type: 'text', text: 'line1' }, { type: 'image' }, { type: 'text', text: 'line2 ✓' }] }] } }),
      mk({ type: 'assistant', timestamp: iso(4), message: { id: 'p2', model: 'claude-y', content: [{ type: 'text', text: 'no usage here' }] } }),
      mk({ type: 'user', timestamp: iso(4), promptSource: 'system', message: { role: 'user', content: '<task-notification><task-id>b1</task-id>' + 'n'.repeat(200) + '</task-notification>' } }),
      mk({ type: 'assistant', timestamp: iso(5), message: { id: 'p3', model: 'claude-y', usage: { input_tokens: 1, cache_read_input_tokens: 2051, cache_creation_input_tokens: 40, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 40 }, output_tokens: 2 }, content: 'plain string reply' } }),
    ]);
    // a third with attachment lines: rendered ones count, the rest do not
    // (its own directory: the CLI tests below count the sessions under `base`)
    const base3 = path.join(tmp, 'sends', 'claude-att');
    const f3 = path.join(base3, '-r', 'dddddddd-0000-0000-0000-000000000003.jsonl');
    writeFile(f3, [
      mk({ type: 'user', timestamp: iso(0), message: { role: 'user', content: 'go' } }),
      mk({ type: 'attachment', timestamp: iso(0), attachment: { type: 'skill_listing', content: 'x'.repeat(3000) }, rendered: [{ content: '<system-reminder>' + 's'.repeat(783) + '</system-reminder>' }] }),
      mk({ type: 'attachment', timestamp: iso(0), attachment: { type: 'mcp_instructions_delta' }, rendered: [{ content: 'a'.repeat(6) }, { content: [{ type: 'text', text: 'b'.repeat(10) }] }] }),
      mk({ type: 'attachment', timestamp: iso(0), attachment: { type: 'prompt_snapshot', systemPrompt: ['p'.repeat(9000)] } }),
      mk({ type: 'attachment', timestamp: iso(0), isSidechain: true, attachment: { type: 'date' }, rendered: [{ content: 'q'.repeat(900) }] }),
      mk({ type: 'assistant', timestamp: iso(1), message: { id: 'q1', model: 'claude-z', usage: { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 998, output_tokens: 1 }, content: [{ type: 'text', text: 'ok' }] } }),
      mk({ type: 'attachment', timestamp: iso(2), attachment: { type: 'total_tokens_reminder' }, rendered: [{ content: 't'.repeat(40) }] }),
      mk({ type: 'assistant', timestamp: iso(3), message: { id: 'q2', model: 'claude-z', usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20, output_tokens: 1 }, content: [{ type: 'text', text: 'ok' }] } }),
    ]);
    for (const [label, file, dir] of [['hand fixture', path.join(base, '-p', `${sid}.jsonl`), base], ['edge fixture', f2, base], ['attachment fixture', f3, base3]]) {
      const text = fs.readFileSync(file, 'utf8');
      const cc = CS.analyze(CT.parseLines(text));
      const me = Sends.analyze(Claude.sendsOf(text, file, dir));
      const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
      ok(`★ parity (${label}): request count, first and last real totals`, cc.requests.length === me.requests && cc.first.realIn === me.first.sent && cc.last.realIn === me.last.sent);
      ok(`★ parity (${label}): every visible category and the total`, ['userText', 'injected', 'toolResults', 'assistantText', 'thinking', 'toolInputs', 'total'].every((k) => cc.visible[k] === me.visible[k]));
      ok(`★ parity (${label}): invisible, first-request overhead, first prompt`, cc.invisible === me.invisible && cc.baseline === me.baseline && same(cc.firstPrompt, me.firstPrompt));
      ok(`★ parity (${label}): cache read / write / uncached of the latest request`, cc.last.cacheRead === me.last.cacheRead && cc.last.cacheWrite === me.last.cacheWrite && cc.last.uncached === me.last.uncached);
      const ttlCc = cc.requests.map((r) => [r.cacheWrite1h, r.cacheWrite5m]);
      const ttlMe = [me.first, me.last].map((r) => [r.cacheWrite1h, r.cacheWrite5m]);
      if (label === 'attachment fixture') ok('★ parity (attachment fixture): rendered attachments counted as injected in both', me.visible.injected === 205 + 2 + 3 + 10 && cc.visible.injected === me.visible.injected);
      else if (label === 'edge fixture') ok('★ parity (edge fixture): 1h/5m split where recorded', same([ttlCc[0], ttlCc[ttlCc.length - 1]], ttlMe));
      else ok('the one deliberate difference: ccsendstats files an unsplit write under 5m, sends leaves it unrecorded', ttlCc[ttlCc.length - 1][1] === 400 && ttlMe[1][1] === null);
    }
  }

  // ---- codex
  const cxDir = path.join(tmp, 'sends', 'codex', '2026', '01', '01');
  const tc = (input, cached, out, cum) => mk({ timestamp: iso(cum), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: out, total_tokens: input + out }, total_token_usage: { total_tokens: cum } } } });
  writeFile(path.join(cxDir, 'rollout-2026-01-01T12-00-00-eeeeeeee-0000-0000-0000-000000000001.jsonl'), [
    mk({ timestamp: iso(0), type: 'session_meta', payload: { id: 'eeeeeeee-0000-0000-0000-000000000001', cwd: '/c', base_instructions: { text: 'b'.repeat(40) } } }),
    mk({ timestamp: iso(0), type: 'turn_context', payload: { cwd: '/c', model: 'gpt-x' } }),
    mk({ timestamp: iso(1), type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'd'.repeat(20) }] } }),
    mk({ timestamp: iso(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>' + 'e'.repeat(19) + '</environment_context>' }] } }),
    mk({ timestamp: iso(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'u'.repeat(12) }] } }),
    mk({ timestamp: iso(2), type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 's'.repeat(16) }], encrypted_content: 'X'.repeat(4000) } }),
    mk({ timestamp: iso(2), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: 'a'.repeat(8) } }),
    tc(500, 400, 5, 505),
    tc(500, 400, 5, 505), // repeated with no new request
    mk({ timestamp: iso(3), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'o'.repeat(40) } }),
    mk({ timestamp: iso(4), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'r'.repeat(24) }] } }),
    tc(800, 700, 6, 1311),
  ]);
  writeFile(path.join(cxDir, 'rollout-2026-01-01T13-00-00-eeeeeeee-0000-0000-0000-000000000002.jsonl'), [
    mk({ timestamp: iso(10), type: 'session_meta', payload: { id: 'eeeeeeee-0000-0000-0000-000000000002', cwd: '/c' } }),
    mk({ timestamp: iso(11), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } }),
    mk({ timestamp: iso(12), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 999 }, total_token_usage: { total_tokens: 999 } } } }),
  ]);
  const cx = Codex.readSends({ dir: path.join(tmp, 'sends', 'codex'), keepRequests: true }).sessions;
  const c1 = Sends.analyze(cx.find((x) => x.id.endsWith('1'))), c2 = Sends.analyze(cx.find((x) => x.id.endsWith('2')));
  ok('★ codex: a repeated token_count is not a second request', c1.requests === 2);
  ok('★ codex: input_tokens is the real total (cached part included); uncached = input − cached', c1.first.sent === 500 && c1.first.cacheRead === 400 && c1.first.uncached === 100 && c1.last.sent === 800);
  ok('★ codex: base_instructions is the recorded system prompt; developer + runtime user turns are injected', c1.visible.system === 10 && c1.visible.injected === 21 && c1.visible.userText === 3);
  // developer 20 B (5) + <environment_context> turn 62 B (15.5 → 16) = 21 injected.
  // The latest request carried everything up to its last input (the tool output), not its own reply
  ok('★ codex: what a request carried stops at its last input, not its own response', c1.visible.toolResults === 10 && c1.visible.assistantText === 0 && c1.visible.thinking === 4 && c1.visible.toolInputs === 2 && c1.visible.total === 50);
  ok('codex: invisible = 800 − 50; the first message is the typed one', c1.invisible === 750 && c1.baseline === 497 && c1.firstPrompt.chars === 12);
  ok('★ codex: a combined total with no input side is "total only", never used as the input', c2.usage === 'total-only' && c2.last === null && c2.invisible === null && c2.baseline === null && c2.list[0].total === 999 && c2.list[0].sent === null);

  // ---- gemini: $set replaces the message list, $push appends
  const gmDir = path.join(tmp, 'sends', 'gemini');
  const um = { id: 'm1', timestamp: iso(0), type: 'user', content: 'g'.repeat(20) };
  writeFile(path.join(gmDir, 'proj', 'chats', 'session-1.jsonl'), [
    mk({ sessionId: 'person-1', startTime: iso(0) }),
    mk({ $set: { messages: [um] } }),
    mk({ $set: { messages: [um, { id: 'm2', timestamp: iso(1), type: 'gemini', content: 'h'.repeat(8), tokens: { input: 300, cached: 100, output: 5 }, model: 'gemini-x' }] } }),
    mk({ $push: { messages: { id: 'm3', timestamp: iso(2), type: 'gemini', content: 'i'.repeat(4), toolCalls: [{ name: 'read_file', args: { p: 1 }, result: 'j'.repeat(40) }] } } }),
  ]);
  writeFile(path.join(gmDir, 'proj', 'chats', 'session-2.jsonl'), [mk({ sessionId: 'person-2', startTime: iso(5) }), mk({ $set: { messages: [{ id: 'x', timestamp: iso(5), type: 'user', content: 'hi' }] } })]);
  writeFile(path.join(gmDir, 'proj', 'chats', 'session-3.jsonl'), [mk({ sessionId: 'a2a-server', startTime: iso(6) }), mk({ $set: { messages: [{ id: 'x', timestamp: iso(6), type: 'gemini', tokens: { input: 5 } }] } })]);
  const gm = Gemini.readSends({ dir: gmDir }).sessions;
  const g1 = Sends.analyze(gm.find((x) => x.id === 'session-1'));
  ok('gemini: an a2a-server chat is left out unless --include-automated', gm.length === 2 && Gemini.readSends({ dir: gmDir, includeAutomated: true }).sessions.length === 3);
  ok('★ gemini: a rewritten history ($set) is read once, not twice', g1.firstPrompt.est === 5 && g1.visible.userText === 5 && g1.requests === 1);
  ok('gemini: tokens.input is the total, tokens.cached its cache read; no cache write recorded', g1.last.sent === 300 && g1.last.cacheRead === 100 && g1.last.uncached === 200 && g1.last.cacheWrite === null && g1.cache.write === null);
  ok('★ gemini: a chat with no tokens reads "not recorded", never zero', Sends.analyze(gm.find((x) => x.id === 'session-2')).usage === 'none' && Sends.analyze(gm.find((x) => x.id === 'session-2')).last === null);

  // ---- cursor: bubbles in the thread's order, tokenCount as the total
  {
    const tally = new Wire.Tally();
    Cursor.sendsOfBubbles([
      { type: 1, text: 'k'.repeat(40), createdAt: iso(0) },
      { type: 2, text: 'l'.repeat(8), createdAt: iso(1), tokenCount: { inputTokens: 900, outputTokens: 4 }, toolFormerData: { name: 'read_file', params: 'p'.repeat(12), result: 'm'.repeat(20) } },
      { type: 2, text: 'n'.repeat(4), createdAt: iso(2), tokenCount: { inputTokens: 0, outputTokens: 0 } },
    ], tally);
    const cu = Sends.analyze({ agent: 'cursor', id: 'z', ...tally.result() });
    ok('★ cursor: only a non-zero inputTokens is a request; no cache split recorded', cu.requests === 1 && cu.last.sent === 900 && cu.last.cacheRead === null && cu.cache.read === null);
    ok('cursor: the request carried what came before its bubble', cu.visible.userText === 10 && cu.visible.total === 10 && cu.invisible === 890);
  }

  // ---- the CLI
  const bin = path.join(__dirname, '..', 'bin', 'agstats.js');
  const nope = path.join(tmp, 'nope');
  const dirArgs = ['--dir', `claude=${base}`, '--dir', `codex=${path.join(tmp, 'sends', 'codex')}`, '--dir', `gemini=${gmDir}`, '--dir', `cursor=${nope}`];
  const run = (args, extra = dirArgs) => { try { return { code: 0, out: execFileSync('node', [bin, ...args, ...extra], { encoding: 'utf8', stdio: 'pipe' }) }; } catch (e) { return { code: e.status, out: e.stdout, err: e.stderr }; } };
  const one = JSON.parse(run(['sends', '--json', '--session', 'dddddddd-0000-0000-0000-000000000001']).out);
  ok('★ sends --session --json: the hand-computed numbers, with the estimate named', one.agent === 'claude' && one.last.sent === 1705 && one.invisible === 1547 && one.baseline === 1290 && one.estimate === 'bytes / 4' && one.list.length === 2);
  ok('sends --session picks by id prefix across agents', JSON.parse(run(['sends', '--json', '--session', 'eeeeeeee-0000-0000-0000-000000000001']).out).agent === 'codex');
  // the first codex rollout's last token_count is stamped 12:21:51, later than anything else
  ok('★ sends defaults to the latest session, whichever agent wrote it', JSON.parse(run(['sends', '--json', '--all']).out).session === 'eeeeeeee-0000-0000-0000-000000000001');
  ok('sends --agent narrows the latest', JSON.parse(run(['sends', '--json', '--all', '--agent', 'claude']).out).agent === 'claude');
  ok('sends --session with no match exits 1', run(['sends', '--session', 'nomatch']).code === 1);
  ok('sends --json with nothing to show answers null', run(['sends', '--json', '--session', 'nomatch']).out.trim() === 'null');
  const nr = run(['sends', '--session', 'session-2']).out;
  ok('★ sends text for an agent without usage says "not recorded", and prints no total', /not recorded/.test(nr) && !/Last request/.test(nr));
  ok('sends text: totals real, breakdown estimated', /totals are real/.test(run(['sends', '--session', 'dddddddd-0000-0000-0000-000000000001']).out));
  const cmp = JSON.parse(run(['sends', '--by-agent', '--json', '--all']).out);
  const row = (x) => cmp.agents.find((r) => r.agent === x);
  ok('★ sends --by-agent: per-agent medians from the sessions that recorded usage', row('claude').recorded === 2 && row('claude').sessions === 2 && row('claude').medianBaseline != null
    && row('codex').recorded === 1 && row('codex').totalOnly === 1 && row('codex').medianBaseline === 497);
  ok('★ sends --by-agent: an agent with no usage has null medians, not zeros', row('gemini').recorded === 1 && row('gemini').notRecorded === 1);
  ok('★ sends --by-agent: a missing agent is "not installed"', row('cursor').installed === false && /not installed/.test(run(['sends', '--by-agent', '--all']).out));
  ok('sends --by-agent: cache split is null for an agent that records none', row('gemini').cache !== null && row('codex').ttl === null);
  const period = JSON.parse(run(['sends', '--by-agent', '--json', '--since', '20300101']).out);
  ok('★ sends --by-agent honours the period (nothing started after 2030)', period.agents.filter((r) => r.installed).every((r) => r.sessions === 0));
  ok('sends --by-agent defaults to the last 30 days (fixtures are older)', JSON.parse(run(['sends', '--by-agent', '--json']).out).agents.filter((r) => r.installed).every((r) => r.sessions === 0));
  const zlib = require('zlib');
  const sarch = path.join(tmp, 'sends', 'archive');
  fs.mkdirSync(path.join(sarch, 'projects', '-p'), { recursive: true });
  fs.writeFileSync(path.join(sarch, 'projects', '-p', 'ffffffff-0000-0000-0000-00000000000a.jsonl.gz'), zlib.gzipSync(claudeLines.join('\n')));
  ok('★ sends --archive reads an archived session', JSON.parse(run(['sends', '--json', '--session', 'ffffffff', '--archive', sarch]).out).archived === true
    && run(['sends', '--json', '--session', 'ffffffff']).out.trim() === 'null');
  ok('--help lists sends', /\bsends\b/.test(run(['--help']).out));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
