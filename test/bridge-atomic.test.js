const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { renameWithRetry } = require('../bridge-atomic');
const { appendAction } = require('../bridge-actions');

const error = code => Object.assign(new Error(code), { code });

test('rename retries transient Windows replacement errors with bounded backoff', async () => {
  let calls = 0;
  const waits = [];
  await renameWithRetry('source', 'destination', {
    rename: async () => {
      calls += 1;
      if (calls < 3) throw error('EPERM');
    },
    wait: async ms => { waits.push(ms); }
  });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [5, 10]);
});

test('rename does not retry unrelated errors and eventually gives up', async () => {
  let calls = 0;
  await assert.rejects(
    renameWithRetry('source', 'destination', {
      rename: async () => { calls += 1; throw error('ENOENT'); },
      wait: async () => { throw new Error('should not wait'); }
    }),
    { code: 'ENOENT' }
  );
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(
    renameWithRetry('source', 'destination', {
      rename: async () => { calls += 1; throw error('EBUSY'); },
      wait: async () => {}
    }),
    { code: 'EBUSY' }
  );
  assert.equal(calls, 8);
});

test('action sequencing uses retrying replacement', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-atomic-'));
  const originalRename = fs.rename;
  let calls = 0;
  fs.rename = async (...args) => {
    calls += 1;
    if (calls === 1) throw error('EPERM');
    return originalRename(...args);
  };
  try {
    const record = await appendAction({ summary: 'retry sequence replacement' }, { cwd });
    assert.equal(record.seq, 0);
    assert.equal(calls, 2);
  } finally {
    fs.rename = originalRename;
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

const coordinator = path.resolve(__dirname, '..', 'bridge-coordinator.js');

function runCoordinator(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [coordinator, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('coordinator state writes survive a transient reader lock', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-coordinator-atomic-'));
  const stateFile = path.join(cwd, '.bridge', 'state.json');
  let handle;
  try {
    assert.equal((await runCoordinator(cwd, ['init'])).code, 0);
    handle = await fs.open(stateFile, 'r');
    const release = setTimeout(() => handle.close().catch(() => {}), 200);
    try {
      const result = await runCoordinator(cwd, ['start', 'retry state replacement']);
      assert.equal(result.code, 0, result.stderr);
    } finally {
      clearTimeout(release);
      await handle.close().catch(() => {});
    }
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.equal(state.task, 'retry state replacement');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});