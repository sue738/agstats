'use strict';
/**
 * readers/index.js — the registry. Adding an agent = one require line here
 * plus a file in this directory. Metrics never import a reader directly.
 *
 * Every reader exports: AGENT, defaultDir(), detect(opts), read(opts) →
 * {agent, dir, sessions, error?}, rawSources(opts) → [{file, project,
 * scrubbable, chunks?()}].
 */
const READERS = [
  require('./claude.js'),
  require('./codex.js'),
  require('./gemini.js'),
  require('./cursor.js'),
];

function byName(name) {
  return READERS.find((r) => r.AGENT === name) || null;
}

/** The `only` set, refusing names no reader has: a typo must not read as "that agent did nothing". */
function onlySet(only) {
  if (!only) return null;
  const bad = only.filter((n) => !byName(n));
  if (bad.length) throw new Error(`unknown agent ${bad.map((n) => `"${n}"`).join(', ')} — expected one of ${READERS.map((r) => r.AGENT).join(', ')}`);
  return new Set(only);
}

/**
 * Read every agent found (or only `only`, a list of names). A reader that is
 * not installed yields {installed:false} so callers can say so explicitly.
 * `dirs` maps agent name → override base dir (for tests and --dir).
 */
function readAll(opts = {}) {
  const only = onlySet(opts.only);
  const dirs = opts.dirs || {};
  const out = [];
  for (const r of READERS) {
    if (only && !only.has(r.AGENT)) continue;
    const o = { dir: dirs[r.AGENT], includeAutomated: !!opts.includeAutomated, sinceMs: opts.sinceMs };
    if (!r.detect(o)) { out.push({ agent: r.AGENT, dir: o.dir || r.defaultDir(), installed: false, sessions: [], automated: 0 }); continue; }
    const res = r.read(o);
    // Automated sessions are counted here and shown by `agents`, but metrics
    // only ever see them when asked (--include-automated).
    const automated = res.sessions.filter((s) => s.automated).length;
    const sessions = opts.includeAutomated ? res.sessions : res.sessions.filter((s) => !s.automated);
    out.push({ agent: r.AGENT, dir: res.dir, installed: true, sessions, automated, error: res.error });
  }
  return out;
}

/** Raw sources of every installed agent (for the secret scanner). */
function rawAll(opts = {}) {
  const only = onlySet(opts.only);
  const dirs = opts.dirs || {};
  const out = [];
  for (const r of READERS) {
    if (only && !only.has(r.AGENT)) continue;
    const o = { dir: dirs[r.AGENT] };
    if (!r.detect(o)) continue;
    for (const s of r.rawSources(o)) out.push({ agent: r.AGENT, ...s });
  }
  return out;
}

module.exports = { READERS, byName, readAll, rawAll, NAMES: READERS.map((r) => r.AGENT) };
