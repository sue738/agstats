'use strict';
/**
 * metrics/quota.js — where is the capacity actually going?
 *
 * Ported from ccquota. You meant to spend your capacity on the main project,
 * and the side experiment quietly ate 60% of the month. Usage is only ever
 * reported globally, so nothing tells you. Budgets are shares of a period,
 * not absolutes — "about a fifth of my month" is a thing you can reason
 * about; "40M tokens" is not.
 *
 * Budgets live in ~/.agentanalytics/budgets.json (or $AGENTANALYTICS_CONF). That
 * file is the one thing this metric writes, and only on `--set` / `--clear`.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { NAME } = require('../brand.js');

const PERIODS = { day: 86400000, week: 7 * 86400000, month: 30 * 86400000 };

function confPath() {
  return process.env[`${NAME.toUpperCase()}_CONF`] || path.join(os.homedir(), `.${NAME}`, 'budgets.json');
}
function readConf(file) { try { return JSON.parse(fs.readFileSync(file || confPath(), 'utf8')); } catch (e) { return {}; } }
function writeConf(c, file) { const f = file || confPath(); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(c, null, 2)); }

/** Start of the current period, aligned so numbers don't drift mid-day. */
function periodStart(period, nowMs) {
  const now = new Date(nowMs);
  if (period === 'day') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (period === 'week') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() - d.getDay());
    return d.getTime();
  }
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

/** How far through the period we are, 0..1. */
function periodProgress(period, nowMs) {
  const start = periodStart(period, nowMs);
  const now = new Date(nowMs);
  let end;
  if (period === 'day') end = start + 86400000;
  else if (period === 'week') end = start + 7 * 86400000;
  else end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  return Math.min(1, Math.max(0, (nowMs - start) / (end - start)));
}

/** Tokens per project (display name = last path segment) for the current period. */
function usageByProject(sessions, period, nowMs) {
  const start = periodStart(period, nowMs);
  const by = new Map();
  let total = 0;
  for (const s of sessions) {
    const name = String(s.project || '').split('/').filter(Boolean).pop() || s.agent;
    for (const e of s.events) {
      if (!e.tokens || e.t < start || e.t > nowMs) continue;
      const n = e.tokens.in + e.tokens.out + e.tokens.cacheRead + e.tokens.cacheWrite;
      by.set(name, (by.get(name) || 0) + n);
      total += n;
    }
  }
  return { by, total, start };
}

/** Compare actual shares against budgeted shares, overruns first. */
function assess(usage, budgets, progress) {
  budgets = budgets || {};
  const rows = [];
  const names = new Set([...usage.by.keys(), ...Object.keys(budgets)]);
  for (const name of names) {
    const tokens = usage.by.get(name) || 0;
    const share = usage.total ? tokens / usage.total : 0;
    const budget = budgets[name] != null ? budgets[name] / 100 : null;
    let status = 'unbudgeted';
    let overBy = null;
    if (budget != null) {
      overBy = share - budget;
      const paceRatio = budget > 0 ? share / budget : Infinity;
      if (paceRatio > 1.25) status = 'over';
      else if (paceRatio > 1.0) status = 'slightly-over';
      else if (paceRatio > 0.75) status = 'on-track';
      else status = 'under';
    }
    rows.push({ name, tokens, share, budget, overBy, status });
  }
  const rank = { over: 0, 'slightly-over': 1, unbudgeted: 2, 'on-track': 3, under: 4 };
  rows.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.tokens - a.tokens));
  return { rows, total: usage.total, progress };
}

function validateBudgets(budgets) {
  const sum = Object.values(budgets || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  return { sum, valid: sum <= 100, over: Math.max(0, sum - 100) };
}

module.exports = { PERIODS, confPath, readConf, writeConf, periodStart, periodProgress, usageByProject, assess, validateBudgets };
