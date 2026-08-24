'use strict';
// Senior-level adversarial stress tests: concurrency, agent locks, and
// timeout/event races during proposals and consultation.
// No real sleeps: in-process races use promise gating; subprocess races use
// spawn storms. Clean workspaces in finally.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { runProcess } = require('../bridge-adapter');
const {
  start: startRunner,
  resume: resumeRunner,
  approve: approveRunner,
  propose,
  consult,
  execute,
  invokeAgentWithRetry,
  unlockAgent,
  withAgentLock,
  AgentBusyError
} = require('../bridge-runner');

const coordinator = path.resolve(__dirname, '..', 'bridge-coordinator.js');
const DEAD_PID = 2147483647;

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function gate(trigger = null, release = null) {
  const started = trigger || deferred();
  const unblock = release || deferred();
  return { started, unblock };
}

function coordinatorPassthrough(command, args, options) {
  if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
  return null;
}

function ok(output, extra = {}) {
  return { ok: true, code: 0, signal: null, stdout: JSON.stringify(output), stderr: '', timed_out: false, ...extra };
}

function gateProvider(handle, behavior) {
  return async (command, args, options) => {
    const real = coordinatorPassthrough(command, args, options);
    if (real) return real;
    if (behavior.before) await behavior.before(args, options);
    if (handle.started) handle.started.resolve();
    await handle.unblock.promise;
    return behavior.output(command, args, options);
  };
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

function proposeOutput(sessionID = 'race-session') {
  return {
    decision: 'propose',
    summary: 'Small racy chunk',
    files: ['README.md'],
    tests: ['read README'],
    sessionID
  };
}

function flowMock(sessionID = 'race-session') {
  return async (command, args, options) => {
    const real = coordinatorPassthrough(command, args, options);
    if (real) return real;
    if (args[2] === 'hands-propose') return ok(proposeOutput(sessionID));
    if (args[2] === 'hands-consult') {
      await options.onEvent?.({ type: 'tool.completed', tool: 'ask_codex' });
      return ok(consultationFor(args, sessionID));
    }
    return ok({ decision: 'completed', summary: 'Chunk done', files: ['README.md'], tests: ['read README'], sessionID });
  };
}

async function createGitWorkspace(prefix) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
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

function lockPath(cwd) {
  return path.join(cwd, '.bridge', 'agent.lock');
}

async function lockExists(cwd) {
  try {
    await fs.access(lockPath(cwd));
    return true;
  } catch {
    return false;
  }
}

async function readStateFile(cwd) {
  return JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'state.json'), 'utf8'));
}

async function readEvents(cwd) {
  const text = await fs.readFile(path.join(cwd, '.bridge', 'events.jsonl'), 'utf8');
  const events = [];
  let dangling = '';
  for (const line of text.trim().split(/\r?\n/).filter(Boolean)) {
    try { events.push(JSON.parse(line)); } catch { dangling = line; }
  }
  return { events, dangling };
}

async function assertFinalIntegrity(cwd) {
  const { events, dangling } = await readEvents(cwd);
  assert.equal(dangling, '', 'dangling or corrupt JSONL line in events.jsonl');
  events.forEach((event, index) => assert.equal(event.seq, index, 'event seq gap at index ' + index));
  const files = await fs.readdir(path.join(cwd, '.bridge'));
  assert.deepEqual(files.filter(name => name.endsWith('.tmp')), [], 'leftover .tmp files in .bridge');
  return { state: await readStateFile(cwd), events };
}

async function assertLightIntegrity(cwd) {
  const state = await readStateFile(cwd);
  await readEvents(cwd);
  return state;
}

function run(cwd, args, expected = 0) {
  const result = spawnSync(process.execPath, [coordinator, ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, expected, 'Unexpected exit for ' + args.join(' ') + '\n' + result.stdout + result.stderr);
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

async function planningWorkspace() {
  const cwd = await createGitWorkspace('qa-race-');
  await runProcess(process.execPath, [coordinator, 'init'], { cwd });
  await runProcess(process.execPath, [coordinator, 'start', 'QA race task'], { cwd });
  return cwd;
}

async function consultingWorkspace() {
  const cwd = await planningWorkspace();
  const got = await propose({ cwd, manual: true, runProcess: flowMock('qa-consult-session'), retryDelayMs: 0 });
  assert.equal(got.state.phase, 'brain_approving', 'proposal should reach brain_approving');
  run(cwd, ['approve', 'QA approved']);
  run(cwd, ['bind-session', 'qa-consult-session']);
  assert.equal((await readStateFile(cwd)).phase, 'hands_consulting');
  return cwd;
}

async function executingWorkspace() {
  const cwd = await consultingWorkspace();
  const state = await readStateFile(cwd);
  run(cwd, ['consult', JSON.stringify({
    decision: 'approved',
    assignment_id: state.assignment_id,
    revision: state.revision,
    summary: 'Brain confirmed the approved chunk.',
    brain_answer: 'Proceed with the approved files and focused validation.'
  })]);
  assert.equal((await readStateFile(cwd)).phase, 'hands_executing');
  return cwd;
}

// ---------------------------------------------------------------- lock exclusivity

test('propose in-flight: second propose is AgentBusyError and files stay intact', async () => {
  const cwd = await planningWorkspace();
  const h = gate();
  const first = propose({
    cwd,
    runProcess: gateProvider(h, { output: () => ok(proposeOutput('lock-propose-session')) }),
    retryDelayMs: 0
  });
  await h.started.promise;
  assert.equal(await lockExists(cwd), true, 'agent.lock must exist while provider in flight');
  const state = await assertLightIntegrity(cwd);
  assert.equal(state.phase, 'planning', 'no state mutation while proposal in flight');

  await assert.rejects(
    () => propose({ cwd, runProcess: flowMock(), retryDelayMs: 0 }),
    error => error instanceof AgentBusyError && error.code === 'agent_busy'
  );
  await assertLightIntegrity(cwd);

  h.unblock.resolve();
  const outcome = await first;
  assert.equal(outcome.state.phase, 'brain_approving');
  assert.equal(await lockExists(cwd), false, 'agent.lock must be released after success');
  const finalState = (await assertFinalIntegrity(cwd)).state;
  assert.equal(finalState.hands_session_id, 'lock-propose-session');
  assert.match(finalState.approach.summary, /Small racy chunk/);
});

test('consult in-flight: locked out, coordinator start rejected, third call executes', async () => {
  const cwd = await consultingWorkspace();
  const h = gate();
  const first = consult({
    cwd,
    runProcess: gateProvider(h, {
      output: async (command, args, options) => {
        await options.onEvent?.({ type: 'tool.completed', tool: 'ask_codex' });
        return ok(consultationFor(args, 'qa-consult-session'));
      }
    }),
    retryDelayMs: 0
  });
  await h.started.promise;
  assert.equal(await lockExists(cwd), true);

  await assert.rejects(
    () => consult({ cwd, runProcess: flowMock(), retryDelayMs: 0 }),
    error => error instanceof AgentBusyError && error.code === 'agent_busy'
  );
  run(cwd, ['start', 'Intruder task'], 1);

  h.unblock.resolve();
  const consulted = await first;
  assert.equal(consulted.state.phase, 'hands_executing');
  assert.equal(await lockExists(cwd), false, 'lock released after consultation');

  const executed = await execute({ cwd, autonomous: false, runProcess: flowMock('qa-consult-session'), retryDelayMs: 0 });
  assert.equal(executed.state.phase, 'brain_reviewing');
  assert.equal(await lockExists(cwd), false);
  const final = await assertFinalIntegrity(cwd);
  assert.equal(final.state.consultation.decision, 'approved');
  assert.equal(final.state.execution_claimed, true);
  assert.equal(final.events.filter(event => event.type === 'brain_consulted').length, 1);
});

test('start() while a proposal is in flight is AgentBusyError, then a retry succeeds', async () => {
  const cwd = await planningWorkspace();
  const h = gate();
  const first = startRunner('QA race task', {
    cwd,
    autonomous: false,
    manual: true,
    runProcess: gateProvider(h, { output: () => ok(proposeOutput('start-lock-session')) }),
    retryDelayMs: 0
  });
  await h.started.promise;
  await assert.rejects(
    () => startRunner('QA race task', { cwd, autonomous: false, manual: true, runProcess: flowMock(), retryDelayMs: 0 }),
    error => error instanceof AgentBusyError && error.code === 'agent_busy'
  );
  h.unblock.resolve();
  const outcome = await first;
  assert.equal(outcome.state.phase, 'brain_approving');
  assert.equal(await lockExists(cwd), false);
  await assertFinalIntegrity(cwd);
});

// ---------------------------------------------------------------- crash during lock

test('provider crash beyond retries frees the agent lock for the next run', async () => {
  const cwd = await planningWorkspace();
  let providerCalls = 0;
  const crashMock = async (command, args, options) => {
    const real = coordinatorPassthrough(command, args, options);
    if (real) return real;
    providerCalls += 1;
    return { ok: false, code: 1, signal: null, stdout: '', stderr: 'permission denied', timed_out: false };
  };
  const crashed = await propose({ cwd, runProcess: crashMock, retryDelayMs: 0 });
  assert.equal(crashed.state.phase, 'blocked_user');
  assert.match(crashed.error, /permission denied/);
  assert.equal(providerCalls, 1, 'non-retryable failure must not re-run the provider');
  assert.equal(await lockExists(cwd), false, 'lock must be released after a crash path');

  const resumed = await resumeRunner({ cwd, autonomous: false, manual: true, runProcess: flowMock('crash-recovery-session'), retryDelayMs: 0 });
  assert.equal(resumed.state.phase, 'brain_approving');
  assert.equal(resumed.state.hands_session_id, 'crash-recovery-session');
  assert.equal(await lockExists(cwd), false);
  await assertFinalIntegrity(cwd);
});

test('provider exception thrown mid-lock frees the lock and blocks cleanly', async () => {
  const cwd = await planningWorkspace();
  const boomMock = async (command, args, options) => {
    const real = coordinatorPassthrough(command, args, options);
    if (real) return real;
    throw new Error('provider process blew up');
  };
  const crashed = await propose({ cwd, runProcess: boomMock, retryDelayMs: 0 });
  assert.equal(crashed.state.phase, 'blocked_user');
  assert.match(crashed.error, /blew up/);
  assert.equal(await lockExists(cwd), false, 'lock must not leak on an exception path');
  await assertFinalIntegrity(cwd);
});

test('stale leaked agent.lock blocks propose until explicit unlock, then recovery works', async () => {
  const cwd = await planningWorkspace();
  const file = lockPath(cwd);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ pid: DEAD_PID, token: 'ghost', role: 'hands' }) + '\n', 'utf8');
  await assert.rejects(
    () => propose({ cwd, runProcess: flowMock(), retryDelayMs: 0 }),
    error => error instanceof AgentBusyError && error.code === 'agent_busy'
  );
  assert.equal((await readStateFile(cwd)).phase, 'planning', 'no mutation while locked');

  const removed = await unlockAgent({ cwd });
  assert.equal(removed.unlocked, true);
  const outcome = await propose({ cwd, runProcess: flowMock('stale-recovered-session'), retryDelayMs: 0 });
  assert.equal(outcome.state.phase, 'brain_approving');
  assert.equal(await lockExists(cwd), false);
  await assertFinalIntegrity(cwd);
});

test('unlockAgent refuses live locks, accepts aged pid-less locks', async () => {
  const cwd = await planningWorkspace();
  const file = lockPath(cwd);
  await fs.writeFile(file, JSON.stringify({ pid: process.pid, token: 'mine', role: 'hands' }) + '\n', 'utf8');
  await assert.rejects(() => unlockAgent({ cwd }), /live process/);
  const old = new Date(Date.now() - 60000);
  await fs.utimes(file, old, old);
  await assert.rejects(() => unlockAgent({ cwd }), /live process/, 'live pid must win over age');
  await fs.writeFile(file, JSON.stringify({ token: 'anon', role: 'hands' }) + '\n', 'utf8');
  await fs.utimes(file, old, old);
  const removed = await unlockAgent({ cwd });
  assert.equal(removed.unlocked, true);
  const outcome = await propose({ cwd, runProcess: flowMock('unlock-then-propose'), retryDelayMs: 0 });
  assert.equal(outcome.state.phase, 'brain_approving');
});

test('coordinator recover refuses a live agent.lock but auto-cleans a dead-pid stale one', async () => {
  const cwd = await executingWorkspace();
  const file = lockPath(cwd);
  await fs.writeFile(file, JSON.stringify({ pid: process.pid, token: 'live', role: 'hands' }) + '\n', 'utf8');
  run(cwd, ['recover'], 1);
  assert.equal((await readStateFile(cwd)).phase, 'hands_executing', 'recover must not touch state while live lock held');

  await fs.writeFile(file, JSON.stringify({ pid: DEAD_PID, token: 'ghost', role: 'hands' }) + '\n', 'utf8');
  run(cwd, ['recover']);
  const recovered = await readStateFile(cwd);
  assert.equal(recovered.phase, 'blocked_user');
  assert.equal(recovered.resume_phase, 'hands_consulting');
  assert.equal(recovered.recovery_required, false);
  assert.equal(await lockExists(cwd), false, 'stale agent.lock must be removed by the recover path');
  await assertFinalIntegrity(cwd);
});

// ---------------------------------------------------------------- stale state races

test('stale state: concurrent approach during an in-flight proposal yields stale_state without mutation', async () => {
  const cwd = await planningWorkspace();
  const h = gate();
  const inFlight = propose({
    cwd,
    runProcess: gateProvider(h, { output: () => ok(proposeOutput('stale-approach-session')) }),
    retryDelayMs: 0
  });
  await h.started.promise;
  run(cwd, ['approach', 'Racy proposal from the side channel', '--files', 'README.md', '--manual']);
  assert.equal((await readStateFile(cwd)).phase, 'brain_approving');

  h.unblock.resolve();
  const outcome = await inFlight;
  assert.match(outcome.error, /stale_state|changed while the agent was starting|found brain_approving/);
  assert.equal(outcome.state.phase, 'brain_approving', 'must return the CURRENT state, not block over it');
  assert.match(outcome.state.approach.summary, /Racy proposal from the side channel/);
  assert.equal(outcome.state.revision, 1);
  const final = await assertFinalIntegrity(cwd);
  assert.equal(final.events.filter(event => event.type === 'approach_submitted').length, 1, 'runner must not replay the approach');
  assert.equal(await lockExists(cwd), false);
});

test('stale state: concurrent coordinator start during an in-flight proposal is rejected, not clobbered', async () => {
  const cwd = await planningWorkspace();
  const h = gate();
  const inFlight = propose({
    cwd,
    manual: true,
    runProcess: gateProvider(h, { output: () => ok(proposeOutput('stale-start-session')) }),
    retryDelayMs: 0
  });
  await h.started.promise;
  const intruder = run(cwd, ['start', 'Intruder task replaced the assignment'], 1);
  assert.match(intruder.stderr, /Invalid transition/, 'coordinator start must reject a live planning proposal');

  h.unblock.resolve();
  const outcome = await inFlight;
  assert.equal(outcome.error, undefined, 'in-flight proposal must complete untouched');
  assert.equal(outcome.state.phase, 'brain_approving');
  assert.equal(outcome.state.task, 'QA race task', 'original task must win');
  assert.equal(outcome.state.revision, 1);
  const final = await assertFinalIntegrity(cwd);
  assert.equal(final.events.filter(event => event.type === 'assignment_created').length, 1);
  assert.equal(await lockExists(cwd), false);
});

test('stale state: concurrent coordinator consult during an in-flight consultation yields current state', async () => {
  const cwd = await consultingWorkspace();
  const h = gate();
  const inFlight = consult({
    cwd,
    runProcess: gateProvider(h, {
      output: async (command, args, options) => {
        await options.onEvent?.({ type: 'tool.completed', tool: 'ask_codex' });
        return ok(consultationFor(args, 'qa-consult-session'));
      }
    }),
    retryDelayMs: 0
  });
  await h.started.promise;
  const state = await readStateFile(cwd);
  run(cwd, ['consult', JSON.stringify({
    decision: 'approved',
    assignment_id: state.assignment_id,
    revision: state.revision,
    summary: 'Side channel completed the consultation.',
    brain_answer: 'Proceed with the approved files.'
  })]);

  h.unblock.resolve();
  const outcome = await inFlight;
  assert.match(outcome.error, /stale_state|changed while the agent was starting/);
  assert.equal(outcome.state.phase, 'hands_executing', 'side-channel result must be preserved');
  assert.equal(outcome.state.revision_consumed, true);
  const final = await assertFinalIntegrity(cwd);
  assert.equal(final.events.filter(event => event.type === 'brain_consulted').length, 1, 'runner must not double-write the consultation');
  assert.equal(await lockExists(cwd), false);
});

// ---------------------------------------------------------------- timeout / event races

test('timeout race: ask_codex event before timeout never smuggles a pass', async () => {
  const cwd = await consultingWorkspace();
  let providerCalls = 0;
  const timeoutMock = async (command, args, options) => {
    const real = coordinatorPassthrough(command, args, options);
    if (real) return real;
    providerCalls += 1;
    await options.onEvent?.({ type: 'tool.completed', tool: 'ask_codex' });
    return { ok: false, code: null, signal: 'SIGTERM', stdout: '', stderr: 'timed out', timed_out: true };
  };
  const outcome = await consult({ cwd, runProcess: timeoutMock, retryAttempts: 2, retryDelayMs: 0 });
  assert.equal(outcome.state.phase, 'blocked_user');
  assert.equal(outcome.state.block_kind, 'consultation_retry');
  assert.equal(outcome.state.resume_phase, 'hands_consulting');
  assert.match(outcome.error, /tim(e|ed) out/i);
  assert.equal(outcome.state.consultation, null, 'consultation must not be recorded from a timed-out provider');
  assert.equal(providerCalls, 2);
  const final = await assertFinalIntegrity(cwd);
  assert.equal(final.events.filter(event => event.type === 'brain_consulted').length, 0);
});

test('event race: valid JSON without ask_codex event fails as brain_consultation_missing', async () => {
  const cwd = await consultingWorkspace();
  let providerCalls = 0;
  const silentMock = async (command, args, options) => {
    const real = coordinatorPassthrough(command, args, options);
    if (real) return real;
    providerCalls += 1;
    return ok(consultationFor(args, 'qa-consult-session'));
  };
  const outcome = await consult({ cwd, runProcess: silentMock, retryAttempts: 2, retryDelayMs: 0 });
  assert.equal(outcome.state.phase, 'blocked_user');
  assert.match(outcome.error, /ask_codex/i);
  assert.equal(outcome.state.block_kind, 'consultation_retry');
  assert.equal(providerCalls, 1, 'a successful provider result does not retry');
  const final = await assertFinalIntegrity(cwd);
  assert.equal(final.events.filter(event => event.type === 'brain_consulted').length, 0);
  assert.equal(final.state.consultation, null);
});

test('retry race: attempt-1 event evidence never resurrects a timed-out attempt', async () => {
  const cwd = await consultingWorkspace();
  let providerCalls = 0;
  const sneakyMock = async (command, args, options) => {
    const real = coordinatorPassthrough(command, args, options);
    if (real) return real;
    providerCalls += 1;
    if (providerCalls === 1) {
      await options.onEvent?.({ type: 'tool.completed', tool: 'ask_codex' });
      return { ok: false, code: null, signal: 'SIGTERM', stdout: '', stderr: 'timed out', timed_out: true };
    }
    return ok(consultationFor(args, 'qa-consult-session'));
  };
  const outcome = await consult({ cwd, runProcess: sneakyMock, retryAttempts: 2, retryDelayMs: 0 });
  assert.equal(providerCalls, 2);
  assert.equal(outcome.state.phase, 'blocked_user', 'attempt-1 event must not count for attempt 2');
  assert.match(outcome.error, /ask_codex/i);
  const final = await assertFinalIntegrity(cwd);
  assert.equal(final.events.filter(event => event.type === 'brain_consulted').length, 0);
});

test('retry race: attempt-2 event and approval alone drives success', async () => {
  const cwd = await consultingWorkspace();
  let providerCalls = 0;
  const maybeMock = async (command, args, options) => {
    const real = coordinatorPassthrough(command, args, options);
    if (real) return real;
    providerCalls += 1;
    if (providerCalls === 1) {
      return { ok: false, code: null, signal: 'SIGTERM', stdout: '', stderr: 'timed out', timed_out: true };
    }
    await options.onEvent?.({ type: 'tool.completed', tool: 'ask_codex' });
    return ok(consultationFor(args, 'qa-consult-session'));
  };
  const outcome = await consult({ cwd, runProcess: maybeMock, retryAttempts: 2, retryDelayMs: 0 });
  assert.equal(providerCalls, 2, 'exactly two invocations');
  assert.equal(outcome.state.phase, 'hands_executing');
  assert.equal(outcome.state.consultation.decision, 'approved');
  const final = await assertFinalIntegrity(cwd);
  assert.equal(final.events.filter(event => event.type === 'brain_consulted').length, 1);
  assert.equal(await lockExists(cwd), false);
});

test('execute timeout race: completion-shaped stdout still fails and requires recover', async () => {
  const cwd = await executingWorkspace();
  const timeoutMock = async (command, args, options) => {
    const real = coordinatorPassthrough(command, args, options);
    if (real) return real;
    return {
      ok: false,
      code: null,
      signal: 'SIGTERM',
      stdout: JSON.stringify({ decision: 'completed', summary: 'I actually finished', sessionID: 'qa-consult-session' }),
      stderr: '',
      timed_out: true
    };
  };
  const failed = await execute({ cwd, runProcess: timeoutMock, retryDelayMs: 0 });
  assert.equal(failed.state.phase, 'blocked_user');
  assert.equal(failed.state.recovery_required, true);
  assert.match(failed.error, /bridge recover/i);
  assert.equal(await lockExists(cwd), false);

  const refused = await resumeRunner({ cwd, runProcess: flowMock('qa-consult-session'), retryDelayMs: 0 });
  assert.equal(refused.state.phase, 'blocked_user');
  assert.match(refused.error, /bridge recover/i);

  run(cwd, ['recover']);
  const recovered = await resumeRunner({ cwd, autonomous: false, manual: true, runProcess: flowMock('qa-consult-session'), retryDelayMs: 0 });
  assert.equal(recovered.state.phase, 'brain_reviewing');
  assert.equal(await lockExists(cwd), false);
  const final = await assertFinalIntegrity(cwd);
  assert.equal(final.state.git_status, 'clean_after_execution');
});

// ---------------------------------------------------------------- coordinator mutation races

test('coordinator race: 16 parallel start => exactly one success', async () => {
  const cwd = await createGitWorkspace('qa-storm-start-');
  try {
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => runAsync(cwd, ['start', 'Storm task ' + i])));
    assert.equal(results.filter(result => result.code === 0).length, 1);
    const final = await assertFinalIntegrity(cwd);
    assert.equal(final.state.phase, 'planning');
    assert.equal(final.events.length, 2);
    assert.equal(final.events[1].type, 'assignment_created');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('coordinator race: block vs resume storm keeps one consistent owner', async () => {
  const cwd = await createGitWorkspace('qa-storm-block-');
  try {
    run(cwd, ['init']);
    run(cwd, ['start', 'Block storm task']);
    const results = await Promise.all([
      ...Array.from({ length: 8 }, (_, i) => runAsync(cwd, ['block', 'Storm block ' + i])),
      ...Array.from({ length: 8 }, (_, i) => runAsync(cwd, ['resume']))
    ]);
    assert.ok(results.some(result => result.code === 0), 'at least one storm participant must land');
    const final = await assertFinalIntegrity(cwd);
    assert.ok(['planning', 'blocked_user'].includes(final.state.phase), 'final phase must be consistent, found ' + final.state.phase);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('coordinator race: pause/resume storm at blocked_user stays consistent', async () => {
  const cwd = await createGitWorkspace('qa-storm-pause-');
  try {
    run(cwd, ['init']);
    run(cwd, ['start', 'Pause storm task']);
    run(cwd, ['block', 'Waiting for the storm']);
    const results = await Promise.all([
      ...Array.from({ length: 8 }, (_, i) => runAsync(cwd, ['pause'])),
      ...Array.from({ length: 8 }, (_, i) => runAsync(cwd, ['resume']))
    ]);
    assert.ok(results.some(result => result.code === 0));
    const final = await assertFinalIntegrity(cwd);
    assert.ok(['planning', 'paused', 'blocked_user'].includes(final.state.phase), 'final phase must be consistent, found ' + final.state.phase);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('coordinator race: parallel claim-execution yields exactly one owner', async () => {
  const cwd = await executingWorkspace();
  try {
    const state = await readStateFile(cwd);
    const results = await Promise.all(Array.from({ length: 8 }, () => runAsync(cwd, ['claim-execution', state.execution_lease_id])));
    assert.equal(results.filter(result => result.code === 0).length, 1, 'exactly one claim must win');
    const final = await assertFinalIntegrity(cwd);
    assert.equal(final.state.execution_claimed, true);
    assert.equal(final.events.filter(event => event.type === 'execution_claimed').length, 1);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- lock hygiene

test('lock hygiene: full propose/consult/execute flow leaves no agent.lock at any gate', async () => {
  const cwd = await createGitWorkspace('qa-hygiene-');
  try {
    assert.equal(await lockExists(cwd), false);
    const proposed = await startRunner('Hygiene task', {
      cwd,
      autonomous: false,
      manual: true,
      runProcess: flowMock('hygiene-session'),
      retryDelayMs: 0
    });
    assert.equal(proposed.state.phase, 'brain_approving');
    assert.equal(await lockExists(cwd), false);

    const completed = await approveRunner('Approved by QA', { cwd, runProcess: flowMock('hygiene-session'), retryDelayMs: 0 });
    assert.equal(completed.state.phase, 'brain_reviewing');
    assert.equal(await lockExists(cwd), false);
    const final = await assertFinalIntegrity(cwd);
    assert.equal(final.state.consultation.decision, 'approved');
    assert.equal(final.state.execution_claimed, true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('lock hygiene: direct retry never creates a lock; withAgentLock is reentrant-safe', async () => {
  const cwd = await planningWorkspace();
  try {
    assert.equal(await lockExists(cwd), false);
    const details = await invokeAgentWithRetry('hands-propose', 'prompt', {
      cwd,
      runProcess: async (command, args, options) => {
        const real = coordinatorPassthrough(command, args, options);
        if (real) return real;
        return ok(proposeOutput('direct-session'));
      },
      retryAttempts: 2,
      retryDelayMs: 0
    });
    assert.equal(details.result.decision, 'propose');
    assert.equal(await lockExists(cwd), false, 'bare invokeAgentWithRetry must not create agent.lock');

    const outer = await withAgentLock({ cwd }, 'hands', async () => {
      await assert.rejects(
        () => withAgentLock({ cwd }, 'hands-evaluate', async () => 'inner'),
        error => error instanceof AgentBusyError && error.code === 'agent_busy'
      );
      return 'outer-done';
    });
    assert.equal(outer, 'outer-done');
    assert.equal(await lockExists(cwd), false, 'nested busy reject must not leak the outer lock');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('resume storm on a live consultation: one AgentBusyError, one survivor, no corruption', async () => {
  const cwd = await consultingWorkspace();
  let consultCalls = 0;
  const h = gate();
  const stormMock = async (command, args, options) => {
    const real = coordinatorPassthrough(command, args, options);
    if (real) return real;
    if (args[2] !== 'hands-consult') return ok({ decision: 'completed', summary: 'done', sessionID: 'qa-consult-session' });
    consultCalls += 1;
    if (consultCalls === 1) await h.unblock.promise;
    await options.onEvent?.({ type: 'tool.completed', tool: 'ask_codex' });
    return ok(consultationFor(args, 'qa-consult-session'));
  };

  const attempts = [
    resumeRunner({ cwd, autonomous: false, manual: true, runProcess: stormMock, retryDelayMs: 0 }),
    resumeRunner({ cwd, autonomous: false, manual: true, runProcess: stormMock, retryDelayMs: 0 })
  ];
  // The gated winner cannot settle, so the first settlement is always the loser.
  const firstSettled = await Promise.race(attempts).then(
    value => ({ status: 'fulfilled', value }),
    reason => ({ status: 'rejected', reason })
  );
  h.unblock.resolve();
  const settled = await Promise.allSettled(attempts);

  const fulfilled = settled.filter(entry => entry.status === 'fulfilled');
  const rejected = settled.filter(entry => entry.status === 'rejected');
  assert.equal(firstSettled.status, 'rejected', 'the lock loser must be the fast settlement');
  assert.equal(fulfilled.length, 1, 'exactly one resume must succeed');
  assert.equal(rejected.length, 1, 'exactly one resume must lose the lock race');
  assert.equal(rejected[0].reason instanceof AgentBusyError, true);
  assert.equal(rejected[0].reason.code, 'agent_busy');
  assert.equal(fulfilled[0].value.state.phase, 'brain_reviewing', 'winning resume must run consult and execute to completion');
  assert.equal(consultCalls, 1, 'the losing resume must never invoke the provider');
  assert.equal(await lockExists(cwd), false);
  const final = await assertFinalIntegrity(cwd);
  assert.equal(final.events.filter(event => event.type === 'brain_consulted').length, 1);
});