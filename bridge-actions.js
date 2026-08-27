'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { renameWithRetry } = require('./bridge-atomic');
const MAX_FIELD_LENGTH = 240;
const MAX_ID_LENGTH = 120;
const DEFAULT_LOCK_WAIT_MS = 10000;

function bridgePath(cwd, name) {
  return path.join(cwd || process.cwd(), '.bridge', name);
}

function actionFile(cwd) {
  return bridgePath(cwd, 'actions.jsonl');
}

function actionLockFile(cwd) {
  return bridgePath(cwd, 'actions.lock');
}

function sequenceFile(cwd) {
  return bridgePath(cwd, 'actions.seq');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function redact(value, maxLength = MAX_FIELD_LENGTH) {
  if (value === undefined || value === null) return '';
  let text = String(value).replace(/\s+/g, ' ').trim();
  text = text
    .replace(/(Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password|passwd|authorization|cookie|session[_-]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,})\b/g, '[REDACTED]');
  return text.length > maxLength ? text.slice(0, maxLength - 3) + '...' : text;
}

function safeId(value) {
  const text = redact(value, MAX_ID_LENGTH);
  return text || null;
}

function duration(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function makeId() {
  return 'action-' + Date.now().toString(36) + '-' + process.pid + '-' + crypto.randomBytes(5).toString('hex');
}

function normalizeAction(event = {}) {
  const record = {
    id: safeId(event.id) || makeId(),
    at: new Date().toISOString(),
    session_id: safeId(event.session_id),
    assignment_id: safeId(event.assignment_id),
    chunk: event.chunk === undefined || event.chunk === null ? null : redact(event.chunk, 48),
    agent: redact(event.agent, 64) || 'unknown',
    kind: redact(event.kind, 48) || 'action',
    phase: redact(event.phase, 64) || 'unknown',
    target: redact(event.target, 96) || 'unknown',
    summary: redact(event.summary, MAX_FIELD_LENGTH) || 'Telemetry event',
    path: redact(event.path, MAX_FIELD_LENGTH) || null,
    command: redact(event.command, MAX_FIELD_LENGTH) || null,
    query: redact(event.query, MAX_FIELD_LENGTH) || null,
    status: redact(event.status, 32) || 'unknown',
    duration_ms: duration(event.duration_ms),
    risk: redact(event.risk, 48) || null,
    approval: redact(event.approval, 48) || null,
    revision: Number.isInteger(event.revision) ? event.revision : null,
    provider_session_id: safeId(event.provider_session_id),
    pid: process.pid
  };
  const detailRef = redact(event.detail_ref, 160);
  if (detailRef) record.detail_ref = detailRef;
  return record;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function readLock(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; return {}; }
}

async function acquireLock(cwd, waitMs = DEFAULT_LOCK_WAIT_MS) {
  const file = actionLockFile(cwd);
  const started = Date.now();
  await fs.mkdir(path.dirname(file), { recursive: true });
  while (true) {
    const token = crypto.randomBytes(12).toString('hex');
    try {
      const handle = await fs.open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }) + '\n', 'utf8');
      await handle.close();
      return { file, token };
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      const owner = await readLock(file);
      if (owner && owner.pid && !processAlive(Number(owner.pid))) {
        await fs.unlink(file).catch(unlinkError => {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        });
        continue;
      }
      if (Date.now() - started >= waitMs) throw new Error('Timed out waiting for the telemetry action lock.');
      await delay(4);
    }
  }
}

async function releaseLock(lock) {
  if (!lock) return;
  const owner = await readLock(lock.file);
  if (!owner || owner.token !== lock.token) return;
  await fs.unlink(lock.file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function nextSequence(cwd) {
  let current = 0;
  try {
    current = Number((await fs.readFile(sequenceFile(cwd), 'utf8')).trim());
    if (!Number.isInteger(current) || current < 0) current = 0;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const next = current;
  const temp = sequenceFile(cwd) + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try {
    await fs.writeFile(temp, String(next + 1) + '\n', 'utf8');
    await renameWithRetry(temp, sequenceFile(cwd));
    return next;
  } finally {
    await fs.unlink(temp).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function appendAction(event, options = {}) {
  const cwd = options.cwd || process.cwd();
  const file = actionFile(cwd);
  const lock = await acquireLock(cwd, options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS);
  try {
    const record = normalizeAction(event);
    record.seq = await nextSequence(cwd);
    await fs.appendFile(file, JSON.stringify(record) + '\n', 'utf8');
    return record;
  } finally {
    await releaseLock(lock);
  }
}

module.exports = {
  actionFile,
  actionLockFile,
  appendAction,
  normalizeAction,
  redact
};
