'use strict';
/**
 * metrics/leaks.js — secrets sitting in plaintext in agent transcripts.
 *
 * Ported from ccleaks. Philosophy: HIGH PRECISION over recall. Every rule
 * matches a vendor-specific prefix or an unambiguous structure — no generic
 * "password=" heuristics that drown users in false positives. A leak scanner
 * people mute is worthless.
 *
 * This metric does not go through the Session/Event model on purpose: it
 * needs the raw bytes (tool commands, tool outputs, everything), and holding
 * every transcript's text in memory is exactly what the model avoids. So it
 * streams each reader's rawSources() file by file.
 *
 * Scrubbing rewrites a transcript in place, replacing each detected secret
 * with [REDACTED:<rule-id>] while keeping every line valid JSON. Only file
 * sources marked scrubbable are ever touched — never another program's
 * database.
 */
const fs = require('fs');

const RULES = [
  { id: 'aws-access-key',    name: 'AWS access key ID',        re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'aws-secret-key',    name: 'AWS secret key (in assignment)', re: /aws_secret_access_key\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi },
  { id: 'github-pat',        name: 'GitHub personal access token', re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { id: 'github-fine-pat',   name: 'GitHub fine-grained PAT',  re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { id: 'github-oauth',      name: 'GitHub OAuth/refresh token', re: /\bgh[ours]_[A-Za-z0-9]{36}\b/g },
  { id: 'anthropic-key',     name: 'Anthropic API key',        re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'openai-key',        name: 'OpenAI API key',           re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b/g },
  { id: 'slack-token',       name: 'Slack token',              re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'stripe-key',        name: 'Stripe secret key',        re: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g },
  { id: 'google-api-key',    name: 'Google API key',           re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'npm-token',         name: 'npm token',                re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'private-key-block', name: 'Private key block',        re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'jwt',               name: 'JWT (3-part, signed)',     re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\b/g },
  { id: 'telegram-bot',      name: 'Telegram bot token',       re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g },
  { id: 'sendgrid-key',      name: 'SendGrid API key',         re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
];

/** Mask a secret for display: keep first 4 + last 4, never the middle. */
function mask(s) {
  const str = String(s);
  if (str.length <= 10) return str[0] + '…' + str[str.length - 1];
  return str.slice(0, 4) + '…' + str.slice(-4) + ` (${str.length} chars)`;
}

/** Scan one text chunk. Returns [{ruleId, ruleName, secret, masked}]. Callers must only ever print `masked`. */
function scanText(text, rules) {
  const findings = [];
  for (const rule of rules || RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      const secret = m[1] || m[0];
      findings.push({ ruleId: rule.id, ruleName: rule.name, secret, masked: mask(secret) });
      if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
    }
  }
  return findings;
}

/** Read a file line by line without holding it whole; a session can exceed Node's max string. */
function* fileLines(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return; }
  let start = 0;
  while (start < buf.length) {
    let nl = buf.indexOf(0x0a, start);
    if (nl === -1) nl = buf.length;
    if (nl > start) yield buf.toString('utf8', start, nl);
    start = nl + 1;
  }
}

/**
 * Scan every source. Findings are deduped by rule+secret across all sources,
 * with an occurrence count and the sources they were seen in.
 * @param {Array<{agent, file, project, chunks?}>} sources
 * @param {{days?: number, now?: number}} opts
 */
function scan(sources, opts = {}) {
  const cutoff = opts.days ? (opts.now || Date.now()) - opts.days * 86400000 : null;
  const map = new Map();
  const unreadable = [];
  let scanned = 0;
  for (const src of sources) {
    // A chunk source (Cursor's sqlite DB) still names one real file in
    // `src.file`; its mtime is as good a cutoff signal as a transcript
    // file's — except sqlite's WAL mode means fresh writes can land in
    // `<file>-wal` while `<file>` itself keeps an old mtime (measured: the
    // DB proper hadn't moved since May, but its -wal sidecar had), so the
    // cutoff has to look at whichever of the two is newer. Only a source
    // with no file at all (stat fails) and no `chunks()` fallback for
    // reading it gets skipped outright.
    let mtimeMs = 0, statOk = true;
    try { mtimeMs = fs.statSync(src.file).mtimeMs; } catch (e) { statOk = false; }
    try { const w = fs.statSync(src.file + '-wal').mtimeMs; if (w > mtimeMs) mtimeMs = w; statOk = true; } catch (e) { /* no WAL sidecar */ }
    if (!statOk && !src.chunks) continue;
    if (cutoff && statOk && mtimeMs < cutoff) continue;
    // A source that cannot be read (Cursor holding its database locked) is
    // reported, not counted as scanned: "clean" must mean "read and clean".
    let texts;
    try { texts = src.chunks ? src.chunks() : fileLines(src.file); } catch (e) { unreadable.push({ agent: src.agent, file: src.file, error: e.message }); continue; }
    scanned++;
    for (const text of texts) {
      for (const f of scanText(text)) {
        const key = f.ruleId + ' ' + f.secret;
        if (!map.has(key)) map.set(key, { rule: f.ruleId, name: f.ruleName, masked: f.masked, occurrences: 0, agents: new Set(), files: new Set(), firstSeen: mtimeMs || null });
        const r = map.get(key);
        r.occurrences++; r.agents.add(src.agent); r.files.add(src.file);
      }
    }
  }
  const findings = [...map.values()].map((r) => ({ ...r, agents: [...r.agents], files: [...r.files], fileCount: r.files.size }))
    .sort((a, b) => b.occurrences - a.occurrences);
  return { findings, scanned, unreadable };
}

// ------------------------------------------------------------------ scrub (verbatim from ccleaks)

const SCRUB_RE_OVERRIDES = {
  'private-key-block':
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----|[\s\S]*)/g,
};

function replaceSecretsInString(str, rule) {
  const base = SCRUB_RE_OVERRIDES[rule.id] || rule.re;
  const re = base.flags.includes('d') ? base : new RegExp(base.source, base.flags + 'd');
  re.lastIndex = 0;
  let out = '', last = 0, m;
  const secrets = [];
  while ((m = re.exec(str)) !== null) {
    const secret = m[1] || m[0];
    const start = m[1] && m.indices && m.indices[1] ? m.indices[1][0] : m.index;
    out += str.slice(last, start) + `[REDACTED:${rule.id}]`;
    last = start + secret.length;
    secrets.push(secret);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  if (!secrets.length) return null;
  out += str.slice(last);
  return { out, secrets };
}

function scrubValue(value, rules, hits) {
  if (typeof value === 'string') {
    let s = value;
    for (const rule of rules) {
      const r = replaceSecretsInString(s, rule);
      if (r) { s = r.out; for (const secret of r.secrets) hits.push({ ruleId: rule.id, ruleName: rule.name, secret, masked: mask(secret) }); }
    }
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, rules, hits));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[scrubValue(k, rules, hits)] = scrubValue(v, rules, hits);
    return out;
  }
  return value;
}

function scrubLine(line, rules) {
  if (!line || line.length < 20) return { line, hits: [], parseError: false };
  let obj;
  try { obj = JSON.parse(line); } catch (e) { return { line, hits: [], parseError: true }; }
  const hits = [];
  const scrubbed = scrubValue(obj, rules || RULES, hits);
  if (!hits.length) return { line, hits, parseError: false };
  return { line: JSON.stringify(scrubbed), hits, parseError: false };
}

function scrubContent(content, rules) {
  const endsWithNewline = content.endsWith('\n');
  const lines = content.split('\n');
  if (endsWithNewline) lines.pop();
  const outLines = [];
  const hits = [];
  let parseErrors = 0;
  for (const line of lines) {
    const r = scrubLine(line, rules);
    outLines.push(r.line);
    if (r.parseError && line.trim()) parseErrors++;
    for (const h of r.hits) hits.push(h);
  }
  return { content: outLines.join('\n') + (endsWithNewline ? '\n' : ''), hits, parseErrors, changed: hits.length > 0 };
}

/** True when the file looks live (recent writes) and must be skipped. */
function isActive(mtimeMs, { now = Date.now(), activeMinutes = 5 } = {}) {
  return now - mtimeMs < activeMinutes * 60000;
}

/** Scrub one file on disk: backup, then atomic rewrite (tmp + rename), permissions preserved. */
function scrubFile(file, rules, { backup = true } = {}) {
  const content = fs.readFileSync(file, 'utf8');
  const r = scrubContent(content, rules);
  if (!r.changed) return { changed: false, hits: [], parseErrors: r.parseErrors };
  if (backup) fs.copyFileSync(file, file + '.pre-scrub.bak');
  const mode = fs.statSync(file).mode & 0o777;
  const tmp = file + '.scrub-tmp';
  fs.writeFileSync(tmp, r.content, { mode });
  fs.renameSync(tmp, file);
  return { changed: true, hits: r.hits, parseErrors: r.parseErrors };
}

function groupHits(hits) {
  const map = new Map();
  for (const h of hits) {
    const key = h.ruleId + ' ' + h.secret;
    if (!map.has(key)) map.set(key, { rule: h.ruleId, name: h.ruleName, masked: h.masked, occurrences: 0 });
    map.get(key).occurrences++;
  }
  return [...map.values()];
}

module.exports = { RULES, mask, scanText, fileLines, scan, replaceSecretsInString, scrubLine, scrubContent, scrubFile, isActive, groupHits };
