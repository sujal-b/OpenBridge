'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const coordinator = path.resolve(__dirname, '..', 'bridge-coordinator.js');
const coordinatorLib = require('../bridge-coordinator');
const { runProcess } = require('../bridge-adapter');
const { start: startRunner, approve } = require('../bridge-runner');

// Manual-path wrapper matching the legacy contract tests.
const start = (task, options = {}) => startRunner(task, { ...options, autonomous: false, manual: true });

async function createGitWorkspace(prefix) {
  const base = path.join(process.cwd(), '.tmp-test-workspaces');
  await fs.mkdir(base, { recursive: true });
  const cwd = await fs.mkdtemp(path.join(base, prefix || 'stage2-'));
  await fs.writeFile(path.join(cwd, '.gitignore'), '.bridge/\n', 'utf8');
  await fs.writeFile(path.join(cwd, 'README.md'), '# Test project\n', 'utf8');
  const git = args => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, 'git ' + args.join(' ') + ' failed: ' + result.stderr);
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'runner@example.invalid']);
  git(['config', 'user.name', 'Mind-Limb Runner']);
  git(['add', '.']);
  git(['commit', '-qm', 'baseline']);
  return cwd;
}

function runSubprocess(cwd, args, expected = 0) {
  const result = spawnSync(process.execPath, [coordinator, ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, expected, 'Unexpected exit for ' + args.join(' ') + '\n' + result.stdout + result.stderr);
  return result;
}

// Volatile ids/timestamps differ between two fresh workspaces by construction;
// everything else must match byte-for-byte after projection.
function normalizeState(state) {
  const copy = { ...state };
  copy.session_id = '<session>';
  copy.assignment_id = copy.assignment_id ? '<assignment>' : null;
  copy.updated_at = '<ts>';
  if (copy.activity) copy.activity = { ...copy.activity, started_at: '<ts>' };
  if (copy.execution_lease_id) copy.execution_lease_id = '<lease>';
  return copy;
}

function normalizeEvents(text) {
  return text.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const event = JSON.parse(line);
    return { seq: event.seq, type: event.type, phase: event.phase, active_agent: event.active_agent, revision: event.revision, summary: event.summary };
  });
}

async function readStateFile(cwd) {
  return JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'state.json'), 'utf8'));
}

function brainTransportMock(calls, options = {}) {
  return async (command, args, runOptions) => {
    calls.push({ command, args });
    if (command === process.execPath && args[0] === coordinator) {
      if (options.subprocess) return runProcess(command, args, runOptions);
      // In-process mode must never route coordinator work through a process
      // spawn; falling through would misread the call as an agent request, so
      // fail loudly instead.
      throw new Error('Unexpected coordinator subprocess spawn: ' + args.slice(0, 2).join(' '));
    }
    if (args[2] === 'brain') {
      return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ approved: true, guidance: 'Proceed with the approved chunk as specified.' }), stderr: '', timed_out: false };
    }
    const output = args[2] === 'hands-propose'
      ? { decision: 'propose', summary: 'Validate before saving', files: ['src/save.js'], tests: ['node --test'], sessionID: 'stage2-session' }
      : { decision: 'completed', summary: 'Validation added', files: ['src/save.js'], tests: ['node --test'], sessionID: 'stage2-session' };
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify(output), stderr: '', timed_out: false };
  };
}

test('in-process handleCommand produces state and events identical to subprocess mode', async () => {
  const subprocessDir = await createGitWorkspace('stage2-sub-');
  const inprocessDir = await createGitWorkspace('stage2-inproc-');
  const sequence = [
    ['start', 'Ship the login page'],
    ['block', 'Need user input on scope'],
    ['resume'],
    ['pause'],
    ['cancel', 'Scrapped']
  ];
  try {
    for (const args of sequence) runSubprocess(subprocessDir, args);
    for (const args of sequence) await coordinatorLib.handleCommand([...args], { cwd: inprocessDir });

    const subState = normalizeState(await readStateFile(subprocessDir));
    const inState = normalizeState(await readStateFile(inprocessDir));
    assert.deepEqual(inState, subState);

    const subEvents = normalizeEvents(await fs.readFile(path.join(subprocessDir, '.bridge', 'events.jsonl'), 'utf8'));
    const inEvents = normalizeEvents(await fs.readFile(path.join(inprocessDir, '.bridge', 'events.jsonl'), 'utf8'));
    assert.deepEqual(inEvents, subEvents);
  } finally {
    await fs.rm(subprocessDir, { recursive: true, force: true });
    await fs.rm(inprocessDir, { recursive: true, force: true });
  }
});

test('runner coordinator commands execute in-process without spawning the coordinator', async () => {
  const cwd = await createGitWorkspace('stage2-nospawn-');
  await fs.mkdir(path.join(cwd, '.bridge'), { recursive: true });
  // Legacy brain.json resolves to the zen provider (viaOpencode), so the mocked
  // runProcess doubles as the Brain transport: args[2] === 'brain'.
  await fs.writeFile(path.join(cwd, '.bridge', 'brain.json'), JSON.stringify({ provider: 'zen' }), 'utf8');
  const calls = [];
  const mockedProcess = brainTransportMock(calls);
  try {
    await start('Add save validation', { cwd, runProcess: mockedProcess });
    const executed = await approve('Approved by MIND', { cwd, runProcess: mockedProcess });
    assert.equal(executed.state.phase, 'brain_reviewing');
    const coordinatorSpawns = calls.filter(call => call.command === process.execPath && call.args[0] === coordinator);
    assert.deepEqual(coordinatorSpawns, [], 'coordinator must not be spawned in in-process mode');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('MIND_LIMB_COORD_INPROCESS=0 restores coordinator subprocess mode', async () => {
  process.env.MIND_LIMB_COORD_INPROCESS = '0';
  const cwd = await createGitWorkspace('stage2-subproc-flag-');
  await fs.mkdir(path.join(cwd, '.bridge'), { recursive: true });
  await fs.writeFile(path.join(cwd, '.bridge', 'brain.json'), JSON.stringify({ provider: 'zen' }), 'utf8');
  const calls = [];
  const mockedProcess = brainTransportMock(calls, { subprocess: true });
  try {
    await start('Add save validation', { cwd, runProcess: mockedProcess });
    const executed = await approve('Approved by MIND', { cwd, runProcess: mockedProcess });
    assert.equal(executed.state.phase, 'brain_reviewing');
    const coordinatorSpawns = calls.filter(call => call.command === process.execPath && call.args[0] === coordinator);
    assert.ok(coordinatorSpawns.length > 0, 'escape hatch must spawn coordinator subprocesses');
  } finally {
    delete process.env.MIND_LIMB_COORD_INPROCESS;
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('handleCommand returns text for reads, state for mutations, rejects bad commands', async () => {
  const cwd = await createGitWorkspace('stage2-shapes-');
  try {
    const status = await coordinatorLib.handleCommand(['status'], { cwd });
    assert.match(status.text, /Phase: idle/);

    const started = await coordinatorLib.handleCommand(['start', 'Shape check'], { cwd });
    assert.equal(started.state.phase, 'planning');

    await assert.rejects(
      () => coordinatorLib.handleCommand(['nonsense'], { cwd }),
      /Unknown command: nonsense/
    );
    await assert.rejects(
      () => coordinatorLib.handleCommand(['start', 'Too far'], { cwd }),
      /transition/i
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('concurrent in-process commands serialize instead of racing the state lock', async () => {
  const cwd = await createGitWorkspace('stage2-conc-');
  try {
    // Without the command queue, pause would evaluate against the idle phase
    // and be rejected as an invalid transition before start lands.
    const [started, paused] = await Promise.all([
      coordinatorLib.handleCommand(['start', 'Concurrent task'], { cwd }),
      coordinatorLib.handleCommand(['pause'], { cwd })
    ]);
    assert.equal(started.state.phase, 'planning');
    assert.equal(paused.state.phase, 'paused');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('in-process commands respect a live state.lock from an external caller', async () => {
  const cwd = await createGitWorkspace('stage2-lock-');
  try {
    await coordinatorLib.handleCommand(['start', 'Lock arbitration'], { cwd });
    // Simulate an external subprocess holding the lock: live pid, fresh stamp.
    await fs.writeFile(
      path.join(cwd, '.bridge', 'state.lock'),
      JSON.stringify({ pid: process.pid, token: 'external', at: new Date().toISOString() }) + '\n',
      'utf8'
    );
    await assert.rejects(
      () => coordinatorLib.handleCommand(['pause'], { cwd }),
      error => error.code === 'coordinator_busy'
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('mixed transports keep event seq contiguous on a shared workspace', async () => {
  const cwd = await createGitWorkspace('stage2-mixed-');
  try {
    runSubprocess(cwd, ['start', 'Mixed transport task']);
    await coordinatorLib.handleCommand(['block', 'Hold for details'], { cwd });
    runSubprocess(cwd, ['resume']);
    await coordinatorLib.handleCommand(['pause'], { cwd });

    const state = await readStateFile(cwd);
    assert.equal(state.phase, 'paused');

    const text = await fs.readFile(path.join(cwd, '.bridge', 'events.jsonl'), 'utf8');
    const events = text.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    events.forEach((event, index) => assert.equal(event.seq, index, 'event seq gap at index ' + index));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
