'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { invokeAgent, drainTelemetry } = require('../bridge-runner');
const adapter = require('../bridge-adapter');

const coordinator = path.resolve(__dirname, '..', 'bridge-coordinator.js');

async function withWorkspace(fn) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-stage1-'));
  await fs.mkdir(path.join(cwd, '.bridge'), { recursive: true });
  await fs.writeFile(
    path.join(cwd, '.bridge', 'state.json'),
    JSON.stringify({ phase: 'hands_executing', task: 't', session_id: 's1', assignment_id: 'a1', revision: 1, hands_session_id: 'hs1' }) + '\n',
    'utf8'
  );
  try {
    return await fn(cwd);
  } finally {
    // Telemetry writes are fire-and-forget; let them settle before cleanup.
    await drainTelemetry().catch(() => {});
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

function actionContext(agent = 'hands') {
  return {
    session_id: 's1',
    assignment_id: 'a1',
    chunk: 1,
    revision: 1,
    provider_session_id: 'hs1',
    agent,
    kind: 'action',
    phase: 'hands_executing',
    target: 'hands-execution',
    risk: 'low',
    approval: 'granted',
    policy: null
  };
}

// H1 — the single largest overhead bug in the bridge. The provider stream emits
// one event per tool call, and execution produces dozens to hundreds of them.
// Each one used to spawn a coordinator subprocess (two Node processes) purely to
// write the dashboard activity line.
test('H1: provider events no longer spawn one coordinator call per event', async () => {
  await withWorkspace(async cwd => {
    const eventCount = 60;
    const coordinatorCalls = [];

    const mockedProcess = async (command, args, options) => {
      if (command === process.execPath && args[0] === coordinator) {
        coordinatorCalls.push(String(args[1]));
        return { ok: true, code: 0, signal: null, stdout: '', stderr: '', timed_out: false };
      }
      for (let i = 0; i < eventCount; i += 1) {
        await options.onEvent(
          { type: 'tool.completed', tool: 'read', target: 'src/file' + (i % 7) + '.js' },
          JSON.stringify({ type: 'tool.completed', tool: 'read' }),
          'stdout'
        );
      }
      return {
        ok: true,
        code: 0,
        signal: null,
        stdout: JSON.stringify({ decision: 'completed', summary: 'done' }) + '\n',
        stderr: '',
        timed_out: false
      };
    };

    await invokeAgent('hands', 'prompt', {
      cwd,
      runProcess: mockedProcess,
      actionContext: actionContext('hands')
    });

    const activityCalls = coordinatorCalls.filter(name => name === 'activity');
    assert.ok(activityCalls.length > 0, 'the final activity must still be written');
    // Coalescing must collapse 60 events down to a handful of writes, not 60.
    assert.ok(
      activityCalls.length <= 5,
      `expected <=5 activity coordinator calls for ${eventCount} events, got ${activityCalls.length}`
    );
    assert.ok(
      activityCalls.length < eventCount / 4,
      `activity calls should be far below the event count (${eventCount}), got ${activityCalls.length}`
    );
  });
});

test('H1: the last observed activity is still flushed after the provider finishes', async () => {
  await withWorkspace(async cwd => {
    const coordinatorCalls = [];
    const mockedProcess = async (command, args, options) => {
      if (command === process.execPath && args[0] === coordinator) {
        coordinatorCalls.push(String(args[1]));
        return { ok: true, code: 0, signal: null, stdout: '', stderr: '', timed_out: false };
      }
      await options.onEvent(
        { type: 'tool.completed', tool: 'edit', target: 'src/final.js' },
        JSON.stringify({ type: 'tool.completed', tool: 'edit' }),
        'stdout'
      );
      return {
        ok: true,
        code: 0,
        signal: null,
        stdout: JSON.stringify({ decision: 'completed', summary: 'done' }) + '\n',
        stderr: '',
        timed_out: false
      };
    };
    await invokeAgent('hands', 'prompt', {
      cwd,
      runProcess: mockedProcess,
      actionContext: actionContext('hands')
    });
    assert.ok(coordinatorCalls.includes('activity'), 'the pending activity must be flushed on completion');
  });
});

test('H1: activity is flushed even when the provider call fails', async () => {
  await withWorkspace(async cwd => {
    const coordinatorCalls = [];
    const mockedProcess = async (command, args, options) => {
      if (command === process.execPath && args[0] === coordinator) {
        coordinatorCalls.push(String(args[1]));
        return { ok: true, code: 0, signal: null, stdout: '', stderr: '', timed_out: false };
      }
      await options.onEvent(
        { type: 'tool.completed', tool: 'bash', command: 'npm test' },
        JSON.stringify({ type: 'tool.completed', tool: 'bash' }),
        'stdout'
      );
      return { ok: false, code: 1, signal: null, stdout: '', stderr: 'provider exploded', timed_out: false };
    };
    await assert.rejects(
      invokeAgent('hands', 'prompt', { cwd, runProcess: mockedProcess, actionContext: actionContext('hands') }),
      /hands failed/
    );
    assert.ok(coordinatorCalls.includes('activity'), 'the failure activity must still reach the dashboard');
  });
});

// H7 — resolveExecutable swept every PATH entry with existsSync, then read every
// .cmd in every PATH entry, synchronously, on every spawn.
test('H7: resolveExecutable caches PATH scans instead of repeating them per spawn', () => {
  const realExistsSync = fsSync.existsSync;
  let existsSyncCalls = 0;
  fsSync.existsSync = function counted(...args) {
    existsSyncCalls += 1;
    return realExistsSync.apply(this, args);
  };
  try {
    adapter.clearExecutableCache();
    adapter.resolveExecutable('opencode');
    const afterFirst = existsSyncCalls;
    adapter.resolveExecutable('opencode');
    adapter.resolveExecutable('opencode');
    assert.equal(
      existsSyncCalls,
      afterFirst,
      'repeat lookups must hit the cache and perform no further filesystem scans'
    );
  } finally {
    fsSync.existsSync = realExistsSync;
    adapter.clearExecutableCache();
  }
});

test('H7: the cache key tracks PATH so an env change is not served stale', () => {
  const realExistsSync = fsSync.existsSync;
  let existsSyncCalls = 0;
  fsSync.existsSync = function counted(...args) {
    existsSyncCalls += 1;
    return realExistsSync.apply(this, args);
  };
  const previousPath = process.env.PATH;
  try {
    adapter.clearExecutableCache();
    adapter.resolveExecutable('opencode');
    process.env.PATH = (previousPath || '') + ';C:\\nonexistent-bridge-probe';
    const before = existsSyncCalls;
    adapter.resolveExecutable('opencode');
    assert.ok(existsSyncCalls > before, 'a changed PATH must invalidate the cache entry');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fsSync.existsSync = realExistsSync;
    adapter.clearExecutableCache();
  }
});
