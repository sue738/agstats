'use strict';
/**
 * wire.js — what each request sent, as far as a transcript can tell. A port
 * of ccsendstats' transcript analysis (not its proxy: this package never
 * touches the network).
 *
 * Two kinds of number, never mixed:
 *
 * - Totals are REAL: the provider's own usage figures the agent wrote down
 *   (Claude: input + cache-read + cache-creation; Codex: input_tokens, which
 *   already includes the cached part; Cursor: its per-bubble inputTokens).
 * - The breakdown is an ESTIMATE: bytes of what the transcript shows, at ~4
 *   bytes a token (no tokenizer). What the transcript never shows — the system
 *   prompt, tool definitions — is the remainder, "invisible overhead".
 *
 * Readers walk their native format in order and feed a Tally: blocks of text
 * by category, and requests with their usage. The tally keeps numbers only
 * (no text), snapshotting the visible estimate at the first and the latest
 * request. The estimate rules are ccsendstats' verbatim — rounding per block,
 * the injected-tag split — so the two agree on the same Claude transcript
 * (test/test.js holds them to it when ccsendstats is on the machine).
 *
 * Request {t, model, sent, uncached, cacheRead, cacheWrite, cacheWrite1h,
 *          cacheWrite5m, out, total?}
 *   sent        input tokens of the request, real — null when the format
 *               recorded only a combined figure (`total`, input + output)
 *   cacheRead / cacheWrite / uncached — null when the format has no such split
 *   cacheWrite1h / cacheWrite5m — Claude's TTL split, null when not recorded
 *               (ccsendstats files an unsplit write under 5m; this does not
 *               guess — undercount, never invent)
 */

/** Categories, in the order they print. `system` exists only where a format records the system prompt (Codex). */
const CATS = ['toolResults', 'assistantText', 'thinking', 'toolInputs', 'injected', 'userText', 'system'];

/** Estimated tokens from UTF-8 bytes (≈ 4 bytes/token, English-heavy text). Not a tokenizer. */
function estTokens(s) {
  if (!s) return 0;
  return Math.round(Buffer.byteLength(String(s), 'utf8') / 4);
}

/** Runtime-written text inside a user turn: reminders, hook output, slash-command echoes. */
const INJECTED_RE = /<system-reminder>[\s\S]*?<\/system-reminder>|<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>|<local-command-std(?:out|err)>[\s\S]*?<\/local-command-std(?:out|err)>/g;

/** Split a user text block into {injected, rest}: what the runtime wrote vs what was typed. */
function splitInjected(text) {
  let injected = '';
  const rest = String(text == null ? '' : text).replace(INJECTED_RE, (m) => { injected += m; return ''; });
  return { injected, rest: rest.trim() };
}

function emptyBreakdown() {
  const b = {};
  for (const c of CATS) b[c] = 0;
  b.total = 0;
  return b;
}

const SUM_KEYS = ['sent', 'uncached', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'cacheWrite5m', 'out'];

/**
 * Running estimate for one session. `add*` in transcript order, `request()`
 * when a request's usage appears; the snapshot taken then is everything
 * visible *before* it (what that request carried).
 */
class Tally {
  constructor(o = {}) {
    this.b = emptyBreakdown();
    this.keep = !!o.keepRequests;
    this.list = [];
    this.count = 0;       // requests with a real `sent`
    this.totalOnly = 0;   // requests that recorded only input + output combined
    this.first = null; this.last = null;
    this.visibleAtFirst = null; this.visibleAtLast = null;
    this.firstPrompt = null;
    this.promptClosed = false;
    // sums over the requests that recorded each field; `has` counts them, so
    // a field no request recorded stays null instead of reading as zero
    this.sums = {}; this.has = {};
    for (const k of SUM_KEYS) { this.sums[k] = 0; this.has[k] = 0; }
  }

  /** Add a block of `cat` text. */
  add(cat, text) {
    const n = estTokens(text);
    if (!n) return;
    this.b[cat] += n; this.b.total += n;
  }

  /** A user text block: the injected tags go to `injected`, the rest to `userText`. */
  addUser(text) {
    const { injected, rest } = splitInjected(text);
    this.add('injected', injected);
    this.add('userText', rest);
    return rest;
  }

  /**
   * The first thing a person said, estimated (ccsendstats' firstPromptEst):
   * readers call it for each user turn until one has words; a tool-result
   * turn before that closes the question (`null` — no first prompt).
   */
  prompt(text) {
    if (this.promptClosed || this.firstPrompt) return;
    if (text == null) { this.promptClosed = true; return; }
    if (String(text).trim()) this.firstPrompt = { est: estTokens(text), chars: String(text).trim().length };
  }

  /** The visible estimate as it stands — for a format whose usage line lands after the response (Codex), taken at the request's last input. */
  mark() { return { ...this.b }; }

  /**
   * A request whose usage the transcript recorded. `at` is what it carried
   * (a mark()); by default, everything added so far — right for a format
   * that writes the usage on the response itself, before its content (Claude).
   */
  request(r, at) {
    const req = {
      t: r.t == null ? null : r.t, model: r.model || '',
      sent: r.sent == null ? null : r.sent,
      uncached: r.uncached == null ? null : r.uncached,
      cacheRead: r.cacheRead == null ? null : r.cacheRead,
      cacheWrite: r.cacheWrite == null ? null : r.cacheWrite,
      cacheWrite1h: r.cacheWrite1h == null ? null : r.cacheWrite1h,
      cacheWrite5m: r.cacheWrite5m == null ? null : r.cacheWrite5m,
      out: r.out == null ? null : r.out,
    };
    if (r.total != null) req.total = r.total;
    if (this.keep) this.list.push(req);
    if (req.sent == null) { if (req.total != null) this.totalOnly++; return; }
    this.count++;
    for (const k of SUM_KEYS) if (req[k] != null) { this.sums[k] += req[k]; this.has[k]++; }
    const snap = at ? { ...at } : { ...this.b };
    if (!this.first) { this.first = req; this.visibleAtFirst = snap; }
    this.last = req; this.visibleAtLast = snap;
  }

  /** The numbers a metric needs, and nothing else. */
  result() {
    const sums = {};
    for (const k of SUM_KEYS) sums[k] = this.has[k] ? this.sums[k] : null;
    return {
      usage: this.count ? 'recorded' : this.totalOnly ? 'total-only' : 'none',
      requests: this.count, totalOnly: this.totalOnly,
      first: this.first, last: this.last,
      visibleAtFirst: this.visibleAtFirst, visibleAtLast: this.visibleAtLast,
      visible: { ...this.b },
      firstPrompt: this.firstPrompt,
      sums,
      ...(this.keep ? { list: this.list } : {}),
    };
  }
}

module.exports = { CATS, estTokens, splitInjected, INJECTED_RE, emptyBreakdown, Tally };
