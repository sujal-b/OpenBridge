'use strict';

// QA recovery / fault-injection E2E suite.
// Adversarial production-resilience tests for the full
// propose -> review -> consult -> execute -> review pipeline
// plus handover robustness, corruption resilience, and dashboard consistency.
// No production file is modified; if a genuine bug is found the failing test
// is kept and reported.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runProcess } = require('../bridge-adapter');
const { readSnapshot, allowedControls } = require('../bridge-inspector');
const {
  readState, runCommand, start, resume, revise, approve,
  reviewProposal, reviewResult, unlockAgent, invokeAgentWithRetry, AgentBusyError
} = require('../bridge-runner');

const coordinator = path.resolve(__dirname, '..', 'bridge-coordinator.js');
const bridgeCli = path.resolve(__dirname, '..', 'bridge.js');

// ---------------------------------------------------------------------------
// Harness (patterns from bridge-runner.test.js)
// ---------------------------------------------------------------------------

async function markBrainConsultation(args, options) {
  if (args[2] === 'hands-consult' && options && options.onEvent) {
    await options.onEvent({ type: 'tool.completed', tool: 'ask_codex' });
  }
}

async function createGitWorkspace(prefix) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.writeFile(path.join(cwd, '.gitignore'), '.bridge/\n.opencode/\n', 'utf8');
  await fs.writeFile(path.join(cwd, 'README.md'), '# Test project\n', 'utf8');
  const git = args => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, 'git ' + args.join(' ') + ' failed: ' + result.stderr);
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'qa@example.invalid']);
  git(['config', 'user.name', 'Mind-Limb QA']);
  git(['add', '.']);
  git(['commit', '-qm', 'baseline']);
  return cwd;
}

function consultationFor(args, sessionID) {
  const prompt = String(args.at(-1) || '');
  const assignment_id = (prompt.match(/Assignment ID: ([^\r\n]+)/) || [])[1];
  const revision = Number((prompt.match(/Revision: (\d+)/) || [])[1]);
  return {
    decision: 'approved',
    assignment_id,
    revision,
    summary: 'Brain confirmed the approved chunk.',
    brain_answer: 'Proceed with the approved files and focused validation.',
    sessionID
  };
}

function fakeProcess(output, extra = {}) {
  return async () => ({
    ok: true,
    code: 0,
    signal: null,
    stdout: output,
    stderr: '',
    timed_out: false,
    ...extra
  });
}

// Deterministic provider fault injector. `spec` maps an agent name to a rule:
//   { agent: { from: n, to: n|undefined, mode: 'timeout'|'fail'|'transient'|'revise'|'blocked-consult'|'blocked-exec' } }
// The rule fires for invocations from..to of that agent (1-based, per agent).
// No Math.random anywhere: every failure position is a fixed per-test index.
function makeProvider(cwd, { spec = {}, writeOnTimeoutExecute = false, sessionID = 'qa-session-1' } = {}) {
  const counts = {};
  const calls = [];
  const agentCalls = agent => {
    counts[agent] = (counts[agent] || 0) + 1;
    return counts[agent];
  };
  const ruleFor = (agent, n) => {
    const rule = spec[agent];
    if (!rule || !rule.mode) return null;
    const to = rule.to === undefined ? rule.from : rule.to;
    if (n < rule.from || n > to) return null;
    return rule;
  };
  const reply = async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) {
      return runProcess(command, args, options);
    }
    const agent = args[2];
    const n = agentCalls(agent);
    const prompt = String(args.at(-1) || '');
    calls.push({ agent, n });
    await markBrainConsultation(args, options);
    const rule = ruleFor(agent, n);
    if (rule) {
      if (agent === 'hands' && writeOnTimeoutExecute) {
        await fs.appendFile(path.join(cwd, 'README.md'), '\n# partial edit from timed-out HANDS\n', 'utf8');
      }
      if (rule.mode === 'timeout') {
        return { ok: false, code: null, signal: 'SIGTERM', stdout: '', stderr: 'provider timed out', timed_out: true };
      }
      if (rule.mode === 'fail') {
        return { ok: false, code: 9, signal: null, stdout: '', stderr: 'provider exploded', timed_out: false };
      }
      if (rule.mode === 'transient') {
        return { ok: true, code: 0, signal: null, stdout: JSON.stringify({
          decision: 'blocked', question: 'ask_codex could not start; retry?',
          context: 'MCP ask_codex spawn failed transiently', transient: true
        }), stderr: '', timed_out: false };
      }
      if (rule.mode === 'revise') {
        return { ok: true, code: 0, signal: null, stdout: JSON.stringify({
          decision: 'revise', summary: 'Narrow the chunk and keep it bounded.',
          feedback: 'Cut to one file and run one check.'
        }), stderr: '', timed_out: false };
      }
      if (rule.mode === 'blocked-consult') {
        return { ok: true, code: 0, signal: null, stdout: JSON.stringify({
          decision: 'blocked', question: 'Which scope boundary applies?', context: 'Ambiguous acceptance criteria.'
        }), stderr: '', timed_out: false };
      }
      if (rule.mode === 'blocked-exec') {
        return { ok: true, code: 0, signal: null, stdout: JSON.stringify({
          decision: 'blocked', question: 'Chunk scope is unclear.', context: 'Not safe to edit yet.'
        }), stderr: '', timed_out: false };
      }
    }
    if (agent === 'hands-propose') {
      return { ok: true, code: 0, signal: null, stdout: JSON.stringify({
        decision: 'propose', role: 'QA reliability engineer',
        summary: 'Bounded QA slice ' + n, files: ['README.md'], tests: ['node --check README.md'], sessionID
      }), stderr: '', timed_out: false };
    }
    if (agent === 'hands-consult') {
      if (/BRAIN-RESULT-REVIEW/i.test(prompt)) {
        return { ok: true, code: 0, signal: null, stdout: JSON.stringify({
          decision: 'complete', summary: 'Brain reviewed the executed chunk.'
        }), stderr: '', timed_out: false };
      }
      if (/BRAIN-REVIEW/i.test(prompt)) {
        return { ok: true, code: 0, signal: null, stdout: JSON.stringify({
          decision: 'approved', summary: 'Approve the bounded chunk.'
        }), stderr: '', timed_out: false };
      }
      return { ok: true, code: 0, signal: null, stdout: JSON.stringify(consultationFor(args, sessionID)), stderr: '', timed_out: false };
    }
    if (agent === 'hands-evaluate') {
      return { ok: true, code: 0, signal: null, stdout: JSON.stringify({
        decision: 'passed', summary: 'Focused checks passed.', tests: ['node --check README.md'], risks: []
      }), stderr: '', timed_out: false };
    }
    if (agent === 'hands') {
      return { ok: true, code: 0, signal: null, stdout: JSON.stringify({
        decision: 'completed', summary: 'Executed QA slice ' + n + '.', files: ['README.md'],
        tests: ['node --check README.md'], sessionID
      }), stderr: '', timed_out: false };
    }
    throw new Error('Unexpected agent: ' + agent);
  };
  return { reply, calls, counts: () => ({ ...counts }) };
}

// ---------------------------------------------------------------------------
// Invariant sweep: after every transition the store must stay healthy.
// ---------------------------------------------------------------------------

async function assertInvariants(cwd, { eventsMayBeBroken = false } = {}) {
  const bridge = path.join(cwd, '.bridge');
  const entries = await fs.readdir(bridge);
  for (const name of entries) {
    assert.ok(!name.endsWith('.tmp'), 'leftover .tmp file in .bridge: ' + name);
    assert.ok(name !== 'commit.pending.json', 'leftover pending commit: ' + name);
    assert.ok(name !== 'init.lock', 'leftover init lock: ' + name);
  }
  const raw = JSON.parse(await fs.readFile(path.join(bridge, 'state.json'), 'utf8'));
  assert.ok(raw && typeof raw === 'object', 'state.json must parse');
  assert.equal(typeof raw.event_seq, 'number', 'event_seq must stay numeric');
  const text = await fs.readFile(path.join(bridge, 'events.jsonl'), 'utf8');
  const seqs = [];
  for (const line of text.trim().split(/\r?\n/).filter(Boolean)) {
    try {
      seqs.push(JSON.parse(line).seq);
    } catch {
      if (!eventsMayBeBroken) assert.fail('events.jsonl contains an unparseable line');
    }
  }
  if (seqs.length) {
    for (let i = 1; i < seqs.length; i += 1) {
      assert.equal(seqs[i], seqs[i - 1] + 1, 'event_seq gap between lines ' + i + ' and ' + (i + 1));
    }
    assert.equal(seqs[seqs.length - 1], raw.event_seq, 'state event_seq must match the last audit event');
  }
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' });
  assert.equal(status.status, 0, 'git status failed');
  assert.ok(!/.bridge/i.test(status.stdout), 'bridge store leaked into the git worktree: ' + status.stdout);
  for (const lock of ['agent.lock', 'state.lock', 'actions.lock']) {
    try {
      await fs.access(path.join(bridge, lock));
      assert.fail(lock + ' still present after the pipeline');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function cleanup(cwd, extra = () => {}) {
  try { await extra(); } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

function autoOptions(cwd, provider, attempts = 1) {
  return { cwd, runProcess: provider.reply, retryAttempts: attempts, retryDelayMs: 0 };
}

// ---------------------------------------------------------------------------
// 1. Kill-chain injection: every single-point failure must recover to `done`.
// ---------------------------------------------------------------------------

test('kill chain: propose provider timeout -> raw block -> resume -> done', async () => {
  const cwd = await createGitWorkspace('qa-kill-propose-');
  const provider = makeProvider(cwd, { spec: { 'hands-propose': { from: 1, mode: 'timeout' } } });
  const opts = autoOptions(cwd, provider);
  try {
    const blocked = await start('QA kill chain', opts);
    assert.equal(blocked.state.phase, 'blocked_user');
    assert.equal(blocked.state.block_kind, null);
    assert.equal(blocked.state.recovery_required, false);
    // Proposals run in the planning phase; submitApproach only advances to
    // hands_proposing on success, so resume targets planning.
    assert.equal(blocked.state.resume_phase, 'planning');
    assert.match(blocked.error, /timed out/i);
    assert.deepEqual(allowedControls(blocked.state), ['revise', 'pause', 'resume', 'stop']);
    const done = await resume({ ...opts, autonomous: true });
    assert.equal(done.state.phase, 'done');
    assert.equal(provider.counts()['hands-propose'], 2, 'exactly one retried proposal');
    await assertInvariants(cwd);
  } finally {
    await cleanup(cwd);
  }
});

test('kill chain: proposal review provider failure -> escalation -> revise -> done', async () => {
  const cwd = await createGitWorkspace('qa-kill-review-');
  const provider = makeProvider(cwd, { spec: { 'hands-consult': { from: 1, to: 1, mode: 'fail' } } });
  const opts = autoOptions(cwd, provider);
  try {
    const blocked = await start('QA kill chain', opts);
    assert.equal(blocked.state.phase, 'blocked_user');
    assert.equal(blocked.state.block_kind, 'escalation');
    assert.equal(blocked.state.recovery_required, false);
    assert.equal(blocked.state.resume_phase, 'planning');
    assert.deepEqual(allowedControls(blocked.state), ['revise', 'pause', 'stop']);
    const resumeGuard = await resume({ ...opts, autonomous: true });
    assert.equal(resumeGuard.state.phase, 'blocked_user');
    assert.match(resumeGuard.error, /revised proposal/i);
    const done = await revise('Keep it strictly bounded.', { ...opts, autonomous: true });
    assert.equal(done.state.phase, 'done');
    await assertInvariants(cwd);
  } finally {
    await cleanup(cwd);
  }
});

test('kill chain: proposal review returns revise -> auto-advances, never blocks -> done', async () => {
  const cwd = await createGitWorkspace('qa-kill-revise-');
  const provider = makeProvider(cwd, { spec: { 'hands-consult': { from: 1, to: 1, mode: 'revise' } } });
  const opts = autoOptions(cwd, provider);
  try {
    const done = await start('QA kill chain', opts);
    assert.equal(done.state.phase, 'done');
    // One Brain revise request (revision bumps to 2) followed by a fresh
    // approach submission (bumps to 3): documented contract, see
    // bridge-autonomous.test.js "revision === 3".
    assert.equal(done.state.revision, 3);
    assert.equal(provider.counts()['hands-consult'], 4, 'revised review + consultation + fresh consultation + result review');
    assert.equal(provider.counts()['hands-propose'], 2);
    await assertInvariants(cwd);
  } finally {
    await cleanup(cwd);
  }
});

test('kill chain: consult provider timeout -> consultation_retry -> resume -> done', async () => {
  const cwd = await createGitWorkspace('qa-kill-consult-to-');
  const provider = makeProvider(cwd, { spec: { 'hands-consult': { from: 2, to: 2, mode: 'timeout' } } });
  const opts = autoOptions(cwd, provider);
  try {
    const blocked = await start('QA kill chain', opts);
    assert.equal(blocked.state.phase, 'blocked_user');
    assert.equal(blocked.state.block_kind, 'consultation_retry');
    assert.equal(blocked.state.recovery_required, false);
    assert.equal(blocked.state.resume_phase, 'hands_consulting');
    assert.deepEqual(allowedControls(blocked.state), ['pause', 'resume', 'stop']);
    const done = await resume({ ...opts, autonomous: true });
    assert.equal(done.state.phase, 'done');
    assert.equal(provider.counts()['hands-consult'], 4, 'review + failed consult + fresh consult + result review');
    await assertInvariants(cwd);
  } finally {
    await cleanup(cwd);
  }
});

test('kill chain: transient ask_codex consult block -> consultation_retry -> resume -> done', async () => {
  const cwd = await createGitWorkspace('qa-kill-consult-transient-');
  const provider = makeProvider(cwd, { spec: { 'hands-consult': { from: 2, to: 2, mode: 'transient' } } });
  const opts = autoOptions(cwd, provider);
  try {
    const blocked = await start('QA kill chain', opts);
    assert.equal(blocked.state.phase, 'blocked_user');
    assert.equal(blocked.state.block_kind, 'consultation_retry');
    assert.match(blocked.error, /ask_codex/i);
    const done = await resume({ ...opts, autonomous: true });
    assert.equal(done.state.phase, 'done');
    await assertInvariants(cwd);
  } finally {
    await cleanup(cwd);
  }
});

test('kill chain: consult material block -> needs_revision -> revise -> done', async () => {
  const cwd = await createGitWorkspace('qa-kill-consult-block-');
  const provider = makeProvider(cwd, { spec: { 'hands-consult': { from: 2, to: 2, mode: 'blocked-consult' } } });
  const opts = autoOptions(cwd, provider);
  try {
    const blocked = await start('QA kill chain', opts);
    assert.equal(blocked.state.phase, 'blocked_user');
    assert.equal(blocked.state.block_kind, 'needs_revision');
    assert.equal(blocked.state.resume_phase, 'hands_consulting');
    assert.deepEqual(allowedControls(blocked.state), ['revise', 'pause', 'stop']);
    const done = await revise('Confirm the scope boundary and proceed.', { ...opts, autonomous: true });
    assert.equal(done.state.phase, 'done');
    assert.equal(done.state.revision, 3);
    await assertInvariants(cwd);
  } finally {
    await cleanup(cwd);
  }
});

test('kill chain: execute provider failure -> execution_recovery -> recover -> resume -> done', async () => {
  const cwd = await createGitWorkspace('qa-kill-exec-fail-');
  const provider = makeProvider(cwd, { spec: { hands: { from: 1, to: 1, mode: 'fail' } } });
  const opts = autoOptions(cwd, provider);
  try {
    const blocked = await start('QA kill chain', opts);
    assert.equal(blocked.state.phase, 'blocked_user');
    assert.equal(blocked.state.block_kind, 'execution_recovery');
    assert.equal(blocked.state.recovery_required, true);
    // A hard interrupt leaves an executing-phase marker here; the
    // recovery_required flag is what gates resume, and recover rewrites this.
    assert.equal(blocked.state.resume_phase, 'hands_executing');
    assert.deepEqual(allowedControls(blocked.state), ['pause', 'stop', 'recover']);
    const guarded = await resume({ ...opts, autonomous: true });
    assert.equal(guarded.state.phase, 'blocked_user');
    assert.match(guarded.error, /bridge recover before bridge resume/i);
    const recovered = await runCommand(['recover'], opts);
    assert.equal(recovered.phase, 'blocked_user');
    assert.equal(recovered.recovery_required, false);
    assert.equal(recovered.block_kind, null);
    assert.equal(recovered.resume_phase, 'hands_consulting');
    assert.equal(recovered.execution_lease_id, null);
    assert.equal(recovered.revision_consumed, false);
    assert.equal(recovered.execution_claimed, false);
    const done = await resume({ ...opts, autonomous: true });
    assert.equal(done.state.phase, 'done');
    assert.equal(provider.counts().hands, 2, 'exactly one re-execution after recovery');
    await assertInvariants(cwd);
  } finally {
    await cleanup(cwd);
  }
});

test('kill chain: execute blocked decision -> execution_recovery -> recover -> resume -> done', async () => {
  const cwd = await createGitWorkspace('qa-kill-exec-blocked-');
  const provider = makeProvider(cwd, { spec: { hands: { from: 1, to: 1, mode: 'blocked-exec' } } });
  const opts = autoOptions(cwd, provider);
  try {
    const blocked = await start('QA kill chain', opts);
    assert.equal(blocked.state.phase, 'blocked_user');
    assert.equal(blocked.state.block_kind, 'execution_recovery');
    assert.equal(blocked.state.recovery_required, true);
    assert.match(blocked.state.blocked_reason, /scope is unclear/i);
    await runCommand(['recover'], opts);
    const done = await resume({ ...opts, autonomous: true });
    assert.equal(done.state.phase, 'done');
    await assertInvariants(cwd);
  } finally {
    await cleanup(cwd);
  }
});

test('kill chain: result review provider failure -> escalation -> revise -> done', async () => {
  const cwd = await createGitWorkspace('qa-kill-resultreview-');
  const provider = makeProvider(cwd, { spec: { 'hands-consult': { from: 3, to: 3, mode: 'fail' } } });
  const opts = autoOptions(cwd, provider);
  try {
    const blocked = await start('QA kill chain', opts);
    assert.equal(blocked.state.phase, 'blocked_user');
    assert.equal(blocked.state.block_kind, 'escalation');
    assert.equal(blocked.state.resume_phase, 'planning');
    const done = await revise('Re-run the same bounded chunk.', { ...opts, autonomous: true });
    assert.equal(done.state.phase, 'done');
    assert.ok(provider.counts()['hands-consult'] >= 6, 'both pipelines fully reviewed');
    await assertInvariants(cwd);
  } finally {
    await cleanup(cwd);
  }
});

test('kill chain: evaluator provider failure -> escalation -> revise -> done', async () => {
  const cwd = await createGitWorkspace('qa-kill-evaluator-');
  // hands-evaluate fails; the documented fallback (hands-consult evaluation)
  // also fails, so the chunk escalates.
  const provider = makeProvider(cwd, {
    spec: {
      'hands-evaluate': { from: 1, to: 1, mode: 'fail' },
      'hands-consult': { from: 3, to: 3, mode: 'fail' }
    }
  });
  const opts = autoOptions(cwd, provider);
  try {
    const blocked = await start('QA kill chain', opts);
    assert.equal(blocked.state.phase, 'blocked_user');
    assert.equal(blocked.state.block_kind, 'escalation');
    assert.match(blocked.error, /evaluation failed/i);
    const done = await revise('Evaluate the same chunk again.', { ...opts, autonomous: true });
    assert.equal(done.state.phase, 'done');
    assert.equal(provider.counts()['hands-evaluate'], 2, 'exactly one re-evaluation');
    await assertInvariants(cwd);
  } finally {
    await cleanup(cwd);
  }
});

// ---------------------------------------------------------------------------
// 2. Retry-then-fail: audit scenario — provider fails twice, then recovers.
// ---------------------------------------------------------------------------

test('retry-then-fail: consult fails attempts 1 and 2 -> consultation_retry -> resume with recovered provider -> done', async () => {
  const cwd = await createGitWorkspace('qa-retry-fail-');
  const provider = makeProvider(cwd, { spec: { 'hands-consult': { from: 2, to: 3, mode: 'fail' } } });
  const opts = autoOptions(cwd, provider, 2);
  try {
    const blocked = await start('QA audit scenario', opts);
    assert.equal(blocked.state.phase, 'blocked_user');
    assert.equal(blocked.state.block_kind, 'consultation_retry');
    assert.match(blocked.error, /after 2 attempts/, 'provider_failed must report both attempts');
    assert.equal(provider.counts()['hands-consult'], 3, 'review + fail + fail consumed before blocking');
    const done = await resume({ ...opts, autonomous: true });
    assert.equal(done.state.phase, 'done');
    assert.equal(provider.counts()['hands-consult'], 5, 'review + 2 fails + fresh consult + result review');
    assert.equal(provider.counts().hands, 1, 'exactly one execution after provider recovery');
    await assertInvariants(cwd);
  } finally {
    await cleanup(cwd);
  }
});

test('invokeAgentWithRetry: two failed attempts surface "(after 2 attempts)" then a clean run succeeds', async () => {
  let calls = 0;
  const failing = async () => {
    calls += 1;
    return { ok: false, code: 9, signal: null, stdout: '', stderr: 'down', timed_out: false };
  };
  await assert.rejects(
    () => invokeAgentWithRetry('hands-consult', 'prompt', { runProcess: failing, retryAttempts: 2, retryDelayMs: 0 }),
    error => error.code === 'provider_failed' && /after 2 attempts/.test(error.message)
  );
  assert.equal(calls, 2);
  const recovered = await invokeAgentWithRetry('hands-consult', 'prompt', {
    runProcess: fakeProcess(JSON.stringify({ decision: 'approved', summary: 'ok' })),
    retryAttempts: 2,
    retryDelayMs: 0
  });
  assert.equal(recovered.result.decision, 'approved');
});

// ---------------------------------------------------------------------------
// 3. Recovery after execution: partial change kept, fresh consultation,
//    single-use lease protection.
// ---------------------------------------------------------------------------

test('execution timeout after a file change: execution_recovery keeps the change, recover + resume use a FRESH consultation, claimed lease cannot be re-executed', async () => {
  const cwd = await createGitWorkspace('qa-recovery-');
  const provider = makeProvider(cwd, { spec: { hands: { from: 1, to: 1, mode: 'timeout' } }, writeOnTimeoutExecute: true });
  const opts = autoOptions(cwd, provider);
  try {
    const blocked = await start('QA recovery', opts);
    assert.equal(blocked.state.phase, 'blocked_user');
    assert.equal(blocked.state.block_kind, 'execution_recovery');
    assert.equal(blocked.state.recovery_required, true);
    const originalLease = blocked.state.execution_lease_id;
    assert.ok(originalLease);
    assert.equal(blocked.state.revision_consumed, true);
    assert.match(blocked.error, /may have partially changed files/i);

    // The partial working-tree change survives the block.
    const readme = await fs.readFile(path.join(cwd, 'README.md'), 'utf8');
    assert.match(readme, /partial edit from timed-out HANDS/, 'timed-out HANDS edit must be preserved');

    // While blocked the lease can never be re-claimed: the coordinator
    // refuses with a phase guard because the session is no longer executing.
    const reClaim = await runProcess(process.execPath, [coordinator, 'claim-execution', originalLease], { cwd });
    assert.equal(reClaim.ok, false, 'a blocked session must not accept a lease re-claim');
    assert.equal(provider.counts().hands, 1, 'execution must not run a second time before recovery');

    // Documented recovery: recover keeps the change, then resume starts a FRESH consultation.
    await runCommand(['recover'], opts);
    const resumed = await resume({ ...opts, autonomous: true });
    assert.equal(resumed.state.phase, 'done');
    const finalState = await readState(opts);
    assert.notEqual(finalState.execution_lease_id, originalLease, 'fresh consultation must mint a new lease');
    assert.equal(finalState.revision_consumed, true);
    assert.equal(finalState.recovery_required, false);
    assert.equal(finalState.block_kind, null);
    assert.equal(provider.counts()['hands-consult'], 4, 'review + original consultation + fresh consultation + result review');
    assert.equal(provider.counts().hands, 2, 'one original attempt + one post-recovery execution');
    await assertInvariants(cwd);
  } finally {
    await cleanup(cwd);
  }
});

test('single-use execution lease: a second claim of the same lease trips the execution_claimed guard before any provider call', async () => {
  const cwd = await createGitWorkspace('qa-lease-guard-');
  const provider = makeProvider(cwd);
  const opts = autoOptions(cwd, provider);
  try {
    await runCommand(['start', 'QA lease guard'], opts);
    await runCommand(['approach', 'Role: QA\nBounded check', '--files', 'README.md'], opts);
    await runCommand(['brain-approve', 'Approved'], opts);
    const approved = await readState(opts);
    await runCommand(['consult', JSON.stringify({
      decision: 'approved',
      assignment_id: approved.assignment_id,
      revision: approved.revision,
      summary: 'Brain confirmed.',
      brain_answer: 'Proceed.'
    })], opts);
    const executing = await readState(opts);
    const first = await runProcess(process.execPath, [coordinator, 'claim-execution', executing.execution_lease_id], { cwd });
    assert.equal(first.ok, true, 'first claim must succeed');
    const second = await runProcess(process.execPath, [coordinator, 'claim-execution', executing.execution_lease_id], { cwd });
    assert.equal(second.ok, false, 'second claim must be refused');
    assert.match(second.stderr, /already claimed/i);
    assert.equal(provider.counts().hands, undefined, 'no HANDS provider call may run after the guard trips');
    await assertInvariants(cwd);
  } finally {
    await cleanup(cwd);
  }
});

// ---------------------------------------------------------------------------
// 4. Handover integrity under restart: each phase re-reads state from disk.
// ---------------------------------------------------------------------------

test('handover: propose, review, approve+consult+execute, result review as four fresh top-level calls preserve approach/assignment/revision/session', async () => {
  const cwd = await createGitWorkspace('qa-handover-');
  const provider = makeProvider(cwd);
  const opts = autoOptions(cwd, provider);
  try {
    const proposed = await start('QA handover task', { ...opts, autonomous: false, manual: true });
    assert.equal(proposed.state.phase, 'brain_approving');
    const handover = {
      approach_summary: proposed.state.approach.summary,
      approach_files: proposed.state.approach.files,
      approach_role: proposed.state.approach.role,
      assignment_id: proposed.state.assignment_id,
      revision: proposed.state.revision,
      session: proposed.state.hands_session_id,
      task: proposed.state.task
    };

    const reviewed = await reviewProposal(await readState(opts), opts);
    assert.equal(reviewed.result.decision, 'approved');

    const executed = await approve('MIND approves', opts);
    assert.equal(executed.state.phase, 'brain_reviewing');

    const finished = await reviewResult(executed, opts);
    assert.equal(finished.state.phase, 'done');

    const finalState = await readState(opts);
    assert.equal(finalState.approach.summary, handover.approach_summary, 'approach summary lost');
    assert.deepEqual(finalState.approach.files, handover.approach_files, 'approved files lost');
    assert.equal(finalState.approach.role, handover.approach_role, 'approach role lost');
    assert.equal(finalState.assignment_id, handover.assignment_id, 'assignment_id lost');
    assert.equal(finalState.revision, handover.revision, 'revision lost');
    assert.equal(finalState.hands_session_id, handover.session, 'HANDS session lost');
    assert.equal(finalState.task, handover.task, 'task lost');
    assert.equal(finalState.approach.handoff.status, 'brain_approved', 'handoff payload lost');
    assert.equal(finalState.consultation.assignment_id, handover.assignment_id, 'consultation payload lost');
    assert.equal(finalState.consultation.revision, handover.revision, 'consultation revision lost');
    await assertInvariants(cwd);
  } finally {
    await cleanup(cwd);
  }
});

// ---------------------------------------------------------------------------
// 5. Corruption resilience.
// ---------------------------------------------------------------------------

test('corruption: truncated state.json — coordinator status and readState must recover without crashing', async () => {
  const cwd = await createGitWorkspace('qa-corrupt-truncate-');
  const provider = makeProvider(cwd);
  try {
    await runCommand(['init'], autoOptions(cwd, provider));
    await fs.writeFile(path.join(cwd, '.bridge', 'state.json'), '{"phase":"plann', 'utf8');
    await cleanup(cwd, async () => {
      const status = await runProcess(process.execPath, [coordinator, 'status'], { cwd });
      assert.equal(status.ok, true, 'coordinator status must survive truncated state.json; got: ' + status.stderr);
      const state = await readState({ cwd, runProcess: provider.reply });
      assert.ok(state && typeof state === 'object', 'runner readState must recover a usable state');
      await assertInvariants(cwd);
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('corruption: hostile phase null must be normalized back to a valid phase', async () => {
  const cwd = await createGitWorkspace('qa-corrupt-phase-');
  const provider = makeProvider(cwd);
  const opts = autoOptions(cwd, provider);
  try {
    const proposed = await start('QA corrupt task', { ...opts, autonomous: false, manual: true });
    assert.equal(proposed.state.phase, 'brain_approving');
    const file = path.join(cwd, '.bridge', 'state.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    raw.phase = null;
    await fs.writeFile(file, JSON.stringify(raw), 'utf8');
    await cleanup(cwd, async () => {
      const status = await runProcess(process.execPath, [coordinator, 'status'], { cwd });
      assert.equal(status.ok, true, 'status should not crash on hostile phase; got: ' + status.stderr);
      const started = await runProcess(process.execPath, [coordinator, 'start', 'Recovery task'], { cwd });
      assert.equal(started.ok, true, 'coordinator start must recover from phase:null; got: ' + started.stderr);
      await assertInvariants(cwd);
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('corruption: hostile event_seq "NaN" must be coerced to a number so continuity survives', async () => {
  const cwd = await createGitWorkspace('qa-corrupt-seq-');
  const provider = makeProvider(cwd);
  const opts = autoOptions(cwd, provider);
  try {
    await start('QA corrupt task', { ...opts, autonomous: false, manual: true });
    const file = path.join(cwd, '.bridge', 'state.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    raw.event_seq = 'NaN';
    await fs.writeFile(file, JSON.stringify(raw), 'utf8');
    await cleanup(cwd, async () => {
      await runCommand(['activity', 'mind', 'post-corruption pulse'], opts);
      const repaired = await readState(opts);
      assert.equal(typeof repaired.event_seq, 'number', 'event_seq must be numeric after the next commit');
      await assertInvariants(cwd);
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('corruption: hostile block_kind 123 is tolerated by the dashboard and resume self-heals to done', async () => {
  const cwd = await createGitWorkspace('qa-corrupt-kind-');
  const provider = makeProvider(cwd);
  const opts = autoOptions(cwd, provider);
  try {
    // Real, reachable blocked shape: a material consultation block that the
    // coordinator records as needs_revision with resume_phase hands_consulting.
    await runCommand(['start', 'QA corrupt kind task'], opts);
    await runCommand(['approach', 'Role: reliability architect\nBounded one-line check', '--files', 'README.md'], opts);
    await runCommand(['bind-session', 'qa-session-1'], opts);
    await runCommand(['brain-approve', 'Approved'], opts);
    await runCommand(['block', '--kind', 'needs_revision', 'Acceptance criteria need a decision'], opts);
    const file = path.join(cwd, '.bridge', 'state.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(raw.resume_phase, 'hands_consulting');
    raw.block_kind = 123;
    await fs.writeFile(file, JSON.stringify(raw), 'utf8');
    await cleanup(cwd, async () => {
      const status = await runProcess(process.execPath, [coordinator, 'status'], { cwd });
      assert.equal(status.ok, true, 'status must not crash on hostile block_kind; got: ' + status.stderr);
      const snapshot = await readSnapshot(cwd);
      assert.ok(Array.isArray(snapshot.controls), 'dashboard controls must stay an array');
      const resumed = await resume({ ...opts, autonomous: true });
      assert.equal(resumed.state.phase, 'done', 'resume must self-heal a hostile block_kind back to an active pipeline');
      await assertInvariants(cwd);
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('corruption: events.jsonl broken line is skipped by log, inspector, and later commits', async () => {
  const cwd = await createGitWorkspace('qa-corrupt-events-');
  const provider = makeProvider(cwd);
  const opts = autoOptions(cwd, provider);
  try {
    await start('QA corrupt events task', { ...opts, autonomous: false, manual: true });
    await fs.appendFile(path.join(cwd, '.bridge', 'events.jsonl'), 'this is not json at all\n', 'utf8');
    const logResult = await runProcess(process.execPath, [coordinator, 'log', '20'], { cwd });
    assert.equal(logResult.ok, true, 'coordinator log must skip the broken line');
    assert.match(logResult.stdout, /approach_submitted/, 'valid events must still be listed');
    await runCommand(['activity', 'mind', 'pulse after corruption'], opts);
    const snapshot = await readSnapshot(cwd);
    assert.ok(snapshot.warnings.some(w => w.source === 'events.jsonl' && w.type === 'malformed'), 'inspector must warn on the broken line');
    const seqs = snapshot.events.map(event => event.seq);
    for (let i = 1; i < seqs.length; i += 1) {
      assert.equal(seqs[i], seqs[i - 1] + 1, 'valid events must stay contiguous across the broken line');
    }
    await assertInvariants(cwd, { eventsMayBeBroken: true });
  } finally {
    await cleanup(cwd);
  }
});

test('corruption: stale agent.lock pointing to a dead PID blocks resume, unlock-agent clears it, pipeline completes', async () => {
  const cwd = await createGitWorkspace('qa-corrupt-lock-');
  const provider = makeProvider(cwd, { spec: { 'hands-consult': { from: 2, to: 2, mode: 'timeout' } } });
  const opts = autoOptions(cwd, provider);
  try {
    const blocked = await start('QA stale lock', opts);
    assert.equal(blocked.state.block_kind, 'consultation_retry');
    await fs.writeFile(path.join(cwd, '.bridge', 'agent.lock'), JSON.stringify({
      pid: 99999999,
      token: 'stale-token',
      agent: 'hands',
      started_at: new Date().toISOString()
    }) + '\n', 'utf8');
    await assert.rejects(() => resume({ ...opts, autonomous: true }), AgentBusyError);
    const unlocked = await unlockAgent(opts);
    assert.equal(unlocked.unlocked, true);
    const done = await resume({ ...opts, autonomous: true });
    assert.equal(done.state.phase, 'done');
    await assertInvariants(cwd);
  } finally {
    await cleanup(cwd);
  }
});

test('corruption: partial .bridge (files missing) is rebuilt by ensureStore without losing the session', async () => {
  const cwd = await createGitWorkspace('qa-corrupt-store-');
  const provider = makeProvider(cwd);
  const opts = autoOptions(cwd, provider);
  try {
    const proposed = await start('QA partial store', { ...opts, autonomous: false, manual: true });
    const sessionId = proposed.state.session_id;
    const assignmentId = proposed.state.assignment_id;
    for (const name of ['events.jsonl', 'plan.md', 'policy.json']) {
      await fs.unlink(path.join(cwd, '.bridge', name));
    }
    await cleanup(cwd, async () => {
      const status = await runProcess(process.execPath, [coordinator, 'status'], { cwd });
      assert.equal(status.ok, true, 'status must rebuild missing store files');
      for (const name of ['events.jsonl', 'plan.md', 'policy.json']) {
        await fs.access(path.join(cwd, '.bridge', name));
      }
      const state = await readState(opts);
      assert.equal(state.session_id, sessionId, 'session must survive partial store loss');
      assert.equal(state.assignment_id, assignmentId, 'assignment must survive partial store loss');
      assert.equal(state.phase, 'brain_approving', 'phase must survive partial store loss');
      await assertInvariants(cwd);
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Dashboard-level consistency and the real CLI.
// ---------------------------------------------------------------------------

test('dashboard: allowedControls offers exactly the documented control set per block kind, and bridge.js status renders each', async () => {
  const expected = {
    needs_revision: ['revise', 'pause', 'stop'],
    consultation_retry: ['pause', 'resume', 'stop'],
    execution_recovery: ['pause', 'stop', 'recover'],
    escalation: ['revise', 'pause', 'stop']
  };
  for (const [kind, controls] of Object.entries(expected)) {
    const cwd = await createGitWorkspace('qa-dash-' + kind + '-');
    const provider = makeProvider(cwd);
    const opts = autoOptions(cwd, provider, 1);
    try {
      const blocked = await produceBlock(kind, cwd, opts);
      assert.equal(blocked.phase, 'blocked_user', kind + ': must block the user');
      const state = await readState(opts);
      assert.deepEqual(allowedControls(state), controls, 'allowedControls mismatch for ' + kind);
      const cli = spawnSync(process.execPath, [bridgeCli, 'status', '--project', cwd], { cwd, encoding: 'utf8' });
      assert.equal(cli.status, 0, bridgeCli + ' status crashed for ' + kind + ': ' + cli.stderr);
      assert.match(cli.stdout, /Phase: blocked_user/, 'CLI must render the blocked phase for ' + kind);
      assert.match(cli.stdout, /Task: QA dashboard block/, 'CLI must render the task for ' + kind);
      if (kind === 'execution_recovery') {
        assert.equal(state.recovery_required, true, 'execution_recovery must require recovery');
      }
      await assertInvariants(cwd);
    } finally {
      await cleanup(cwd);
    }
  }
});

// Drives the coordinator directly to each canonical blocked state.
async function produceBlock(kind, cwd, opts) {
  await runCommand(['start', 'QA dashboard block'], opts);
  if (kind === 'escalation') return runCommand(['block', '--kind', 'escalation', 'Human decision needed'], opts);
  await runCommand(['approach', 'Role: QA\nOne bounded check', '--files', 'README.md'], opts);
  await runCommand(['brain-approve', 'Approved'], opts);
  if (kind === 'needs_revision') return runCommand(['block', '--kind', 'needs_revision', 'User wants a change'], opts);
  if (kind === 'consultation_retry') return runCommand(['block', '--kind', 'consultation_retry', 'ask_codex temporarily unavailable'], opts);
  if (kind === 'execution_recovery') {
    const state = await readState(opts);
    const consultation = {
      decision: 'approved',
      assignment_id: state.assignment_id,
      revision: state.revision,
      summary: 'Brain confirmed.',
      brain_answer: 'Proceed.'
    };
    await runCommand(['consult', JSON.stringify(consultation)], opts);
    const executing = await readState(opts);
    await runCommand(['claim-execution', executing.execution_lease_id], opts);
    return runCommand(['block', 'HANDS interrupted by process loss'], opts);
  }
  throw new Error('unknown kind: ' + kind);
}

// ---------------------------------------------------------------------------
// 7. Invariant sweep over a full autonomous lifecycle.
// ---------------------------------------------------------------------------

test('invariant sweep: full autonomous lifecycle leaves seq contiguous, no temp files, no git pollution, no locks', async () => {
  const cwd = await createGitWorkspace('qa-invariant-');
  const provider = makeProvider(cwd);
  const opts = autoOptions(cwd, provider);
  try {
    const done = await start('QA invariant sweep', opts);
    assert.equal(done.state.phase, 'done');
    await assertInvariants(cwd);
    const snapshot = await readSnapshot(cwd);
    assert.equal(snapshot.state.phase, 'done');
    assert.equal(snapshot.warnings.length, 0, 'dashboard must report zero warnings on a healthy session');
    const bridgeEntries = await fs.readdir(path.join(cwd, '.bridge'));
    assert.deepEqual(
      bridgeEntries.slice().sort(),
      ['actions.jsonl', 'actions.seq', 'events.jsonl', 'plan.md', 'policy.json', 'state.json'],
      'store must contain exactly the canonical files'
    );
    const gitLog = spawnSync('git', ['log', '--oneline', '-3'], { cwd, encoding: 'utf8' });
    assert.equal(gitLog.status, 0);
    assert.equal(gitLog.stdout.trim().split(/\r?\n/).length, 1, 'bridge must not create commits in the worktree');
    assert.match(gitLog.stdout, /baseline/);
  } finally {
    await cleanup(cwd);
  }
});