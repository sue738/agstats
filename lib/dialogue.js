'use strict';
/**
 * dialogue.js — what a line of dialogue is, judged at read time.
 *
 * The model keeps no text (a million events must fit in memory), so anything
 * that needs the words is decided here, once, and stored as a flag:
 *
 *   isSystemText  a "user" turn the runtime wrote: continuation summaries,
 *                 hook bounces, pasted caveats. Not a person.
 *   askKind       a short user turn that cost attention but carried no new
 *                 intent — a status check, an approval, a nudge to keep going.
 *                 Ported from ccattention, whose point is that the cost of an
 *                 agent is how many times you have to speak per errand.
 *   isSelfFix     an assistant turn that retracts its own previous output —
 *                 the most direct quality signal in the transcript (measured:
 *                 1.7–3.9% on normal days, 10% on a day things kept failing).
 *
 * Patterns are Japanese and English. They are heuristics and say so.
 */

/**
 * User turns Claude Code writes itself, recognised by their leading tag.
 * Counted on this machine's transcripts (user turns that are not tool
 * results): task-notification 1,206 (a background task reporting back),
 * command-message / command-name 491 (slash-command echoes),
 * local-command-stdout / -caveat 174, bash-stdout 68. The same tags appear in
 * Codex Desktop transcripts, so both readers use this list.
 *
 * bash-input (68) is the one a person typed: `!git status` in the prompt.
 * It is still not a prompt — it runs locally, the model is asked nothing and
 * no reply follows, so counting it would add a prompt nobody answered and a
 * "you waited" gap for a reply that never came. Left out, deliberately.
 */
const RUNTIME_TAG = /^<(task-notification|local-command-(stdout|stderr|caveat)|command-(name|message|args)|bash-(input|stdout|stderr)|user-prompt-submit-hook)\b/;

const SYSTEM_PREFIXES = ['Another Claude', 'Base directory', 'This session is being continued', 'Stop hook', 'Caveat', '[Request interrupted'];

const STATUS = /^(進んでる|動いてる|続けてる|終わった|進んだ|動ける|今何|今どんな|今止ま|まだ|どうなった|status\??|how('s| is) it going|are you (done|stuck)|done\??|still (working|running)\??)/i;
const APPROVE = /^(はい|うん|ok|okay|OK|いいよ|いいです|やって|やろう|やりましょう|お願い|進めて|続けて|そう|それで|このまま|着手|する|やる|了解|よろしく|yes|yep|sure|go( ahead)?|do it|proceed|continue|sounds good|lgtm|[0-9a-c])$/i;
const NUDGE = /(止まってる|また止ま|作りますと言って|言って(作業|実装)してない|続けて|なんで止|you stopped|keep going|why did you stop|you said you would)/i;

const SELF_FIX = /訂正します|誤りでした|間違って|外れました|戻します|撤回|私の(誤り|失敗|見落と)|信用できません|数え直|取り下げ|前提が崩れ|I was wrong|my mistake|I retract|correction:|that was incorrect|I misread|I miscounted/i;

function isSystemText(txt) {
  const s = String(txt || '').trimStart();
  return SYSTEM_PREFIXES.some((p) => s.startsWith(p));
}

/** 'status' | 'approve' | 'nudge' | null for a human turn. */
function askKind(txt) {
  const s = String(txt || '').trim();
  if (!s || s.length > 600) return null;
  if (STATUS.test(s)) return 'status';
  if (NUDGE.test(s)) return 'nudge';
  if (s.length <= 15 && APPROVE.test(s)) return 'approve';
  return null;
}

function isSelfFix(txt) { return SELF_FIX.test(String(txt || '')); }

module.exports = { RUNTIME_TAG, SYSTEM_PREFIXES, STATUS, APPROVE, NUDGE, SELF_FIX, isSystemText, askKind, isSelfFix };
