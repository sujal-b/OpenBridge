'use strict';

// The dirty-tree remediation flow. A dirty working tree at the approval gate is
// a retryable environment precondition, not a proposal failure: it blocks as
// `dirty_tree` (with resume_phase back into approval), the dashboard offers
// `bridge resume` instead of `bridge revise`, and resume after cleanup re-enters
// the gate with the Brain's approval standing — no re-proposal, no re-review.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { handleCommand, DIRTY_TREE_MESSAGE_PREFIX, repoPath } = require('../bridge-coordinator');
const runner = require('../bridge-runner');
const { allowedControls } = require('../bridge-inspector');
const { controlsFor } = require('../bridge');

async function createGitWorkspace(prefix) {
  const base = path.join(process.cwd(), '.tmp-test-workspaces');
  await fs.mkdir(base, { recursive: true });
  const cwd = await fs.mkdtemp(path.join(base, prefix || 'dirty-tree-'));
  await fs.writeFile(path.join(cwd, '.gitignore'), '.bridge/\n', 'utf8');
  await fs.writeFile(path.join(cwd, 'README.md'), '# Test project\n', 'utf8');
  const git = args => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, 'git ' + args.join(' ') + ' failed: ' + result.stderr);
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'dirty-tree@example.invalid']);
  git(['config', 'user.name', 'Dirty Tree Tests']);
  git(['add', '.']);
  git(['commit', '-qm', 'baseline']);
  return cwd;
}

function baseState(phase, extra = {}) {
  return {
    schema_version: 1,
    session_id: 'session-dirty-tree',
    assignment_id: 'assignment-dirty-tree',
    phase,
    task: 'dirty tree remediation analysis',
    active_agent: 'mind',
    activity: { agent: 'mind', action: 'Waiting', started_at: new Date().toISOString() },
    revision: 1,
    hands_session_id: null,
    approach: { summary: 'Update README only', files: ['README.md'], risks: [], acceptance: [], revision: 1 },
    approval: 'pending',
    autonomy: { mode: 'brain_autonomous', approved_by: null, approved_at: null },
    consultation: null,
    execution_lease_id: null,
    git_before: null,
    git_after: null,
    blocked_reason: null,
    block_kind: null,
    resume_phase: null,
    recovery_required: false,
    event_seq: 3,
    updated_at: new Date().toISOString(),
    ...extra
  };
}

async function writeState(cwd, state) {
  const file = path.join(cwd, '.bridge', 'state.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state) + '\n', 'utf8');
}

async function readStateFrom(cwd) {
  return JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'state.json'), 'utf8'));
}

async function readEvents(cwd) {
  const raw = await fs.readFile(path.join(cwd, '.bridge', 'events.jsonl'), 'utf8');
  return raw.trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('dirty_tree block records resume_phase into approval and resume re-enters the gate', async () => {
  const cwd = await createGitWorkspace('dirty-tree-coord-');
  try {
    await writeState(cwd, baseState('brain_approving'));

    await handleCommand(['block', '--kind', 'dirty_tree', DIRTY_TREE_MESSAGE_PREFIX + ' Commit or stash.'], { cwd });
    let state = await readStateFrom(cwd);
    assert.equal(state.phase, 'blocked_user');
    assert.equal(state.block_kind, 'dirty_tree');
    assert.equal(state.resume_phase, 'brain_approving');
    assert.equal(state.recovery_required, false);

    await handleCommand(['resume'], { cwd });
    state = await readStateFrom(cwd);
    assert.equal(state.phase, 'brain_approving');
    assert.equal(state.block_kind, null);
    assert.equal(state.blocked_reason, null);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('propose preflight blocks a dirty tree before any agent run', async () => {
  const cwd = await createGitWorkspace('dirty-tree-preflight-');
  try {
    await writeState(cwd, baseState('planning'));
    // Real dirt, real git: the preflight measures the environment, so a stubbed
    // provider must not be able to forge or suppress it.
    await fs.appendFile(path.join(cwd, 'README.md'), '\nuncommitted work\n', 'utf8');
    await fs.writeFile(path.join(cwd, 'notes.txt'), 'untracked\n', 'utf8');
    const spawned = [];
    const runProcess = async (cmd) => {
      spawned.push(cmd);
      return { ok: false, stderr: 'no provider in test' };
    };

    const result = await runner.propose({ cwd, runProcess, retryAttempts: 1, retryDelayMs: 0 });

    assert.equal(result.state.phase, 'blocked_user');
    assert.equal(result.state.block_kind, 'dirty_tree');
    assert.equal(result.state.resume_phase, 'planning');
    assert.match(result.error, /Working tree is already dirty/);
    assert.match(result.state.blocked_reason, /README\.md/);
    assert.match(result.state.blocked_reason, /notes\.txt/);
    assert.ok(spawned.every(cmd => cmd !== 'opencode'), 'proposal agent must not run on a dirty tree');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('approval-gate dirty tree blocks as dirty_tree, not escalation', async () => {
  const cwd = await createGitWorkspace('dirty-tree-gate-');
  try {
    await fs.appendFile(path.join(cwd, 'README.md'), '\nstray edit between review and approval\n', 'utf8');
    await writeState(cwd, baseState('brain_approving'));

    let reviewCalls = 0;
    const result = await runner.autoAdvance({ state: await readStateFrom(cwd) }, {
      cwd,
      brainReviewProposal: async () => {
        reviewCalls += 1;
        return { decision: 'approve', summary: 'approved by stub' };
      }
    });

    assert.equal(reviewCalls, 1);
    assert.equal(result.state.phase, 'blocked_user');
    assert.equal(result.state.block_kind, 'dirty_tree');
    assert.equal(result.state.resume_phase, 'brain_approving');
    assert.match(result.state.blocked_reason, new RegExp(DIRTY_TREE_MESSAGE_PREFIX));
    assert.match(result.state.blocked_reason, /Dirty files/);
    assert.match(result.state.blocked_reason, /README\.md/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('resume after cleanup re-enters approval with the Brain approval standing', async () => {
  const cwd = await createGitWorkspace('dirty-tree-resume-');
  try {
    await writeState(cwd, baseState('blocked_user', {
      block_kind: 'dirty_tree',
      resume_phase: 'brain_approving',
      blocked_reason: DIRTY_TREE_MESSAGE_PREFIX + ' Commit or stash unrelated changes before approval.',
      activity: { agent: 'user', action: 'Waiting for user', started_at: new Date().toISOString() }
    }));

    const result = await runner.resume({
      cwd,
      // Canary: the approval stands, so a Brain re-review would be a regression.
      brainReviewProposal: () => {
        throw new Error('Brain must not re-review after cleanup');
      }
    });

    const state = await readStateFrom(cwd);
    const events = await readEvents(cwd);
    const approval = events.find(event => event.type === 'approach_approved');
    assert.ok(approval, 'approval must be re-recorded on resume');
    assert.match(approval.summary, /approval stands/);
    assert.equal(state.approval, 'approved');
    // Consultation cannot proceed in a workspace without Brain config; it fails
    // fast on the missing HANDS session binding — before any agent spawn.
    assert.equal(result.error, 'No HANDS session is bound.');
    assert.equal(state.phase, 'blocked_user');
    assert.notEqual(state.block_kind, 'dirty_tree');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('resume refuses with the file list while the tree is still dirty', async () => {
  const cwd = await createGitWorkspace('dirty-tree-still-');
  try {
    await fs.appendFile(path.join(cwd, 'README.md'), '\nstill dirty\n', 'utf8');
    await writeState(cwd, baseState('blocked_user', {
      block_kind: 'dirty_tree',
      resume_phase: 'brain_approving',
      blocked_reason: DIRTY_TREE_MESSAGE_PREFIX + ' Commit or stash unrelated changes before approval.',
      activity: { agent: 'user', action: 'Waiting for user', started_at: new Date().toISOString() }
    }));

    const result = await runner.resume({ cwd });

    assert.match(result.error, /Working tree is already dirty/);
    assert.match(result.error, /README\.md/);
    const state = await readStateFrom(cwd);
    assert.equal(state.phase, 'blocked_user');
    assert.equal(state.block_kind, 'dirty_tree');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('preflight passes on a clean tree and the proposal agent runs', async () => {
  const cwd = await createGitWorkspace('dirty-tree-clean-');
  try {
    await writeState(cwd, baseState('planning'));
    const agentCalls = [];
    const runProcess = async cmd => {
      agentCalls.push(cmd);
      return { ok: false, stderr: 'no provider in test' };
    };

    const result = await runner.propose({ cwd, runProcess, retryAttempts: 1, retryDelayMs: 0 });

    assert.ok(agentCalls.includes('opencode'), 'clean tree must reach the proposal agent');
    assert.equal(result.state.block_kind, null, 'clean-tree failure must not be misclassified as dirty_tree');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('dashboard offers resume — not revise — for a dirty_tree block', async () => {
  for (const resumePhase of ['brain_approving', 'planning', 'hands_proposing']) {
    const state = baseState('blocked_user', {
      block_kind: 'dirty_tree',
      resume_phase: resumePhase,
      blocked_reason: DIRTY_TREE_MESSAGE_PREFIX,
      activity: { agent: 'user', action: 'Waiting for user', started_at: new Date().toISOString() }
    });

    assert.ok(allowedControls(state).includes('resume'), 'resume must be offered for ' + resumePhase);
    assert.ok(!allowedControls(state).includes('revise'), 'revise must not be offered for ' + resumePhase + ' — it cannot clean a tree');
    const line = controlsFor(state);
    assert.match(line, /bridge resume/);
    assert.doesNotMatch(line, /bridge revise/);
  }
});

test('revise refuses on a dirty_tree block instead of dead-ending into the same gate', async () => {
  const cwd = await createGitWorkspace('dirty-tree-revise-');
  try {
    await writeState(cwd, baseState('blocked_user', {
      block_kind: 'dirty_tree',
      resume_phase: 'brain_approving',
      blocked_reason: DIRTY_TREE_MESSAGE_PREFIX + ' Commit or stash unrelated changes before approval.',
      activity: { agent: 'user', action: 'Waiting for user', started_at: new Date().toISOString() }
    }));

    await assert.rejects(
      handleCommand(['revise', 'try the other approach'], { cwd }),
      /Revise cannot clean a working tree/
    );
    const state = await readStateFrom(cwd);
    assert.equal(state.phase, 'blocked_user', 'a refused revise must not change the phase');
    assert.equal(state.block_kind, 'dirty_tree');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// --- Revision-cycle tolerance -------------------------------------------------
// A rejected attempt leaves its own changes in the tree. Re-work must not force
// the user to git-clean the bridge's own output: the gate, the preflight, and
// the completion scope check all tolerate dirt that stays inside the chunk's
// accumulated attempt_scope while HEAD sits on the chunk baseline.

function revisionState(cwd, phase, extra = {}) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
  return baseState(phase, {
    git_before: head,
    attempt_scope: [repoPath('README.md')],
    ...extra
  });
}

test('approval gate tolerates the rejected attempt changes during a revision cycle', async () => {
  const cwd = await createGitWorkspace('dirty-tree-tolerate-');
  try {
    await fs.appendFile(path.join(cwd, 'README.md'), '\nattempt one changes\n', 'utf8');
    await writeState(cwd, revisionState(cwd, 'brain_approving'));

    await handleCommand(['brain-approve', 'Brain approved the revised attempt'], { cwd });
    const state = await readStateFrom(cwd);
    assert.equal(state.phase, 'hands_consulting');
    assert.equal(state.git_status, 'changes_present', 'tolerated dirt must not be reported as a clean tree');
    assert.deepEqual(state.attempt_scope, [repoPath('README.md')], 'scope union dedupes the re-approved files');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('approval gate still blocks files outside the chunk scope during a revision cycle', async () => {
  const cwd = await createGitWorkspace('dirty-tree-stray-');
  try {
    await fs.appendFile(path.join(cwd, 'README.md'), '\nattempt one changes\n', 'utf8');
    await fs.writeFile(path.join(cwd, 'stray.txt'), 'user droppings\n', 'utf8');
    await writeState(cwd, revisionState(cwd, 'brain_approving'));

    await assert.rejects(
      handleCommand(['brain-approve', 'Brain approved the revised attempt'], { cwd }),
      /Working tree is already dirty/
    );
    const state = await readStateFrom(cwd);
    assert.equal(state.phase, 'brain_approving', 'a refused approval must not change the phase');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('approval gate drops the carve-out once the user commits mid-cycle', async () => {
  const cwd = await createGitWorkspace('dirty-tree-committed-');
  try {
    await fs.appendFile(path.join(cwd, 'README.md'), '\nattempt one changes\n', 'utf8');
    await writeState(cwd, revisionState(cwd, 'brain_approving', {
      git_before: '0'.repeat(40), // HEAD moved: the user took history ownership
      attempt_scope: [repoPath('README.md')]
    }));

    await assert.rejects(
      handleCommand(['brain-approve', 'Brain approved the revised attempt'], { cwd }),
      /Working tree is already dirty/
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

function revisionProposeStub(spawned) {
  // Git runs for real (the workspace carries the actual dirt); only the
  // provider is stubbed.
  return async cmd => {
    spawned.push(cmd);
    return { ok: false, stderr: 'no provider in test' };
  };
}

test('preflight tolerates the rejected attempt changes so revise can re-propose', async () => {
  const cwd = await createGitWorkspace('dirty-tree-preflight-tol-');
  try {
    await fs.appendFile(path.join(cwd, 'README.md'), '\nattempt one changes\n', 'utf8');
    await writeState(cwd, revisionState(cwd, 'hands_proposing'));
    const spawned = [];

    const result = await runner.propose({ cwd, runProcess: revisionProposeStub(spawned), retryAttempts: 1, retryDelayMs: 0 });

    assert.ok(spawned.includes('opencode'), 'in-scope attempt dirt must reach the proposal agent');
    assert.notEqual(result.state.block_kind, 'dirty_tree');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('preflight still blocks files outside the chunk scope during a revision cycle', async () => {
  const cwd = await createGitWorkspace('dirty-tree-preflight-stray-');
  try {
    await fs.appendFile(path.join(cwd, 'README.md'), '\nattempt one changes\n', 'utf8');
    await fs.writeFile(path.join(cwd, 'stray.txt'), 'user droppings\n', 'utf8');
    await writeState(cwd, revisionState(cwd, 'hands_proposing'));
    const spawned = [];

    const result = await runner.propose({ cwd, runProcess: revisionProposeStub(spawned), retryAttempts: 1, retryDelayMs: 0 });

    assert.equal(result.state.phase, 'blocked_user');
    assert.equal(result.state.block_kind, 'dirty_tree');
    assert.equal(result.state.resume_phase, 'hands_proposing');
    assert.match(result.state.blocked_reason, /stray\.txt/);
    assert.ok(!spawned.includes('opencode'), 'out-of-scope dirt must not reach the proposal agent');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('completion scope check accepts the accumulated attempt scope', async () => {
  const cwd = await createGitWorkspace('dirty-tree-complete-');
  try {
    await fs.appendFile(path.join(cwd, 'README.md'), '\nattempt one changes\n', 'utf8');
    await writeState(cwd, revisionState(cwd, 'hands_executing', {
      execution_lease_id: 'lease-t',
      revision_consumed: true,
      execution_claimed: true,
      execution_started_at: new Date().toISOString(),
      // The revised proposal narrowed its file list; the earlier attempt's
      // file must still count via the accumulated scope.
      approach: { summary: 'narrowed retry', files: ['notes.txt'], risks: [], acceptance: [], revision: 2 }
    }));

    await handleCommand(['complete', 'lease-t', 'attempt two ready for review'], { cwd });
    const state = await readStateFrom(cwd);
    assert.equal(state.phase, 'brain_reviewing', 'attempt-one files must not read as scope violations');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('completion scope check stays strict without an accumulated scope', async () => {
  const cwd = await createGitWorkspace('dirty-tree-complete-strict-');
  try {
    await fs.appendFile(path.join(cwd, 'README.md'), '\nattempt one changes\n', 'utf8');
    await writeState(cwd, baseState('hands_executing', {
      execution_lease_id: 'lease-t',
      revision_consumed: true,
      execution_claimed: true,
      execution_started_at: new Date().toISOString(),
      git_before: spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim(),
      approach: { summary: 'single attempt', files: ['notes.txt'], risks: [], acceptance: [], revision: 1 }
    }));

    await handleCommand(['complete', 'lease-t', 'ready for review'], { cwd });
    const state = await readStateFrom(cwd);
    assert.equal(state.phase, 'blocked_user');
    assert.equal(state.block_kind, 'execution_recovery');
    assert.equal(state.recovery_required, true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// --- Tool runtime data exemption ----------------------------------------------
// Agent runtimes write session/cache data into the project while a session is
// live (.omo/run-continuation/*.json blocked a real approval). Untracked files
// under runtime prefixes are exempt at every checkpoint; tracked changes and
// unknown paths still block.

async function writePolicy(cwd, policy) {
  await fs.writeFile(path.join(cwd, '.bridge', 'policy.json'), JSON.stringify(policy) + '\n', 'utf8');
}

test('approval gate exempts untracked agent runtime data', async () => {
  const cwd = await createGitWorkspace('runtime-exempt-gate-');
  try {
    await fs.mkdir(path.join(cwd, '.omo', 'run-continuation'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.omo', 'run-continuation', 'ses_1.json'), '{"continuation":true}\n', 'utf8');
    await writeState(cwd, baseState('brain_approving'));

    await handleCommand(['brain-approve', 'Brain approved'], { cwd });
    const state = await readStateFrom(cwd);
    assert.equal(state.phase, 'hands_consulting', 'runtime data must not block the gate');
    assert.equal(state.git_status, 'clean_before_execution');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('approval gate still blocks tracked changes inside a runtime directory', async () => {
  const cwd = await createGitWorkspace('runtime-tracked-');
  try {
    await fs.mkdir(path.join(cwd, '.omo'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.omo', 'tracked.json'), '{"v":1}\n', 'utf8');
    spawnSync('git', ['add', '.'], { cwd });
    spawnSync('git', ['commit', '-qm', 'track runtime file'], { cwd });
    await fs.appendFile(path.join(cwd, '.omo', 'tracked.json'), '\n{"v":2}\n', 'utf8');
    await writeState(cwd, baseState('brain_approving'));

    await assert.rejects(
      handleCommand(['brain-approve', 'Brain approved'], { cwd }),
      /Working tree is already dirty/
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('approval.ignorePaths in policy.json extends the exemption', async () => {
  const cwd = await createGitWorkspace('runtime-policy-');
  try {
    await writeState(cwd, baseState('brain_approving'));
    await writePolicy(cwd, { approval: { ignorePaths: ['.cache/'] } });
    await fs.mkdir(path.join(cwd, '.cache'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.cache', 'blob.bin'), 'x\n', 'utf8');
    await fs.writeFile(path.join(cwd, 'random.txt'), 'not exempt\n', 'utf8');

    await assert.rejects(
      handleCommand(['brain-approve', 'Brain approved'], { cwd }),
      error => {
        assert.match(error.message, /Working tree is already dirty/);
        assert.match(error.message, /random\.txt/);
        assert.doesNotMatch(error.message, /\.cache/, 'exempted prefix must not be listed as dirt');
        assert.match(error.message, /approval\.ignorePaths/, 'the block must teach the remedy');
        return true;
      }
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('preflight exempts runtime data and lists only real dirt', async () => {
  const cwd = await createGitWorkspace('runtime-preflight-');
  try {
    await writeState(cwd, baseState('planning'));
    await fs.mkdir(path.join(cwd, '.omo', 'run-continuation'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.omo', 'run-continuation', 'ses_1.json'), '{}\n', 'utf8');
    await fs.appendFile(path.join(cwd, 'README.md'), '\nreal work\n', 'utf8');
    const spawned = [];

    const result = await runner.propose({ cwd, runProcess: revisionProposeStub(spawned), retryAttempts: 1, retryDelayMs: 0 });

    assert.equal(result.state.block_kind, 'dirty_tree');
    assert.match(result.state.blocked_reason, /README\.md/);
    assert.doesNotMatch(result.state.blocked_reason, /\.omo/);
    assert.ok(!spawned.includes('opencode'));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('completion scope check ignores runtime data written during execution', async () => {
  const cwd = await createGitWorkspace('runtime-complete-');
  try {
    await fs.appendFile(path.join(cwd, 'README.md'), '\nattempt one changes\n', 'utf8');
    await writeState(cwd, revisionState(cwd, 'hands_executing', {
      execution_lease_id: 'lease-t',
      revision_consumed: true,
      execution_claimed: true,
      execution_started_at: new Date().toISOString()
    }));
    await fs.mkdir(path.join(cwd, '.omo', 'run-continuation'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.omo', 'run-continuation', 'ses_1.json'), '{}\n', 'utf8');

    await handleCommand(['complete', 'lease-t', 'ready for review'], { cwd });
    const state = await readStateFrom(cwd);
    assert.equal(state.phase, 'brain_reviewing', 'runtime data must not read as a scope violation');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

