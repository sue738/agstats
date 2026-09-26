# agstats

**What your coding agents did, from their own transcripts — Claude Code, Codex CLI, Gemini CLI and Cursor, side by side.**

```bash
npx agstats agents     # which agents are on this machine, and how much history each has
npx agstats hours      # how long they actually ran, per day
npx agstats blast      # what they did that cannot be undone
```

Every coding agent writes its transcript to disk. agstats reads all of them
into one model, so the same metric comes out comparable across agents.
Local files only, no network, zero dependencies. Node ≥ 22.13.

## Agents

| agent | reads |
|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` (subagents included) |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` |
| Gemini CLI | `~/.gemini/tmp/*/chats/*.jsonl` (+ legacy `logs.json`) |
| Cursor | `…/Cursor/User/globalStorage/state.vscdb` (read-only, via `node:sqlite`) |

A missing agent shows as *not installed*, never as zero. Sessions a program
wrote (a cron job, an a2a server) are flagged `automated` and left out of
every metric unless `--include-automated`.

## Commands

| command | answers |
|---|---|
| `agents` | what was found, where, how far back — and when Claude Code's cleanup deletes the oldest |
| `hours` | agent-hours per day / month / project; `--card`, `--svg` for a share card |
| `tools` | which tools fail and how often; `--suggest` clusters the causes |
| `blast` | actions that escaped git and temp dirs — pushes, publishes, outbound calls |
| `leaks` | secrets sitting in plaintext (exit 1 on findings, 3 if a source was unreadable); `leaks scrub` redacts them |
| `stats` | prompts, replies, hours of day, tokens by model |
| `timeline` | a calendar of the work and streaks |
| `quota` | share of tokens per project against a budget |
| `diff` | what one session changed: files, churn, commands |
| `skills` | which Claude Code skills actually fire |
| `attention` | how often you had to step in per errand |
| `overlap` | the same file written by two sessions close together |
| `waits` | time you waited for the agent, and the agent for you |
| `advise` | what to change, from what was measured (changes nothing itself) |
| `guards` | whether a hook you added stopped the failure — before vs after |
| `sends` | what each request sent: real totals, cache split, estimated breakdown, overhead before your first message; `--by-agent` compares agents |

Every command takes `--json`, and a period: `--today`, `--week`, `--month`,
`--days N`, `--all`, `--since YYYYMMDD`, `--until YYYYMMDD` (`leaks` picks files
by modification time, so it takes a start but refuses `--until`).
`--dir claude=/some/copy` reads a copy instead of the live directory.
`--archive [dir]` also reads a [cclogsall](https://github.com/sue738/cclogsall) backup of Claude Code
sessions (default `~/.cclogsall`), so metrics reach past the cleanup; a session still live is read from there.

## How hours are measured

Gaps between consecutive transcript entries are summed, and any gap over 60
seconds is dropped: a working agent writes every few seconds, so a minute of
silence means it stopped (or sat on a permission prompt). Parallel agents add
up; wall-clock time is shown beside them.

## Limits

- The only writes are `hours --svg`, `quota --set`/`--clear` and `guards add`/`rm`
  (under `~/.agstats/`), and `leaks scrub`, which asks first and keeps a backup.
- History is only as long as each agent keeps it (Claude Code: 30 days by default — `agents` says when the next deletion is due, and `--archive` reads past it).
- `sends` totals are the providers' own usage figures; the breakdown is estimated from bytes (~4/token), and "invisible" (system prompt, tool definitions) is the remainder. Claude's attachment lines (skill listings, MCP instructions, reminders) count as injected context when they record the text they sent (Claude Code 2.1.263+); older ones stay in the remainder. Cursor shows totals only: whether its token count is per request or per turn is undocumented, so its breakdown is *n/a*. `--by-agent` compares interactive sessions; headless runs (`claude -p`, `codex exec`, CI) are separate rows. An agent that records no usage shows *not recorded*.
- `attention` flags are regex heuristics (English and Japanese) — read them as a trend.

## As a library

```js
const { readers, model, metrics } = require('agstats');
const found = readers.readAll({ sinceMs: Date.now() - 86400000 });
```

## License

MIT
