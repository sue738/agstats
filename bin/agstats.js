#!/usr/bin/env node
/**
 * agstats — what your coding agents did, from their own transcripts.
 *
 *   agstats agents            which agents were found, where, how much history
 *   agstats hours             agent-hours per day, every agent side by side
 *   agstats tools             which tools fail, and how often
 *   agstats blast             what cannot be undone
 *   agstats leaks             what secrets sit in plaintext (leaks scrub: redact them)
 */
'use strict';

const fs = require('fs');
const readline = require('readline');
const { NAME, TAGLINE, ENV_LANG } = require('../lib/brand.js');
const Readers = require('../lib/readers/index.js');
const H = require('../lib/metrics/hours.js');
const Tools = require('../lib/metrics/tools.js');
const Blast = require('../lib/metrics/blast.js');
const Leaks = require('../lib/metrics/leaks.js');
const Stats = require('../lib/metrics/stats.js');
const Timeline = require('../lib/metrics/timeline.js');
const Quota = require('../lib/metrics/quota.js');
const Diff = require('../lib/metrics/diff.js');
const Skills = require('../lib/metrics/skills.js');
const Attention = require('../lib/metrics/attention.js');
const Guards = require('../lib/metrics/guards.js');
const Advise = require('../lib/metrics/advise.js');
const Overlap = require('../lib/metrics/overlap.js');
const Waits = require('../lib/metrics/waits.js');
const R = require('../lib/render.js');
const M = require('../lib/model.js');

const JA = /^ja/i.test(process.env[ENV_LANG] || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '');
const L = (en, ja) => (JA ? ja : en);
const n = (x) => Number(x || 0).toLocaleString('en-US');

const HELP = `${NAME} — ${TAGLINE}

Usage:
  ${NAME} <command> [options]

Commands:
  agents           which agents were found, where, and how much history each has
  hours            agent-hours: daily table (default), --monthly, --by-project, --card
  tools            tool calls and failure rate per tool; --suggest clusters the failures
  blast            what cannot be undone: escaped vs contained actions; --list shows examples
  leaks            secrets sitting in transcripts (read-only; exit 1 on findings, 3 if a source was unreadable)
  leaks scrub      redact detected secrets in place (--dry-run, --yes, --no-backup)
  stats            working habits: prompts, replies, tools per prompt, hours of day, tokens, cache share
  timeline         a calendar of your work (--weeks N), streaks, hour bars
  quota            share of tokens per project this period vs budget (--set a=50 b=30, --period, --clear)
  diff             what one session changed: files by touches, commands (--session ID, --commands, --git)
  skills           which skills actually fire: tool / typed / auto (--unused)
  attention        how many times you had to speak per errand, per day (--weekly); nudges, approvals, self-corrections
  guards           did the guard you installed stop the failure: rates before/after (guards add <tool> [--since D] [--note ..] [--signature ..], guards rm <tool>)
  advise           what to change, from what was measured — with thresholds, an artifact, and the command that re-measures (--show <id>)
  overlap          the same file written by two sessions within 30 min (--window N) — the collisions nobody saw
  waits            who waited for whom: you for the agent, the agent for you, per day (--by-agent)

Scope:
  --agent a[,b]        only these agents (${Readers.NAMES.join(', ')})
  --dir agent=path     override an agent's transcript root (repeatable)
  --include-automated  count sessions written by programs (a2a servers, cron) — off by default

Period:
  --today | --week | --month | --days N | --all | --since YYYYMMDD | --until YYYYMMDD
  (hours/tools default to everything on disk; blast defaults to the last 30 days;
   leaks selects files by modification time, so it takes a start but not --until)

Output:
  --json           machine-readable
  --monthly / --by-project / --caps / --card / --svg [path]   (hours)
  --suggest        (tools) tools over 20% failure with their failures clustered
  --scope main|both (tools) main-loop only (default) or include subagents' own tool use
  --list           (blast) show examples of every escaped action

Tuning:
  --idle-gap N     silence (seconds) counted as "stopped" (default ${H.IDLE_GAP_S})

Reads local files only. Changes nothing except \`leaks scrub\` (which asks first).`;

const COMMANDS = ['agents', 'hours', 'tools', 'blast', 'leaks', 'stats', 'timeline', 'quota', 'diff', 'skills', 'attention', 'guards', 'advise', 'overlap', 'waits'];

function parseArgs(argv) {
  const o = { dirs: {} };
  const rest = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--monthly') o.monthly = true;
    else if (a === '--daily') o.daily = true;
    else if (a === '--today') o.today = true;
    else if (a === '--week') o.days = 7;
    else if (a === '--month') o.thisMonth = true;
    else if (a === '--all') o.all = true;
    else if (a === '--days') o.days = +argv[++i];
    else if (a === '--since') o.since = argv[++i];
    else if (a === '--until') o.until = argv[++i];
    else if (a === '--card') o.card = true;
    // `agstats --svg hours` means the default file, not a file named "hours"
    else if (a === '--svg') { const v = argv[i + 1]; o.svg = (v && !v.startsWith('-') && !COMMANDS.includes(v)) ? argv[++i] : `${NAME}.svg`; }
    else if (a === '--json') o.json = true;
    else if (a === '--caps') o.caps = true;
    else if (a === '--by-project') o.byProject = true;
    else if (a === '--suggest') o.suggest = true;
    else if (a === '--scope') o.scope = argv[++i];
    else if (a === '--list') o.list = true;
    else if (a === '--weeks') o.weeks = +argv[++i];
    else if (a === '--period') o.period = argv[++i];
    else if (a === '--set') { o.set = []; while (argv[i + 1] && !argv[i + 1].startsWith('--')) o.set.push(argv[++i]); }
    else if (a === '--clear') o.clear = true;
    else if (a === '--session') o.session = argv[++i];
    else if (a === '--project') o.project = argv[++i];
    else if (a === '--commands') o.commands = true;
    else if (a === '--git') o.git = true;
    else if (a === '--unused') o.unused = true;
    else if (a === '--weekly') o.weekly = true;
    else if (a === '--window') o.window = +argv[++i];
    else if (a === '--by-agent') o.byAgent = true;
    else if (a === '--note') o.note = argv[++i];
    else if (a === '--signature') o.signature = argv[++i];
    else if (a === '--show') o.show = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--no-backup') o.noBackup = true;
    else if (a === '--idle-gap') o.idleGapS = +argv[++i];
    else if (a === '--include-automated') o.includeAutomated = true;
    else if (a === '--agent') {
      // An unknown name used to narrow to nothing and print zeros, which read
      // as "that agent did nothing".
      o.only = String(argv[++i] || '').split(',').map((x) => x.trim()).filter(Boolean);
      const bad = o.only.filter((x) => !Readers.NAMES.includes(x));
      if (!o.only.length || bad.length) usageError(L(`--agent: ${bad.length ? `unknown agent "${bad.join(', ')}"` : 'expected a name'} — one of ${Readers.NAMES.join(', ')}`, `--agent: ${bad.length ? `不明なエージェント "${bad.join(', ')}"` : '名前を指定してください'} — ${Readers.NAMES.join(', ')} のいずれか`));
    }
    else if (a === '--dir') {
      const v = String(argv[++i] || '');
      const k = v.indexOf('=');
      const name = k > 0 ? v.slice(0, k) : '';
      if (!Readers.NAMES.includes(name) || !v.slice(k + 1)) usageError(L(`--dir: expected agent=path with agent one of ${Readers.NAMES.join(', ')}, got "${v}"`, `--dir: agent=path 形式で指定してください(agent は ${Readers.NAMES.join(', ')}): "${v}"`));
      o.dirs[name] = v.slice(k + 1);
    }
    else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a.startsWith('-')) { console.error(L(`unknown option ${a}`, `不明なオプション ${a}`)); process.exit(2); }
    else rest.push(a);
  }
  o.command = rest[0] || 'hours';
  o.sub = rest[1] || null;
  o.arg = rest[2] || null;
  // A malformed date must not silently widen or empty the window: "2026-7-1"
  // once meant "all history" and "--until yesterday" meant 1970. Fail loudly.
  for (const k of ['since', 'until']) {
    if (o[k] != null && parseDate(o[k]) == null) {
      console.error(L(`--${k}: expected YYYYMMDD or YYYY-MM-DD, got "${o[k]}"`, `--${k}: YYYYMMDD か YYYY-MM-DD で指定してください: "${o[k]}"`));
      process.exit(2);
    }
  }
  for (const [k, flag] of [['days', '--days'], ['weeks', '--weeks'], ['window', '--window'], ['idleGapS', '--idle-gap']]) {
    if (o[k] != null && !(Number.isFinite(o[k]) && o[k] > 0)) usageError(L(`${flag}: expected a positive number`, `${flag}: 正の数で指定してください`));
  }
  if (o.since && o.until && parseDate(o.since) > parseDate(o.until)) usageError(L(`--since ${o.since} is after --until ${o.until}`, `--since ${o.since} が --until ${o.until} より後です`));
  return o;
}

function usageError(msg) { console.error(msg); process.exit(2); }

function parseDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null; // 2026-02-30
  return d.getTime();
}

/** True when the user asked for a period (not just the command's default). */
function hasPeriod(o) { return !!(o.since || o.until || o.days || o.today || o.thisMonth); }

/** Resolve the requested window (same rules as cchours). `firstMs` = oldest activity on disk. */
function resolveRange(o, firstMs, now) {
  const to = o.until ? parseDate(o.until) + 86400000 : Date.now();
  if (o.since) return { from: parseDate(o.since), to, label: L(`${o.since} →`, `${o.since} 以降`) };
  if (o.today) return { from: H.dayRange(now)[0], to, label: L('Today', '今日') };
  if (o.days) return { from: H.dayRange(new Date(now - (o.days - 1) * 86400000))[0], to, label: L(`Last ${o.days} days`, `直近${o.days}日`) };
  if (o.thisMonth) return { from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), to, label: L('This month', '今月') };
  if ((o.card || o.svg) && !o.all) {
    return { from: H.dayRange(new Date(now - 29 * 86400000))[0], to, label: L('last 30 days', '直近30日') };
  }
  const from = Number.isFinite(firstMs) ? firstMs : to - 86400000;
  const days = Math.max(1, Math.round((to - from) / 86400000));
  return { from, to, label: L(days === 1 ? `1 day on disk` : `${days} days on disk`, `ディスク上の${days}日間`) };
}

function short(p) {
  const base = String(p).split('/').filter(Boolean).pop() || String(p);
  return base.slice(0, 28);
}

/**
 * Names clipped in the middle to `w` columns, keeping both ends: tool names
 * share long prefixes (mcp__claude-in-chrome__…) and differ at the end, so
 * cutting the tail printed distinct tools as identical rows. If clipping
 * would still merge two names, they are shown in full.
 */
function clipNames(names, w = 36) {
  const clip = (s) => (s.length <= w ? s : s.slice(0, Math.ceil((w - 1) / 2)) + '…' + s.slice(s.length - Math.floor((w - 1) / 2)));
  const out = names.map(clip);
  return new Set(out).size === new Set(names).size ? out : names;
}

function allSessions(found) {
  const out = [];
  for (const f of found) out.push(...f.sessions);
  return out;
}

function foundAgents(found) {
  return Readers.NAMES.filter((name) => found.some((f) => f.agent === name && f.sessions.length));
}

// ---------------------------------------------------------------- agents

function cmdAgents(o, found) {
  const rows = [];
  const out = [];
  for (const f of found) {
    let first = Infinity, last = 0, events = 0, subs = 0;
    for (const s of f.sessions) {
      events += s.events.length;
      if (s.parentId != null) subs++;
      if (s.events.length) { first = Math.min(first, s.events[0].t); last = Math.max(last, s.events[s.events.length - 1].t); }
    }
    const human = f.sessions.filter((s) => !s.automated).length;
    const rec = {
      agent: f.agent, installed: f.installed, dir: f.dir, sessions: human, automated: f.automated || 0, subagents: subs, events,
      first: f.sessions.length ? M.dayKey(first) : null,
      last: f.sessions.length ? M.dayKey(last) : null,
      error: f.error || null,
    };
    out.push(rec);
    rows.push([
      f.agent,
      f.installed ? String(human) : L('not installed', '未検出'),
      f.installed ? (rec.automated ? String(rec.automated) : '') : '',
      f.installed && f.sessions.length ? `${rec.first} → ${rec.last}` : (f.error ? `⚠ ${f.error}` : ''),
      f.dir.replace(process.env.HOME || '', '~'),
    ]);
  }
  if (o.json) return console.log(JSON.stringify(out, null, 2));
  console.log(R.banner(L(`${NAME} — agents found on this machine`, `${NAME} — このマシンで見つかったエージェント`)));
  console.log(R.table([L('agent', 'エージェント'), L('sessions', 'セッション'), L('automated', '自動実行'), L('history', '期間'), L('where', '場所')], rows,
    { align: ['l', 'r', 'r', 'l', 'l'] }));
  console.log(L('\n  a session is one transcript file (or one thread); subagents count as their own session.',
    '\n  1セッション = 転記ファイル1つ(またはスレッド1つ)。サブエージェントも1セッションと数える。'));
  if (out.some((r) => r.automated)) {
    console.log(L('  "automated" = written by a program (an a2a server, a cron job), not a person. Left out of every metric unless --include-automated.',
      '  「自動実行」= 人ではなくプログラム(a2a サーバー・cron)が書いたもの。--include-automated を付けない限りどの指標にも入れない。'));
  }
}

// ---------------------------------------------------------------- hours

/** Write the share card, or say plainly why not: a bad path is the user's to fix, not a stack trace. */
function writeSvg(file, svg) {
  const path = require('path');
  let st = null;
  try { st = fs.statSync(file); } catch (e) { /* new file */ }
  if (st && st.isDirectory()) usageError(L(`--svg: ${file} is a directory — give a file path`, `--svg: ${file} はディレクトリです — ファイルのパスを指定してください`));
  const dir = path.dirname(path.resolve(file));
  if (!fs.existsSync(dir)) usageError(L(`--svg: directory ${dir} does not exist`, `--svg: ディレクトリ ${dir} がありません`));
  try { fs.writeFileSync(file, svg); } catch (e) { console.error(L(`--svg: could not write ${file}: ${e.message}`, `--svg: ${file} に書けませんでした: ${e.message}`)); process.exit(1); }
}

function cmdHours(o, found) {
  const sessions = allSessions(found);
  const agents = H.fromSessions(sessions, o.idleGapS || H.IDLE_GAP_S);
  // --json always answers in JSON: the empty result, not a sentence.
  if (!agents.length && !o.json) {
    console.log(L('(no transcripts with measurable activity found — try `agents` to see what was detected)',
      '(計測できる転記がありません — `agents` で検出状況を確認してください)'));
    return;
  }
  const names = foundAgents(found);
  const multi = new Set(agents.map((a) => a.agent)).size > 1;
  const now = new Date();
  const { from, to, label } = resolveRange(o, Math.min(...agents.map((a) => a.firstMs)), now);
  const scopeLine = L('  scope: main loop + subagent turns', '  集計範囲: メインループ + サブエージェント');

  if (o.card || o.svg) {
    const s = H.summarize(agents, from, to);
    const clock = H.byClockHour(agents, from, to);
    const grid = H.byDayHour(agents, from, to);
    const night = H.nightShare(clock);
    const oldest = Math.min(...agents.map((a) => a.firstMs));
    const covered = Math.max(1, Math.ceil((to - Math.max(from, oldest)) / 86400000));
    const asked = Math.round((to - from) / 86400000);
    const d = {
      label: (o.monthly || o.thisMonth) ? H.monthKey(from)
        : (covered < asked - 1 ? L(`last 30 days (${covered}d of history)`, `直近30日(履歴は${covered}日分)`) : label),
      hours: s.agentHours, personMonths: s.personMonths,
      subShare: s.agentHours ? s.subagentHours / s.agentHours : 0,
      nightShare: night.share, parallelism: s.parallelism, subCount: s.subCount, wallHours: s.wallHours, grid,
    };
    // --svg with --json writes the file too; the "wrote" line goes to stderr so stdout stays JSON.
    if (o.svg) { writeSvg(o.svg, R.cardSvg(d, JA)); (o.json ? console.error : console.log)(L(`wrote ${o.svg}`, `${o.svg} を書き出しました`)); }
    if (o.json) {
      const day0 = H.dayRange(new Date(from))[0];
      return console.log(JSON.stringify({ from, to, day0: M.dayKey(day0), hours: s.agentHours, agents: s.agents, grid, ...(o.svg ? { svg: o.svg } : {}) }, null, 2));
    }
    if (o.card || !o.svg) console.log('\n' + R.card(d, JA) + '\n');
    return;
  }

  if (o.caps) {
    const rows = [];
    const caps = [];
    for (const cap of [30, 60, 120, 300, 600, 900]) {
      const ag = H.fromSessions(sessions, cap);
      const s = H.summarize(ag, from, to);
      caps.push({ idleCapS: cap, agentHours: s.agentHours, wallHours: s.wallHours, parallelism: s.parallelism });
      rows.push([`${cap}s`, R.fmtH(s.agentHours), R.fmtH(s.wallHours), `×${s.parallelism.toFixed(1)}`]);
    }
    if (o.json) return console.log(JSON.stringify({ from, to, caps }, null, 2));
    console.log(R.banner(L(`${NAME} hours — idle-cap band (${label})`, `${NAME} hours — 上限別の稼働時間 (${label})`)));
    console.log(R.table([L('idle cap', '停止とみなす沈黙'), L('agent-hrs', '延べ稼働'), L('wall', '実経過'), L('parallel', '並列')], rows));
    console.log(scopeLine);
    console.log(L('\nNo single cap is "the truth" — a wider cap credits longer silences as work.',
      '\nどれか1つが「正解」ではない。上限を広げるほど長い沈黙も稼働に数える。'));
    return;
  }

  if (o.byProject) {
    const s = H.summarize(agents, from, to);
    if (o.json) return console.log(JSON.stringify({ from, to, agentHours: s.agentHours, projects: s.projects }, null, 2));
    const rows = s.projects.map((p) => [short(p.name), R.fmtH(p.hours), R.bar(p.hours / s.projects[0].hours, 16)]);
    console.log(R.banner(L(`${NAME} hours — by project (${label})`, `${NAME} hours — プロジェクト別 (${label})`)));
    console.log(R.table([L('project', 'プロジェクト'), L('agent-hrs', '延べ稼働'), ''], rows,
      { align: ['l', 'r', 'l'], totalRow: [L('Total', '合計'), R.fmtH(s.agentHours), ''] }));
    console.log(scopeLine);
    return;
  }

  if (o.monthly) {
    const months = H.byMonth(agents, now.getTime());
    if (o.json) return console.log(JSON.stringify(months, null, 2));
    const rows = months.map((m) => [
      m.month + (m.partial ? '*' : ''), `${m.observedDays.toFixed(0)}d`, R.fmtH(m.hours), R.fmtH(m.hoursPer30Days),
      m.personMonthsPerMonth.toFixed(2), R.fmtH(m.longestRunHours), R.fmtH(m.subagentHours),
    ]);
    console.log(R.banner(L(`${NAME} hours — monthly`, `${NAME} hours — 月別`)));
    console.log(R.table(
      [L('month', '月'), L('observed', '観測'), L('agent-hrs', '延べ稼働'), L('per 30d', '30日換算'), L('person-mo', '人月/月'), L('longest', '最長連続'), L('subagents', 'サブ')],
      rows));
    console.log(scopeLine);
    console.log(L('\n* = month still running. "per 30d" scales the observed span, because agents delete',
      '\n* = 進行中の月。「30日換算」は観測期間で割り戻した値 — エージェントは古い転記を'));
    console.log(L('  old transcripts on their own schedule, so early months are usually partial.',
      '  自分の都合で消すため、古い月はたいてい欠けている。'));
    return;
  }

  // ---- daily (default) ----
  const rows = [];
  const daily = [];
  for (let d = new Date(from); d.getTime() < to; d = new Date(d.getTime() + 86400000)) {
    const [ds, de] = H.dayRange(d);
    const s = H.summarize(agents, ds, de);
    if (s.agentHours <= 0) continue;
    const row = [M.dayKey(ds), R.fmtH(s.agentHours), R.fmtH(s.wallHours), `×${s.parallelism.toFixed(1)}`,
      R.fmtH(s.longestRunHours), R.fmtH(s.mainHours), R.fmtH(s.subagentHours)];
    if (multi) for (const name of names) { const a = s.agents.find((x) => x.name === name); row.push(a ? R.fmtH(a.hours) : '0m'); }
    rows.push(row);
    daily.push({ date: M.dayKey(ds), ...s });
  }
  const tot = H.summarize(agents, from, to);
  if (o.json) return console.log(JSON.stringify({ from, to, scope: 'both', ...tot, daily }, null, 2));
  const headers = [L('date', '日付'), L('agent-hrs', '延べ稼働'), L('wall', '実経過'), L('parallel', '並列'), L('longest', '最長連続'), L('main', 'メイン'), L('subagents', 'サブ')];
  const totalRow = [L('Total', '合計'), R.fmtH(tot.agentHours), R.fmtH(tot.wallHours), `×${tot.parallelism.toFixed(1)}`, R.fmtH(tot.longestRunHours), R.fmtH(tot.mainHours), R.fmtH(tot.subagentHours)];
  if (multi) for (const name of names) {
    headers.push(name);
    const a = tot.agents.find((x) => x.name === name);
    totalRow.push(a ? R.fmtH(a.hours) : '0m');
  }
  console.log(R.banner(L(`${NAME} hours — daily (${label})`, `${NAME} hours — 日別 (${label})`)));
  console.log(R.table(headers, rows, { totalRow }));
  console.log(scopeLine);
  if (tot.personMonths >= 0.1) {
    console.log(L(`\n  = ${tot.personMonths.toFixed(2)} person-months of machine time (${H.HOURS_PER_PERSON_DAY}h × ${H.DAYS_PER_PERSON_MONTH}d). Try: ${NAME} hours --monthly, ${NAME} hours --card`,
      `\n  = 人月換算 ${tot.personMonths.toFixed(2)} 人月ぶんの稼働 (${H.HOURS_PER_PERSON_DAY}h × ${H.DAYS_PER_PERSON_MONTH}日)。月別: ${NAME} hours --monthly / 共有: ${NAME} hours --card`));
  }
}

// ---------------------------------------------------------------- tools

function firstEventMs(sessions) {
  let first = Infinity;
  for (const s of sessions) if (s.events.length && s.events[0].t < first) first = s.events[0].t;
  return first;
}

function cmdTools(o, found) {
  const sessions = allSessions(found);
  const { from, to, label } = resolveRange(o, firstEventMs(sessions), new Date());
  const s = Tools.summarize(sessions, from, to, { scope: o.scope });
  const multi = Object.keys(s.byAgent).length > 1;
  if (o.json) {
    const out = { from, to, scope: o.scope === 'both' ? 'both' : 'main', ...s, errors: undefined };
    if (o.suggest) out.suggest = Tools.suggest(s);
    return console.log(JSON.stringify(out, null, 2));
  }
  if (!s.total) return console.log(L('(no tool calls in this window)', '(この期間にツール呼び出しはありません)'));
  console.log(R.banner(L(`${NAME} tools — ${n(s.total)} calls, ${s.errorRate}% error (${label})`, `${NAME} tools — ${n(s.total)} 回, エラー ${s.errorRate}% (${label})`)));
  const max = s.rows[0].calls;
  const shown = s.rows.slice(0, 30);
  const names = clipNames(shown.map((r) => r.tool));
  const rows = shown.map((r, i) => [
    ...(multi ? [r.agent] : []),
    names[i], n(r.calls), Tools.bar(r.calls, max, 20),
    r.errors ? `⚠ ${n(r.errors)} (${r.errorRate}%)` : '',
  ]);
  console.log(R.table([...(multi ? [L('agent', 'エージェント')] : []), L('tool', 'ツール'), L('calls', '呼び出し'), '', L('errors', 'エラー')], rows,
    { align: [...(multi ? ['l'] : []), 'l', 'r', 'l', 'l'] }));
  if (multi) {
    const parts = Object.entries(s.byAgent).map(([a, b]) => `${a} ${n(b.calls)} (${b.errorRate}% err)`);
    console.log(L(`  by agent: ${parts.join(' · ')}`, `  エージェント別: ${parts.join(' · ')}`));
  }
  if (s.rows.length > 30) console.log(L(`  … ${s.rows.length - 30} more tools; --json for all`, `  … 他 ${s.rows.length - 30} ツール(--json で全件)`));
  if (o.suggest) {
    const sug = Tools.suggest(s);
    console.log('');
    if (!sug.length) console.log(L('  no tool over 20% failure with 5+ calls', '  5回以上呼ばれて失敗率20%超のツールはありません'));
    for (const t of sug) {
      const g = Tools.guardCandidate(t);
      console.log(L(`  ${multi ? t.agent + ' ' : ''}${t.tool}: ${t.errors}/${t.calls} failed (${t.errorRate}%) — ${g.candidate ? '🛡 guard candidate: ' : ''}${g.reason}`,
        `  ${multi ? t.agent + ' ' : ''}${t.tool}: ${t.calls} 回中 ${t.errors} 回失敗 (${t.errorRate}%) — ${g.candidate ? '🛡 ガード候補: ' : ''}${g.reason}`));
      for (const c of t.clusters.slice(0, 5)) console.log(`      ${String(c.count).padStart(4)}× [${Tools.classifyFailure(c).kind}] ${c.sample.slice(0, 84)}`);
    }
  }
}

// ---------------------------------------------------------------- blast

function cmdBlast(o, found) {
  const sessions = allSessions(found);
  if (!o.all && !o.days && !o.since && !o.today && !o.thisMonth) o.days = 30;
  const { from, to, label } = resolveRange(o, firstEventMs(sessions), new Date());
  const r = Blast.summarize(sessions, from, to);
  if (o.json) return console.log(JSON.stringify({ from, to, ...r }, null, 2));
  if (!r.actions) return console.log(L('(no agent activity in this window)', '(この期間にエージェントの記録がありません)'));
  const bar = (f, w = 22) => { const k = Math.max(0, Math.min(w, Math.round((f || 0) * w))); return '█'.repeat(k) + '░'.repeat(w - k); };
  const acted = r.contained + r.ephemeral + r.escaped;
  const out = [''];
  out.push(`  ${NAME} blast — ${label}`);
  out.push('');
  out.push(L(`  Your agents took ${n(acted)} actions that changed something.`, `  エージェントが何かを変えた操作は ${n(acted)} 回。`));
  out.push('');
  out.push(`  ${bar(r.containment)}  ${(r.containment * 100).toFixed(1)}%`);
  out.push(L(`  caught by your safety net (git, temp dirs) — undoable`, `  が安全網(git・一時領域)の中 — 取り消せる`));
  out.push('');
  out.push(L(`  ${n(r.escaped)} escaped it. Those cannot be undone locally:`, `  ${n(r.escaped)} 回は外に出た。ローカルでは取り消せない:`));
  out.push('');
  for (const c of r.categories) out.push(`    ${String(n(c.count)).padStart(6)}  ${c.label}`);
  const agents = Object.entries(r.byAgent);
  if (agents.length > 1) {
    out.push('');
    out.push(L('  by agent:', '  エージェント別:'));
    for (const [a, b] of agents) out.push(`    ${a.padEnd(8)} ${bar(b.containment, 12)} ${(b.containment * 100).toFixed(1)}%  ${n(b.escaped)} escaped / ${n(b.contained + b.ephemeral + b.escaped)} changes`);
  }
  if (o.list) {
    out.push('');
    out.push(L('  examples:', '  実例:'));
    for (const c of r.categories) for (const s of c.samples) {
      out.push(`    ${M.dayKey(s.ts)}  ${s.agent.padEnd(7)} ${String(s.detail).replace(/\s+/g, ' ').slice(0, 88)}`);
    }
  }
  if (r.busiestDay) {
    out.push('');
    out.push(L(`  busiest day: ${r.busiestDay[0]} (${n(r.busiestDay[1])} escaped actions)`, `  最も多かった日: ${r.busiestDay[0]}(${n(r.busiestDay[1])} 回)`));
  }
  out.push('');
  out.push(L('  This is not a warning — it is the measurement nobody has.', '  これは警告ではなく、誰も持っていなかった実測値です。'));
  out.push(L(`  ${n(r.readonly)} read-only actions were ignored; only changes are counted.`, `  読み取りのみの ${n(r.readonly)} 回は数えていません(変更した操作だけを数えます)。`));
  out.push('');
  console.log(out.join('\n'));
}

// ---------------------------------------------------------------- leaks

function confirm(question) {
  if (!process.stdin.isTTY) {
    console.error(L('scrub: refusing to rewrite files without a TTY — pass --yes to proceed non-interactively.', 'scrub: TTY なしでは書き換えません — 非対話で進めるには --yes を付けてください。'));
    process.exit(2);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); }));
}

async function cmdLeaksScrub(o, sources, sinceMs) {
  const eligible = sources.filter((s) => s.scrubbable);
  const skippedDb = sources.length - eligible.length;
  const plan = [];
  const skipped = [];
  let allHits = [];
  for (const s of eligible) {
    let mtimeMs;
    try { mtimeMs = fs.statSync(s.file).mtimeMs; } catch (e) { continue; }
    if (sinceMs != null && mtimeMs < sinceMs) continue;
    if (Leaks.isActive(mtimeMs)) { skipped.push(s); continue; }
    let content;
    try { content = fs.readFileSync(s.file, 'utf8'); } catch (e) { continue; }
    const r = Leaks.scrubContent(content, Leaks.RULES);
    if (r.changed) { plan.push({ ...s, hits: r.hits, parseErrors: r.parseErrors }); allHits = allHits.concat(r.hits); }
  }
  for (const s of skipped) console.log(L(`⏭  skipped (active in the last 5 min — likely a live session): ${s.file}`, `⏭  スキップ(5分以内に更新 — 稼働中のセッション): ${s.file}`));
  if (skippedDb) console.log(L(`⏭  ${skippedDb} database source(s) are scan-only; ${NAME} never writes to another program's database.`, `⏭  データベース由来の ${skippedDb} 件は走査のみ。${NAME} は他プログラムのデータベースに書きません。`));
  if (!plan.length) { console.log(L('✅ nothing to scrub — no secrets matched in eligible transcript files.', '✅ 対象なし — 書き換え可能な転記に秘密は見つかりませんでした。')); process.exit(0); }
  const grouped = Leaks.groupHits(allHits);
  console.log(L(`\nWill redact ${allHits.length} occurrence(s) of ${grouped.length} distinct secret(s) across ${plan.length} file(s):\n`, `\n${plan.length} ファイル中の ${grouped.length} 種類・${allHits.length} 箇所を伏せ字にします:\n`));
  for (const g of grouped) console.log(`  [${g.name}]  ${g.masked}   ${g.occurrences}×`);
  console.log('');
  for (const p of plan) console.log(`  ${p.agent.padEnd(7)} ${p.file}${p.parseErrors ? `   (${p.parseErrors} unparseable line(s) kept verbatim)` : ''}`);
  if (o.dryRun) { console.log(L('\n--dry-run: no files were modified.', '\n--dry-run: 変更していません。')); process.exit(1); }
  if (!o.yes) {
    const go = await confirm(L('\nRewrite these files in place? [y/N] ', '\nこれらのファイルをその場で書き換えますか? [y/N] '));
    if (!go) { console.log(L('aborted — nothing changed.', '中止 — 何も変えていません。')); process.exit(2); }
  }
  let changed = 0;
  const backups = [];
  for (const p of plan) {
    let mtimeMs;
    try { mtimeMs = fs.statSync(p.file).mtimeMs; } catch (e) { continue; }
    if (Leaks.isActive(mtimeMs)) { console.log(`⏭  became active, skipped: ${p.file}`); continue; }
    const r = Leaks.scrubFile(p.file, Leaks.RULES, { backup: !o.noBackup });
    if (r.changed) { changed++; if (!o.noBackup) backups.push(p.file + '.pre-scrub.bak'); }
  }
  let residual = 0;
  for (const p of plan) { try { residual += Leaks.scrubContent(fs.readFileSync(p.file, 'utf8'), Leaks.RULES).hits.length; } catch (e) { /* unreadable */ } }
  console.log(`\n✅ scrubbed ${changed} file(s). Re-scan of those files: ${residual === 0 ? '0 findings' : `⚠ ${residual} finding(s) remain`}.`);
  if (backups.length) {
    console.log(L('\n⚠  Backups still CONTAIN the secrets. After verifying your sessions, delete them:', '\n⚠  バックアップには秘密がそのまま残っています。確認後に削除してください:'));
    for (const b of backups) console.log(`     rm '${b}'`);
  }
  console.log(L('\nRedaction removes local copies — it does not un-leak anything. Rotate the credentials.', '\n伏せ字はローカルのコピーを消すだけで、漏洩を取り消しはしません。資格情報をローテートしてください。'));
  process.exit(residual === 0 ? 0 : 1);
}

/**
 * Leaks reads whole files, so a period can only be a modification-time
 * cutoff: a file untouched since the start holds nothing newer. An end date
 * cannot be honoured that way (a file touched later still holds older
 * lines), so --until is refused rather than silently ignored.
 */
function leaksSince(o) {
  if (o.until) usageError(L('leaks: --until is not supported — files are selected by modification time, so only a start (--since, --days, --week, --month, --today) can be honoured', 'leaks: --until は使えません — ファイルを更新時刻で選ぶため、開始側(--since, --days, --week, --month, --today)しか守れません'));
  return hasPeriod(o) ? resolveRange(o, NaN, new Date()).from : null;
}

async function cmdLeaks(o, sources) {
  const sinceMs = leaksSince(o);
  if (o.sub === 'scrub') return cmdLeaksScrub(o, sources, sinceMs);
  const r = Leaks.scan(sources, { sinceMs });
  // exit 1 means findings, so a source that could not be read must not share
  // it: 3 = nothing found, but the scan was incomplete.
  const code = r.findings.length ? 1 : r.unreadable.length ? 3 : 0;
  if (o.json) {
    console.log(JSON.stringify({ sources_scanned: r.scanned, unreadable: r.unreadable, findings: r.findings.map((f) => ({ ...f, files: undefined })) }, null, 2));
    process.exit(code);
  }
  for (const u of r.unreadable) console.log(L(`⚠  could not read ${u.agent} ${u.file}: ${u.error}`, `⚠  読めませんでした ${u.agent} ${u.file}: ${u.error}`));
  if (!r.findings.length) {
    if (r.unreadable.length) console.log(L(`no secrets matched in the ${n(r.scanned)} source(s) that could be read — not a clean bill: ${r.unreadable.length} went unread`, `読めた ${n(r.scanned)} 件に秘密はありませんでした — ただし ${r.unreadable.length} 件は未読のため「異常なし」とは言えません`));
    else console.log(L(`✅ clean — no secrets matched in ${n(r.scanned)} source(s)`, `✅ 異常なし — ${n(r.scanned)} 件の転記に秘密は見つかりませんでした`));
    process.exit(code);
  }
  console.log(L(`🚨 ${r.findings.length} distinct secret(s) found in your agents' transcripts:\n`, `🚨 転記に ${r.findings.length} 種類の秘密が残っています:\n`));
  for (const f of r.findings) {
    console.log(`  [${f.name}]  ${f.masked}`);
    console.log(L(`      agents: ${f.agents.join(', ')}   in ${f.fileCount} file(s)   seen ${f.occurrences}×`, `      エージェント: ${f.agents.join(', ')}   ${f.fileCount} ファイル   ${f.occurrences} 回`));
  }
  console.log(L(`\nWhat to do:
  1. Rotate these credentials NOW — treat them as exposed.
  2. Remove them from your history without losing it:
     ${NAME} leaks scrub      (redacts in place, keeps the sessions; file sources only)
  3. Prevention: keep secrets in env vars/managers, never paste them into a
     session, and remember tool output (curl -v, env, printenv) is recorded too.`,
  `\nやること:
  1. この資格情報を今すぐローテートする — 漏れたものとして扱う。
  2. 履歴を失わずに消す:
     ${NAME} leaks scrub      (その場で伏せ字にする。ファイル由来の転記のみ)
  3. 予防: 秘密は環境変数やマネージャに置き、セッションに貼らない。
     ツール出力(curl -v, env, printenv)も記録されることを忘れない。`));
  process.exit(1);
}

// ---------------------------------------------------------------- stats

function cmdStats(o, found) {
  const sessions = allSessions(found);
  const { from, to, label } = resolveRange(o, firstEventMs(sessions), new Date());
  const s = Stats.summarize(sessions, from, to);
  if (o.json) return console.log(JSON.stringify({ from, to, ...s }, null, 2));
  if (!s.sessions) return console.log(L('(no sessions in this window)', '(この期間にセッションはありません)'));
  const DOW = JA ? ['日', '月', '火', '水', '木', '金', '土'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const f = Stats.fmt;
  console.log(R.banner(L(`${NAME} stats — ${label}`, `${NAME} stats — ${label}`)));
  console.log(L(`sessions ${n(s.sessions)}   prompts ${n(s.prompts)}   replies ${n(s.replies)}   tool calls ${n(s.toolCalls)}`, `セッション ${n(s.sessions)}   指示 ${n(s.prompts)}   返答 ${n(s.replies)}   ツール実行 ${n(s.toolCalls)}`));
  console.log(L(`  dialogue counts are main loop + human prompts only; tokens include subagents`, `  対話の数はメインループの人間の指示のみ。トークンはサブエージェント込み`));
  console.log(L(`avg session ${s.avgSessionMin} min   ${s.toolsPerPrompt} tool calls per prompt`, `平均セッション長 ${s.avgSessionMin}分   1指示あたりツール実行 ${s.toolsPerPrompt}回`));
  console.log(L(`\nhour of day (0-23)\n  ${Stats.sparkline(s.byHour)}\n  peak: ${s.peakHour}:00 / ${DOW[s.peakDow]}`, `\n活動時間帯 (0-23時)\n  ${Stats.sparkline(s.byHour)}\n  ピーク: ${s.peakHour}時台 / ${DOW[s.peakDow]}曜日`));
  const agents = Object.entries(s.byAgent);
  if (agents.length > 1) {
    console.log(L('\nby agent', '\nエージェント別'));
    for (const [a, b] of agents) console.log(`  ${a.padEnd(8)} ${L('prompts', '指示')} ${String(n(b.prompts)).padStart(6)}   ${L('tool calls', 'ツール')} ${String(n(b.toolCalls)).padStart(7)}   ${L('tokens', 'トークン')} ${f(b.tokens)}`);
  }
  if (s.topProjects.length) {
    console.log(L('\ntop projects', '\nよく使うプロジェクト'));
    for (const [p, c] of s.topProjects) console.log(`  ${short(p).padEnd(24)} ${n(c)} ${L('prompts', '指示')}`);
  }
  const models = Object.entries(s.byModel).sort((a, b) => b[1] - a[1]);
  if (models.length) {
    console.log(L('\ntokens by model', '\nモデル別トークン'));
    for (const [m, v] of models) console.log(`  ${m.padEnd(14)} ${f(v)}`);
  }
  console.log(L(`\ntokens ${f(s.tokens.total)}  (${s.cacheShare}% cache reads)`, `\nトークン合計 ${f(s.tokens.total)}  (うちキャッシュ読込 ${s.cacheShare}%)`));
  console.log(`  in ${f(s.tokens.in)}  out ${f(s.tokens.out)}  cacheR ${f(s.tokens.cacheRead)}  cacheW ${f(s.tokens.cacheWrite)}`);
  if (s.lines.added) console.log(L(`\nlines written +${n(s.lines.added)} / removed −${n(s.lines.removed)} (from recorded patches)`, `\n書いた行 +${n(s.lines.added)} / 消した行 −${n(s.lines.removed)}(記録されたパッチから)`));
  if (s.compactions) console.log(L(`context compacted ${n(s.compactions)}× — that many times a session forgot its own beginning`, `コンテキスト圧縮 ${n(s.compactions)}回 — その回数だけ、セッションは冒頭を忘れています`));
}

// ---------------------------------------------------------------- timeline

function cmdTimeline(o, found) {
  const sessions = allSessions(found);
  const weeks = o.weeks || 26;
  // A period narrows the samples, and --until also moves the calendar's
  // right edge (and the day "current streak" counts back from).
  const range = hasPeriod(o) ? resolveRange(o, firstEventMs(sessions), new Date()) : null;
  const endKey = o.until ? M.dayKey(range.to - 1) : null;
  const samples = range ? Timeline.samplesOf(sessions, range.from, range.to) : Timeline.samplesOf(sessions);
  if (!samples.length && !o.json) return console.log(L('(no records yet)', '(まだ記録がありません)'));
  const days = Timeline.byDay(samples);
  const cal = Timeline.calendar(days, endKey, weeks);
  const st = Timeline.streaks(days, endKey);
  const totalTokens = samples.reduce((a, s) => a + s.tokens, 0);
  if (o.json) {
    return console.log(JSON.stringify({
      ...(range ? { from: range.from, to: range.to } : {}),
      days: [...days.entries()].map(([d, v]) => ({ day: d, tokens: v.tokens, stamps: v.stamps, sessions: v.sessions.size })),
      streaks: st, totalTokens, activeDays: days.size,
    }, null, 2));
  }
  const DOW = JA ? ['日', '月', '火', '水', '木', '金', '土'] : ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  console.log(range ? L(`📅 ${range.label} · ${weeks} weeks shown\n`, `📅 ${range.label} · ${weeks}週を表示\n`) : L(`📅 last ${weeks} weeks\n`, `📅 直近${weeks}週\n`));
  console.log('    ' + Timeline.monthAxis(cal.start, weeks));
  cal.grid.forEach((line, i) => console.log(`${DOW[i].padEnd(3)} ${line}`));
  console.log(`    ${Timeline.HEAT.join(' ')}  ${L('less → more', '少 → 多')}`);
  console.log(L(`\n⏰ hour of day (0-23)\n    ${Timeline.hourBars(samples)}`, `\n⏰ 時間帯 (0-23時)\n    ${Timeline.hourBars(samples)}`));
  console.log(L(`\n🔥 streak ${st.current} days  (longest ${st.longest})`, `\n🔥 連続 ${st.current}日  (最長 ${st.longest}日)`));
  console.log(L(`📊 ${n(days.size)} active days · ${Stats.fmt(totalTokens)} tokens`, `📊 稼働 ${n(days.size)}日 · ${Stats.fmt(totalTokens)} tokens`));
  const projects = new Map();
  for (const s of samples) projects.set(s.project, (projects.get(s.project) || 0) + (s.tokens || s.stamp || 0));
  const top = [...projects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length > 1) {
    console.log(L('\nprojects:', '\nプロジェクト:'));
    const max = top[0][1];
    for (const [p, v] of top) console.log(`  ${short(p).padEnd(20)} ${'█'.repeat(Math.max(1, Math.round((v / max) * 20))).padEnd(20)} ${Stats.fmt(v)}`);
  }
}

// ---------------------------------------------------------------- quota

function cmdQuota(o, found) {
  const period = o.period || 'month';
  if (!Quota.PERIODS[period]) { console.error(L('--period must be day|week|month', '--period は day|week|month')); process.exit(2); }
  let conf = Quota.readConf();
  if (o.clear) { Quota.writeConf({}); return console.log(L('✅ budgets cleared', '✅ 予算をすべて削除しました')); }
  if (o.set && o.set.length) {
    for (const s of o.set) {
      const m = String(s).match(/^(.+)=(\d+(?:\.\d+)?)$/);
      if (!m) { console.error(L(`--set: "${s}" must be project=percent`, `--set: "${s}" は project=percent 形式で指定してください`)); process.exit(2); }
      conf[m[1]] = Number(m[2]);
    }
    const v = Quota.validateBudgets(conf);
    Quota.writeConf(conf);
    console.log(L(`✅ budgets set: ${Object.entries(conf).map(([k, x]) => `${k} ${x}%`).join(', ')}  (${Quota.confPath()})`, `✅ 予算を設定: ${Object.entries(conf).map(([k, x]) => `${k} ${x}%`).join(', ')}  (${Quota.confPath()})`));
    if (!v.valid) console.log(L(`⚠ budgets sum to ${v.sum}% — ${v.over} points over 100`, `⚠ 合計 ${v.sum}% — 100%を${v.over}pt超えています`));
    return;
  }
  const now = Date.now();
  const usage = Quota.usageByProject(allSessions(found), period, now);
  const progress = Quota.periodProgress(period, now);
  const result = Quota.assess(usage, conf, progress);
  if (o.json) return console.log(JSON.stringify({ period, ...result, budgets: conf }, null, 2));
  if (!result.total) return console.log(L(`(no token usage recorded this ${period})`, `(この${period === 'month' ? '月' : period === 'week' ? '週' : '日'}の記録なし)`));
  const ICON = { over: '🔴', 'slightly-over': '🟠', 'on-track': '🟢', under: '🔵', unbudgeted: '⚪' };
  const LABEL = JA ? { over: '超過', 'slightly-over': 'やや超過', 'on-track': '想定内', under: '余裕', unbudgeted: '予算なし' }
    : { over: 'over', 'slightly-over': 'slightly over', 'on-track': 'on track', under: 'under', unbudgeted: 'no budget' };
  const PN = JA ? { day: '今日', week: '今週', month: '今月' }[period] : `this ${period}`;
  console.log(L(`🧮 ${PN} by project  (${Math.round(progress * 100)}% of the period elapsed · ${Stats.fmt(result.total)} tokens)\n`, `🧮 ${PN}の配分  (期間の ${Math.round(progress * 100)}% 経過 · 計 ${Stats.fmt(result.total)} tokens)\n`));
  for (const r of result.rows.slice(0, 20)) {
    const bar = '█'.repeat(Math.max(0, Math.round(r.share * 24))).padEnd(24, '·');
    const budgetStr = r.budget != null ? L(`budget ${Math.round(r.budget * 100)}%`, `予算 ${Math.round(r.budget * 100)}%`) : '—';
    console.log(`  ${ICON[r.status]} ${String(r.name).slice(0, 18).padEnd(18)} ${bar} ${String(Math.round(r.share * 100)).padStart(3)}%  ${budgetStr.padEnd(10)} ${LABEL[r.status]}`);
  }
  if (result.rows.length > 20) console.log(L(`  … ${result.rows.length - 20} more (--json)`, `  … 他 ${result.rows.length - 20} 件(--json)`));
  const v = Quota.validateBudgets(conf);
  if (!v.valid) console.log(L(`\n⚠ budgets sum to ${v.sum}% (over 100%)`, `\n⚠ 予算の合計が ${v.sum}% です(100%を超えています)`));
  if (!Object.keys(conf).length) console.log(L(`\nset a budget: ${NAME} quota --set ${result.rows.slice(0, 2).map((r) => r.name + '=50').join(' ')}`, `\n予算を決める: ${NAME} quota --set ${result.rows.slice(0, 2).map((r) => r.name + '=50').join(' ')}`));
}

// ---------------------------------------------------------------- diff

function cmdDiff(o, found) {
  const s = Diff.pickSession(allSessions(found), { id: o.session, project: o.project });
  if (!s) { console.error(L('no matching session', 'セッションが見つかりません')); process.exit(1); }
  const { files, commands, lines } = Diff.collectChanges(s);
  if (o.json) return console.log(JSON.stringify({ agent: s.agent, session: s.id, project: s.project, files, commands, lines }, null, 2));
  console.log(`=== ${s.agent} · ${short(s.project)} / ${s.id.slice(0, 8)} ===`);
  if (!files.length) console.log(L('(no file changes)', '(ファイル変更なし)'));
  for (const c of files) {
    const kind = c.created && c.writes && !c.edits ? L('new  ', '新規') : c.writes ? L('write', '書換') : L('edit ', '編集');
    const rel = s.project && c.path.startsWith(s.project) ? c.path.slice(s.project.length + 1) : c.path;
    const churn = c.added || c.removed ? `  +${c.added} −${c.removed}` : '';
    console.log(`  ${kind}  ${rel}` + (c.touches > 1 ? `  (${c.touches}×)` : '') + churn);
  }
  console.log(`\n${files.length} files · ${commands.length} commands` + (lines.added ? ` · +${lines.added} −${lines.removed} ${L('lines', '行')}` : ''));
  if (lines.added && lines.selfUndo >= 0.25) console.log(L(`  ${(lines.selfUndo * 100).toFixed(0)}% of the lines it wrote, it removed again from files it created — before any commit, so git never sees it`, `  書いた行の ${(lines.selfUndo * 100).toFixed(0)}% を、自分で作ったファイルから自分で消しています(コミット前なので git には残りません)`));
  if (o.commands && commands.length) {
    console.log(L('\n--- commands ---', '\n--- 実行したコマンド ---'));
    for (const c of commands.slice(0, 40)) console.log(`  $ ${c.command.slice(0, 110)}`);
    if (commands.length > 40) console.log(L(`  … ${commands.length - 40} more`, `  … 他 ${commands.length - 40} 件`));
  }
  if (o.git) {
    const g = Diff.gitChanged(s.project && s.project.startsWith('/') ? s.project : process.cwd());
    if (!g) console.log(L('\n(not a git repository)', '\n(gitリポジトリではありません)'));
    else {
      const touched = new Set(files.map((c) => c.path));
      const other = g.filter((x) => !touched.has(x.path));
      console.log('\n--- git ---');
      console.log(L(`  git sees ${g.length} changed file(s)`, `  gitが検出した変更: ${g.length} 件`));
      if (other.length) { console.log(L(`  ⚠ ${other.length} not from this session:`, `  ⚠ このセッション以外の変更 ${other.length} 件:`)); for (const x of other.slice(0, 10)) console.log(`     ${x.status} ${x.path.split('/').pop()}`); }
      else console.log(L('  all from this session', '  すべてこのセッション由来'));
    }
  }
}

// ---------------------------------------------------------------- skills

function cmdSkills(o, found) {
  const sessions = allSessions(found);
  const { from, to, label } = resolveRange(o, firstEventMs(sessions), new Date());
  const known = Skills.installedSkills(sessions);
  const invs = Skills.invocations(sessions);
  const rows = Skills.summarize(invs, known, { from, to });
  const skills = rows.filter((r) => !r.isCommand);
  const commands = rows.filter((r) => r.isCommand);
  const unused = Skills.neverFired(rows, known);
  if (o.json) return console.log(JSON.stringify({ from, to, skills, commands, installed: [...known].sort(), unused }, null, 2));
  if (o.unused) {
    console.log(L(`${unused.length} installed skill(s) never fired (${known.size} installed, ${label}):`, `一度も発火していないスキル ${unused.length} 件(インストール ${known.size} 件、${label}):`));
    for (const u of unused) console.log(`  ${u}`);
    return;
  }
  if (!skills.length) return console.log(L('(no skill invocations recorded — only Claude Code records them today)', '(スキルの起動記録なし — 現状 Claude Code だけが記録します)'));
  const age = (ms) => { const d = Math.round((Date.now() - ms) / 86400000); return d <= 0 ? L('today', '今日') : `${d}d`; };
  const max = skills[0].total;
  const skillNames = clipNames(skills.slice(0, 30).map((r) => r.name));
  const tbl = skills.slice(0, 30).map((r, i) => [skillNames[i], n(r.total), n(r.tool), n(r.typed), n(r.auto), n(r.interactive), n(r.headless + r.ci), Tools.bar(r.total, max, 12), r.lastMs ? age(r.lastMs) : '']);
  console.log(R.banner(L(`${NAME} skills — ${label}`, `${NAME} skills — ${label}`)));
  console.log(R.table([L('skill', 'スキル'), L('runs', '回'), 'tool', 'typed', 'auto', L('interactive', '対話'), L('scheduled', '自動'), '', L('last', '最終')], tbl, { align: ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'l', 'r'] }));
  console.log(L(`  tool = the description matched · typed = you knew the name · auto = the runtime ran it (once per session)`, `  tool = description が合致 · typed = 名前を打った · auto = 自動発火(セッションごとに1回)`));
  console.log(L(`  interactive / scheduled = whether a person was in the loop (cli) or not (sdk-cli, CI)`, `  対話 / 自動 = 人が見ていた(cli)か、無人(sdk-cli・CI)か`));
  if (commands.length) console.log(L(`  built-in commands typed: ${commands.map((c) => `/${c.name} ${c.total}`).join(' · ')}`, `  組み込みコマンド: ${commands.map((c) => `/${c.name} ${c.total}`).join(' · ')}`));
  if (unused.length) console.log(L(`\n  ${unused.length} installed skill(s) never fired — ${NAME} skills --unused`, `\n  一度も発火していないスキル ${unused.length} 件 — ${NAME} skills --unused`));
}

// ---------------------------------------------------------------- attention

function cmdAttention(o, found) {
  const sessions = allSessions(found);
  if (!o.all && !o.days && !o.since && !o.today && !o.thisMonth) o.days = 21;
  const { from, to, label } = resolveRange(o, firstEventMs(sessions), new Date());
  const rows = Attention.summarize(sessions, { from, to, keyOf: o.weekly ? Attention.weekKey : Attention.dayKey });
  if (o.json) return console.log(JSON.stringify({ from, to, rows }, null, 2));
  if (!rows.length) return console.log(L('(no dialogue in this window)', '(この期間に対話はありません)'));
  console.log(R.banner(L(`${NAME} attention — ${label}${o.weekly ? ', by week' : ''}`, `${NAME} attention — ${label}${o.weekly ? '、週別' : ''}`)));
  const tbl = rows.map((r) => [r.key, n(r.sessions), n(r.you), String(r.perSession), `${r.newIntentShare}%`, n(r.status), n(r.approve), n(r.nudge), n(r.agent), n(r.bursts), r.fixes ? `${n(r.fixes)} (${r.fixShare}%)` : '']);
  console.log(R.table([L('period', '期間'), L('sess', 'ｾｯｼｮﾝ'), L('you', 'あなた'), L('per sess', '/ｾｯｼｮﾝ'), L('new intent', '新規'), L('status', '状況'), L('approve', '承認'), L('nudge', '催促'), L('agent', 'ｴｰｼﾞｪﾝﾄ'), L('bursts', '連投'), L('self-fix', '自己訂正')], tbl));
  console.log(L(`  you = human turns · per sess = turns per session you spoke in that day (the errand unit)
  new intent = turns that were not a status check, approval or nudge · bursts = 4+ replies with no turn from you
  self-fix = replies retracting a previous one. Heuristic patterns (ja/en); a trend, not a verdict.`,
  `  あなた = 人の発話 · /ｾｯｼｮﾝ = その日に話したセッション1つあたりの発話数(用件の単位)
  新規 = 状況確認・承認・催促でなかった発話の割合 · 連投 = あなたの発話なしに4回以上続いた返答
  自己訂正 = 直前の自分の出力を撤回した返答。パターン判定(日英)なので、傾向として読む。`));
}

// ---------------------------------------------------------------- guards

function cmdGuards(o, found) {
  let guards = Guards.readGuards();
  if (o.sub === 'add') {
    if (!o.arg) { console.error(L('guards add <tool> [--since YYYYMMDD] [--note ..] [--signature ..]', 'guards add <ツール名> [--since YYYYMMDD] [--note ..] [--signature ..]')); process.exit(2); }
    const since = M.localIso(o.since ? parseDate(o.since) : Date.now());
    guards = guards.filter((g) => !(g.tool === o.arg && (g.signature || null) === (o.signature || null)));
    guards.push({ tool: o.arg, since, ...(o.signature ? { signature: o.signature } : {}), ...(o.note ? { note: o.note } : {}) });
    Guards.writeGuards(guards);
    return console.log(L(`✅ guard registered: ${o.arg} since ${M.dayKey(Date.parse(since))}  (${Guards.confPath()})`, `✅ ガードを登録: ${o.arg} ${M.dayKey(Date.parse(since))} 以降  (${Guards.confPath()})`));
  }
  if (o.sub === 'rm') {
    if (!o.arg) usageError(L('guards rm <tool>', 'guards rm <ツール名>'));
    const before = guards.length;
    guards = guards.filter((g) => g.tool !== o.arg);
    Guards.writeGuards(guards);
    return console.log(L(`removed ${before - guards.length} guard(s) for ${o.arg}`, `${o.arg} のガード ${before - guards.length} 件を削除`));
  }
  if (!guards.length && !o.json) return console.log(L(`(no guards registered — after installing a hook or a rule: ${NAME} guards add <tool> --note "what you did")`, `(ガードの登録なし — hook や規則を入れたら: ${NAME} guards add <ツール名> --note "何をしたか")`));
  const results = Guards.evaluate(guards, allSessions(found));
  if (o.json) return console.log(JSON.stringify(results, null, 2));
  const ICON = { fixed: '✅', improved: '🟢', unchanged: '🟡', worse: '🔴', insufficient: '⏳', 'no-baseline': '⚪' };
  console.log(R.banner(L(`${NAME} guards — did it work?`, `${NAME} guards — 効いたか?`)));
  const rows = results.map((r) => [
    `${ICON[r.verdict]} ${r.tool}${r.signature ? ` [${r.signature.slice(0, 20)}]` : ''}`, M.dayKey(Date.parse(r.since)),
    `${n(r.rates.before.errors)}/${n(r.rates.before.calls)}${r.rates.before.rate != null ? ` (${r.rates.before.rate.toFixed(1)}%)` : ''}`,
    `${n(r.rates.after.errors)}/${n(r.rates.after.calls)}${r.rates.after.rate != null ? ` (${r.rates.after.rate.toFixed(1)}%)` : ''}`,
    r.verdict, r.reason + (r.note ? `  · ${L('note', 'メモ')}: ${r.note}` : ''),
  ]);
  console.log(R.table([L('guard', 'ガード'), L('since', '投入日'), L('before', '前'), L('after', '後'), L('verdict', '判定'), ''], rows, { align: ['l', 'l', 'r', 'r', 'l', 'l'] }));
  console.log(L('  calls are shown beside rates so "fewer failures because fewer calls" cannot pass as success; fewer than 20 calls since = not yet', '  呼出数を率の横に出すのは「呼ばなくなったから減った」を成功と読まないため。投入後20件未満は「まだ言えない」'));
}

// ---------------------------------------------------------------- advise

function cmdAdvise(o, found) {
  const sessions = allSessions(found);
  if (!o.all && !o.days && !o.since && !o.today && !o.thisMonth) o.days = 30;
  const { from, to, label } = resolveRange(o, firstEventMs(sessions), new Date());
  const f = Advise.findings(sessions, from, to);
  if (o.json) return console.log(JSON.stringify({ from, to, findings: f }, null, 2));
  if (o.show) {
    const one = f.find((x) => x.id === o.show || x.id.startsWith(o.show));
    if (!one) { console.error(L(`no finding "${o.show}"`, `"${o.show}" という所見はありません`)); process.exit(1); }
    console.log(`${one.id}\n${one.title}\n\n${one.advice}\n`);
    if (one.artifact) console.log(one.artifact + '\n');
    console.log(L(`re-measure: ${one.remeasure}`, `測り直し: ${one.remeasure}`));
    return;
  }
  console.log(R.banner(L(`${NAME} advise — ${label}`, `${NAME} advise — ${label}`)));
  if (!f.length) return console.log(L('  nothing crossed a threshold. That is the result, not an absence of one.', '  閾値を超えたものはありません。これが結果であって、未計測ではありません。'));
  const SEV = { high: '🔴', medium: '🟠', low: '🟡' };
  for (const x of f) {
    console.log(`\n${SEV[x.severity]} ${x.id}`);
    console.log(`   ${x.title}`);
    console.log(L(`   threshold: ${x.threshold}`, `   閾値: ${x.threshold}`));
    console.log(`   → ${x.advice}`);
    console.log(L(`   re-measure: ${x.remeasure}${x.artifact ? `   · artifact: ${NAME} advise --show ${x.id}` : ''}`, `   測り直し: ${x.remeasure}${x.artifact ? `   · 現物: ${NAME} advise --show ${x.id}` : ''}`));
  }
  console.log(L(`\n  nothing was changed. Every line above names the number it came from and the command that checks whether the change worked.`, `\n  何も変更していません。各行は根拠の数字と、直した後に確かめるコマンドを持っています。`));
}


// ---------------------------------------------------------------- overlap

function cmdOverlap(o, found) {
  const sessions = allSessions(found);
  if (!o.all && !o.days && !o.since && !o.today && !o.thisMonth) o.days = 30;
  const { from, to, label } = resolveRange(o, firstEventMs(sessions), new Date());
  const cols = Overlap.collisions(sessions, { from, to, windowMin: o.window || Overlap.WINDOW_MIN });
  if (o.json) return console.log(JSON.stringify({ from, to, windowMin: o.window || Overlap.WINDOW_MIN, collisions: cols }, null, 2));
  console.log(R.banner(L(`${NAME} overlap — ${label}, window ${o.window || Overlap.WINDOW_MIN} min`, `${NAME} overlap — ${label}、窓 ${o.window || Overlap.WINDOW_MIN} 分`)));
  if (!cols.length) {
    const wider = Overlap.collisions(sessions, { from, to, windowMin: 24 * 60 }).length;
    return console.log(L(`  no file was written by two sessions within the window. That is the result${wider ? ` (${wider} file(s) collide within 24h: --window 1440)` : ''}.`,
      `  窓の中で2セッションが同じファイルを書いた例はありません。これが結果です${wider ? `(24時間なら ${wider} 件: --window 1440)` : ''}。`));
  }
  const rows = cols.slice(0, 40).map((c) => [short(c.path), n(c.sessions), n(c.pairs), `${c.minGapMin}m`, n(c.writes)]);
  console.log(R.table([L('file', 'ファイル'), L('sessions', 'セッション'), L('collisions', '衝突'), L('closest', '最短間隔'), L('writes', '書込')], rows, { align: ['l', 'r', 'r', 'r', 'r'] }));
  console.log(L('\n  closest collisions:', '\n  最も近かった衝突:'));
  for (const c of cols.slice(0, 5)) for (const x of c.examples.slice(0, 1)) {
    console.log(`  ${M.minuteKey(x.t)}  ${short(c.path).padEnd(28)} ${x.a.agent} …${x.a.session.slice(-6)} → ${x.b.agent} …${x.b.session.slice(-6)}  ${x.gapMin}m apart`);
  }
  console.log(L(`  ${n(cols.length)} file(s) collided. A collision is the same path written by two sessions (subagents count under their parent) within the window.`, `  衝突したファイル ${n(cols.length)} 件。衝突 = 別セッション(サブエージェントは親に含める)が窓の中で同じパスに書いたこと。`));
}

// ---------------------------------------------------------------- waits

function cmdWaits(o, found) {
  const sessions = allSessions(found);
  if (!o.all && !o.days && !o.since && !o.today && !o.thisMonth) o.days = 14;
  const { from, to, label } = resolveRange(o, firstEventMs(sessions), new Date());
  const keyOf = o.byAgent ? (t, s) => s.agent : undefined;
  const r = Waits.summarize(sessions, { from, to, keyOf });
  if (o.json) return console.log(JSON.stringify({ from, to, ...r }, null, 2));
  if (!r.rows.length) return console.log(L('(no human dialogue in this window)', '(この期間に人の対話はありません)'));
  const f = (sec) => R.fmtH(sec / 3600);
  const rows = r.rows.map((x) => [x.key, f(x.youWaitedS), n(x.youWaits), f(x.youLongestS), f(x.agentWaitedS), n(x.agentWaits), f(x.agentLongestS), f(x.toolWaitedS), n(x.toolWaits), f(x.toolLongestS)]);
  console.log(R.banner(L(`${NAME} waits — ${label}${o.byAgent ? ', by agent' : ''}`, `${NAME} waits — ${label}${o.byAgent ? '、エージェント別' : ''}`)));
  console.log(R.table([o.byAgent ? L('agent', 'エージェント') : L('day', '日'), L('you waited', 'あなたが待った'), '#', L('longest', '最長'), L('agent waited', 'エージェントが待った'), '#', L('longest', '最長'), L('tool waited', 'ツールが待った'), '#', L('longest', '最長')], rows,
    { totalRow: [L('Total', '合計'), f(r.total.youWaitedS), n(r.total.youWaits), f(r.total.youLongestS), f(r.total.agentWaitedS), n(r.total.agentWaits), f(r.total.agentLongestS), f(r.total.toolWaitedS), n(r.total.toolWaits), f(r.total.toolLongestS)] }));
  console.log(L(`  you waited = from your turn to the agent's first entry · agent waited = from its last entry to your next turn (capped at ${Waits.CAP_H}h: past that you had left)
  tool waited = a tool call that took over ${Waits.TOOL_WAIT_S}s to come back: a permission prompt or a slow tool — the transcript cannot tell which. Main loop, human turns only.`,
  `  あなたが待った = あなたの発話から次のエージェントの記録まで · エージェントが待った = 最後の記録からあなたの次の発話まで(${Waits.CAP_H}時間で打ち切り: それ以上は離席)
  ツールが待った = 結果が返るまで ${Waits.TOOL_WAIT_S} 秒超かかったツール呼び出し = 許可プロンプトか遅いツール(転記では区別できない)。メインループの人の発話のみ。`));
}

// ---------------------------------------------------------------- main

async function main() {
  const o = parseArgs(process.argv);
  if (o.command === 'leaks') return cmdLeaks(o, Readers.rawAll({ only: o.only, dirs: o.dirs }));
  const found = Readers.readAll({ only: o.only, dirs: o.dirs, includeAutomated: o.includeAutomated });
  if (o.command === 'agents') return cmdAgents(o, found);
  if (o.command === 'hours') return cmdHours(o, found);
  if (o.command === 'tools') return cmdTools(o, found);
  if (o.command === 'blast') return cmdBlast(o, found);
  if (o.command === 'stats') return cmdStats(o, found);
  if (o.command === 'timeline') return cmdTimeline(o, found);
  if (o.command === 'quota') return cmdQuota(o, found);
  if (o.command === 'diff') return cmdDiff(o, found);
  if (o.command === 'skills') return cmdSkills(o, found);
  if (o.command === 'attention') return cmdAttention(o, found);
  if (o.command === 'guards') return cmdGuards(o, found);
  if (o.command === 'advise') return cmdAdvise(o, found);
  if (o.command === 'overlap') return cmdOverlap(o, found);
  if (o.command === 'waits') return cmdWaits(o, found);
  console.error(L(`unknown command "${o.command}"`, `不明なコマンド "${o.command}"`));
  console.log(HELP);
  process.exit(2);
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  // leaks reserves exit 1 for "secrets found"; a crash there must not read as findings.
  process.exit(process.argv.slice(2).includes('leaks') ? 3 : 1);
});
