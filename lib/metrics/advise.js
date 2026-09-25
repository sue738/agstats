'use strict';
/**
 * metrics/advise.js — what to change, from what was measured.
 *
 * A finding is only worth printing when three things are true: the number
 * crossed a threshold that is printed beside it, the fix can be handed over
 * as a concrete artifact (a hook skeleton, a list of skill names, a command),
 * and there is a command that measures whether the fix worked. Advice that
 * cannot be re-measured is not emitted — an optimizer that prints unfalsifiable
 * tips loses the reader's trust the second time.
 *
 * Nothing here is applied. The person applies it; `guards` measures it.
 */
const Tools = require('./tools.js');
const Skills = require('./skills.js');
const Stats = require('./stats.js');
const Blast = require('./blast.js');
const { NAME } = require('../brand.js');

const T = {
  guardMinCalls: 20, guardMinRate: 15, guardMinShare: 0.8,
  skillMinTyped: 3,
  modelMinReplies: 50, modelFixRatio: 2,
  cacheShareMin: 80, compactionsPer100Prompts: 2,
  containmentMin: 0.7,
};

/** A PreToolUse hook skeleton for one tool: the artifact a guard finding hands over. */
function hookSkeleton(tool, marker) {
  const safe = tool.replace(/[^A-Za-z0-9_]/g, '-');
  return [
    `# ~/.claude/hooks/guard-${safe}.sh  (PreToolUse, matcher: "${tool}")`,
    `# Reads the tool input on stdin as JSON; exit 2 with a message to block the call.`,
    `#!/bin/sh`,
    `input=$(cat)`,
    `# TODO: the check that catches the "${marker || 'input'}" failure before the call, e.g.`,
    `# echo "$input" | jq -e '.tool_input.<field> | type == "string"' >/dev/null || { echo "${tool}: <field> must be a string" >&2; exit 2; }`,
    `exit 0`,
    ``,
    `# settings.json → "hooks": { "PreToolUse": [ { "matcher": "${tool}", "hooks": [ { "type": "command", "command": "~/.claude/hooks/guard-${safe}.sh" } ] } ] }`,
    `# then: ${NAME} guards add ${tool} --note "hook installed"`,
  ].join('\n');
}

/** Self-correction rate per model (assistant replies with `fix`). */
function modelFixRates(sessions, from, to) {
  const by = {};
  for (const s of sessions) {
    if (s.parentId != null) continue;
    for (const e of s.events) {
      if (e.kind !== 'assistant' || e.injected || !e.chars || e.t < from || e.t >= to) continue;
      const m = Stats.family(e.model);
      if (!m) continue;
      const b = by[m] || (by[m] = { replies: 0, fixes: 0 });
      b.replies++; if (e.fix) b.fixes++;
    }
  }
  return Object.entries(by).map(([model, b]) => ({ model, replies: b.replies, fixes: b.fixes, rate: b.replies ? +((b.fixes / b.replies) * 100).toFixed(1) : 0 }))
    .sort((a, b) => b.rate - a.rate);
}

/**
 * @returns {Array<{id, severity:'high'|'medium'|'low', title, value, threshold, advice, artifact?, remeasure}>}
 */
function findings(sessions, from = -Infinity, to = Infinity, opts = {}) {
  const out = [];
  const t = { ...T, ...(opts.thresholds || {}) };

  // 1. tool failures a guard could stop
  const tools = Tools.summarize(sessions, from, to);
  for (const s of Tools.suggest(tools, { minCalls: t.guardMinCalls, minRate: t.guardMinRate })) {
    const g = Tools.guardCandidate(s, { minShare: t.guardMinShare });
    if (!g.candidate) continue;
    out.push({
      id: `guard:${s.tool}`, severity: 'high',
      title: `${s.tool} fails ${s.errorRate}% of the time (${s.errors}/${s.calls}) and ${(g.dominance.share * 100).toFixed(0)}% of the failures are one input error`,
      value: s.errorRate, threshold: `≥${t.guardMinRate}% over ≥${t.guardMinCalls} calls, one cause ≥${t.guardMinShare * 100}%`,
      advice: `Block the call before it is made: a PreToolUse hook that checks the input for "${g.classification.marker}". Register it, then let ${NAME} guards say whether it worked.`,
      artifact: hookSkeleton(s.tool, g.classification.marker),
      remeasure: `${NAME} guards`,
    });
  }
  // failures that a guard cannot stop still deserve a line, without an artifact
  for (const s of Tools.suggest(tools, { minCalls: t.guardMinCalls, minRate: t.guardMinRate })) {
    const g = Tools.guardCandidate(s, { minShare: t.guardMinShare });
    if (g.candidate || !g.classification || g.classification.kind === 'input') continue;
    out.push({
      id: `flaky:${s.tool}`, severity: 'medium',
      title: `${s.tool} fails ${s.errorRate}% of the time (${s.errors}/${s.calls}); the dominant cause is ${g.classification.kind}`,
      value: s.errorRate, threshold: `≥${t.guardMinRate}% over ≥${t.guardMinCalls} calls`,
      advice: g.classification.kind === 'quota' ? 'A rate limit on the other side: stop calling it in loops, or batch. No hook fixes this.'
        : g.classification.kind === 'auth' ? 'Auth or session expiry: re-authenticate; nothing in the input is wrong.'
        : g.classification.kind === 'state' ? 'The failure depends on the environment at call time (missing file, timeout): not visible before the call. Retry policy, not a hook.'
        : 'Causes are mixed; read the clusters (tools --suggest) before deciding.',
      remeasure: `${NAME} tools --suggest`,
    });
  }

  // 2. skills typed by name but never matched by description
  const invs = Skills.invocations(sessions);
  const rows = Skills.summarize(invs, Skills.installedSkills(sessions), { from, to });
  const silent = rows.filter((r) => !r.isCommand && r.onDisk && r.typed >= t.skillMinTyped && r.tool === 0);
  if (silent.length) {
    out.push({
      id: 'skills:description', severity: 'medium',
      title: `${silent.length} skill(s) are typed by name (${silent.reduce((a, r) => a + r.typed, 0)}×) but their description never matched a request`,
      value: silent.length, threshold: `typed ≥${t.skillMinTyped}, tool = 0, SKILL.md on disk`,
      advice: 'The description is the trigger. Rewrite it with the phrases people actually type (the typed invocations are the corpus), then watch the `tool` column.',
      artifact: silent.map((r) => `${r.name}  typed ${r.typed}×`).join('\n'),
      remeasure: `${NAME} skills`,
    });
  }

  // 3. one model corrects itself far more than another
  const mf = modelFixRates(sessions, from, to).filter((m) => m.replies >= t.modelMinReplies);
  if (mf.length >= 2) {
    const worst = mf[0], best = mf[mf.length - 1];
    if (best.rate > 0 && worst.rate >= best.rate * t.modelFixRatio) {
      out.push({
        id: 'models:self-fix', severity: 'medium',
        title: `${worst.model} retracts its own output ${worst.rate}% of the time vs ${best.model} ${best.rate}% (${worst.replies} / ${best.replies} replies)`,
        value: worst.rate, threshold: `≥${t.modelFixRatio}× the best model, ≥${t.modelMinReplies} replies each`,
        advice: `For the work you actually do, ${worst.model} costs more corrections. Route the tasks where it corrects itself to ${best.model}, then compare next month.`,
        artifact: mf.map((m) => `${m.model.padEnd(10)} ${String(m.fixes).padStart(5)} / ${String(m.replies).padStart(6)}  ${m.rate}%`).join('\n'),
        remeasure: `${NAME} advise --json  (models:self-fix)`,
      });
    }
  }

  // 4. context hygiene
  const st = Stats.summarize(sessions, from, to);
  if (st.tokens.total > 1e6 && st.cacheShare < t.cacheShareMin) {
    out.push({
      id: 'context:cache', severity: 'low',
      title: `only ${st.cacheShare}% of tokens are cache reads`,
      value: st.cacheShare, threshold: `<${t.cacheShareMin}% with >1M tokens`,
      advice: 'Low cache reads mean the prefix keeps changing: instructions edited mid-session, or many short sessions. Keep CLAUDE.md stable during the day; prefer one long session over many restarts.',
      remeasure: `${NAME} stats`,
    });
  }
  if (st.prompts >= 100 && st.compactions / st.prompts * 100 >= t.compactionsPer100Prompts) {
    out.push({
      id: 'context:compaction', severity: 'low',
      title: `${st.compactions} compactions for ${st.prompts} prompts — sessions keep forgetting their own start`,
      value: +((st.compactions / st.prompts) * 100).toFixed(1), threshold: `≥${t.compactionsPer100Prompts} per 100 prompts`,
      advice: 'Split work into sessions on purpose (/clear at a boundary you choose) instead of letting compaction choose it for you.',
      remeasure: `${NAME} stats`,
    });
  }

  // 5. safety net
  const bl = Blast.summarize(sessions, from, to);
  if (bl.actions >= 100 && bl.containment < t.containmentMin) {
    const top = bl.categories.filter((c) => c.key !== 'outbound').slice(0, 3);
    out.push({
      id: 'blast:containment', severity: 'high',
      title: `${(bl.containment * 100).toFixed(1)}% of changes were undoable; ${bl.escaped} escaped`,
      value: +(bl.containment * 100).toFixed(1), threshold: `<${t.containmentMin * 100}% over ≥100 actions`,
      advice: top.length ? `The largest non-messaging leaks: ${top.map((c) => `${c.label} (${c.count})`).join(', ')}. A PreToolUse hook on Bash that asks before those commands is the cheapest net.` : 'Almost all of it is messaging tools (MCP, Slack); decide per destination whether that is intended.',
      artifact: top.length ? hookSkeleton('Bash', top[0].key) : undefined,
      remeasure: `${NAME} blast`,
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

module.exports = { THRESHOLDS: T, hookSkeleton, modelFixRates, findings };
