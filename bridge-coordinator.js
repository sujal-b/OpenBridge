#!/usr/bin/env node

// Mind-Limb Bridge coordinator.
// One source of truth: .bridge/state.json
// Audit only: .bridge/events.jsonl

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { defaultPolicy } = require('./bridge-policy');
const { renameWithRetry } = require('./bridge-atomic');
const { isLegacyConsultationRetry, coerceEventSeq, lastEvent } = require('./bridge-state');

const execFileAsync = promisify(execFile);
const root = process.cwd();
const bridgeDir = path.join(root, '.bridge');
const stateFile = path.join(bridgeDir, 'state.json');
const eventsFile = path.join(bridgeDir, 'events.jsonl');
const planFile = path.join(bridgeDir, 'plan.md');
const policyFile = path.join(bridgeDir, 'policy.json');
const initLockFile = path.join(bridgeDir, 'init.lock');
const lockFile = path.join(bridgeDir, 'state.lock');
const commitFile = path.join(bridgeDir, 'commit.pending.json');

let stateLockDepth = 0;

const phases = new Set([
  'idle', 'planning', 'hands_proposing', 'brain_approving',
  'hands_consulting', 'hands_executing', 'brain_reviewing', 'blocked_user', 'paused',
  'done', 'cancelled'
]);

const blockKinds = new Set(['needs_revision', 'consultation_retry', 'escalation']);

const transitions = {
  idle: ['planning', 'cancelled'],
  planning: ['hands_proposing', 'blocked_user', 'paused', 'cancelled'],
  hands_proposing: ['brain_approving', 'hands_proposing', 'blocked_user', 'paused', 'cancelled'],
  brain_approving: ['hands_proposing', 'hands_consulting', 'blocked_user', 'paused', 'cancelled'],
  hands_consulting: ['hands_executing', 'hands_proposing', 'blocked_user', 'paused', 'cancelled'],
  hands_executing: ['brain_reviewing', 'hands_proposing', 'blocked_user', 'paused', 'cancelled'],
  brain_reviewing: ['planning', 'hands_proposing', 'done', 'blocked_user', 'paused', 'cancelled'],
  blocked_user: ['planning', 'hands_proposing', 'brain_approving', 'hands_consulting', 'hands_executing', 'brain_reviewing', 'paused', 'cancelled'],
  paused: ['planning', 'hands_proposing', 'brain_approving', 'hands_consulting', 'hands_executing', 'brain_reviewing', 'blocked_user', 'cancelled'],
  done: ['planning'],
  cancelled: ['planning']
};

function now() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return prefix + '-' + Date.now().toString(36);
}

function makeLeaseId() {
  return 'lease-' + Date.now().toString(36) + '-' + crypto.randomBytes(8).toString('hex');
}

function initialState() {
  return {
    schema_version: 1,
    session_id: makeId('session'),
    phase: 'idle',
    active_agent: 'none',
    activity: { agent: 'none', action: 'Idle', started_at: null },
    task: '',
    assignment_id: null,
    hands_session_id: null,
    revision: 0,
    approach: null,
    approval: 'none',
    autonomy: { mode: 'manual', approved_by: null, approved_at: null },
    consultation: null,
    execution_lease_id: null,
    revision_consumed: false,
    execution_claimed: false,
    execution_started_at: null,
    git_before: null,
    git_after: null,
    git_status: 'unknown',
    blocked_reason: null,
    block_kind: null,
    recovery_required: false,
    mind_feedback: null,
    evaluation: { status: 'idle', summary: null, at: null },
    resume_phase: null,
    event_seq: 0,
    last_summary: 'Bridge initialized',
    updated_at: now()
  };
}

function approachMetadata(revision, status = 'awaiting_brain') {
  return {
    roles: { planner: 'brain', proposer: 'hands', executor: 'hands', reviewer: 'brain', primary: 'task-matched engineer' },
    handoff: { from: 'hands', to: 'brain', status, revision }
  };
}

function normalizeApproach(approach) {
  if (!approach || typeof approach !== 'object') return null;
  const metadata = approachMetadata(Number(approach.revision) || 0);
  return {
    ...approach,
    files: Array.isArray(approach.files) ? approach.files : [],
    risks: Array.isArray(approach.risks) ? approach.risks : [],
    acceptance: Array.isArray(approach.acceptance) ? approach.acceptance : [],
    roles: { ...metadata.roles, ...(approach.roles || {}) },
    handoff: { ...metadata.handoff, ...(approach.handoff || {}) },
    role: typeof approach.role === 'string' && approach.role.trim() ? approach.role.trim().slice(0, 120) : 'task-matched engineer'
  };
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(file, value) {
  const temp = file + '.' + process.pid + '.' + crypto.randomBytes(5).toString('hex') + '.tmp';
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    await renameWithRetry(temp, file);
  } finally {
    await fs.unlink(temp).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
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

function lockToken() {
  return crypto.randomBytes(16).toString('hex');
}

async function readLockOwner(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    try { return JSON.parse(text); } catch {
      const pid = Number(text.split(/\r?\n/)[0]);
      return Number.isInteger(pid) && pid > 0 ? { pid } : {};
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return {};
  }
}

async function staleLock(file, maxAgeMs = 30000) {
  const owner = await readLockOwner(file);
  if (!owner) return false;
  if (owner.pid && processAlive(Number(owner.pid))) return false;
  try {
    const stat = await fs.stat(file);
    return Date.now() - stat.mtimeMs >= maxAgeMs;
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

async function writeTextAtomic(file, text) {
  const temp = file + '.' + process.pid + '.' + crypto.randomBytes(5).toString('hex') + '.tmp';
  try {
    await fs.writeFile(temp, text, 'utf8');
    await renameWithRetry(temp, file);
  } finally {
    await fs.unlink(temp).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function reconcilePending() {
  if (!(await exists(commitFile))) return;
  const pending = JSON.parse(await fs.readFile(commitFile, 'utf8'));
  if (!pending.state || !pending.plan || !pending.event) throw new Error('Invalid pending bridge commit. Inspect ' + commitFile + '.');
  await writeJsonAtomic(stateFile, pending.state);
  await writeTextAtomic(planFile, pending.plan);
  let hasEvent = false;
  try {
    const lines = (await fs.readFile(eventsFile, 'utf8')).split(/\r?\n/).filter(Boolean);
    hasEvent = lines.some(line => {
      try {
        const event = JSON.parse(line);
        return event.seq === pending.event.seq && event.session_id === pending.event.session_id;
      } catch { return false; }
    });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!hasEvent) await fs.appendFile(eventsFile, JSON.stringify(pending.event) + '\n', 'utf8');
  await fs.unlink(commitFile).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function reconcilePendingIfSafe() {
  if (!(await exists(commitFile))) return;
  let lock;
  try { lock = await acquireLock(); } catch (error) {
    if (error.code === 'coordinator_busy') return;
    throw error;
  }
  try { await reconcilePending(); } finally { await releaseLock(lock); }
}

async function ensureStore() {
  await fs.mkdir(bridgeDir, { recursive: true });
  const ready = await Promise.all([stateFile, eventsFile, planFile, policyFile].map(exists));
  if (!ready.every(Boolean)) {
    let initHandle;
    while (!initHandle) {
      try {
        initHandle = await fs.open(initLockFile, 'wx');
        await initHandle.writeFile(JSON.stringify({ pid: process.pid, at: now() }) + '\n', 'utf8');
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (await staleLock(initLockFile)) {
          await fs.unlink(initLockFile).catch(unlinkError => {
            if (unlinkError.code !== 'ENOENT') throw unlinkError;
          });
          continue;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    try {
      const stateCreated = !(await exists(stateFile));
      const eventInfo = stateCreated ? await lastEvent(root) : { seq: -1, session_id: null };
      const initial = stateCreated ? initialState() : null;
      if (initial && eventInfo.seq >= 0) {
        initial.event_seq = eventInfo.seq;
        if (eventInfo.session_id) initial.session_id = eventInfo.session_id;
      }
      if (initial) await writeJsonAtomic(stateFile, initial);
      if (!(await exists(eventsFile))) {
        const event = initial
          ? { seq: 0, at: initial.updated_at, session_id: initial.session_id, assignment_id: null, revision: 0, type: 'initialized', phase: 'idle', active_agent: 'none', summary: 'Bridge initialized' }
          : null;
        await writeTextAtomic(eventsFile, event ? JSON.stringify(event) + '\n' : '');
      }
      if (!(await exists(planFile))) await writeTextAtomic(planFile, '# Mind-Limb Bridge\n\nNo active task.\n');
      if (!(await exists(policyFile))) await writeTextAtomic(policyFile, JSON.stringify(defaultPolicy, null, 2) + '\n');
    } finally {
      await initHandle.close();
      await fs.unlink(initLockFile).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
  await reconcilePendingIfSafe();
}

function normalizeState(state) {
  const defaults = initialState();
  const normalized = {
    ...defaults,
    ...state,
    activity: { ...defaults.activity, ...(state.activity || {}) },
    approach: normalizeApproach(state.approach),
    autonomy: { ...defaults.autonomy, ...(state.autonomy || {}) },
    evaluation: { ...defaults.evaluation, ...(state.evaluation || {}) },
    consultation: state.consultation ?? null,
    execution_lease_id: state.execution_lease_id ?? null,
    revision_consumed: state.revision_consumed === true,
    execution_claimed: state.execution_claimed === true,
execution_started_at: state.execution_started_at ?? null
  };
  if (!phases.has(normalized.phase)) normalized.phase = 'idle';
  normalized.event_seq = coerceEventSeq(state) ?? 0;
  // Older runners marked transient ask_codex/MCP startup failures as revisions.
  // Only migrate that exact consultation state; material consultation blocks stay revisions.
  if (isLegacyConsultationRetry(normalized)) normalized.block_kind = 'consultation_retry';
  return normalized;
}

async function lastEventSeq() {
  let maxSeq = -1;
  try {
    const lines = (await fs.readFile(eventsFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (Number.isInteger(event.seq) && event.seq >= 0 && event.seq > maxSeq) maxSeq = event.seq;
      } catch {
        // Skip broken log tails; continuity is derived from valid events only.
      }
    }
  } catch {
    // No readable events file; a fresh log starts at zero.
  }
  return maxSeq;
}

async function reinitializeState() {
  await ensureStore();
  const state = initialState();
  const eventInfo = await lastEvent(root);
  if (eventInfo.seq >= 0) {
    state.event_seq = eventInfo.seq;
    if (eventInfo.session_id) state.session_id = eventInfo.session_id;
  }
  await writeJsonAtomic(stateFile, state);
  return state;
}

async function repairPlan(raw) {
  const normalized = normalizeState(raw);
  const repairedSeq = coerceEventSeq(raw) === null;
  if (repairedSeq) {
    const eventInfo = await lastEvent(root);
    if (eventInfo.seq >= 0) normalized.event_seq = eventInfo.seq;
  }
  const needsRepair = repairedSeq || (raw.block_kind === 'needs_revision' && normalized.block_kind === 'consultation_retry');
  return { normalized, needsRepair };
}

async function repairStateUnderLock() {
  let lock;
  try { lock = await acquireLock(); } catch (error) {
    if (error.code === 'coordinator_busy') return;
    throw error;
  }
  try {
    await reconcilePending();
    let raw;
    try { raw = JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch { return; }
    const { normalized, needsRepair } = await repairPlan(raw);
    if (needsRepair) await writeJsonAtomic(stateFile, normalized);
  } finally {
    await releaseLock(lock);
  }
}

async function readState() {
  await ensureStore();
  // Keep corrupt snapshots for diagnosis briefly, then remove old repair litter.
  const corruptCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const name of await fs.readdir(bridgeDir).catch(() => [])) {
    if (!name.startsWith('state.json.corrupt-')) continue;
    const file = path.join(bridgeDir, name);
    const stat = await fs.stat(file).catch(() => null);
    if (stat && stat.mtimeMs < corruptCutoff) await fs.unlink(file).catch(() => {});
  }
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const quarantineFile = stateFile + '.corrupt-' + Date.now().toString(36);
    try {
      await renameWithRetry(stateFile, quarantineFile);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await fs.copyFile(stateFile, quarantineFile).catch(copyError => {
          if (copyError.code !== 'ENOENT') throw copyError;
        });
        await fs.unlink(stateFile).catch(unlinkError => {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        });
      }
    }
    raw = await reinitializeState();
  }
  const { normalized, needsRepair } = await repairPlan(raw);
  if (needsRepair) {
    if (stateLockDepth > 0) await writeJsonAtomic(stateFile, normalized);
    else await repairStateUnderLock();
  }
  return normalized;
}

async function acquireLock() {
  const token = lockToken();
  try {
    const handle = await fs.open(lockFile, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: now() }) + '\n', 'utf8');
    await handle.close();
    return { file: lockFile, token };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readLockOwner(lockFile);
    const pid = owner && Number(owner.pid);
    const validPid = Number.isInteger(pid) && pid > 0;
    const stale = validPid ? !processAlive(pid) : await staleLock(lockFile);
    if (stale) {
      await fs.unlink(lockFile).catch(unlinkError => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      });
      return acquireLock();
    }
    const busy = new Error('Another coordinator command is active. Inspect ' + lockFile + ', then run "unlock" only if it is stale.');
    busy.code = 'coordinator_busy';
    throw busy;
  }
}

async function releaseLock(lock) {
  if (!lock) return;
  const owner = await readLockOwner(lock.file);
  if (!owner || owner.token !== lock.token) return;
  await fs.unlink(lock.file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function withLock(action) {
  await fs.mkdir(bridgeDir, { recursive: true });
  await ensureStore();
  const lock = await acquireLock();
  stateLockDepth += 1;
  try {
    return await action();
  } finally {
    stateLockDepth -= 1;
    await releaseLock(lock);
  }
}

async function gitSnapshot() {
  let isRepo = false;
  try {
    await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: root });
    const prefix = await execFileAsync('git', ['rev-parse', '--show-prefix'], { cwd: root });
    if (prefix.stdout.trim()) return { isRepo: false, head: null, dirty: false, status: [] };
    isRepo = true;
  } catch {
    return { isRepo: false, head: null, dirty: false, status: [] };
  }

  let head = null;
  try {
    const headResult = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
    head = headResult.stdout.trim() || null;
  } catch {
    // A repository may not have its first commit yet.
  }

  let lines = [];
  try {
    const statusResult = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: root, maxBuffer: 10 * 1024 * 1024 }
    );
    lines = statusResult.stdout.split(/\r?\n/).filter(Boolean);
  } catch {}
  return { isRepo, head, dirty: lines.length > 0, status: lines };
}

function statusPaths(line) {
  const value = String(line || '').slice(3).trim();
  if (!value) return [];
  return value.split(' -> ').map(item => {
    const trimmed = item.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      try { return JSON.parse(trimmed); } catch {}
    }
    return trimmed.replace(/\\/g, '/');
  }).filter(Boolean);
}

function repoPath(value) {
  let normalized = String(value || '').trim().replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (!normalized || normalized === '..' || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) return null;
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function requirePhase(state, expected) {
  if (state.phase !== expected) throw new Error('Expected phase ' + expected + ', found ' + state.phase + '.');
}

function assertTransition(from, to) {
  if (!phases.has(to)) throw new Error('Unknown phase: ' + to);
  if (!transitions[from] || !transitions[from].includes(to)) throw new Error('Invalid transition: ' + from + ' -> ' + to);
}

function parseFiles(args) {
  const manual = args.includes('--manual');
  const values = args.filter(value => value !== '--manual');
  const marker = values.indexOf('--files');
  if (marker < 0) return { text: values.join(' ').trim(), files: [], manual };
  return {
    text: values.slice(0, marker).join(' ').trim(),
    files: values.slice(marker + 1).join(' ').split(',').map(item => item.trim()).filter(Boolean),
    manual
  };
}

function renderPlan(state) {
  const lines = [
    '# Mind-Limb Bridge', '',
    '- Phase: ' + state.phase,
    '- Active agent: ' + state.active_agent,
    '- Task: ' + (state.task || '(none)'),
    '- Assignment: ' + (state.assignment_id || '(none)'),
    '- Revision: ' + state.revision,
    '- Approval: ' + state.approval, ''
  ];
  if (state.approach) {
    lines.push('## HANDS approach', '', state.approach.summary || '(no summary)', '');
    if (state.approach.files.length) lines.push('Files:', ...state.approach.files.map(file => '- ' + file), '');
  }
  if (state.blocked_reason) lines.push('## Blocked', '', state.blocked_reason, '');
  return lines.join('\n') + '\n';
}

async function appendEvent(event) {
  await fs.appendFile(eventsFile, JSON.stringify(event) + '\n', 'utf8');
}

async function commit(next, type, summary, extra) {
  next.event_seq += 1;
  next.last_summary = summary;
  next.updated_at = now();
  const event = {
    seq: next.event_seq,
    at: next.updated_at,
    session_id: next.session_id,
    assignment_id: next.assignment_id,
    revision: next.revision,
    type,
    phase: next.phase,
    active_agent: next.active_agent,
    summary,
    autonomy: next.autonomy,
    handoff: next.approach?.handoff || null,
    evaluation: next.evaluation,
    ...(extra || {})
  };
  const plan = renderPlan(next);
  await writeJsonAtomic(commitFile, { state: next, plan, event });
  await writeJsonAtomic(stateFile, next);
  await writeTextAtomic(planFile, plan);
  await appendEvent(event);
  await fs.unlink(commitFile).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  return next;
}

async function mutate(type, summary, updater, extra) {
  return withLock(async () => {
    const current = await readState();
    const next = JSON.parse(JSON.stringify(current));
    const update = await updater(next, current);
    return commit(next, update?.type || type, update?.summary || summary, { ...(extra || {}), ...(update?.extra || {}) });
  });
}

async function beginTask(task) {
  if (!task) throw new Error('A task description is required.');
  return mutate('assignment_created', 'MIND started: ' + task, next => {
    assertTransition(next.phase, 'planning');
    next.phase = 'planning';
    next.active_agent = 'mind';
    next.activity = { agent: 'mind', action: 'Planning task', started_at: now() };
    next.task = task;
    next.hands_session_id = null;
    next.assignment_id = makeId('assignment');
    next.revision = 0;
    next.approach = null;
    next.approval = 'none';
    next.autonomy = { mode: 'brain_autonomous', approved_by: null, approved_at: null };
    next.consultation = null;
    next.execution_lease_id = null;
    next.revision_consumed = false;
    next.execution_claimed = false;
    next.execution_started_at = null;
    next.git_before = null;
    next.git_after = null;
    next.git_status = 'unknown';
    next.blocked_reason = null;
    next.block_kind = null;
    next.recovery_required = false;
    next.mind_feedback = null;
    next.evaluation = { status: 'idle', summary: null, at: null };
    next.activity = { agent: 'mind', action: 'Planning task', started_at: now() };
    next.resume_phase = null;
  });
}


async function bindHandsSession(sessionId) {
  if (!sessionId) throw new Error('A HANDS session ID is required.');
  return mutate('hands_session_bound', 'HANDS session bound for sequential continuation', next => {
    if (!['planning', 'hands_proposing', 'brain_approving', 'hands_consulting', 'hands_executing', 'brain_reviewing'].includes(next.phase)) {
      throw new Error('Cannot bind a HANDS session during phase ' + next.phase + '.');
    }
    if (next.hands_session_id && next.hands_session_id !== sessionId) {
      throw new Error('A different HANDS session is already bound; refusing to fork the conversation.');
    }
    if (next.phase === 'hands_executing' && !next.hands_session_id) {
      throw new Error('Cannot bind a new HANDS session during execution.');
    }
    next.hands_session_id = sessionId;
  }, { provider_session_id: sessionId });
}

async function setActivity(agent, action) {
  if (!agent || !action) throw new Error('Agent and activity are required.');
  return mutate('activity_updated', agent + ': ' + action, next => {
    next.activity = { agent, action, started_at: now() };
  });
}
async function submitApproach(args) {
  const parsed = parseFiles(args);
  if (!parsed.text) throw new Error('An approach summary is required.');
  return mutate('approach_submitted', 'HANDS submitted an approach for MIND approval', next => {
    if (next.phase === 'planning') next.phase = 'hands_proposing';
    requirePhase(next, 'hands_proposing');
    assertTransition(next.phase, 'brain_approving');
    next.phase = 'brain_approving';
    next.active_agent = 'mind';
    next.activity = { agent: 'mind', action: 'Waiting for approval', started_at: now() };
    next.revision += 1;
    const roleMatch = parsed.text.match(/(?:^|\n)Role:\s*([^\n]+)/i);
    const role = roleMatch ? roleMatch[1].trim().slice(0, 120) : 'task-matched engineer';
    next.approach = { summary: parsed.text, files: parsed.files, risks: [], acceptance: [], role, revision: next.revision, ...approachMetadata(next.revision) };
    next.mind_feedback = null;
    next.autonomy = { mode: parsed.manual ? 'manual' : 'brain_autonomous', approved_by: null, approved_at: null };
    next.evaluation = { status: 'idle', summary: null, at: null };
    next.approval = 'pending';
    next.blocked_reason = null;
    next.block_kind = null;
  });
}

async function approve(summary) {
  return approveApproach(summary, 'manual');
}

async function approveApproach(summary, mode = 'manual') {
  return mutate('approach_approved', summary || 'MIND approved the HANDS approach', async next => {
    requirePhase(next, 'brain_approving');
    if (mode === 'manual' && next.autonomy?.mode === 'brain_autonomous') {
      throw new Error('Ordinary approval is disabled for autonomous Brain review; wait for Brain or provide explicit revised guidance.');
    }
    assertTransition(next.phase, 'hands_consulting');
    const git = await gitSnapshot();
    if (!git.isRepo) throw new Error('Execution requires a Git repository. Run "git init" and create a baseline commit before approval.');
    if (!git.head) throw new Error('Execution requires a baseline Git commit before approval.');
    if (!(next.approach?.files || []).length) throw new Error('The approved approach must name at least one file.');
    if (git.dirty) throw new Error('Working tree is already dirty. Commit or stash unrelated changes before approval.');
    next.phase = 'hands_consulting';
    next.active_agent = 'hands-consult';
    next.activity = { agent: 'hands-consult', action: 'Consulting Brain before execution', started_at: now() };
    next.approval = 'approved';
    next.autonomy = {
      mode: mode === 'brain' ? 'brain_approved' : 'manual',
      approved_by: mode === 'brain' ? 'brain' : 'user',
      approved_at: now()
    };
    if (next.approach) next.approach.handoff = { ...(next.approach.handoff || {}), status: 'brain_approved' };
    next.consultation = null;
    next.execution_lease_id = null;
    next.revision_consumed = false;
    next.execution_claimed = false;
    next.execution_started_at = null;
    next.git_before = git.head;
    next.git_after = null;
    next.git_status = 'clean_before_execution';
    next.block_kind = null;
  });
}

async function brainApprove(summary) {
  return approveApproach(summary || 'Brain approved the HANDS approach automatically.', 'brain');
}

async function recordEvaluation(payload) {
  let evaluation;
  try { evaluation = JSON.parse(String(payload || '')); } catch {
    throw new Error('Invalid HANDS evaluation result.');
  }
  if (!evaluation || !['passed', 'failed', 'blocked'].includes(evaluation.decision)) {
    throw new Error('HANDS evaluation decision must be passed, failed, or blocked.');
  }
  return mutate('evaluation_recorded', 'HANDS evaluation: ' + evaluation.decision, next => {
    requirePhase(next, 'brain_reviewing');
    next.evaluation = {
      status: evaluation.decision,
      summary: typeof evaluation.summary === 'string' ? evaluation.summary.trim().slice(0, 2000) : '',
      at: now(),
      tests: Array.isArray(evaluation.tests) ? evaluation.tests.slice(0, 30) : [],
      risks: Array.isArray(evaluation.risks) ? evaluation.risks.slice(0, 30) : []
    };
  });
}

async function approveConsultation(payload) {
  let consultation;
  try { consultation = JSON.parse(String(payload || '')); } catch {
    throw new Error('Invalid Brain consultation result.');
  }
  return mutate('brain_consulted', 'Brain consultation verified for the approved chunk', next => {
    requirePhase(next, 'hands_consulting');
    if (next.revision_consumed) throw new Error('This approved revision already has a consumed execution lease.');
    if (consultation.decision !== 'approved'
      || consultation.assignment_id !== next.assignment_id
      || Number(consultation.revision) !== next.revision
      || typeof consultation.summary !== 'string'
      || !consultation.summary.trim()
      || typeof consultation.brain_answer !== 'string'
      || !consultation.brain_answer.trim()) {
      throw new Error('Brain consultation did not match the active assignment and revision.');
    }
    assertTransition(next.phase, 'hands_executing');
    next.consultation = {
      decision: 'approved',
      assignment_id: consultation.assignment_id,
      revision: next.revision,
      summary: consultation.summary.trim().slice(0, 1200),
      brain_answer: typeof consultation.brain_answer === 'string' ? consultation.brain_answer.trim().slice(0, 2000) : ''
    };
    next.execution_lease_id = makeLeaseId();
    next.revision_consumed = true;
    next.execution_claimed = false;
    next.execution_started_at = null;
    next.phase = 'hands_executing';
    next.active_agent = 'hands';
    next.activity = { agent: 'hands', action: 'Executing the consulted chunk', started_at: now() };
  });
}

async function claimExecution(leaseId) {
  if (!leaseId) throw new Error('An execution lease ID is required to start the chunk.');
  return mutate('execution_claimed', 'HANDS claimed the single-use execution lease', next => {
    requirePhase(next, 'hands_executing');
    if (!next.revision_consumed || next.execution_lease_id !== leaseId) {
      throw new Error('Execution lease is missing or does not match the active chunk.');
    }
    if (next.execution_claimed) {
      const error = new Error('Execution lease was already claimed. Recover the interrupted run before retrying.');
      error.code = 'execution_claimed';
      throw error;
    }
    next.execution_claimed = true;
    next.execution_started_at = now();
    next.active_agent = 'hands';
    next.activity = { agent: 'hands', action: 'Starting the claimed execution lease', started_at: now() };
  });
}

async function revise(summary) {
  const feedback = summary || 'User requested an approach revision';
  return mutate('approach_revision_requested', feedback, next => {
    // ponytail: allow mid-flight steering from any active phase directly to hands_proposing
    if (['idle', 'done', 'cancelled'].includes(next.phase)) {
      throw new Error('Cannot steer or revise when session is ' + next.phase + '.');
    }
    assertTransition(next.phase, 'hands_proposing');
    next.phase = 'hands_proposing';
    next.active_agent = 'hands';
    next.activity = { agent: 'hands', action: 'Preparing revised proposal with user guidance', started_at: now() };
    next.mind_feedback = feedback;
    next.consultation = null;
    next.execution_lease_id = null;
    next.revision_consumed = false;
    next.execution_claimed = false;
    next.execution_started_at = null;
    next.revision += 1;
    next.approval = 'pending';
    next.blocked_reason = null;
    next.block_kind = null;
    next.resume_phase = null;
  });
}

async function continueChunk(summary) {
  const feedback = summary || 'Brain requested the next bounded chunk';
  return mutate('chunk_continuation_requested', feedback, next => {
    requirePhase(next, 'brain_reviewing');
    assertTransition(next.phase, 'planning');
    next.phase = 'planning';
    next.active_agent = 'mind';
    next.activity = { agent: 'mind', action: 'Planning the next chunk', started_at: now() };
    next.mind_feedback = feedback;
    next.consultation = null;
    next.execution_lease_id = null;
    next.revision_consumed = false;
    next.execution_claimed = false;
    next.execution_started_at = null;
    next.approval = 'none';
    next.blocked_reason = null;
    next.block_kind = null;
    next.recovery_required = false;
    next.resume_phase = null;
    next.evaluation = { status: 'idle', summary: null, at: null };
  });
}

async function complete(args) {
  const values = Array.isArray(args) ? args.slice() : [String(args || '')];
  const leaseId = values.shift();
  const summary = values.join(' ').trim() || 'HANDS completed the approved chunk';
  if (!leaseId) throw new Error('An execution lease ID is required to complete the chunk.');
  return mutate('chunk_completed', summary, async next => {
    requirePhase(next, 'hands_executing');
    if (next.execution_lease_id !== leaseId) {
      throw new Error('Execution lease does not match the active chunk.');
    }
    if (!next.revision_consumed || !next.execution_lease_id || !next.execution_claimed) {
      throw new Error('Execution lease is missing or was not claimed; start the chunk through HANDS before completing it.');
    }
    const git = await gitSnapshot();
    if (!git.isRepo) throw new Error('Execution verification requires a Git repository.');
    const changed = [...new Set(git.status.flatMap(statusPaths))];
    const headChanged = git.head !== next.git_before;
    const approved = new Set((next.approach?.files || []).map(repoPath).filter(Boolean));
    const outOfScope = changed.filter(file => !approved.has(repoPath(file)));
    next.git_after = git.head;
    if (headChanged || outOfScope.length) {
      assertTransition(next.phase, 'blocked_user');
      next.phase = 'blocked_user';
      next.active_agent = 'user';
      next.activity = { agent: 'user', action: 'Scope violation needs inspection', started_at: now() };
      next.git_status = 'scope_violation';
      next.recovery_required = true;
      next.resume_phase = 'hands_consulting';
      next.block_kind = 'execution_recovery';
      const reason = headChanged ? 'the Git HEAD changed during execution' : 'files outside the approved scope';
      next.blocked_reason = 'HANDS modified ' + reason + (outOfScope.length ? ': ' + outOfScope.slice(0, 20).join(', ') : '.');
      return {
        type: 'scope_violation',
        summary: 'HANDS modified files outside the approved scope',
        extra: { changed_files: changed.slice(0, 50), out_of_scope: outOfScope.slice(0, 50), head_changed: headChanged }
      };
    }
    assertTransition(next.phase, 'brain_reviewing');
    next.phase = 'brain_reviewing';
    next.active_agent = 'mind';
    next.activity = { agent: 'mind', action: 'Reviewing completed chunk', started_at: now() };
    next.git_status = git.dirty ? 'changes_present' : 'clean_after_execution';
  });
}

async function block(reason, kind = null) {
  if (!reason) throw new Error('A blocked reason is required.');
  if (kind !== null && !blockKinds.has(kind)) {
    throw new Error('Unsupported block kind: ' + kind + '.');
  }
  return mutate('blocked_user', 'Waiting for user: ' + reason, next => {
    if (next.phase === 'blocked_user') return;
    if (kind === 'consultation_retry' && next.phase !== 'hands_consulting') {
      throw new Error('A consultation retry block is only valid while HANDS is consulting.');
    }
    const interruptedExecution = next.phase === 'hands_executing';
    assertTransition(next.phase, 'blocked_user');
    next.resume_phase = kind === 'consultation_retry' ? 'hands_consulting' : (kind === 'escalation' ? 'planning' : next.phase);
    next.recovery_required = interruptedExecution;
    next.phase = 'blocked_user';
    next.active_agent = 'user';
    next.block_kind = interruptedExecution ? 'execution_recovery' : kind;
    next.activity = { agent: 'user', action: 'Waiting for user', started_at: now() };
    next.blocked_reason = reason;
  });
}

async function claimAgentLock(role) {
  const file = path.join(bridgeDir, 'agent.lock');
  const token = lockToken();
  try {
    const handle = await fs.open(file, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, token, role, started_at: now() }) + '\n', 'utf8');
    await handle.close();
    return { file, token };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readLockOwner(file);
    const pid = owner && Number(owner.pid);
    const validPid = Number.isInteger(pid) && pid > 0;
    const stale = validPid ? !processAlive(pid) : await staleLock(file);
    if (stale) {
      await fs.unlink(file).catch(unlinkError => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      });
      return claimAgentLock(role);
    }
    throw new Error('A HANDS provider call is still active. Wait for it to finish before recovering.');
  }
}

async function releaseAgentLock(lock) {
  if (!lock) return;
  const owner = await readLockOwner(lock.file);
  if (!owner || owner.token !== lock.token) return;
  await fs.unlink(lock.file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function recover() {
  const lock = await claimAgentLock('recovery');
  try {
    return await mutate('execution_recovered', 'Execution recovery acknowledged; waiting for user resume', next => {
      if (next.phase === 'blocked_user' && next.recovery_required) {
        next.recovery_required = false;
        next.active_agent = 'user';
        next.block_kind = null;
        next.activity = { agent: 'user', action: 'Recovery acknowledged; inspect complete', started_at: now() };
        next.blocked_reason = 'Recovery acknowledged. Run bridge resume only after confirming the working tree is safe.';
        next.resume_phase = 'hands_consulting';
        next.execution_lease_id = null;
        next.revision_consumed = false;
        next.execution_claimed = false;
        next.execution_started_at = null;
        return;
      }
      if (next.phase !== 'hands_executing') {
        throw new Error('Recovery is only valid while HANDS is executing or waiting for execution recovery; found ' + next.phase + '.');
      }
      next.phase = 'blocked_user';
      next.active_agent = 'user';
      next.activity = { agent: 'user', action: 'Recovery acknowledged; inspect complete', started_at: now() };
      next.blocked_reason = 'Execution was interrupted. Inspect the working tree, then run bridge resume.';
      next.recovery_required = false;
      next.resume_phase = 'hands_consulting';
      next.execution_lease_id = null;
      next.block_kind = null;
      next.revision_consumed = false;
      next.execution_claimed = false;
      next.execution_started_at = null;
    });
  } finally {
    await releaseAgentLock(lock);
  }
}
async function resume() {
    return mutate('resumed', 'User resumed the session', next => {
      if (!['paused', 'blocked_user'].includes(next.phase)) {
        throw new Error('Resume is only valid while the session is paused or waiting for the user; found ' + next.phase + '.');
      }
      if (next.recovery_required) throw new Error('Recovery is required. Inspect the working tree and run recover before resume.');
      const target = next.resume_phase || 'planning';
      if (next.phase === 'blocked_user' && ['needs_revision', 'escalation'].includes(next.block_kind)) {
        throw new Error('This blocker needs a revision. Use bridge revise "your answer" before resuming.');
      }
      assertTransition(next.phase, target);
      next.phase = target;
      next.active_agent = target === 'blocked_user' || target === 'paused'
        ? 'user'
        : (target.startsWith('brain_') || target === 'planning' ? 'mind' : (target === 'hands_consulting' ? 'hands-consult' : 'hands'));
      if (target !== 'blocked_user') {
        next.blocked_reason = null;
        next.block_kind = null;
      }
      next.activity = { agent: next.active_agent, action: 'Resumed', started_at: now() };
      next.resume_phase = null;
    });
  }

async function pause() {
    return mutate('paused', 'User paused the session', next => {
      if (next.phase === 'paused') return;
      if (next.phase === 'hands_executing') {
        throw new Error('Pause is unavailable while HANDS is executing. Wait for the current chunk to finish.');
      }
      assertTransition(next.phase, 'paused');
      next.resume_phase = next.phase;
      next.phase = 'paused';
      next.active_agent = 'user';
      next.activity = { agent: 'user', action: 'Paused by user', started_at: now() };
    });
  }

async function finish(summary) {
  return mutate('session_done', summary || 'MIND marked the session complete', next => {
    requirePhase(next, 'brain_reviewing');
    assertTransition(next.phase, 'done');
    next.phase = 'done';
    next.active_agent = 'none';
    next.activity = { agent: 'none', action: 'Complete', started_at: now() };
    next.approval = 'complete';
  });
}

async function cancel(summary) {
    return mutate('session_cancelled', summary || 'User cancelled the session', next => {
      if (next.phase === 'done' || next.phase === 'cancelled') {
        throw new Error('Stop is unavailable while the session is ' + next.phase + '.');
      }
      if (next.phase === 'hands_executing') {
        throw new Error('Stop is unavailable while HANDS is executing. Wait for the current chunk to finish.');
      }
      assertTransition(next.phase, 'cancelled');
      next.phase = 'cancelled';
      next.active_agent = 'none';
      next.activity = { agent: 'none', action: 'Stopped', started_at: now() };
    });
  }

function printStatus(state) {
  console.log([
    'Phase: ' + state.phase,
    'Active: ' + state.active_agent,
    'Task: ' + (state.task || '(none)'),
    'Assignment: ' + (state.assignment_id || '(none)'),
    'Revision: ' + state.revision,
    'Approval: ' + state.approval,
    'Git: ' + state.git_status,
    'Last: ' + state.last_summary,
    'Updated: ' + state.updated_at
  ].join('\n'));
}

async function printLog(limit) {
  await ensureStore();
  const text = await fs.readFile(eventsFile, 'utf8');
  const lines = text.trim().split(/\r?\n/).filter(Boolean).slice(-(limit || 10));
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      console.log('[' + event.at + '] ' + event.type + ' | ' + event.phase + ' | ' + event.summary);
    } catch {
      // A reader can observe an incomplete final JSONL line during append.
    }
  }
}

async function unlock() {
  const owner = await readLockOwner(lockFile);
  if (!owner) {
    console.log('No coordinator lock found.');
    return;
  }
  const pid = owner && Number(owner.pid);
  if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) {
    throw new Error('Coordinator lock belongs to live process ' + pid + '; refusing to remove it.');
  }
  if (!(await staleLock(lockFile))) {
    throw new Error('Coordinator lock is not stale yet; refusing to remove it.');
  }
  await fs.unlink(lockFile).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  console.log('Stale coordinator lock removed.');
}

function help() {
  console.log([
    'Mind-Limb Bridge coordinator', '',
    'Commands:',
    '  init                         Create .bridge files',
    '  start <task>                 Start a task with MIND',
    '  approach <summary> [--files a,b]',
    '                               Submit HANDS approach for approval',
    '  bind-session <id>           Store HANDS provider session for continuation',
    '  activity <agent> <action>   Internal live activity update',
    '  claim-execution <lease-id>  Claim the single-use execution lease',
    '  approve [summary]            Legacy manual approval',
    '  brain-approve [summary]      Internal automatic Brain approval',
    '  evaluate <json>              Record read-only HANDS evaluation',
    '  revise [summary]             Request a revised approach',
    '  complete [lease-id] <summary> Report HANDS chunk complete',
    '  block <reason>               Stop and wait for the user',
    '  recover                      Recover an interrupted HANDS execution',
    '  resume                       Resume a blocked or paused session',
    '  pause                        Pause the session',
    '  done [summary]               Mark the reviewed session complete',
    '  cancel [summary]             Cancel the session',
    '  status                       Show current state',
    '  log [count]                  Show recent audit entries',
    '  unlock                       Remove a stale coordinator lock'
  ].join('\n'));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift() || 'help';
  if (command === 'help') return help();
  if (command === 'unlock') return unlock();
  let result;
  switch (command) {
    case 'init': result = await readState(); console.log('Initialized ' + bridgeDir); break;
    case 'start': result = await beginTask(args.join(' ')); break;
    case 'approach': result = await submitApproach(args); break;
    case 'bind-session': result = await bindHandsSession(args[0]); break;
    case 'activity': result = await setActivity(args.shift(), args.join(' ')); break;
    case 'claim-execution': result = await claimExecution(args[0]); break;
    case 'approve': result = await approve(args.join(' ')); break;
    case 'brain-approve':
    case 'approve-auto': result = await brainApprove(args.join(' ')); break;
    case 'evaluate':
    case 'evaluation': result = await recordEvaluation(args.join(' ')); break;
    case 'consult': result = await approveConsultation(args.join(' ')); break;
    case 'revise': result = await revise(args.join(' ')); break;
    case 'continue': result = await continueChunk(args.join(' ')); break;
    case 'complete': result = await complete(args); break;
    case 'block': {
      const marker = args.indexOf('--kind');
      const kind = marker >= 0 ? args[marker + 1] : null;
      if (marker >= 0) {
        if (!kind) throw new Error('--kind requires a value.');
        args.splice(marker, 2);
      }
      result = await block(args.join(' '), kind);
      break;
    }
    case 'recover': result = await recover(); break;
    case 'resume': result = await resume(); break;
    case 'pause': result = await pause(); break;
    case 'done': result = await finish(args.join(' ')); break;
    case 'cancel': result = await cancel(args.join(' ')); break;
    case 'status': return printStatus(await readState());
    case 'log': return printLog(Number(args[0]) || 10);
    default: throw new Error('Unknown command: ' + command);
  }
  if (result) printStatus(result);
}

process.on('uncaughtException', (err) => {
  console.error('FATAL: ' + err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : '';
  console.error('FATAL: ' + msg);
  if (stack) console.error(stack);
  process.exit(1);
});
main().catch(error => {
  console.error('Error: ' + error.message);
  process.exitCode = 1;
});
