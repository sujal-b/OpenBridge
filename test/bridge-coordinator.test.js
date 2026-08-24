const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const coordinator = path.resolve(__dirname, '..', 'bridge-coordinator.js');
const inspector = path.resolve(__dirname, '..', 'inspector.html');

async function withWorkspace(callback) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-eval-'));
  try {
    await fs.writeFile(path.join(workspace, '.gitignore'), '.bridge/\n', 'utf8');
    git(workspace, ['init', '-q']);
    git(workspace, ['config', 'user.email', 'evaluation@example.invalid']);
    git(workspace, ['config', 'user.name', 'Mind-Limb Evaluation']);
    git(workspace, ['add', '.']);
    git(workspace, ['commit', '-qm', 'baseline']);
    return await callback(workspace);
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
}

function run(workspace, args, expectedExit = 0) {
  const result = spawnSync(process.execPath, [coordinator, ...args], { cwd: workspace, encoding: 'utf8' });
  assert.equal(result.status, expectedExit, `Command failed: node bridge-coordinator.js ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function readState(workspace) {
  return JSON.parse(await fs.readFile(path.join(workspace, '.bridge', 'state.json'), 'utf8'));
}

async function completeChunk(workspace, summary) {
  const state = await readState(workspace);
  run(workspace, ['claim-execution', state.execution_lease_id]);
  run(workspace, ['complete', state.execution_lease_id, summary || 'Chunk completed']);
  return readState(workspace);
}
async function advanceConsultation(workspace) {
  const state = await readState(workspace);
  run(workspace, ['consult', JSON.stringify({
    decision: 'approved',
    assignment_id: state.assignment_id,
    revision: state.revision,
    summary: 'Brain confirmed the approved chunk.',
    brain_answer: 'Proceed with the approved files and focused validation.'
  })]);
  return readState(workspace);
}
async function readEvents(workspace) {
  const text = await fs.readFile(path.join(workspace, '.bridge', 'events.jsonl'), 'utf8');
  return text.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function git(workspace, args, expectedExit = 0) {
  const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
  assert.equal(result.status, expectedExit, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}

async function createCleanGitWorkspace() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-git-eval-'));
  await fs.writeFile(path.join(workspace, '.gitignore'), '.bridge/\n', 'utf8');
  await fs.writeFile(path.join(workspace, 'README.md'), '# Evaluation project\n', 'utf8');
  git(workspace, ['init', '-q']);
  git(workspace, ['config', 'user.email', 'evaluation@example.invalid']);
  git(workspace, ['config', 'user.name', 'Mind-Limb Evaluation']);
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-qm', 'baseline']);
  return workspace;
}

test('initialization creates one state file, an audit log, and a plan view', async () => {
  await withWorkspace(async workspace => {
    run(workspace, ['init']);
    const state = await readState(workspace);
    const events = await readEvents(workspace);
    const plan = await fs.readFile(path.join(workspace, '.bridge', 'plan.md'), 'utf8');
    assert.equal(state.phase, 'idle');
    assert.equal(state.event_seq, 0);
    assert.equal(events[0].type, 'initialized');
    assert.match(plan, /No active task/);
  });
});

test('the normal MIND -> HANDS -> MIND flow is enforced', async () => {
  await withWorkspace(async workspace => {
    run(workspace, ['start', 'Add upload validation']);
    assert.equal((await readState(workspace)).phase, 'planning');
    run(workspace, ['approach', 'Inspect before editing', '--files', 'src.txt']);
    let state = await readState(workspace);
    assert.equal(state.phase, 'brain_approving');
    assert.equal(state.active_agent, 'mind');
    assert.equal(state.revision, 1);
    assert.deepEqual(state.approach.files, ['src.txt']);
    run(workspace, ['approve']);
    await advanceConsultation(workspace);
    state = await readState(workspace);
    assert.equal(state.phase, 'hands_executing');
    assert.equal(state.active_agent, 'hands');
    assert.equal(state.approval, 'approved');
    assert.equal(state.git_status, 'clean_before_execution');
    await fs.writeFile(path.join(workspace, 'src.txt'), 'changed\n', 'utf8');
    await completeChunk(workspace, 'Chunk completed');
    state = await readState(workspace);
    assert.equal(state.phase, 'brain_reviewing');
    assert.equal(state.git_status, 'changes_present');
    assert.equal(state.active_agent, 'mind');
    run(workspace, ['done', 'Reviewed']);
    assert.equal((await readState(workspace)).phase, 'done');
  });
});

test('execution leases are single-use and recovery requires a fresh consultation', async () => {
  await withWorkspace(async workspace => {
    run(workspace, ['start', 'Lease replay protection']);
    run(workspace, ['approach', 'Change one file', '--files', 'src.txt']);
    run(workspace, ['approve']);
    const consulted = await advanceConsultation(workspace);
    assert.equal(consulted.phase, 'hands_executing');
    const lease = consulted.execution_lease_id;
    run(workspace, ['claim-execution', lease]);
    const claimed = await readState(workspace);
    assert.equal(claimed.execution_claimed, true);
    run(workspace, ['claim-execution', lease], 1);
    assert.deepEqual(await readState(workspace), claimed);
    run(workspace, ['recover']);
    const recovered = await readState(workspace);
    assert.equal(recovered.phase, 'blocked_user');
    assert.equal(recovered.execution_lease_id, null);
    assert.equal(recovered.execution_claimed, false);
    run(workspace, ['resume']);
    assert.equal((await readState(workspace)).phase, 'hands_consulting');
  });
});

test('completion blocks files outside the approved scope', async () => {
  const workspace = await createCleanGitWorkspace();
  try {
    run(workspace, ['start', 'Scope enforcement']);
    run(workspace, ['approach', 'Change one approved file', '--files', 'app.txt']);
    run(workspace, ['approve']);
    await advanceConsultation(workspace);
    await fs.writeFile(path.join(workspace, 'app.txt'), 'approved change\n', 'utf8');
    await fs.writeFile(path.join(workspace, 'unexpected.txt'), 'unexpected change\n', 'utf8');
    const state = await completeChunk(workspace, 'Scope test complete');
    assert.equal(state.phase, 'blocked_user');
    assert.equal(state.git_status, 'scope_violation');
    assert.equal(state.recovery_required, true);
    assert.equal(state.resume_phase, 'hands_consulting');
    assert.match(state.blocked_reason, /unexpected\.txt/);
    const events = await readEvents(workspace);
    assert.equal(events.at(-1).type, 'scope_violation');
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});
test('invalid transitions fail without changing state', async () => {
  await withWorkspace(async workspace => {
    run(workspace, ['init']);
    const before = await readState(workspace);
    run(workspace, ['approve'], 1);
    const after = await readState(workspace);
    assert.deepEqual(after, before);
  });
});

test('MIND can revise an approach and the revision advances', async () => {
  await withWorkspace(async workspace => {
    run(workspace, ['start', 'Revision test']);
    run(workspace, ['approach', 'First approach']);
    run(workspace, ['revise', 'Need clearer test coverage']);
    let state = await readState(workspace);
    assert.equal(state.phase, 'hands_proposing');
    assert.equal(state.revision, 2);
    run(workspace, ['approach', 'Second approach']);
    state = await readState(workspace);
    assert.equal(state.phase, 'brain_approving');
    assert.equal(state.revision, 3);
  });
});

test('approval rejects a non-Git project before execution', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-no-git-'));
  try {
    run(workspace, ['start', 'No Git task']);
    run(workspace, ['approach', 'Inspect only', '--files', 'README.md']);
    const failure = run(workspace, ['approve'], 1);
    const state = await readState(workspace);
    assert.equal(state.phase, 'brain_approving');
    assert.match(failure.stderr, /Git repository/);
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});
test('approval blocks a dirty Git tree', async () => {
  const workspace = await createCleanGitWorkspace();
  try {
    run(workspace, ['start', 'Dirty tree test']);
    run(workspace, ['approach', 'Inspect only', '--files', 'README.md']);
    await fs.writeFile(path.join(workspace, 'uncommitted.txt'), 'unrelated\n', 'utf8');
    run(workspace, ['approve'], 1);
    const state = await readState(workspace);
    assert.equal(state.phase, 'brain_approving');
    assert.equal(state.git_before, null);
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});

test('approval records the clean Git baseline', async () => {
  const workspace = await createCleanGitWorkspace();
  try {
    run(workspace, ['start', 'Clean tree test']);
    run(workspace, ['approach', 'Inspect only', '--files', 'README.md']);
    run(workspace, ['approve']);
    await advanceConsultation(workspace);
    const state = await readState(workspace);
    assert.match(state.git_before, /^[0-9a-f]{40}$/);
    assert.equal(state.git_status, 'clean_before_execution');
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});

test('blocked and paused sessions wait for explicit user recovery', async () => {
  await withWorkspace(async workspace => {
    run(workspace, ['start', 'Recovery test']);
    run(workspace, ['block', 'Need a user decision']);
    let state = await readState(workspace);
    assert.equal(state.phase, 'blocked_user');
    assert.equal(state.active_agent, 'user');
    assert.equal(state.resume_phase, 'planning');
    run(workspace, ['resume']);
    state = await readState(workspace);
    assert.equal(state.phase, 'planning');
    assert.equal(state.active_agent, 'mind');
    run(workspace, ['pause']);
    state = await readState(workspace);
    assert.equal(state.phase, 'paused');
    run(workspace, ['resume']);
    assert.equal((await readState(workspace)).phase, 'planning');
  });
});

test('active execution rejects pause, resume, and stop safely', async () => {
  await withWorkspace(async workspace => {
    run(workspace, ['start', 'Active execution control test']);
    run(workspace, ['approach', 'Execute the approved chunk', '--files', 'app.txt']);
    run(workspace, ['approve']);
    await advanceConsultation(workspace);
    run(workspace, ['pause'], 1);
    run(workspace, ['resume'], 1);
    run(workspace, ['cancel'], 1);
    assert.equal((await readState(workspace)).phase, 'hands_executing');
  });
});

test('interrupted execution can be recovered only without an agent lock', async () => {
  await withWorkspace(async workspace => {
    run(workspace, ['start', 'Recovery command test']);
    run(workspace, ['approach', 'Continue the approved chunk', '--files', 'app.txt']);
    run(workspace, ['approve']);
    await advanceConsultation(workspace);
    run(workspace, ['recover']);
    let state = await readState(workspace);
    assert.equal(state.phase, 'blocked_user');
    assert.equal(state.resume_phase, 'hands_consulting');
    run(workspace, ['resume']);
    state = await readState(workspace);
    assert.equal(state.phase, 'hands_consulting');
    state = await advanceConsultation(workspace);
    assert.equal(state.phase, 'hands_executing');
  });
});

test('a coordinator lock blocks concurrent mutations but not reads', async () => {
  await withWorkspace(async workspace => {
    run(workspace, ['init']);
    const lock = path.join(workspace, '.bridge', 'state.lock');
    await fs.writeFile(lock, 'stale-test\n', 'utf8');
    run(workspace, ['status']);
    run(workspace, ['start', 'Lock test'], 1);
    run(workspace, ['unlock']);
    run(workspace, ['start', 'Lock test']);
    assert.equal((await readState(workspace)).phase, 'planning');
  });
});

test('events are ordered and plan.md follows state.json', async () => {
  await withWorkspace(async workspace => {
    run(workspace, ['start', 'Audit test']);
    run(workspace, ['approach', 'Approach summary', '--files', 'src/example.js']);
    const events = await readEvents(workspace);
    assert.deepEqual(events.map(event => event.seq), [0, 1, 2]);
    const plan = await fs.readFile(path.join(workspace, '.bridge', 'plan.md'), 'utf8');
    assert.match(plan, /Approach summary/);
    assert.match(plan, /src\/example\.js/);
    const bridgeFiles = await fs.readdir(path.join(workspace, '.bridge'));
    assert.equal(bridgeFiles.some(file => file.endsWith('.tmp')), false);
  });
});

test('Inspector contains the expected overview inputs and fields', async () => {
  const html = await fs.readFile(inspector, 'utf8');
  for (const value of ['Mind-Limb Bridge Inspector', 'timeline', 'data-control', 'snapshot', 'update', 'revise']) {
    assert.match(html, new RegExp(value.replace('.', '\\.'), 'i'));
  }
});
test('live coordinator locks cannot be manually removed', async () => {
  await withWorkspace(async workspace => {
    run(workspace, ['init']);
    const lock = path.join(workspace, '.bridge', 'state.lock');
    await fs.writeFile(lock, JSON.stringify({ pid: process.pid, token: 'live-test' }) + '\n', 'utf8');
    run(workspace, ['unlock'], 1);
    assert.equal(await fs.readFile(lock, 'utf8').then(Boolean), true);
    await fs.unlink(lock);
  });
});

test('pending commit journals are reconciled once after interruption', async () => {
  await withWorkspace(async workspace => {
    run(workspace, ['init']);
    const state = await readState(workspace);
    const next = { ...state, phase: 'planning', active_agent: 'mind', task: 'Recovered task', event_seq: 1, last_summary: 'Recovered commit' };
    const event = { seq: 1, at: new Date().toISOString(), session_id: state.session_id, assignment_id: null, revision: 0, type: 'assignment_created', phase: 'planning', active_agent: 'mind', summary: 'Recovered commit' };
    await fs.writeFile(path.join(workspace, '.bridge', 'commit.pending.json'), JSON.stringify({ state: next, plan: '# recovered\n', event }), 'utf8');
    run(workspace, ['status']);
    assert.equal((await readState(workspace)).task, 'Recovered task');
    assert.equal((await readEvents(workspace)).filter(item => item.seq === 1).length, 1);
    assert.equal(await fs.access(path.join(workspace, '.bridge', 'commit.pending.json')).then(() => true).catch(() => false), false);
  });
});

test('recovery refuses a live provider lock', async () => {
  await withWorkspace(async workspace => {
    run(workspace, ['start', 'Live lock recovery']);
    run(workspace, ['approach', 'Continue safely', '--files', 'app.txt']);
    run(workspace, ['approve']);
    await advanceConsultation(workspace);
    await fs.writeFile(path.join(workspace, '.bridge', 'agent.lock'), JSON.stringify({ pid: process.pid, token: 'live-provider' }) + '\n', 'utf8');
    run(workspace, ['recover'], 1);
    assert.equal((await readState(workspace)).phase, 'hands_executing');
    await fs.unlink(path.join(workspace, '.bridge', 'agent.lock'));
  });
});