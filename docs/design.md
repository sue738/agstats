# agentanalytics — design

One CLI that measures what your coding agents did, from the transcripts they
already wrote to disk. Successor to the `cc*` family (cchours, ccblast,
cctoolstat, ccleaks …), which read Claude Code only. This one reads every agent
on the machine and reports them side by side.

Working name: `agentanalytics`. The name lives in exactly one place
(`lib/brand.js`) so it can change before publishing.

## Why a new tool instead of renaming cc*

- `cc` means Claude Code. A Cursor or Codex user never searches for it.
- The metric code in cc* is 80% transcript reading, and the reading is the part
  that differs per agent. A shared reader layer is the whole point.
- One package instead of seven: one reader, one release, one README.

## Invariants (checked by tests, not by reading)

1. **Parity with cchours.** On the same Claude Code transcripts,
   `agentanalytics hours --json` reports the same `agentHours`, `wallHours`,
   `mainHours`, `subagentHours`, `longestRunHours`, `peakParallel` and counts
   as `cchours --json`. Same idle cap (60 s), same stamp rule (one stamp per
   user/assistant line), same interval union. `test/test.js` requires the
   cchours library when it is on this machine and compares both on fixtures;
   never on the live directory, where a running session shifts the number
   between two scans. `--by-project` is *not* identical: it buckets by the
   session's cwd (first seen) where cchours buckets by directory slug.
2. **Undercount, never invent.** A reader that cannot parse a line skips it.
   A session with fewer than two stamps contributes zero time. No "typical
   turn length" is ever assumed. This is inherited from cchours verbatim.
3. **Read-only, local-only.** No network, no dependency. The only writes are
   `hours --svg <path>` and `leaks scrub` (asks first, backs up, file sources
   only — never another program's database). Node ≥ 22.13 (`node:sqlite`
   without a flag; it is required lazily, so a machine without it loses only
   the Cursor reader).
4. **A missing agent renders as "not installed", never as zero.** The
   `agents` subcommand lists what was found and where.
5. **Sessions written by programs are not a person's usage.** A reader that
   can tell (Gemini's a2a server writes every file with sessionId
   `a2a-server`) flags them `automated`; `agents` shows the count in its own
   column and every metric leaves them out unless `--include-automated`.
   Silently dropping them would make "unused" and "excluded" look the same.
6. **Session ids are unique per agent.** Hours groups a session with its
   subagents by id; a shared native id (Gemini) falls back to the file path.
   Violating this merged 28,865 sessions into one 85-hour "longest run".

## Normalised model

Every reader turns its native format into this and nothing else:

```
Session {
  agent:      'claude' | 'codex' | 'gemini' | 'cursor'
  id:         string            // session/thread id
  file:       string            // where it came from (path, or db path + key)
  project:    string            // cwd when known, else the agent's own slug
  parentId:   string | null     // set for subagents (Claude only, so far)
  events:     Event[]           // sorted by t
}
Event {
  t:      number                // ms since epoch
  kind:   'user' | 'assistant' | 'tool_call' | 'tool_result' | 'meta'
  tool:   string?               // tool name for tool_call / tool_result
  callId: string?               // pairs a call with its result
  ok:     boolean?              // tool_result only: did it succeed
  model:  string?               // assistant only, when the format says
  tokens: {in, out, cacheRead, cacheWrite}?   // when the format says
}
```

`kind: 'meta'` is bookkeeping the runtime wrote on its own schedule (session
meta, mode changes, snapshots). Metrics that measure *work* ignore it. This is
how cchours already treats non user/assistant lines.

## Readers

| agent | where | format | status |
|---|---|---|---|
| claude | `~/.claude/projects/**/*.jsonl`, subagents under `<session>/subagents/` | JSONL, `type` user/assistant, ISO `timestamp` | v0 |
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL, `type` session_meta / response_item / event_msg / turn_context, ISO `timestamp` | v0 |
| gemini | `~/.gemini/tmp/<project>/chats/session-*.jsonl` | JSONL of `$set` patches carrying `messages[]` with `timestamp`, `type` user/gemini | v0 (read), few real sessions on the author's machine |
| cursor | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`, table `cursorDiskKV`, keys `composerData:*` (thread, `createdAt`) and `bubbleId:<composer>:<bubble>` (message: `type` 1 user / 2 assistant, `createdAt`, `timingInfo.clientRpcSendTime` / `clientEndTime`, `toolFormerData{name, params, status}`) | SQLite via `node:sqlite`, read-only | v0 |
| antigravity | `~/.gemini/antigravity/conversations/*.pb` | protobuf, schema unknown | not yet — needs the schema |
| zed | `~/Library/Application Support/Zed/threads/threads.db` | SQLite, `threads.data` blob | not yet — no sample data |

What counts as an activity stamp per agent (the rule that decides hours):

- claude: entries with `type` user or assistant. Verbatim from cchours.
- codex: entries with `type` response_item (messages, reasoning, tool calls,
  tool outputs) — the same footprint as Claude's user/assistant lines, which
  carry the tool calls. `event_msg`, `session_meta`, `turn_context` and
  developer/system messages are meta. Measured: event_msg moved hours by
  under 1%, but it includes `turn_aborted`, and an interruption is not work.
  Replayed duplicate lines are dropped (by call_id, or by exact bytes).
- gemini: every message inside a `$set`/`$push` patch; automated files are
  identified from the header line alone and not read further.
- cursor: a bubble's `createdAt` (or `clientRpcSendTime`), plus the turn's
  span `[clientRpcSendTime, clientEndTime]` carried as `Event.end`. Cursor
  writes no heartbeat, so without the span a five-minute turn would be two
  lone stamps and count for nothing. `hours` caps every span at `IDLE_GAP_S`
  (60s) before unioning it in — measured on real data, 19.6% of spans ran
  past 60s and, uncapped, inflated agentHours 7.7x (a permission wait sits
  inside the same span as the work). This undercounts a genuinely long
  single turn; that is the intended tradeoff (undercount, never invent).

## Tool calls across agents

Blast and tools never see a tool name's meaning; each reader normalises a
call to `op` (read / write / shell / outbound / other) and `input`
({command, path}). The per-agent vocabularies:

| agent | shell | write | read | outbound |
|---|---|---|---|---|
| claude | Bash, BashOutput (`command`) | Write, Edit, NotebookEdit, MultiEdit (`file_path`) | Read, Grep, Glob, LS, WebFetch, WebSearch, Task, … | SendMessage, Artifact, `mcp__*`, … |
| codex | shell (`command[]`), exec_command (`cmd`), exec (JS calling `tools.exec_command({cmd})`) | apply_patch (`*** Update File:` path, joined to cwd) | view_image, update_plan, wait, request_user_input_async | — |
| gemini | run_shell_command (`command`) | write_file, replace (`file_path`) | read_file, read_many_files, list_directory, glob, search_file_content, google_web_search, web_fetch | — |
| cursor | run_terminal_cmd (`command`) | edit_file, search_replace, reapply, delete_file (`relativeWorkspacePath`, relative — classified as unknown location → contained) | read_file, list_dir, grep_search, codebase_search, file_search, web_search | `mcp*` |

Leaks does not use the model: it streams each reader's `rawSources()` (files
line by line; Cursor's database as value chunks) because it needs every byte
and the model deliberately keeps none of the text.

## Metrics (subcommands)

| subcommand | port of | v |
|---|---|---|
| `agents` | new: what was found, where, how many sessions, date range, automated count | v0 |
| `hours` | cchours (daily / monthly / by-project / card) | v0 |
| `tools` | cctoolstat (calls, failure rate, failure clusters) + ccflaky (failure kind, guard candidate) | v0 |
| `blast` | ccblast (escaped vs contained actions) | v0 |
| `leaks` | ccleaks (secrets in transcripts; scrub for file sources) | v0 |
| `stats` | ccstats (prompts, replies, tools per prompt, hour of day, tokens by model, cache share, compactions) | v0 |
| `timeline` | cctimeline (calendar, streaks, hour bars; stamps when an agent has no usage) | v0 |
| `quota` | ccquota (share of tokens per project vs budget; budgets in ~/.agentanalytics/budgets.json) | v0 |
| `diff` | ccdiff (files by touches, churn from recorded patches, commands, git cross-check) | v0 |
| `skills` | ccskillstats (tool / typed / auto invocations, entrypoint split, installed-but-silent) | v0 |
| `attention` | ccattention (utterances per session-day, status / approve / nudge, bursts, self-corrections) | v0 |
| `guards` | ccflaky relapse (rates before/after a registered guard; verdict refuses <20 calls after) — registry `~/.agentanalytics/guards.json` | v0 |
| `overlap` | new: same absolute path written by two root sessions (subagents fold into their parent) within a window; default 30 min, with a 24 h hint when empty | v0 |
| `waits` | new: the gaps `hours` discards, attributed — you → agent (spinner), agent → you (reply left waiting, capped 6 h), call → result over 60 s (permission prompt or slow tool) | v0 |
| `advise` | new: findings over the metrics above. A finding exists only if it has a printed threshold, a hand-over artifact where one makes sense, and a re-measure command. Applies nothing | v0 |

`board` / `now` (a live kanban) live in the separate package `agentkanban`,
which shares no code with this one — it carries its own copy of the readers.
Live state is a different product from retrospective measurement: different
name, different entry point, different release cadence, no shared version.

The closed loop is the point of `advise` + `guards`: measure → finding →
the person applies → `guards add` → measure again. A finding without a
re-measure command is not emitted, because advice that cannot be falsified
is what makes people mute the tool.

Dialogue flags are decided at read time in `lib/dialogue.js` and stored on
the event (`human`, `scripted`, `injected`, `ask`, `fix`, `chars`); the text
itself is never kept. `human` additionally requires the session not to be a
headless run (Claude's `entrypoint` sdk-cli / github-action): on this machine
2,071 such runs landed on one day and read as 2,071 conversations until that
rule existed.

Not ported, and why:

- **ccsendstats** (what each request sent to the API, by category): needs the
  byte length of every text block per request. Possible as a raw-source
  metric like leaks; not done.
- **ccinside** (the one-page HTML report over everything): a renderer over
  the metrics above; the metrics exist now, the page does not.
- **ccblackbox / ccattest / cctranscript / ccprompt**: hook-based recorders,
  a shared reader (replaced by `lib/readers`), and a prompt cookbook that
  needs the prompt text — outside a transcript-statistics tool.

Every subcommand takes `--agent <name>[,name]` to narrow, `--json`, and the
period flags cchours already has. Tables get an `agent` column when more than
one agent was found; with one agent the daily and monthly tables carry the
same numbers as cchours (see invariant 1 for what differs).

## No shared package with the board

`agentkanban` used to depend on this one, and used `readers`, `model` and
`dialogue` — **none of the 14 metrics**. A dependency named "analytics" that
the consumer never called for analytics.

That dependency is gone (2026-09-21). The board carries its own copy of the
reader layer in its `lib/vendor/`, and this package has no consumer but its
own CLI. The two tools answer different questions and now ship on their own
schedules; the cost is ~1,000 lines duplicated, which change only when an
agent changes its on-disk format. Fix such a change in whichever copy you
hit it in and carry it across by hand — `diff -r` between the two `lib/`
trees shows the drift. Do not reintroduce the coupling to save the copy.

## Out of scope for v0

Cost in dollars (ccusage owns it), live monitoring, anything that writes back
to an agent's storage.
