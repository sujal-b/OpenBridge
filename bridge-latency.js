'use strict';

// bridge-latency.js — phase/span instrumentation for the Brain <-> HANDS bridge.
//
// Design constraints, in priority order:
//   1. Never perturb what it measures. Spans are buffered in memory and flushed
//      on a timer. Nothing on a hot path awaits a write.
//   2. Never take a lock. Unlike bridge-actions, this does not use actions.lock.
//      latency.jsonl is diagnostic data; a rare interleaved line is an acceptable
//      trade for a telemetry path that cannot itself become a bottleneck.
//   3. Never break a run. Every write is wrapped; a failed flush is swallowed.
//
// Span kinds:
//   phase    — a runner phase (propose, consult, execute, review)
//   process  — a spawned provider/cli process, with cold-start split
//   http     — a Brain HTTP call, with connect/TTFB split
//   coord    — a coordinator subprocess invocation
//   counter  — a monotonic counter sample (summed in reports)
//
// Disable with MIND_LIMB_LATENCY=0.

const fsSync = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const FILE_NAME = 'latency.jsonl';
const FLUSH_INTERVAL_MS = 400;
const MAX_BUFFERED_SPANS = 4000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const ROTATED_FILE_NAME = 'latency.jsonl.1';

const highResNow = typeof performance !== 'undefined' && typeof performance.now === 'function'
  ? () => performance.now()
  : () => Number(process.hrtime.bigint() / 1000000n);

let enabled = process.env.MIND_LIMB_LATENCY !== '0';
let baseCwd = process.cwd();
let buffer = [];
let flushTimer = null;
let flushing = false;
let spansDropped = 0;
let exitHandlerInstalled = false;
// Writes are opt-in via install(). Unit tests and library consumers that never
// call install() record nothing and touch no files.
let installed = false;

function latencyFile(cwd) {
  return path.join(cwd || baseCwd, '.bridge', FILE_NAME);
}

function now() {
  return highResNow();
}

function setEnabled(value) {
  enabled = Boolean(value);
  if (!enabled) {
    reset();
  }
}

function isEnabled() {
  return enabled;
}

function install(cwd) {
  if (cwd) baseCwd = cwd;
  installed = true;
  registerExitHandler();
  return api;
}

// Test seam: stop writing and drop buffered spans.
function uninstall() {
  installed = false;
  reset();
}

function reset() {
  buffer = [];
  spansDropped = 0;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function getSpansDropped() {
  return spansDropped;
}

function roundMs(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function makeId() {
  return 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// ─── Recording ───────────────────────────────────────────────────────────────

function push(record) {
  if (!enabled || !installed) return null;
  if (buffer.length >= MAX_BUFFERED_SPANS) {
    spansDropped += 1;
    return null;
  }
  buffer.push(record);
  scheduleFlush();
  return record;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_INTERVAL_MS);
  // Never keep the process alive just to write telemetry.
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function startSpan(name, meta) {
  if (!enabled || !installed) return noopSpan();
  const start = now();
  const startedAt = new Date().toISOString();
  let ended = false;
  return {
    name,
    start,
    end(extra) {
      if (ended) return null;
      ended = true;
      return record(name, now() - start, {
        ...(meta || {}),
        ...(extra || {}),
        at: startedAt
      });
    },
    fail(error, extra) {
      return this.end({
        ...(extra || {}),
        ok: false,
        error: String((error && error.message) || error || '').slice(0, 200)
      });
    }
  };
}

function noopSpan() {
  return { end: () => null, fail: () => null, name: null, start: 0 };
}

function record(name, durationMs, meta) {
  if (!enabled) return null;
  return push({
    id: makeId(),
    kind: (meta && meta.kind) || 'phase',
    name,
    at: (meta && meta.at) || new Date().toISOString(),
    ms: roundMs(durationMs),
    ok: meta && meta.ok === false ? false : true,
    pid: process.pid,
    ...(meta || {})
  });
}

function count(name, value = 1, meta = {}) {
  if (!enabled) return null;
  return push({
    id: makeId(),
    kind: 'counter',
    name,
    at: new Date().toISOString(),
    value,
    count: value,
    pid: process.pid,
    ...meta
  });
}

// Convenience: time an async function and preserve its return value/errors.
async function timeAsync(name, fn, meta) {
  if (!enabled) return fn();
  const span = startSpan(name, { kind: 'phase', ...(meta || {}) });
  try {
    const value = await fn();
    span.end({ ok: true });
    return value;
  } catch (error) {
    span.fail(error);
    throw error;
  }
}

// ─── Flushing ────────────────────────────────────────────────────────────────

async function rotateIfNeeded(file) {
  try {
    const stat = await fsp.stat(file);
    if (stat.size < MAX_FILE_BYTES) return;
    await fsp.rename(file, path.join(path.dirname(file), ROTATED_FILE_NAME)).catch(() => {});
  } catch (error) {
    if (error && error.code !== 'ENOENT') return;
  }
}

function rotateIfNeededSync(file) {
  try {
    const stat = fsSync.statSync(file);
    if (stat.size < MAX_FILE_BYTES) return;
    try {
      fsSync.renameSync(file, path.join(path.dirname(file), ROTATED_FILE_NAME));
    } catch {}
  } catch (error) {
    if (error && error.code !== 'ENOENT') return;
  }
}

async function flush() {
  if (!enabled || !installed || flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer;
  buffer = [];
  try {
    const file = latencyFile(baseCwd);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await rotateIfNeeded(file);
    await fsp.appendFile(file, batch.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  } catch {
    // Telemetry must never fail a run. Drop the batch.
    spansDropped += batch.length;
  } finally {
    flushing = false;
  }
  if (buffer.length) scheduleFlush();
}

function flushSync() {
  if (!enabled || !installed || buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    const file = latencyFile(baseCwd);
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeededSync(file);
    fsSync.appendFileSync(file, batch.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  } catch {
    spansDropped += batch.length;
  }
}

function registerExitHandler() {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  // The only synchronous flush. 'exit' handlers cannot await, so this is the
  // last chance to persist buffered spans.
  process.on('exit', () => {
    try { flushSync(); } catch {}
  });
}

function shutdown() {
  flushSync();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

// ─── Reporting ───────────────────────────────────────────────────────────────

async function readSpans(cwd, limit = 20000) {
  const file = latencyFile(cwd);
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const spans = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      spans.push(JSON.parse(trimmed));
    } catch {}
  }
  return spans.length > limit ? spans.slice(-limit) : spans;
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[index];
}

function summarize(spans) {
  const durations = new Map();
  const counters = new Map();
  let totalMs = 0;

  for (const span of spans) {
    if (span && span.kind === 'counter') {
      const entry = counters.get(span.name) || { count: 0, value: 0 };
      entry.count += 1;
      entry.value += Number(span.value) || 0;
      counters.set(span.name, entry);
      continue;
    }
    if (!span || typeof span.ms !== 'number') continue;
    const entry = durations.get(span.name) || { name: span.name, kind: span.kind || 'phase', count: 0, values: [], errors: 0, extras: {}, flags: {} };
    entry.count += 1;
    entry.values.push(span.ms);
    totalMs += span.ms;
    if (span.ok === false) entry.errors += 1;
    // Numeric companion metrics (cold_start_ms, ttfb_ms) get percentile
    // rendering; boolean flags (under_lock) get true/total tallies.
    for (const [key, value] of Object.entries(span)) {
      if (key === 'ms' || key === 'pid') continue;
      if (typeof value === 'number') {
        if (!entry.extras[key]) entry.extras[key] = [];
        entry.extras[key].push(value);
      } else if (typeof value === 'boolean') {
        const flag = entry.flags[key] || { true: 0, false: 0 };
        flag[value ? 'true' : 'false'] += 1;
        entry.flags[key] = flag;
      }
    }
    durations.set(span.name, entry);
  }

  const stats = [...durations.values()].map(entry => {
    const values = entry.values.slice().sort((a, b) => a - b);
    const extras = {};
    for (const [key, list] of Object.entries(entry.extras)) {
      const sorted = list.slice().sort((a, b) => a - b);
      extras[key] = {
        p50: roundMs(percentile(sorted, 50)),
        p95: roundMs(percentile(sorted, 95)),
        max: roundMs(sorted[sorted.length - 1])
      };
    }
    const flags = {};
    for (const [key, tally] of Object.entries(entry.flags)) {
      flags[key] = tally.true + '/' + (tally.true + tally.false);
    }
    return {
      name: entry.name,
      kind: entry.kind,
      count: entry.count,
      errors: entry.errors,
      p50: roundMs(percentile(values, 50)),
      p95: roundMs(percentile(values, 95)),
      max: roundMs(values[values.length - 1]),
      mean: roundMs(values.reduce((sum, value) => sum + value, 0) / values.length),
      total: roundMs(values.reduce((sum, value) => sum + value, 0)),
      extras,
      flags
    };
  });

  stats.sort((a, b) => b.total - a.total);

  return {
    spans: stats,
    counters: [...counters.entries()].map(([name, entry]) => ({ name, samples: entry.count, total: entry.value })),
    totalMs: roundMs(totalMs),
    spanCount: spans.length
  };
}

function pad(value, width) {
  return String(value).padEnd(width);
}

function padStart(value, width) {
  return String(value).padStart(width);
}

function formatMs(value) {
  if (value === null || value === undefined) return '-';
  return value >= 1000 ? (value / 1000).toFixed(2) + 's' : Math.round(value) + 'ms';
}

function formatReport(summary) {
  const lines = [];
  lines.push('Latency report — ' + summary.spanCount + ' spans, ' + formatMs(summary.totalMs) + ' instrumented time');
  lines.push('');
  if (!summary.spans.length) {
    lines.push('No spans recorded yet. Run a task with MIND_LIMB_LATENCY unset or =1.');
    return lines.join('\n');
  }
  lines.push(pad('span', 26) + padStart('n', 5) + padStart('p50', 10) + padStart('p95', 10) + padStart('max', 10) + padStart('total', 11) + padStart('err', 5));
  lines.push('-'.repeat(77));
  for (const stat of summary.spans) {
    lines.push(
      pad(stat.name.slice(0, 25), 26) +
      padStart(stat.count, 5) +
      padStart(formatMs(stat.p50), 10) +
      padStart(formatMs(stat.p95), 10) +
      padStart(formatMs(stat.max), 10) +
      padStart(formatMs(stat.total), 11) +
      padStart(stat.errors || '', 5)
    );
    for (const [key, value] of Object.entries(stat.extras)) {
      lines.push('    ' + pad(key, 22) + 'p50 ' + formatMs(value.p50) + '  p95 ' + formatMs(value.p95) + '  max ' + formatMs(value.max));
    }
    for (const [key, tally] of Object.entries(stat.flags || {})) {
      lines.push('    ' + pad(key, 22) + 'true ' + tally);
    }
  }
  if (summary.counters.length) {
    lines.push('');
    lines.push('counters');
    lines.push('-'.repeat(77));
    for (const counter of summary.counters) {
      lines.push(pad(counter.name, 26) + padStart(counter.total, 10) + '   (' + counter.samples + ' samples)');
    }
  }
  return lines.join('\n');
}

const api = {
  FILE_NAME,
  latencyFile,
  now,
  install,
  uninstall,
  setEnabled,
  isEnabled,
  startSpan,
  timeAsync,
  record,
  count,
  flush,
  flushSync,
  shutdown,
  reset,
  getSpansDropped,
  readSpans,
  summarize,
  formatReport
};

module.exports = api;
