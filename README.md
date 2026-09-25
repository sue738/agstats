# agstats

**What your coding agents did, from their own transcripts — every agent on the machine, side by side.**

```bash
npx agstats agents       # which agents were found, and how much history each has
npx agstats hours        # agent-hours per day, per agent
npx agstats blast        # what cannot be undone
```

```
┌────────┬──────────┬───────────┬─────────────────────────┬──────────────────────────────────────┐
│ agent  │ sessions │ automated │ history                 │ where                                │
├────────┼──────────┼───────────┼─────────────────────────┼──────────────────────────────────────┤
│ claude │    10545 │           │ 2026-07-07 → 2026-09-21 │ ~/.claude/projects                   │
│ codex  │     1008 │           │ 2025-09-16 → 2026-09-20 │ ~/.codex/sessions                    │
│ gemini │        1 │     28974 │ 2025-06-26 → 2025-06-26 │ ~/.gemini/tmp                        │
│ cursor │       96 │           │ 2025-04-24 → 2026-05-04 │ ~/Library/…/Cursor/User/globalStorage │
└────────┴──────────┴───────────┴─────────────────────────┴──────────────────────────────────────┘
  "automated" = written by a program (an a2a server, a cron job), not a person.
  Left out of every metric unless --include-automated.
```

Every coding agent writes a full transcript to disk and every usage tool reads
only one of them. agstats reads all of them through one normalised model,
so the same metric — hours, tool failures, irreversible actions, how often you
had to speak — comes out comparable across Claude Code, Codex CLI, Gemini CLI
and Cursor.

It is the successor to the `cc*` family (cchours, cctoolstat, ccblast,
ccleaks, ccstats, cctimeline, ccquota, ccdiff, ccskillstats, ccattention,
ccflaky), which read Claude Code only. On the same Claude Code transcripts
`agstats hours` reports the same numbers as `cchours`, to the second; the
test suite requires cchours when it is on the machine and holds it there.

## Agents read

| agent | transcripts | status |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` (subagents included) | ✓ |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` | ✓ |
| Gemini CLI | `~/.gemini/tmp/*/chats/*.jsonl` (+ legacy `logs.json`); a2a-server files flagged automated | ✓ |
| Cursor | `…/Cursor/User/globalStorage/state.vscdb` (SQLite, read-only via `node:sqlite`) | ✓ |
| Antigravity | `~/.gemini/antigravity/conversations/*.pb` | needs the schema |

A missing agent renders as *not installed* — never as zero.

## Commands

| command | what it answers | from |
|---|---|---|
| `agents` | what is on this machine, where, how far back, how much of it a program wrote | new |
| `hours` | how long the agents actually ran — per day, month, project; a share card | cchours |
| `tools` | which tools fail, and how often; `--suggest` clusters the failures and says whether a guard could stop them | cctoolstat + ccflaky |
| `blast` | what cannot be undone: escaped vs contained actions, per agent | ccblast |
| `leaks` | what secrets sit in plaintext; `leaks scrub` redacts them in place | ccleaks |
| `stats` | working habits: prompts, replies, tools per prompt, hours of day, tokens by model, cache share | ccstats |
| `timeline` | a calendar of the work, streaks, hour bars | cctimeline |
| `quota` | share of tokens per project this period against a budget | ccquota |
| `diff` | what one session changed: files by touches, churn, commands | ccdiff |
| `skills` | which skills actually fire — matched, typed, or run by the runtime | ccskillstats |
| `attention` | how many times you had to speak per errand; nudges, approvals, self-corrections | ccattention |
| `guards` | did the hook or rule you installed stop the failure — rates before and after, with a verdict that refuses thin samples | ccflaky |
| `advise` | what to change, from what was measured: each finding names its threshold, hands over an artifact (a hook skeleton, a list), and the command that re-measures | new |
| `overlap` | the same file written by two sessions within a window (30 min): the collisions between parallel agents nobody saw | new |
| `waits` | who waited for whom: you for the agent, the agent for you, tools that took over a minute to come back (permission prompts) | new |


```
$ agstats advise
🔴 guard:mcp__notion__notion-update-page
   mcp__notion__notion-update-page fails 17.5% of the time (253/1448) and 97% of the failures are one input error
   threshold: ≥15% over ≥20 calls, one cause ≥80%
   → Block the call before it is made: a PreToolUse hook that checks the input for "validation_error".
   re-measure: agstats guards   · artifact: agstats advise --show guard:mcp__notion__notion-update-page

$ agstats guards
┌───────────────────┬────────────┬──────────────┬────────────────┬─────────┬──────────────────────────────────────┐
│ guard             │ since      │       before │          after │ verdict │                                      │
├───────────────────┼────────────┼──────────────┼────────────────┼─────────┼──────────────────────────────────────┤
│ 🔴 ScheduleWakeup │ 2026-08-17 │ 5/114 (4.4%) │ 66/418 (15.8%) │ worse   │ 4.4% → 15.8% — the guard did not bite │
└───────────────────┴────────────┴──────────────┴────────────────┴─────────┴──────────────────────────────────────┘
```

`advise` changes nothing. The loop is: measure → a finding with its threshold →
you apply the artifact → `guards add <tool>` → `guards` says fixed / improved
/ unchanged / worse, or "not yet" while fewer than 20 calls have happened since.

```
$ agstats tools --week --suggest
┌──────────────────────────────────────────────┬───────┬──────────────────────┬───────────────┐
│ tool                                         │ calls │                      │ errors        │
├──────────────────────────────────────────────┼───────┼──────────────────────┼───────────────┤
│ Bash                                         │ 3,224 │ ████████████████████ │ ⚠ 211 (6.5%)  │
│ WebSearch                                    │   887 │ ██████·············· │ ⚠ 4 (0.5%)    │
│ Read                                         │   715 │ ████················ │ ⚠ 42 (5.9%)   │
│ mcp__claude_ai_Slack__slack_search_public_a… │   667 │ ████················ │ ⚠ 72 (10.8%)  │

  mcp__notion__notion-query-data-sources: 63/229 failed (27.5%) — causes only 78% converged (need 80%)
        49× [input] {"name":"APIResponseError","code":"validation_error","status":400 …
         8× [unknown] The socket connection was closed unexpectedly …
```

```
$ agstats blast
  Your agents took 53,382 actions that changed something.

  ██████████████░░░░░░░░  65.5%
  caught by your safety net (git, temp dirs) — undoable

  18,439 escaped it. Those cannot be undone locally:
    16,712  sent something outside this machine
       549  pushed to a remote
       382  cut a release or a PR
  by agent:
    claude   ████████░░░░ 65.2%  18,439 escaped / 53,058 changes
    codex    ████████████ 100.0%  0 escaped / 324 changes
```

```
$ agstats attention --days 7
┌────────────┬──────┬─────┬──────────┬────────────┬────────┬─────────┬───────┬───────┬────────┬───────────┐
│ period     │ sess │ you │ per sess │ new intent │ status │ approve │ nudge │ agent │ bursts │  self-fix │
├────────────┼──────┼─────┼──────────┼────────────┼────────┼─────────┼───────┼───────┼────────┼───────────┤
│ 2026-09-15 │   95 │ 227 │      2.4 │        98% │      2 │       2 │     0 │ 2,247 │     49 │ 19 (0.8%) │
│ 2026-09-18 │    2 │  74 │       37 │       100% │      0 │       0 │     0 │   142 │      7 │ 11 (7.7%) │
```

## Usage

```bash
agstats agents                    # what was found
agstats hours                     # daily table, all agents
agstats hours --agent codex       # one agent
agstats hours --monthly           # per month, normalised to a 30-day rate
agstats hours --week --by-project
agstats hours --card              # paste-anywhere text card, last 30 days
agstats hours --svg card.svg      # the card as an image (30-day × 24-hour heatmap)
agstats tools --week --suggest    # failing tools, failures clustered and classified
agstats blast --list              # escaped actions with examples (default: last 30 days)
agstats leaks --days 30           # secret scan, exit 1 on findings; leaks scrub to redact
agstats stats --month
agstats timeline --weeks 52
agstats quota --set main=60 side=20 && agstats quota --period week
agstats diff --commands --git     # latest session; --session <id prefix> for another
agstats skills --unused
agstats attention --weekly
agstats advise                    # findings over the last 30 days; --show <id> prints the artifact
agstats overlap --window 120      # files two sessions wrote within 2 h
agstats waits --by-agent          # waiting time per agent, last 14 days
agstats guards add Bash --note "rm -rf hook"   # then: agstats guards
agstats <cmd> --json              # every command
agstats <cmd> --include-automated # count sessions a program wrote
agstats <cmd> --dir claude=/some/copy   # read a copy instead of the live directory
```

Period flags on every command: `--today`, `--week`, `--month`, `--days N`,
`--all`, `--since YYYYMMDD`, `--until YYYYMMDD`. A malformed date exits 2
rather than silently widening the window.

## How hours are measured (and why they are lower than you expect)

A turn is *not* "user asked → assistant finished": that span includes every
minute the agent sat blocked on a permission prompt. Instead the gaps between
consecutive transcript entries are summed, and any gap over 60 seconds is
dropped — while an agent is genuinely working it writes every few seconds
(measured: median 3.4 s, p95 42 s), so a minute of silence means it stopped.
A lone entry is credited zero time. Parallel agents add up (that is what a
human team costs); wall-clock time is always shown beside them.

What counts as evidence of work, per agent:

- **Claude Code**: `user` and `assistant` entries — verbatim the cchours rule.
- **Codex CLI**: `response_item` entries (messages, reasoning, tool calls and
  outputs) — the same footprint; the runtime's `event_msg` bookkeeping is not
  work, and it includes `turn_aborted`.
- **Gemini CLI**: every message in a `$set` / `$push` patch.
- **Cursor**: each turn's recorded span (rpc send → end), because Cursor
  writes no heartbeat and a five-minute turn would otherwise count for nothing.

## What is a person, and what is a program

Dialogue metrics (`stats`, `attention`) count a user turn only when a person
typed it: not a tool-result turn, not a slash-command echo, not runtime
context, and not the prompt a headless run (`claude -p` from launchd, a CI
job) was started with — those keep their hours and lose the human flag. Whole
sessions written by a program (Gemini's a2a server) are flagged `automated`,
shown in `agents`, and left out of every metric unless `--include-automated`.

## How tool calls are classified (blast)

Each reader labels a call with what it does — read, write, shell, outbound —
and the shell command or file path it touches. Nothing else is kept. Then:
read-only calls are ignored; a write inside a git repo is contained and one
in `/tmp` is ephemeral (both undoable); a write anywhere else escaped; a shell
command escaped only if it matches a short list (push, publish, release, `rm
-rf`, deploy, system config, `curl -X POST`, global install); every MCP or
messaging tool escaped, because the request already left the machine. An
unknown tool is assumed contained — the number undercounts rather than
invents.

## Honest limitations

- Reads local files only; no network. The only writes are `hours --svg`,
  `quota --set` and `guards add` (their own files under `~/.agstats/`)
  and `leaks scrub` (asks first, backs up, file sources only — never another
  program's database). `advise` never applies anything.
- History is only as long as each agent keeps it (Claude Code deletes after
  `cleanupPeriodDays`, default 30). Keep an archive if the numbers matter.
- `attention`'s status / approval / nudge / self-correction flags are regex
  heuristics (Japanese and English). Read them as a trend.
- `skills` counts invocations only from Claude Code; other agents do not
  record them, so their rows are absent, not zero.
- Reading everything takes 20–60 s on a machine with a year of history; the
  live directory changes under you, so two runs a minute apart differ.
- Zero dependencies. Node ≥ 22.13 (`node:sqlite`; without it only the
  Cursor reader is lost).

## As a library

The readers are the reusable part. `agentkanban` (a live board of every
session) is built on them:

```js
const { readers, model, metrics } = require('agstats');
const found = readers.readAll({ sinceMs: Date.now() - 86400000 });
```

## License

MIT
