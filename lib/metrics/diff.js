'use strict';
/**
 * metrics/diff.js — what did this session actually change?
 *
 * Ported from ccdiff. `git diff` shows the result; this shows the story:
 * which files the agent touched, how many times, in what order, and what
 * commands it ran along the way. The repeat counts are the interesting part —
 * a file touched sixteen times is where the session struggled. Line counts
 * (when the agent records the patch) are the churn git never sees: written
 * and taken back out before any of it reached a commit.
 *
 * Main loop only: a subagent's edits are not this session's story.
 */
const path = require('path');
const { execFileSync } = require('child_process');

/** Build the change set of one session. Pure. */
function collectChanges(session) {
  const files = new Map();
  const commands = [];
  const pathById = new Map();
  let idx = 0;
  for (const e of session.events) {
    if (e.kind === 'tool_call') {
      idx++;
      if (e.op === 'shell' && e.input && e.input.command) {
        commands.push({ idx, command: String(e.input.command).replace(/\s+/g, ' ').trim() });
        continue;
      }
      if (e.op !== 'write') continue;
      const p = e.input && e.input.path;
      if (!p) continue;
      if (e.callId != null) pathById.set(e.callId, p);
      const isWrite = /^(Write|write_file|create_file)$/.test(e.tool);
      // `created` waits for evidence from the first touch's result: a Write
      // onto an existing file is a rewrite, and a format that cannot tell
      // (most) never gets to say "new".
      if (!files.has(p)) files.set(p, { path: p, writes: 0, edits: 0, firstIdx: idx, lastIdx: idx, firstCall: e.callId, created: false, added: 0, removed: 0 });
      const f = files.get(p);
      if (isWrite) f.writes++; else f.edits++;
      f.lastIdx = idx;
    } else if (e.kind === 'tool_result' && e.lines) {
      const p = e.callId != null ? pathById.get(e.callId) : null;
      const f = p && files.get(p);
      if (f) { f.added += e.lines.added; f.removed += e.lines.removed; }
    }
    if (e.kind === 'tool_result' && e.created && e.callId != null) {
      const f = files.get(pathById.get(e.callId));
      if (f && f.firstCall === e.callId) f.created = true;
    }
  }
  const list = [...files.values()].map(({ firstCall, ...f }) => ({ ...f, touches: f.writes + f.edits }))
    .sort((a, b) => b.touches - a.touches || a.firstIdx - b.firstIdx);
  const added = list.reduce((s, f) => s + f.added, 0);
  const removed = list.reduce((s, f) => s + f.removed, 0);
  // Self-undo counts only removals the session can be shown to own: lines
  // taken out of a file it created. A removal from an existing file may be a
  // line that was there before, and dividing all removals by all additions
  // once read as "142% of what it wrote, it removed again".
  const ownRemoved = list.reduce((s, f) => s + (f.created ? f.removed : 0), 0);
  return {
    files: list, commands,
    lines: { added, removed, net: added - removed, selfUndo: added ? Math.min(1, ownRemoved / added) : 0 },
  };
}

/** Pick the session: by id prefix, else the most recently active main session (optionally in a project). */
function pickSession(sessions, { id, project } = {}) {
  let cands = sessions.filter((s) => s.parentId == null && s.events.length);
  if (project) cands = cands.filter((s) => String(s.project).toLowerCase().includes(String(project).toLowerCase()));
  if (id) return cands.find((s) => s.id === id || s.id.startsWith(id)) || null;
  let best = null;
  for (const s of cands) {
    const last = s.events[s.events.length - 1].t;
    if (!best || last > best.last) best = { s, last };
  }
  return best ? best.s : null;
}

/** Files git currently reports as changed, absolute paths. */
function gitChanged(cwd) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const out = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim(), path: path.join(root, l.slice(3).trim()) }));
  } catch (e) { return null; }
}

module.exports = { collectChanges, pickSession, gitChanged };
