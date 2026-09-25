/**
 * render.js — output shapes (ported verbatim from cchours).
 *
 * Two audiences, two shapes:
 *  - `table()`  the ccusage-style box table you read yourself
 *  - `card()`   a paste-anywhere text card you actually want to show someone
 *
 * The card is text, not an image, on purpose. Wordle spread on plain text with
 * emoji blocks: it survives copy-paste into X, Slack, Discord and GitHub with
 * no upload step, no hosting, and no image dependency. An SVG variant exists
 * for people who want a picture, but text is the default because it travels.
 *
 * Zero dependencies.
 */
'use strict';
const { NAME } = require('./brand.js');

// ---------- formatting ----------

function fmtH(h) {
  const t = Math.round(h * 60);
  if (t >= 60) return `${Math.floor(t / 60)}h${String(t % 60).padStart(2, '0')}m`;
  return `${t}m`;
}

/** Visible width — CJK and emoji occupy two terminal columns. */
function width(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a ||
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1f64f) ||
      (c >= 0x1f900 && c <= 0x1f9ff))) ? 2 : 1;
  }
  return w;
}

function padEndW(s, n) { return String(s) + ' '.repeat(Math.max(0, n - width(s))); }
function padStartW(s, n) { return ' '.repeat(Math.max(0, n - width(s))) + String(s); }

// ---------- box table (ccusage-style) ----------

/**
 * @param {string[]} headers
 * @param {Array<Array<string>>} rows
 * @param {object} opts {align: ('l'|'r')[], totalRow?: string[]}
 */
function table(headers, rows, opts = {}) {
  const align = opts.align || headers.map((_, i) => (i === 0 ? 'l' : 'r'));
  const all = opts.totalRow ? rows.concat([opts.totalRow]) : rows;
  const w = headers.map((h, i) => Math.max(width(h), ...all.map((r) => width(r[i] == null ? '' : r[i]))));
  const line = (l, m, r) => l + w.map((n) => '─'.repeat(n + 2)).join(m) + r;
  const fmtRow = (r) => '│ ' + r.map((c, i) =>
    (align[i] === 'r' ? padStartW(c == null ? '' : c, w[i]) : padEndW(c == null ? '' : c, w[i]))).join(' │ ') + ' │';
  const out = [line('┌', '┬', '┐'), fmtRow(headers), line('├', '┼', '┤')];
  for (const r of rows) out.push(fmtRow(r));
  if (opts.totalRow) { out.push(line('├', '┼', '┤')); out.push(fmtRow(opts.totalRow)); }
  out.push(line('└', '┴', '┘'));
  return out.join('\n');
}

/** Title banner, ccusage-style. */
function banner(text) {
  const w = width(text) + 4;
  return ['╭' + '─'.repeat(w) + '╮', '│  ' + text + '  │', '╰' + '─'.repeat(w) + '╯'].join('\n');
}

// ---------- share card ----------

const BLOCK_FULL = '█';
const BLOCK_EMPTY = '░';

function bar(fraction, n = 20, full = BLOCK_FULL, empty = BLOCK_EMPTY) {
  const k = Math.max(0, Math.min(n, Math.round(fraction * n)));
  return full.repeat(k) + empty.repeat(n - k);
}

/**
 * The paste-anywhere card.
 * Every number here is measured, never modelled: hours, the subagent share, and
 * the share of work that happened between 00:00 and 06:00 local time.
 * @param {object} d {label, hours, per30, personMonths, subShare, nightShare,
 *                    parallelism, subCount, wallHours}
 * @param {boolean} ja
 */
function card(d, ja) {
  const L = (en, jp) => (ja ? jp : en);
  const lines = [];
  lines.push(`${NAME} — ${d.label}`);
  lines.push('');
  // Hours only. A person-month conversion reads as "the AI did N months of
  // work", which is not what any of this measures — the card must not invite
  // a claim the tool cannot support.
  lines.push(`   ${fmtH(d.hours)}`);                      // the number, alone, so it reads first
  lines.push(L('   of AI runtime', '   AIの稼働時間'));
  lines.push('');
  lines.push(`   ${bar(d.subShare)} ${Math.round(d.subShare * 100)}%  ` +
    L('run by subagents', 'はサブエージェント'));
  lines.push('');
  lines.push(L(`   ${d.parallelism.toFixed(1)} agents in parallel · ${fmtH(d.wallHours)} wall-clock`,
    `   平均 ${d.parallelism.toFixed(1)} 並列 · 実経過 ${fmtH(d.wallHours)}`));
  lines.push('');
  lines.push(`   npx ${NAME} hours`);
  return lines.join('\n');
}

/**
 * Image variant. Near-square (640×600) because that is what timelines and chat
 * clients crop least, with the hour count set large enough to survive being
 * viewed as a thumbnail — the number is the message.
 * Self-contained SVG: no external fonts, no remote assets.
 */
// GitHub contribution-graph green on GitHub dark. The most instantly-read
// visual language a developer audience has: "a month of green squares" needs
// zero explanation, and the joke lands by itself — your AI now has a
// contribution graph too.
const THEME = { bg: "#0d1117", bg2: "#12171f", border: "#21262d", fg: "#e6edf3", dim: "#8b949e", faint: "#6e7681",
  cell0: "#161b22", ramp: ["#0e4429", "#006d32", "#26a641", "#39d353", "#56e879"] };

/**
 * The heatmap: 30 days × 24 hours, one cell per hour of the month, coloured by
 * how much AI runtime landed in it. This is the picture worth sharing — every
 * person's month makes a different pattern (night columns, weekend gaps,
 * crunch weeks), the way a GitHub contribution graph is personal. All of it is
 * measured; an empty month honestly renders as an empty grid.
 */
function heatSvg(grid, t, x, y, w, h) {
  const days = grid.length, hours = 24;
  const gap = 2;
  const cw = (w - gap * (days - 1)) / days;
  const ch = (h - gap * (hours - 1)) / hours;
  let max = 0;
  for (const day of grid) for (const s of day) if (s > max) max = s;
  const cells = [];
  for (let di = 0; di < days; di++) {
    for (let hi = 0; hi < hours; hi++) {
      const v = grid[di][hi];
      // sqrt scale: a 10-minute cell should be visible next to a 60-minute one
      const c = !v || !max ? t.cell0 : t.ramp[Math.min(t.ramp.length - 1,
        Math.floor(Math.sqrt(v / max) * t.ramp.length))];
      cells.push(`<rect x="${(x + di * (cw + gap)).toFixed(1)}" y="${(y + hi * (ch + gap)).toFixed(1)}" width="${cw.toFixed(1)}" height="${ch.toFixed(1)}" rx="2" fill="${c}"/>`);
    }
  }
  return cells.join('');
}

function cardSvg(d, ja) {
  const L = (en, jp) => (ja ? jp : en);
  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const t = THEME;
  const W = 640, H = 680, x = 52;
  const bw = W - x * 2;
  const pct = Math.round(d.subShare * 100);
  const grid = d.grid && d.grid.length ? d.grid : [new Array(24).fill(0)];
  // split "249h51m" so the unit letters sit smaller than the digits
  const m = /^(\d+)h(\d+)m$/.exec(fmtH(d.hours)) || [null, '0', String(Math.round(d.hours * 60))];
  const hero = m[1] !== '0'
    ? `<tspan font-size="128">${m[1]}</tspan><tspan font-size="54" fill="${t.dim}">h</tspan><tspan font-size="128"> ${m[2]}</tspan><tspan font-size="54" fill="${t.dim}">m</tspan>`
    : `<tspan font-size="128">${m[2]}</tspan><tspan font-size="54" fill="${t.dim}">m</tspan>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${t.bg2}"/><stop offset="1" stop-color="${t.bg}"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" rx="28" fill="url(#bg)"/>
  <rect x="3" y="3" width="${W - 6}" height="${H - 6}" rx="26" fill="none" stroke="${t.border}" stroke-width="1.5"/>

  <text x="${x}" y="84" font-size="19" letter-spacing="1" fill="${t.dim}">${NAME} · ${esc(d.label)}</text>

  <text x="${x - 4}" y="212" fill="${t.fg}" font-weight="bold">${hero}</text>
  <text x="${x}" y="252" font-size="22" fill="${t.dim}">${esc(L('of AI runtime', 'AIの稼働時間'))}</text>

  ${heatSvg(grid, t, x, 296, bw, 220)}
  <text x="${x}" y="290" font-size="12" fill="${t.faint}">0:00</text>
  <text x="${x + bw}" y="290" font-size="12" fill="${t.faint}" text-anchor="end">${esc(L('today →', '→ 今日'))}</text>
  <text x="${x}" y="532" font-size="12" fill="${t.faint}">23:59</text>
  <text x="${x + bw}" y="532" font-size="12" fill="${t.faint}" text-anchor="end">${esc(L('each column is a day · each cell an hour', '1列=1日 · 1マス=1時間'))}</text>

  <text x="${x}" y="596" font-size="19" fill="${t.fg}">${pct}% ${esc(L('run by subagents', 'はサブエージェント'))}<tspan fill="${t.dim}"> · ${esc(L(`${d.parallelism.toFixed(1)} in parallel`, `平均${d.parallelism.toFixed(1)}並列`))}</tspan></text>
  <text x="${x}" y="634" font-size="18" fill="${t.faint}">npx ${NAME} hours</text>
</svg>`;
}

module.exports = { fmtH, width, padEndW, padStartW, table, banner, bar, card, cardSvg, THEME };
