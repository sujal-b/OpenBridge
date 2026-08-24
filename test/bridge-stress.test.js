const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const coordinator = path.resolve(__dirname, '..', 'bridge-coordinator.js');

async function workspace() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-preprod-'));
  await fs.writeFile(path.join(cwd, '.gitignore'), '.bridge/\n', 'utf8');
  await fs.writeFile(path.join(cwd, 'app.txt'), 'baseline\n', 'utf8');
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'preprod@example.invalid']);
  git(cwd, ['config', 'user.name', 'Mind-Limb Preprod']);
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-qm', 'baseline']);
  return cwd;
}

function run(cwd, args, expected = 0) {
  const result = spawnSync(process.execPath, [coordinator, ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, expected, `Unexpected exit for ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function runAsync(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [coordinator, ...args], { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function readState(cwd) {
  return JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'state.json'), 'utf8'));
}

async function advanceConsultation(cwd) {
  const state = await readState(cwd);
  run(cwd, ['consult', JSON.stringify({
    decision: 'approved',
    assignment_id: state.assignment_id,
    revision: state.revision,
    summary: 'Brain confirmed the approved chunk.',
    brain_answer: 'Proceed with the approved files and focused validation.'
  })]);
  return readState(cwd);
}
async function completeChunk(cwd, summary) {
  const state = await readState(cwd);
  run(cwd, ['claim-execution', state.execution_lease_id]);
  run(cwd, ['complete', state.execution_lease_id, summary]);
}

async function readEvents(cwd) {
  const text = await fs.readFile(path.join(cwd, '.bridge', 'events.jsonl'), 'utf8');
  return text.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

async function removeWorkspace(cwd) {
  await fs.rm(cwd, { recursive: true, force: true });
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

async function cleanGitWorkspace() {
  return workspace();
}

test('concurrent first use initializes safely', async () => {
  const cwd = await workspace();
  try {
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => runAsync(cwd, ['start', 'First-use task ' + i])));
    assert.equal(results.filter(result => result.code === 0).length, 1);
    const state = await readState(cwd);
    const events = await readEvents(cwd);
    assert.equal(state.phase, 'planning');
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'initialized');
    assert.equal(events[1].type, 'assignment_created');
    assert.deepEqual(events.map(event => event.seq), [0, 1]);
  } finally {
    await removeWorkspace(cwd);
  }
});
test('long session preserves ordered state through 40 sequential chunks', async () => {
  const cwd = await workspace();
  try {
    run(cwd, ['init']);
    for (let index = 1; index <= 40; index += 1) {
      run(cwd, [index === 1 ? 'start' : 'start', 'Chunk ' + index]);
      run(cwd, ['approach', 'Approach for chunk ' + index, '--files', 'app.txt', '--manual']);
      run(cwd, ['approve']);
      await advanceConsultation(cwd);
      await completeChunk(cwd, 'Completed chunk ' + index);
    }
    run(cwd, ['done', 'Long-session review complete']);
    const state = await readState(cwd);
    const events = await readEvents(cwd);
    assert.equal(state.phase, 'done');
    assert.equal(state.event_seq, 241);
    assert.equal(events.length, 242);
    assert.deepEqual(events.map(event => event.seq), Array.from({ length: 242 }, (_, i) => i));
    assert.equal((await fs.readdir(path.join(cwd, '.bridge'))).some(file => file.endsWith('.tmp')), false);
  } finally {
    await removeWorkspace(cwd);
  }
});

test('parallel mutation attempts leave one valid owner and no corrupt log', async () => {
  const cwd = await workspace();
  try {
    run(cwd, ['init']);
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) => runAsync(cwd, ['start', 'Concurrent task ' + i])));
    const successes = results.filter(result => result.code === 0);
    assert.equal(successes.length, 1);
    const state = await readState(cwd);
    const events = await readEvents(cwd);
    assert.equal(state.phase, 'planning');
    assert.equal(state.event_seq, 1);
    assert.equal(events.length, 2);
    assert.equal(events[1].type, 'assignment_created');
    assert.equal(new Set(results.filter(result => result.code !== 0).map(result => result.code)).size, 1);
  } finally {
    await removeWorkspace(cwd);
  }
});

test('duplicate and stale actions are rejected without replaying work', async () => {
  const cwd = await workspace();
  try {
    run(cwd, ['start', 'Replay protection']);
    run(cwd, ['approach', 'First proposal', '--files', 'app.txt', '--manual']);
    run(cwd, ['approve']);
    await advanceConsultation(cwd);
    const approved = await readState(cwd);
    run(cwd, ['approve'], 1);
    assert.deepEqual(await readState(cwd), approved);
    await completeChunk(cwd, 'Completed once');
    const reviewed = await readState(cwd);
    run(cwd, ['complete', 'Duplicate completion'], 1);
    run(cwd, ['done', 'Finished review']);
    const finished = await readState(cwd);
    run(cwd, ['revise', 'Stale revision'], 1);
    assert.deepEqual(await readState(cwd), finished);
  } finally {
    await removeWorkspace(cwd);
  }
});

test('Git checkpoint detects changes after an approved execution', async () => {
  const cwd = await cleanGitWorkspace();
  try {
    run(cwd, ['init']);
    run(cwd, ['start', 'Git checkpoint']);
    run(cwd, ['approach', 'Change app.txt', '--files', 'app.txt', '--manual']);
    run(cwd, ['approve']);
    await advanceConsultation(cwd);
    const before = await readState(cwd);
    await fs.writeFile(path.join(cwd, 'app.txt'), 'changed by HANDS\n', 'utf8');
    await completeChunk(cwd, 'Change applied');
    const after = await readState(cwd);
    assert.match(before.git_before, /^[0-9a-f]{40}$/);
    assert.equal(after.git_status, 'changes_present');
    assert.equal(after.git_before, before.git_before);
    assert.equal(after.phase, 'brain_reviewing');
  } finally {
    await removeWorkspace(cwd);
  }
});

test('stale lock recovery is explicit and never automatic', async () => {
  const cwd = await workspace();
  try {
    run(cwd, ['init']);
    const lock = path.join(cwd, '.bridge', 'state.lock');
    await fs.writeFile(lock, 'crashed-process\n', 'utf8');
    const blocked = run(cwd, ['start', 'Must not run under stale lock'], 1);
    assert.match(blocked.stderr, /Another coordinator command is active/);
    assert.equal((await readState(cwd)).phase, 'idle');
    const old = new Date(Date.now() - 60000);
    await fs.utimes(lock, old, old);
    run(cwd, ['unlock']);
    run(cwd, ['start', 'Runs after explicit unlock']);
    assert.equal((await readState(cwd)).phase, 'planning');
  } finally {
    await removeWorkspace(cwd);
  }
});