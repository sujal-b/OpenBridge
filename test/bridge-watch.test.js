const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readJsonLines, readState, setRepairRunner, controlsFor, controlAllowed, runnerIsAlive } = require('../bridge');

test('bridge watch reads only a bounded tail of long JSONL logs', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-watch-'));
  try {
    await fs.mkdir(path.join(cwd, '.bridge'));
    const lines = Array.from({ length: 1000 }, (_, seq) => JSON.stringify({ seq, summary: 'x'.repeat(80) })).join('\n') + '\n';
    await fs.writeFile(path.join(cwd, '.bridge', 'events.jsonl'), lines);
    const values = await readJsonLines(cwd, 'events.jsonl', 5, 1024);
    assert.ok(values.length > 0);
    assert.ok(values.length <= 5);
    assert.equal(values.at(-1).seq, 999);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('bridge watch returns an empty list for a missing log', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-watch-missing-'));
  try {
    await fs.mkdir(path.join(cwd, '.bridge'));
    assert.deepEqual(await readJsonLines(cwd, 'missing.jsonl'), []);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('readState repairs corrupt state once under concurrent callers, then cools down', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-repair-'));
  try {
    await fs.mkdir(path.join(cwd, '.bridge'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.bridge', 'state.json'), '{not valid json', 'utf8');

    const stateFile = path.join(cwd, '.bridge', 'state.json');
    let invocations = 0;

    // Phase A — single-flight. The repair SUCCEEDS and is gated open. Success is
    // load-bearing: a *failing* repair arms the cooldown, which would stop the
    // second caller before it ever reaches the single-flight guard, so the test
    // would pass with the guard deleted.
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    setRepairRunner(async () => {
      invocations += 1;
      await gate;
      await fs.writeFile(stateFile, JSON.stringify({ phase: 'idle' }), 'utf8');
      return { ok: true, stdout: '', stderr: '' };
    });

    const first = readState(cwd);
    await new Promise(resolve => setImmediate(resolve)); // first: read done, repair now in flight
    const second = readState(cwd);
    await new Promise(resolve => setImmediate(resolve)); // second: read done, must find repairInFlight
    release();
    const [firstState, secondState] = await Promise.all([first, second]);

    assert.equal(invocations, 1, 'concurrent callers share one repair instead of spawning per caller');
    assert.deepEqual(firstState, { phase: 'idle' });
    assert.deepEqual(secondState, { phase: 'idle' });

    // Phase B — cooldown. A failing repair arms it; the next caller must get a
    // distinct error rather than spawning again.
    await fs.writeFile(stateFile, '{corrupt again', 'utf8');
    setRepairRunner(async () => {
      invocations += 1;
      return { ok: false, stdout: '', stderr: 'coordinator unavailable' };
    });
    await assert.rejects(
      () => readState(cwd),
      error => error.message === 'coordinator unavailable'
    );
    await assert.rejects(
      () => readState(cwd),
      error => error.code === 'STATE_REPAIR_COOLDOWN',
      'a caller arriving during cooldown gets the cooldown error, not a raw SyntaxError'
    );
    assert.equal(invocations, 2, 'cooldown suppresses further repairs');
  } finally {
    setRepairRunner(null);
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('bridge watch uses the shared control policy', () => {
  const blocked = { phase: 'blocked_user', block_kind: 'needs_revision', recovery_required: false, resume_phase: 'hands_proposing' };
  assert.match(controlsFor(blocked), /bridge revise/);
  assert.doesNotMatch(controlsFor(blocked), /\[r\] resume/);
  assert.equal(controlAllowed('resume', blocked), false);
  const consultationRetry = { phase: 'blocked_user', block_kind: 'consultation_retry', recovery_required: false, resume_phase: 'hands_consulting' };
  assert.match(controlsFor(consultationRetry), /bridge resume/);
  assert.doesNotMatch(controlsFor(consultationRetry), /bridge revise/);
  assert.equal(controlAllowed('resume', consultationRetry), true);
  assert.equal(controlAllowed('stop', { phase: 'hands_consulting' }), true);
});

test('runner liveness treats a fresh pid file as alive even for a long-lived pid', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-pid-fresh-'));
  try {
    await fs.mkdir(path.join(cwd, '.bridge'));
    await fs.writeFile(path.join(cwd, '.bridge', 'runner.pid'), JSON.stringify({ pid: process.pid, started_at: Date.now(), token: 'deadbeef' }) + '\n');
    await fs.writeFile(path.join(cwd, '.bridge', 'state.json'), JSON.stringify({ phase: 'hands_executing' }));
    assert.equal(await runnerIsAlive(cwd), true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runner liveness detects a recycled pid when pid and state files are both idle', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-pid-stale-'));
  try {
    await fs.mkdir(path.join(cwd, '.bridge'));
    const pidFile = path.join(cwd, '.bridge', 'runner.pid');
    const stateFile = path.join(cwd, '.bridge', 'state.json');
    await fs.writeFile(pidFile, JSON.stringify({ pid: process.pid, started_at: Date.now(), token: 'deadbeef' }) + '\n');
    await fs.writeFile(stateFile, JSON.stringify({ phase: 'hands_executing' }));
    const old = new Date(Date.now() - 7200000);
    await fs.utimes(pidFile, old, old);
    assert.equal(await runnerIsAlive(cwd), true);
    await fs.utimes(stateFile, old, old);
    assert.equal(await runnerIsAlive(cwd), false);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runner liveness reports a dead pid as stopped', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-pid-dead-'));
  try {
    await fs.mkdir(path.join(cwd, '.bridge'));
    const exited = spawnSync(process.execPath, ['-e', '']);
    await fs.writeFile(path.join(cwd, '.bridge', 'runner.pid'), JSON.stringify({ pid: exited.pid, started_at: Date.now(), token: 'deadbeef' }) + '\n');
    await fs.writeFile(path.join(cwd, '.bridge', 'state.json'), JSON.stringify({ phase: 'hands_executing' }));
    assert.equal(await runnerIsAlive(cwd), false);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runner liveness reads legacy bare-pid files', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-pid-legacy-'));
  try {
    await fs.mkdir(path.join(cwd, '.bridge'));
    await fs.writeFile(path.join(cwd, '.bridge', 'runner.pid'), process.pid + '\n');
    await fs.writeFile(path.join(cwd, '.bridge', 'state.json'), JSON.stringify({ phase: 'hands_executing' }));
    assert.equal(await runnerIsAlive(cwd), true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});