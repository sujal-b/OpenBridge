'use strict';

// Friction-reduction regressions: bridge run must not dead-end on the bridge's
// own scaffold files, provider server faults must retry with a fresh session,
// provider errors must read as human sentences, and the dirty-tree remedy must
// be one command (bridge resume --commit).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const coordinatorPath = path.join(process.cwd(), 'bridge-coordinator.js');
const coordinator = require('../bridge-coordinator');
const runner = require('../bridge-runner');
const { runProcess: realRunProcess } = require('../bridge-adapter');

async function gitWorkspace(prefix) {
  const base = path.join(process.cwd(), '.tmp-test-workspaces');
  await fs.mkdir(base, { recursive: true });
  const cwd = await fs.mkdtemp(path.join(base, prefix));
  await fs.writeFile(path.join(cwd, '.gitignore'), '.bridge/\n', 'utf8');
  await fs.writeFile(path.join(cwd, 'README.md'), '# Test project\n', 'utf8');
  const git = args => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, 'git ' + args.join(' ') + ' failed: ' + result.stderr);
    return result;
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'friction@example.invalid']);
  git(['config', 'user.name', 'Friction Tests']);
  git(['add', '.']);
  git(['commit', '-qm', 'baseline']);
  return { cwd, git };
}

// Provider mock plumbing, mirroring test/qa-race-locks.test.js: real coordinator
// subprocess calls pass through to actual git/state machinery; only OpenCode
// agent calls are simulated. Agent identity is args[2] of the opencode command.
function mockProvider(behavior) {
  return async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinatorPath) {
      return realRunProcess(command, args, options);
    }
    const agent = args[2];
    return behavior(agent, args, options);
  };
}

function ok(output) {
  return { ok: true, code: 0, signal: null, stdout: JSON.stringify(output), stderr: '', timed_out: false };
}

function fail(output) {
  return { ok: false, code: 1, signal: null, stdout: JSON.stringify(output), stderr: '', timed_out: false };
}

function proposeOk(sessionID) {
  return {
    decision: 'propose',
    summary: 'Small focused chunk',
    files: ['README.md'],
    tests: ['read README'],
    sessionID
  };
}

function providerFault(sessionID) {
  return {
    type: 'error',
    timestamp: Date.now(),
    sessionID,
    error: { name: 'UnknownError', data: { message: 'Unexpected server error. Check server logs for details.', ref: 'err_friction' } }
  };
}

// ─── Scaffold auto-commit ─────────────────────────────────────────────────────

async function seedScaffold(cwd, contents) {
  await fs.writeFile(path.join(cwd, '.bridge', 'scaffold.json'), JSON.stringify({
    version: 1,
    files: { 'opencode.json': { sha256: crypto.createHash('sha256').update(contents).digest('hex') } }
  }) + '\n', 'utf8');
  await fs.writeFile(path.join(cwd, 'opencode.json'), contents, 'utf8');
}

test('preflight auto-commits unchanged bridge-owned scaffold files', async () => {
  const { cwd, git } = await gitWorkspace('friction-scaffold-');
  try {
    await coordinator.handleCommand(['init'], { cwd });
    await seedScaffold(cwd, '{"bridge":true}\n');
    await coordinator.handleCommand(['start', 'Scaffold task'], { cwd });

    const proposed = await runner.propose({ cwd, autonomous: false, runProcess: mockProvider(() => ok(proposeOk('ses_scaffold'))) });
    assert.ok(!String(proposed.error || '').includes('Working tree is already dirty'), 'scaffold file must not block: ' + proposed.error);
    assert.match(git(['log', '--oneline']).stdout, /chore: bridge scaffold files/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('preflight never auto-commits a user-modified scaffold file', async () => {
  const { cwd, git } = await gitWorkspace('friction-scaffold-user-');
  try {
    await coordinator.handleCommand(['init'], { cwd });
    await seedScaffold(cwd, 'original\n');
    await fs.writeFile(path.join(cwd, 'opencode.json'), 'user edited this\n', 'utf8');
    await coordinator.handleCommand(['start', 'Scaffold task'], { cwd });

    const proposed = await runner.propose({ cwd, autonomous: false, runProcess: mockProvider(() => ok(proposeOk('ses_x'))) });
    assert.match(String(proposed.error || ''), /Working tree is already dirty/);
    assert.match(String(proposed.error || ''), /opencode\.json/, 'user-modified file must be listed as dirt');
    assert.match(String(proposed.error || ''), /resume --commit/, 'the remedy must be taught');
    assert.doesNotMatch(git(['log', '--oneline']).stdout, /bridge scaffold/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// ─── resume --commit ──────────────────────────────────────────────────────────

test('resume --commit commits user dirt and proceeds without a second command', async () => {
  const { cwd, git } = await gitWorkspace('friction-resume-commit-');
  try {
    await coordinator.handleCommand(['init'], { cwd });
    await fs.writeFile(path.join(cwd, 'notes.txt'), 'scratch\n', 'utf8');
    // Runner-level start runs the preflight that files the dirty_tree block.
    await runner.start('Commit task', { cwd, autonomous: false });
    let state = await runner.readState({ cwd });
    assert.equal(state.phase, 'blocked_user');
    assert.equal(state.block_kind, 'dirty_tree');

    const runProcess = mockProvider(agent => agent === 'hands-propose' ? ok(proposeOk('ses_resume_commit')) : ok({}));
    const result = await runner.resume({ cwd, commitMessage: 'wip notes', autonomous: false, runProcess });
    assert.ok(!result.error, 'resume --commit must succeed: ' + result.error);
    assert.match(git(['log', '--oneline']).stdout, /wip notes/);
    state = await runner.readState({ cwd });
    assert.notEqual(state.phase, 'blocked_user', 'must leave the blocked state in one command');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// ─── Wide auto-resume ─────────────────────────────────────────────────────────

test('start on a dirty_tree blocked session auto-resumes instead of refusing', async () => {
  const { cwd } = await gitWorkspace('friction-auto-resume-');
  try {
    await coordinator.handleCommand(['init'], { cwd });
    await fs.writeFile(path.join(cwd, 'scratch.txt'), 'x\n', 'utf8');
    await runner.start('Resume task', { cwd, autonomous: false });
    let state = await runner.readState({ cwd });
    assert.equal(state.block_kind, 'dirty_tree');

    // User cleans the tree (as resume --commit would); bridge run must now
    // continue instead of refusing with the old dead-end message.
    const gitAdd = spawnSync('git', ['add', 'scratch.txt'], { cwd, encoding: 'utf8' });
    assert.equal(gitAdd.status, 0, 'git add failed: ' + gitAdd.stderr);
    const gitCommit = spawnSync('git', ['commit', '-m', 'checkpoint'], { cwd, encoding: 'utf8' });
    assert.equal(gitCommit.status, 0, 'git commit failed: ' + gitCommit.stderr);
    const runProcess = mockProvider(agent => agent === 'hands-propose' ? ok(proposeOk('ses_auto_resume')) : ok({}));
    const result = await runner.start('Resume task', { cwd, autonomous: false, runProcess });
    assert.ok(result.state, 'auto-resume must return a state');
    state = await runner.readState({ cwd });
    assert.notEqual(state.phase, 'blocked_user');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('start refuses with remedy on a needs_revision block instead of auto-resuming', async () => {
  const { cwd } = await gitWorkspace('friction-needs-revision-');
  try {
    await coordinator.handleCommand(['init'], { cwd });
    await coordinator.handleCommand(['start', 'Revision task'], { cwd });
    const stateFile = path.join(cwd, '.bridge', 'state.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    state.phase = 'blocked_user';
    state.block_kind = 'needs_revision';
    await fs.writeFile(stateFile, JSON.stringify(state));

    await assert.rejects(
      () => runner.start('Revision task', { cwd, autonomous: false }),
      /bridge revise/
    );
    const after = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.equal(after.phase, 'blocked_user', 'refusal must not mutate state');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('start refuses with remedy on a policy escalation block instead of auto-resuming', async () => {
  const { cwd } = await gitWorkspace('friction-escalation-');
  try {
    await coordinator.handleCommand(['init'], { cwd });
    await coordinator.handleCommand(['start', 'Escalation task'], { cwd });
    const stateFile = path.join(cwd, '.bridge', 'state.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    state.phase = 'blocked_user';
    state.block_kind = 'escalation';
    await fs.writeFile(stateFile, JSON.stringify(state));

    await assert.rejects(
      () => runner.start('Escalation task', { cwd, autonomous: false }),
      /bridge revise|bridge done/
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('resume after a provider-fault block skips the dead session and binds a fresh one', async () => {
  const { cwd } = await gitWorkspace('friction-skip-dead-session-');
  try {
    await coordinator.handleCommand(['init'], { cwd });
    await coordinator.handleCommand(['start', 'Skip dead session task'], { cwd });
    const stateFile = path.join(cwd, '.bridge', 'state.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    state.phase = 'blocked_user';
    state.block_kind = 'consultation_retry';
    state.hands_session_id = 'ses_dead_beef';
    state.blocked_reason = 'hands-propose failed [session ses_dead_beef]: Provider server error: UnknownError — Unexpected server error (ref err_dead).';
    await fs.writeFile(stateFile, JSON.stringify(state));

    let sawSessionArg = false;
    const runProcess = mockProvider((agent, args) => {
      if (agent === 'hands-propose') {
        sawSessionArg = args.includes('ses_dead_beef');
        return ok({ ...proposeOk('ses_reborn'), sessionID: 'ses_reborn' });
      }
      return ok({});
    });
    const result = await runner.resume({ cwd, autonomous: false, runProcess });
    assert.ok(!result.error, 'resume must succeed: ' + result.error);
    assert.equal(sawSessionArg, false, 'dead session id must never be passed to the provider');
    const after = await runner.readState({ cwd });
    assert.equal(after.hands_session_id, 'ses_reborn');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('start still refuses with remedy when recovery is required', async () => {
  const { cwd } = await gitWorkspace('friction-recovery-');
  try {
    await coordinator.handleCommand(['init'], { cwd });
    await coordinator.handleCommand(['start', 'Recovery task'], { cwd });
    const stateFile = path.join(cwd, '.bridge', 'state.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    state.phase = 'blocked_user';
    state.block_kind = 'escalation';
    state.recovery_required = true;
    await fs.writeFile(stateFile, JSON.stringify(state));

    await assert.rejects(
      () => runner.start('Recovery task', { cwd, autonomous: false }),
      /bridge recover/
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// ─── Fresh-session retry after server fault ──────────────────────────────────

test('provider server fault retries with a fresh session instead of the poisoned one', async () => {
  const { cwd } = await gitWorkspace('friction-fresh-session-');
  try {
    await coordinator.handleCommand(['init'], { cwd });
    await coordinator.handleCommand(['start', 'Fresh session task'], { cwd });
    let proposeCalls = 0;
    const runProcess = mockProvider((agent, args) => {
      if (agent === 'hands-propose') {
        proposeCalls += 1;
        if (proposeCalls === 1) return fail(providerFault('ses_poisoned'));
        assert.ok(!args.includes('ses_poisoned'), 'retry must not pass the poisoned session id');
        return ok({ ...proposeOk('ses_fresh'), sessionID: 'ses_fresh' });
      }
      return ok({});
    });
    const result = await runner.propose({ cwd, runProcess, retryDelayMs: 0, autonomous: false });
    assert.ok(!result.error, 'second attempt with a fresh session must succeed: ' + result.error);
    assert.equal(proposeCalls, 2, 'exactly one retry expected');
    const state = await runner.readState({ cwd });
    assert.equal(state.hands_session_id, 'ses_fresh', 'replacement session must be bound');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// ─── Humanized provider errors ────────────────────────────────────────────────

test('raw provider JSON errors are humanized before reaching the user', async () => {
  const { cwd } = await gitWorkspace('friction-humanize-');
  try {
    await coordinator.handleCommand(['init'], { cwd });
    await coordinator.handleCommand(['start', 'Humanize task'], { cwd });
    const runProcess = mockProvider(agent => {
      if (agent === 'hands-propose') return fail(providerFault('ses_x'));
      return ok({});
    });
    const result = await runner.propose({ cwd, runProcess, retryAttempts: 1, retryDelayMs: 0, autonomous: false });
    const reason = String(result.error || '');
    assert.match(reason, /Provider server error/);
    assert.match(reason, /err_friction/, 'provider ref must be preserved');
    assert.doesNotMatch(reason, /\{"type"/, 'raw JSON blob must not reach the user');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// ─── Provider session drop precision ──────────────────────────────────────────

test('resume on a blocked session whose prompt/guidance mentions "provider" or "server error" preserves the session id', async () => {
  const { cwd } = await gitWorkspace('friction-keep-session-');
  try {
    await coordinator.handleCommand(['init'], { cwd });
    await coordinator.handleCommand(['start', 'Fix provider authentication and prevent server error in billing'], { cwd });
    const stateFile = path.join(cwd, '.bridge', 'state.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    state.phase = 'blocked_user';
    state.block_kind = 'consultation_retry';
    state.hands_session_id = 'ses_keep_alive';
    state.blocked_reason = 'User guidance: review provider configuration to resolve server error in production';
    await fs.writeFile(stateFile, JSON.stringify(state));

    let sawSessionArg = false;
    let receivedSessionId = null;
    const runProcess = mockProvider((agent, args) => {
      if (agent === 'hands-propose') {
        const idx = args.indexOf('--session');
        if (idx !== -1) receivedSessionId = args[idx + 1];
        sawSessionArg = args.includes('ses_keep_alive');
        return ok({ ...proposeOk('ses_keep_alive'), sessionID: 'ses_keep_alive' });
      }
      return ok({});
    });
    const result = await runner.resume({ cwd, autonomous: false, runProcess });
    assert.ok(!result.error, 'resume must succeed: ' + result.error);
    assert.equal(sawSessionArg, true, 'session id must NOT be dropped when blocked reason merely mentions provider or server error');
    assert.equal(receivedSessionId, 'ses_keep_alive', 'bound session id must be passed to provider');
    const after = await runner.readState({ cwd });
    assert.equal(after.hands_session_id, 'ses_keep_alive', 'original session must remain bound');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('user-actionable blocks never trigger provider session drop even if message mentions provider fault', async () => {
  const { cwd } = await gitWorkspace('friction-user-actionable-');
  try {
    await coordinator.handleCommand(['init'], { cwd });
    await coordinator.handleCommand(['start', 'Actionable block task'], { cwd });
    const stateFile = path.join(cwd, '.bridge', 'state.json');

    for (const blockKind of ['needs_revision', 'escalation', 'dirty_tree', 'execution_recovery']) {
      const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      state.phase = 'blocked_user';
      state.block_kind = blockKind;
      state.hands_session_id = 'ses_actionable';
      state.recovery_required = blockKind === 'execution_recovery';
      state.blocked_reason = 'Provider server error: UnknownError — mock provider crash in ' + blockKind;
      await fs.writeFile(stateFile, JSON.stringify(state));

      // Attempting resume should NEVER clear hands_session_id
      await runner.resume({ cwd, autonomous: false });
      const after = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      assert.equal(after.hands_session_id, 'ses_actionable', `block_kind ${blockKind} must never drop session`);
    }
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('isProviderFaultReason distinguishes real provider crashes from tasks/guidance mentioning provider or server error', () => {
  // False positives that previously triggered session drop:
  assert.equal(runner.isProviderFaultReason('Fix provider authentication'), false);
  assert.equal(runner.isProviderFaultReason('Encountered server error in payment gateway'), false);
  assert.equal(runner.isProviderFaultReason('The cloud provider timed out on webhook delivery'), false);
  assert.equal(runner.isProviderFaultReason('Please configure the auth provider in settings.json'), false);
  assert.equal(runner.isProviderFaultReason('Internal server error in client test suite'), false);
  assert.equal(runner.isProviderFaultReason(''), false);
  assert.equal(runner.isProviderFaultReason(null), false);

  // Real provider crash signatures that must trigger session drop:
  assert.equal(runner.isProviderFaultReason('hands-propose failed (timed out) after 30s: Provider process exceeded the configured timeout.'), true);
  assert.equal(runner.isProviderFaultReason('hands-propose failed [session ses_123]: Provider server error: UnknownError — Unexpected server error (ref err_1).'), true);
  assert.equal(runner.isProviderFaultReason('hands-consult failed (after 2 attempts): hands-consult failed: provider exploded'), true);
  assert.equal(runner.isProviderFaultReason('hands-consult failed: Provider server error: UnknownError — 500 error'), true);
  assert.equal(runner.isProviderFaultReason('brain failed: 502 Bad Gateway'), true);
  assert.equal(runner.isProviderFaultReason('Provider server error: Connection reset by peer.'), true);
  assert.equal(runner.isProviderFaultReason('UnknownError: OpenCode runtime terminated unexpectedly'), true);
});
