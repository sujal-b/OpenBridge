'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const { waitForRunnerReady } = require('../bridge');

function stateLine(updatedAt) {
  return JSON.stringify({ updated_at: updatedAt }) + '\n';
}

// `node -e` stand-ins for a booting bridge-runner: the poll only cares about
// process liveness and state.json's updated_at, so the child needs neither
// config nor transports.
function spawnChild(code, cwd) {
  return spawn(process.execPath, ['-e', code], { cwd, stdio: 'ignore' });
}

// The exit event does not replay: a child that exits on its own while we are
// still polling must not leave `once(child, 'exit')` waiting forever.
async function reap(child) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await once(child, 'exit');
  }
}

async function withBridgeDir(fn) {
  const base = path.join(process.cwd(), '.tmp-test-workspaces');
  await fs.mkdir(base, { recursive: true });
  const cwd = await fs.mkdtemp(path.join(base, 'stage3-ready-'));
  const bridgeDir = path.join(cwd, '.bridge');
  await fs.mkdir(bridgeDir, { recursive: true });
  try {
    return await fn(cwd, bridgeDir);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

test('readiness poll returns as soon as the runner marks state (no fixed sleep)', async () => {
  await withBridgeDir(async (_cwd, bridgeDir) => {
    const stateFile = path.join(bridgeDir, 'state.json');
    const child = spawnChild(
      `require('node:fs').writeFileSync(${JSON.stringify(stateFile)}, ${JSON.stringify(stateLine('t1'))})`,
      bridgeDir
    );
    try {
      const started = Date.now();
      await waitForRunnerReady(bridgeDir, child.pid, { previousUpdated: null });
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 400, 'poll returned after ' + elapsed + 'ms — matches the old fixed sleep');
    } finally {
      await reap(child);
    }
  });
});

test('readiness poll waits for a changed updated_at, not just any content', async () => {
  await withBridgeDir(async (_cwd, bridgeDir) => {
    const stateFile = path.join(bridgeDir, 'state.json');
    await fs.writeFile(stateFile, stateLine('t0'), 'utf8');
    // Child rewrites the same updated_at at 150ms and STAYS ALIVE: an early
    // return would mean the poll fires on any readable file instead of a new
    // state mark, and the only remaining exit is the cap.
    const child = spawnChild(
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(stateFile)}, ${JSON.stringify(stateLine('t0'))}), 150); setTimeout(() => {}, 10000)`,
      bridgeDir
    );
    try {
      const started = Date.now();
      await waitForRunnerReady(bridgeDir, child.pid, { previousUpdated: 't0', capMs: 400 });
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 350, 'poll returned early after ' + elapsed + 'ms on an unchanged updated_at from a live runner');
      assert.ok(elapsed < 1200, 'poll waited ' + elapsed + 'ms — cap not honored');
    } finally {
      await reap(child);
    }
  });
});

test('readiness poll returns on a changed updated_at even with a baseline present', async () => {
  await withBridgeDir(async (_cwd, bridgeDir) => {
    const stateFile = path.join(bridgeDir, 'state.json');
    await fs.writeFile(stateFile, stateLine('t0'), 'utf8');
    const child = spawnChild(
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(stateFile)}, ${JSON.stringify(stateLine('t1'))}), 100)`,
      bridgeDir
    );
    try {
      const started = Date.now();
      await waitForRunnerReady(bridgeDir, child.pid, { previousUpdated: 't0' });
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 400, 'poll took ' + elapsed + 'ms after the runner marked state');
      assert.ok(elapsed >= 80, 'poll returned before the child wrote (' + elapsed + 'ms)');
    } finally {
      await reap(child);
    }
  });
});

test('readiness poll honors its cap when the runner never marks state', async () => {
  await withBridgeDir(async (_cwd, bridgeDir) => {
    // A child that stays alive and never touches state.json.
    const child = spawnChild('setTimeout(() => {}, 10000)', bridgeDir);
    try {
      const started = Date.now();
      await waitForRunnerReady(bridgeDir, child.pid, { capMs: 200 });
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 150, 'poll gave up early after ' + elapsed + 'ms');
      assert.ok(elapsed < 1200, 'poll waited ' + elapsed + 'ms — cap not honored (default is 5000ms)');
    } finally {
      await reap(child);
    }
  });
});

test('MIND_LIMB_RUNNER_READY_MS overrides the default cap', async () => {
  await withBridgeDir(async (_cwd, bridgeDir) => {
    const child = spawnChild('setTimeout(() => {}, 10000)', bridgeDir);
    const previous = process.env.MIND_LIMB_RUNNER_READY_MS;
    process.env.MIND_LIMB_RUNNER_READY_MS = '200';
    try {
      const started = Date.now();
      await waitForRunnerReady(bridgeDir, child.pid);
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 150, 'poll gave up early after ' + elapsed + 'ms');
      assert.ok(elapsed < 1200, 'poll waited ' + elapsed + 'ms — env cap not honored');
    } finally {
      if (previous === undefined) delete process.env.MIND_LIMB_RUNNER_READY_MS;
      else process.env.MIND_LIMB_RUNNER_READY_MS = previous;
      await reap(child);
    }
  });
});

test('readiness poll returns promptly when the runner dies before marking state', async () => {
  await withBridgeDir(async (_cwd, bridgeDir) => {
    const child = spawnChild('process.exit(0)', bridgeDir);
    await once(child, 'exit');
    const started = Date.now();
    // Default 5 s cap: a broken liveness check would hang the full cap here.
    await waitForRunnerReady(bridgeDir, child.pid);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, 'poll waited ' + elapsed + 'ms for an already-dead runner');
  });
});
