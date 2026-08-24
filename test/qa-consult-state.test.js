'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runProcess } = require('../bridge-adapter');
const { allowedControls } = require('../bridge-inspector');
const {
  start: startRunner,
  resume: resumeRunner,
  revise: reviseRunner,
  approve: approveRunner,
  consult,
  invokeAgentWithRetry,
  readState,
  runCommand,
  validateConsultation,
  retryableProviderError
} = require('../bridge-runner');

const coordinator = path.resolve(__dirname, '..', 'bridge-coordinator.js');

const start = (task, options = {}) => startRunner(task, { ...options, autonomous: false, manual: true });
const resume = (options = {}) => resumeRunner({ ...options, autonomous: false, manual: true });
const revise = (summary, options = {}) => reviseRunner(summary, { ...options, autonomous: false, manual: true });

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

function ok(output) {
  return { ok: true, code: 0, signal: null, stdout: JSON.stringify(output), stderr: '', timed_out: false };
}

async function emitAskCodexEvent(args, options) {
  if (args[2] === 'hands-consult' && options && options.onEvent) {
    await options.onEvent({ type: 'tool.completed', tool: 'ask_codex' });
  }
}

function makeMock(handlers) {
  return async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    const agent = args[2];
    const handler = handlers[agent];
    if (typeof handler !== 'function') throw new Error('Unexpected agent invoked during test: ' + agent);
    return handler(args, options, agent);
  };
}

const proposeSnapshot = (sessionID, summary = 'Harness chunk') => ({ decision: 'propose', summary, files: ['src/save.js'], tests: ['node --test'], sessionID });
const consultApproved = (sessionID) => async (args, options) => {
  await emitAskCodexEvent(args, options);
  return ok(consultationFor(args, sessionID));
};
const handsCompleted = (sessionID) => ({ decision: 'completed', summary: 'Harness chunk done', files: ['src/save.js'], tests: ['node --test'], sessionID });

async function reachHandsConsulting(cwd, runProcessOverride = null, sessionID = 'qa-consult-1') {
  const processRunner = runProcessOverride || (async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    throw new Error('Unexpected agent command: ' + (args[2] || args[0]));
  });
  const proposed = await start('Consultation harness task', { cwd, runProcess: processRunner, retryAttempts: 1, retryDelayMs: 0 });
  assert.equal(proposed.state.phase, 'brain_approving');
  assert.equal(proposed.state.hands_session_id, sessionID);
  await runCommand(['approve', 'MIND approved the approach'], { cwd });
  const state = await readState({ cwd });
  assert.equal(state.phase, 'hands_consulting');
  assert.equal(state.revision, 1);
  return state;
}

test('validateConsultation accepts the exact approved payload for the active assignment and revision', async () => {
  const state = { assignment_id: 'assignment-qa-1', revision: 2 };
  validateConsultation({ decision: 'approved', assignment_id: 'assignment-qa-1', revision: 2, summary: 'ok', brain_answer: 'go' }, state);
});

test('validateConsultation rejects a null or missing result', async () => {
  const state = { assignment_id: 'assignment-qa-1', revision: 2 };
  assert.throws(() => validateConsultation(null, state), /did not return a valid Brain decision/i);
  assert.throws(() => validateConsultation(undefined, state), /did not return a valid Brain decision/i);
});

test('validateConsultation rejects a non-approved decision', async () => {
  const state = { assignment_id: 'assignment-qa-1', revision: 2 };
  assert.throws(() => validateConsultation({ decision: 'blocked' }, state), /did not return a valid Brain decision/i);
});

test('validateConsultation rejects a mismatched assignment ID', async () => {
  const state = { assignment_id: 'assignment-qa-1', revision: 2 };
  assert.throws(
    () => validateConsultation({ decision: 'approved', assignment_id: 'assignment-forged', revision: 2, summary: 'ok', brain_answer: 'go' }, state),
    /did not return a valid Brain decision/i
  );
});

test('validateConsultation rejects a wrong revision (number, string, and non-numeric)', async () => {
  const state = { assignment_id: 'assignment-qa-1', revision: 2 };
  const base = { decision: 'approved', assignment_id: 'assignment-qa-1', summary: 'ok', brain_answer: 'go' };
  assert.throws(() => validateConsultation({ ...base, revision: 3 }, state), /did not return a valid Brain decision/i);
  assert.throws(() => validateConsultation({ ...base, revision: '3' }, state), /did not return a valid Brain decision/i);
  assert.throws(() => validateConsultation({ ...base, revision: 'x' }, state), /did not return a valid Brain decision/i);
});

test('validateConsultation rejects a missing or empty revision', async () => {
  const state = { assignment_id: 'assignment-qa-1', revision: 2 };
  const base = { decision: 'approved', assignment_id: 'assignment-qa-1', summary: 'ok', brain_answer: 'go' };
  assert.throws(() => validateConsultation({ ...base, revision: null }, state), /did not return a valid Brain decision/i);
  assert.throws(() => validateConsultation({ ...base }, state), /did not return a valid Brain decision/i);
});

test('validateConsultation rejects a missing or empty summary', async () => {
  const state = { assignment_id: 'assignment-qa-1', revision: 2 };
  const base = { decision: 'approved', assignment_id: 'assignment-qa-1', revision: 2, brain_answer: 'go' };
  assert.throws(() => validateConsultation({ ...base, summary: undefined }, state), /did not return a valid Brain decision/i);
  assert.throws(() => validateConsultation({ ...base, summary: '' }, state), /did not return a valid Brain decision/i);
  assert.throws(() => validateConsultation({ ...base, summary: '   ' }, state), /did not return a valid Brain decision/i);
  assert.throws(() => validateConsultation({ ...base, summary: 42 }, state), /did not return a valid Brain decision/i);
});

test('validateConsultation rejects a missing or empty brain_answer', async () => {
  const state = { assignment_id: 'assignment-qa-1', revision: 2 };
  const base = { decision: 'approved', assignment_id: 'assignment-qa-1', revision: 2, summary: 'ok' };
  assert.throws(() => validateConsultation({ ...base, brain_answer: undefined }, state), /did not return a valid Brain decision/i);
  assert.throws(() => validateConsultation({ ...base, brain_answer: '' }, state), /did not return a valid Brain decision/i);
  assert.throws(() => validateConsultation({ ...base, brain_answer: '  ' }, state), /did not return a valid Brain decision/i);
});

test('consultation prompt carries the current approved approach, assignment, revision, and task', async () => {
  const cwd = await createGitWorkspace('qa-handover-');
  const prompts = [];
  let proposeCalls = 0;
  const mock = makeMock({
    'hands-propose': async () => {
      proposeCalls += 1;
      const summary = proposeCalls === 1 ? 'First broad chunk' : 'Narrowed chunk';
      return ok(proposeSnapshot('qa-handover-1', summary));
    },
    'hands-consult': async (args, options) => {
      prompts.push(String(args.at(-1) || ''));
      await emitAskCodexEvent(args, options);
      return ok(consultationFor(args, 'qa-handover-1'));
    },
    'hands': async () => ok(handsCompleted('qa-handover-1'))
  });
  try {
    await start('Handover regression task', { cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    const first = await readState({ cwd });
    assert.equal(first.revision, 1);
    assert.match(first.approach.summary, /First broad chunk/);
    const revised = await revise('Narrow the chunk to the focused fix.', { cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(revised.state.phase, 'brain_approving');
    assert.equal(revised.state.revision, 3);
    assert.match(revised.state.approach.summary, /Narrowed chunk/);
    assert.ok(!/First broad chunk/.test(revised.state.approach.summary));
    await runCommand(['approve', 'MIND approved the narrowed chunk'], { cwd });
    const awaiting = await readState({ cwd });
    const consulted = await consult({ cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(consulted.state.phase, 'hands_executing');
    const prompt = prompts[prompts.length - 1];
    assert.ok(prompt.includes('Task: Handover regression task'));
    assert.ok(prompt.includes('Assignment ID: ' + awaiting.assignment_id));
    assert.ok(prompt.includes('Revision: ' + awaiting.revision));
    assert.ok(prompt.includes('Approved approach / chunk: ' + awaiting.approach.summary));
    assert.ok(prompt.includes('Approved files: src/save.js'));
    assert.ok(!/First broad chunk/.test(prompt));
    const final = await readState({ cwd });
    assert.equal(final.consultation.assignment_id, awaiting.assignment_id);
    assert.equal(final.consultation.revision, awaiting.revision);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('consult refuses a result whose assignment ID does not match the active state', async () => {
  const cwd = await createGitWorkspace('qa-assign-');
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-assign-1')),
    'hands-consult': async (args, options) => {
      await emitAskCodexEvent(args, options);
      const result = consultationFor(args, 'qa-assign-1');
      result.assignment_id = 'assignment-forged';
      return ok(result);
    }
  });
  try {
    const state = await reachHandsConsulting(cwd, mock, 'qa-assign-1');
    const out = await consult({ cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(out.state.phase, 'blocked_user');
    assert.match(out.state.blocked_reason, /did not return a valid Brain decision/i);
    assert.equal(out.state.resume_phase, 'hands_consulting');
    const after = await readState({ cwd });
    assert.equal(after.assignment_id, state.assignment_id);
    assert.equal(after.revision, state.revision);
    assert.equal(after.consultation, null);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('consult refuses a result whose revision does not match the active state', async () => {
  const cwd = await createGitWorkspace('qa-rev-');
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-rev-1')),
    'hands-consult': async (args, options) => {
      await emitAskCodexEvent(args, options);
      const result = consultationFor(args, 'qa-rev-1');
      result.revision = Number(result.revision) + 1;
      return ok(result);
    }
  });
  try {
    const state = await reachHandsConsulting(cwd, mock, 'qa-rev-1');
    const out = await consult({ cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(out.state.phase, 'blocked_user');
    assert.match(out.state.blocked_reason, /did not return a valid Brain decision/i);
    assert.equal(out.state.resume_phase, 'hands_consulting');
    const after = await readState({ cwd });
    assert.equal(after.revision, state.revision);
    assert.equal(after.consultation, null);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('autonomous brain-review approval handoff keeps assignment and revision bound through consult', async () => {
  const cwd = await createGitWorkspace('qa-approve-');
  const prompts = [];
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-approve-1')),
    'hands-consult': async (args, options) => {
      const prompt = String(args.at(-1) || '');
      prompts.push(prompt);
      await emitAskCodexEvent(args, options);
      if (/Role: BRAIN-REVIEW/.test(prompt)) {
        return ok({ decision: 'approved', summary: 'Brain approved the proposal.', feedback: 'Proceed.' });
      }
      if (/Role: BRAIN-RESULT-REVIEW/.test(prompt)) {
        return ok({ decision: 'complete', summary: 'Brain reviewed the executed chunk.' });
      }
      return ok(consultationFor(args, 'qa-approve-1'));
    },
    'hands-evaluate': async () => ok({ decision: 'passed', summary: 'Focused validation passed.', tests: ['node --test'] }),
    'hands': async () => ok(handsCompleted('qa-approve-1'))
  });
  try {
    const completed = await startRunner('Autonomous approval task', { cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(completed.state.phase, 'done');
    const state = await readState({ cwd });
    assert.equal(state.revision, 1);
    assert.equal(state.consultation.assignment_id, state.assignment_id);
    assert.equal(state.consultation.revision, 1);
    assert.equal(state.approach.handoff.status, 'brain_approved');
    const consultPrompt = prompts.find(prompt => /Phase: consultation/.test(prompt));
    assert.ok(consultPrompt);
    assert.ok(consultPrompt.includes('Assignment ID: ' + state.assignment_id));
    assert.ok(consultPrompt.includes('Revision: ' + state.revision));
    assert.ok(consultPrompt.includes('Approved approach / chunk: ' + state.approach.summary));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('provider_timeout during consult blocks as consultation_retry with resume only', async () => {
  const cwd = await createGitWorkspace('qa-timeout-');
  let consultCalls = 0;
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-timeout-1')),
    'hands-consult': async (args, options) => {
      consultCalls += 1;
      await emitAskCodexEvent(args, options);
      return { ok: false, code: null, signal: 'SIGTERM', stdout: '', stderr: 'provider timed out', timed_out: true };
    }
  });
  try {
    await reachHandsConsulting(cwd, mock, 'qa-timeout-1');
    const out = await consult({ cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(out.state.phase, 'blocked_user');
    assert.equal(out.state.block_kind, 'consultation_retry');
    assert.equal(out.state.resume_phase, 'hands_consulting');
    assert.match(out.state.blocked_reason, /timed out/i);
    assert.equal(consultCalls, 1);
    const controls = allowedControls(out.state);
    assert.ok(controls.includes('resume'));
    assert.ok(!controls.includes('revise'));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('provider_failed during consult blocks as consultation_retry', async () => {
  const cwd = await createGitWorkspace('qa-failed-');
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-failed-1')),
    'hands-consult': async (args, options) => {
      await emitAskCodexEvent(args, options);
      return { ok: false, code: 9, signal: null, stdout: '', stderr: 'spawn failed', timed_out: false };
    }
  });
  try {
    await reachHandsConsulting(cwd, mock, 'qa-failed-1');
    const out = await consult({ cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(out.state.phase, 'blocked_user');
    assert.equal(out.state.block_kind, 'consultation_retry');
    assert.equal(out.state.resume_phase, 'hands_consulting');
    assert.match(out.state.blocked_reason, /hands-consult failed/i);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('a material blocked decision during consult blocks as needs_revision with revise only', async () => {
  const cwd = await createGitWorkspace('qa-blocked-');
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-blocked-1')),
    'hands-consult': async (args, options) => {
      await emitAskCodexEvent(args, options);
      return ok({ decision: 'blocked', question: 'The chunk changes the data schema.', context: 'scope conflict with the task constraint.' });
    }
  });
  try {
    await reachHandsConsulting(cwd, mock, 'qa-blocked-1');
    const out = await consult({ cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(out.state.phase, 'blocked_user');
    assert.equal(out.state.block_kind, 'needs_revision');
    assert.equal(out.state.resume_phase, 'hands_consulting');
    assert.match(out.state.blocked_reason, /data schema/);
    const controls = allowedControls(out.state);
    assert.ok(controls.includes('revise'));
    assert.ok(!controls.includes('resume'));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('a consult without an ask_codex event lands on a retry block kind', async () => {
  const cwd = await createGitWorkspace('qa-noevent-');
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-noevent-1')),
    'hands-consult': async (args, options) => ok(consultationFor(args, 'qa-noevent-1'))
  });
  try {
    await reachHandsConsulting(cwd, mock, 'qa-noevent-1');
    const out = await consult({ cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(out.state.phase, 'blocked_user');
    assert.equal(out.state.block_kind, 'consultation_retry');
    assert.equal(out.state.resume_phase, 'hands_consulting');
    assert.match(out.state.blocked_reason, /without an ask_codex Brain call/i);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('an unparseable provider result during consult blocks without corrupting the session', async () => {
  const cwd = await createGitWorkspace('qa-garbage-');
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-garbage-1')),
    'hands-consult': async (args, options) => {
      await emitAskCodexEvent(args, options);
      return { ok: true, code: 0, signal: null, stdout: 'this is not a json result', stderr: '', timed_out: false };
    }
  });
  try {
    const state = await reachHandsConsulting(cwd, mock, 'qa-garbage-1');
    const out = await consult({ cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(out.state.phase, 'blocked_user');
    assert.match(out.state.blocked_reason, /returned no valid structured result/i);
    assert.equal(out.state.resume_phase, 'hands_consulting');
    const after = await readState({ cwd });
    assert.equal(after.assignment_id, state.assignment_id);
    assert.equal(after.revision, state.revision);
    assert.equal(after.consultation, null);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('resume after a consultation_retry block lands back at hands_consulting', async () => {
  const cwd = await createGitWorkspace('qa-resume1-');
  const stillFailing = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-resume1-1')),
    'hands-consult': async (args, options) => {
      await emitAskCodexEvent(args, options);
      return { ok: false, code: 9, signal: null, stdout: '', stderr: 'provider down', timed_out: false };
    }
  });
  try {
    await reachHandsConsulting(cwd, stillFailing, 'qa-resume1-1');
    const blocked = await consult({ cwd, runProcess: stillFailing, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(blocked.state.block_kind, 'consultation_retry');
    assert.equal(blocked.state.resume_phase, 'hands_consulting');
    const restarted = await resume({ cwd, runProcess: stillFailing, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(restarted.state.phase, 'blocked_user');
    assert.equal(restarted.state.block_kind, 'consultation_retry');
    assert.equal(restarted.state.resume_phase, 'hands_consulting');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('resume after a consultation_retry block completes the consult and executes', async () => {
  const cwd = await createGitWorkspace('qa-resume1b-');
  const failing = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-resume1b-1')),
    'hands-consult': async (args, options) => {
      await emitAskCodexEvent(args, options);
      return { ok: false, code: 9, signal: null, stdout: '', stderr: 'provider down', timed_out: false };
    }
  });
  const healthy = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-resume1b-1')),
    'hands-consult': consultApproved('qa-resume1b-1'),
    'hands': async () => ok(handsCompleted('qa-resume1b-1'))
  });
  try {
    await reachHandsConsulting(cwd, failing, 'qa-resume1b-1');
    const blocked = await consult({ cwd, runProcess: failing, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(blocked.state.block_kind, 'consultation_retry');
    assert.equal(blocked.state.resume_phase, 'hands_consulting');
    const restarted = await resume({ cwd, runProcess: healthy, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(restarted.state.phase, 'brain_reviewing');
    const state = await readState({ cwd });
    assert.equal(state.consultation.assignment_id, state.assignment_id);
    assert.equal(state.consultation.revision, state.revision);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('resume after a needs_revision block is refused until revise supplies Brain guidance', async () => {
  const cwd = await createGitWorkspace('qa-resume2-');
  const proposeCalls = [];
  const mock = makeMock({
    'hands-propose': async () => {
      proposeCalls.push('propose');
      return ok(proposeSnapshot('qa-resume2-1', 'The revised narrower chunk'));
    },
    'hands-consult': async (args, options) => {
      await emitAskCodexEvent(args, options);
      return ok({ decision: 'blocked', question: 'This chunk changes the data schema.', context: 'needs a user decision' });
    }
  });
  try {
    await reachHandsConsulting(cwd, mock, 'qa-resume2-1');
    const blocked = await consult({ cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(blocked.state.block_kind, 'needs_revision');
    const refused = await resume({ cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(refused.state.phase, 'blocked_user');
    assert.match(refused.error, /requires a revised proposal/i);
    const revised = await revise('Keep the schema; narrow the chunk.', { cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(revised.state.phase, 'brain_approving');
    assert.equal(revised.state.revision, 3);
    assert.match(revised.state.approach.summary, /narrower chunk/i);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('resume after a missing-event block resumes the consultation cleanly', async () => {
  const cwd = await createGitWorkspace('qa-resume3-');
  const quiet = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-resume3-1')),
    'hands-consult': async (args, options) => ok(consultationFor(args, 'qa-resume3-1'))
  });
  const loud = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-resume3-1')),
    'hands-consult': consultApproved('qa-resume3-1'),
    'hands': async () => ok(handsCompleted('qa-resume3-1'))
  });
  try {
    await reachHandsConsulting(cwd, quiet, 'qa-resume3-1');
    const blocked = await consult({ cwd, runProcess: quiet, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(blocked.state.phase, 'blocked_user');
    assert.equal(blocked.state.resume_phase, 'hands_consulting');
    const restarted = await resume({ cwd, runProcess: loud, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(restarted.state.phase, 'brain_reviewing');
    const state = await readState({ cwd });
    assert.equal(state.consultation.assignment_id, state.assignment_id);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('session guard failures are never retried', async () => {
  const diverged = new Error('Provider returned a different HANDS session ID during consultation; refusing to fork the bridge conversation.');
  const missing = new Error('Provider did not return a HANDS session ID; refusing to start a second conversation.');
  const noEvent = new Error('HANDS consultation completed without an ask_codex Brain call.');
  noEvent.code = 'brain_consultation_missing';
  assert.equal(retryableProviderError(diverged), false);
  assert.equal(retryableProviderError(missing), false);
  assert.equal(retryableProviderError(noEvent), false);
});

test('propose without a bound provider session is refused', async () => {
  const cwd = await createGitWorkspace('qa-nosession-');
  const mock = makeMock({
    'hands-propose': async () => ok({ decision: 'propose', summary: 'Chunk without a session', files: ['src/save.js'], tests: ['node --test'] })
  });
  try {
    const out = await start('Sessionless task', { cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(out.state.phase, 'blocked_user');
    assert.match(out.state.blocked_reason, /did not return a HANDS session ID/i);
    assert.equal(out.state.resume_phase, 'planning');
    assert.equal(out.state.hands_session_id, null);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('consult with the same bound session id succeeds end to end', async () => {
  const cwd = await createGitWorkspace('qa-samesess-');
  const sessionArgs = [];
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-samesess-1')),
    'hands-consult': async (args, options) => {
      sessionArgs.push(args.filter((value, index) => args[index - 1] === '--session').at(-1));
      await emitAskCodexEvent(args, options);
      return ok(consultationFor(args, 'qa-samesess-1'));
    }
  });
  try {
    const state = await reachHandsConsulting(cwd, mock, 'qa-samesess-1');
    const out = await consult({ cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(out.state.phase, 'hands_executing');
    assert.ok(sessionArgs.every(value => value === 'qa-samesess-1'));
    const after = await readState({ cwd });
    assert.equal(after.hands_session_id, state.hands_session_id);
    assert.equal(after.consultation.assignment_id, state.assignment_id);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('consult refuses a provider that returns a different session id mid-consultation', async () => {
  const cwd = await createGitWorkspace('qa-fork-');
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-fork-1')),
    'hands-consult': async (args, options) => {
      await emitAskCodexEvent(args, options);
      return ok(consultationFor(args, 'qa-fork-forked'));
    }
  });
  try {
    const state = await reachHandsConsulting(cwd, mock, 'qa-fork-1');
    const out = await consult({ cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(out.state.phase, 'blocked_user');
    assert.match(out.state.blocked_reason, /different HANDS session ID/i);
    const after = await readState({ cwd });
    assert.equal(after.hands_session_id, 'qa-fork-1');
    assert.equal(after.assignment_id, state.assignment_id);
    assert.equal(after.consultation, null);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('start, propose, approve, consult, execute all stay bound to one session id', async () => {
  const cwd = await createGitWorkspace('qa-e2e1-');
  const sessionArgs = [];
  const agentCalls = [];
  const mock = makeMock({
    'hands-propose': async (args) => {
      agentCalls.push('hands-propose');
      sessionArgs.push(args.filter((value, index) => args[index - 1] === '--session').at(-1));
      return ok(proposeSnapshot('qa-e2e-1'));
    },
    'hands-consult': async (args, options) => {
      agentCalls.push('hands-consult');
      sessionArgs.push(args.filter((value, index) => args[index - 1] === '--session').at(-1));
      await emitAskCodexEvent(args, options);
      return ok(consultationFor(args, 'qa-e2e-1'));
    },
    'hands': async (args) => {
      agentCalls.push('hands');
      sessionArgs.push(args.filter((value, index) => args[index - 1] === '--session').at(-1));
      return ok(handsCompleted('qa-e2e-1'));
    }
  });
  try {
    const proposed = await start('E2E session binding task', { cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(proposed.state.phase, 'brain_approving');
    assert.equal(proposed.state.hands_session_id, 'qa-e2e-1');
    const approved = await approveRunner('E2E approval', { cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(approved.state.phase, 'brain_reviewing');
    const state = await readState({ cwd });
    assert.equal(state.hands_session_id, 'qa-e2e-1');
    assert.deepEqual(agentCalls, ['hands-propose', 'hands-consult', 'hands']);
    assert.equal(sessionArgs.length, 3);
    assert.equal(sessionArgs[0], undefined, 'the first proposal cannot carry a session yet');
    assert.equal(sessionArgs[1], 'qa-e2e-1');
    assert.equal(sessionArgs[2], 'qa-e2e-1');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('retryAttempts 2 makes exactly two provider invocations on persistent failure', async () => {
  const cwd = await createGitWorkspace('qa-retry1-');
  let consultCalls = 0;
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-retry1-1')),
    'hands-consult': async (args, options) => {
      consultCalls += 1;
      await emitAskCodexEvent(args, options);
      return { ok: false, code: 9, signal: null, stdout: '', stderr: 'provider down', timed_out: false };
    }
  });
  try {
    await reachHandsConsulting(cwd, mock, 'qa-retry1-1');
    const out = await consult({ cwd, runProcess: mock, retryAttempts: 2, retryDelayMs: 0 });
    assert.equal(consultCalls, 2);
    assert.equal(out.state.phase, 'blocked_user');
    assert.equal(out.state.block_kind, 'consultation_retry');
    assert.match(out.state.blocked_reason, /\(after 2 attempts\)/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('invokeAgentWithRetry fires onRetry between exactly two attempts', async () => {
  let calls = 0;
  let retries = 0;
  const failing = async () => {
    calls += 1;
    return { ok: false, code: 9, signal: null, stdout: '', stderr: 'down', timed_out: false };
  };
  await assert.rejects(
    () => invokeAgentWithRetry('hands', 'retry me', {
      runProcess: failing,
      retryAttempts: 2,
      retryDelayMs: 0,
      onRetry: async () => { retries += 1; }
    }),
    /after 2 attempts/
  );
  assert.equal(calls, 2);
  assert.equal(retries, 1);
});

test('a transient provider failure followed by success continues to hands_executing', async () => {
  const cwd = await createGitWorkspace('qa-retry2-');
  let consultCalls = 0;
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-retry2-1')),
    'hands-consult': async (args, options) => {
      consultCalls += 1;
      await emitAskCodexEvent(args, options);
      if (consultCalls === 1) {
        return { ok: false, code: 9, signal: null, stdout: '', stderr: 'transient provider failure', timed_out: false };
      }
      return ok(consultationFor(args, 'qa-retry2-1'));
    }
  });
  try {
    await reachHandsConsulting(cwd, mock, 'qa-retry2-1');
    const out = await consult({ cwd, runProcess: mock, retryAttempts: 2, retryDelayMs: 0 });
    assert.equal(consultCalls, 2);
    assert.equal(out.state.phase, 'hands_executing');
    const state = await readState({ cwd });
    assert.equal(state.consultation.assignment_id, state.assignment_id);
    assert.equal(state.consultation.revision, state.revision);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('consult retries do not surface a caller-supplied onRetry callback', async () => {
  const cwd = await createGitWorkspace('qa-retry6-');
  let consultCalls = 0;
  let callerRetries = 0;
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-retry6-1')),
    'hands-consult': async (args, options) => {
      consultCalls += 1;
      await emitAskCodexEvent(args, options);
      return { ok: false, code: 9, signal: null, stdout: '', stderr: 'provider down', timed_out: false };
    }
  });
  try {
    await reachHandsConsulting(cwd, mock, 'qa-retry6-1');
    const out = await consult({
      cwd,
      runProcess: mock,
      retryAttempts: 2,
      retryDelayMs: 0,
      onRetry: async () => { callerRetries += 1; }
    });
    assert.equal(consultCalls, 2);
    assert.equal(callerRetries, 0);
    assert.equal(out.state.block_kind, 'consultation_retry');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('an ask_codex event from attempt 1 cannot pass a consult that times out on attempt 2', async () => {
  const cwd = await createGitWorkspace('qa-retry3-');
  let consultCalls = 0;
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-retry3-1')),
    'hands-consult': async (args, options) => {
      consultCalls += 1;
      if (consultCalls === 1) {
        await emitAskCodexEvent(args, options);
        return ok({ decision: 'blocked', question: 'ask_codex is temporarily unavailable.', context: 'transient', transient: true });
      }
      return { ok: false, code: null, signal: 'SIGTERM', stdout: '', stderr: 'timeout on final attempt', timed_out: true };
    }
  });
  try {
    await reachHandsConsulting(cwd, mock, 'qa-retry3-1');
    const out = await consult({ cwd, runProcess: mock, retryAttempts: 2, retryDelayMs: 0 });
    assert.equal(consultCalls, 2);
    assert.equal(out.state.phase, 'blocked_user');
    assert.equal(out.state.block_kind, 'consultation_retry');
    assert.match(out.state.blocked_reason, /timed out/i);
    const state = await readState({ cwd });
    assert.equal(state.consultation, null);
    assert.equal(state.execution_lease_id, null);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('a flagged ask_codex event from attempt 1 is reset before a successful attempt 2 without one', async () => {
  const cwd = await createGitWorkspace('qa-retry4-');
  let consultCalls = 0;
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-retry4-1')),
    'hands-consult': async (args, options) => {
      consultCalls += 1;
      if (consultCalls === 1) {
        await emitAskCodexEvent(args, options);
        return ok({ decision: 'blocked', question: 'ask_codex is temporarily unavailable.', context: 'transient', transient: true });
      }
      return ok(consultationFor(args, 'qa-retry4-1'));
    }
  });
  try {
    await reachHandsConsulting(cwd, mock, 'qa-retry4-1');
    const out = await consult({ cwd, runProcess: mock, retryAttempts: 2, retryDelayMs: 0 });
    assert.equal(consultCalls, 2);
    assert.equal(out.state.phase, 'blocked_user');
    assert.match(out.state.blocked_reason, /without an ask_codex Brain call/i);
    assert.equal(out.state.resume_phase, 'hands_consulting');
    const state = await readState({ cwd });
    assert.equal(state.consultation, null);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('a transient consultation block on attempt 1 retries and succeeds on attempt 2', async () => {
  const cwd = await createGitWorkspace('qa-retry5-');
  let consultCalls = 0;
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-retry5-1')),
    'hands-consult': async (args, options) => {
      consultCalls += 1;
      if (consultCalls === 1) {
        await emitAskCodexEvent(args, options);
        return ok({ decision: 'blocked', question: 'ask_codex MCP tool temporarily unavailable.', context: 'retry the protocol', transient: true });
      }
      await emitAskCodexEvent(args, options);
      return ok(consultationFor(args, 'qa-retry5-1'));
    }
  });
  try {
    await reachHandsConsulting(cwd, mock, 'qa-retry5-1');
    const out = await consult({ cwd, runProcess: mock, retryAttempts: 2, retryDelayMs: 0 });
    assert.equal(consultCalls, 2);
    assert.equal(out.state.phase, 'hands_executing');
    const state = await readState({ cwd });
    assert.equal(state.consultation.assignment_id, state.assignment_id);
    assert.equal(state.consultation.revision, state.revision);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('consult while hands_executing is refused by the phase guard', async () => {
  const cwd = await createGitWorkspace('qa-interleave1-');
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-interleave1-1')),
    'hands-consult': consultApproved('qa-interleave1-1')
  });
  try {
    await reachHandsConsulting(cwd, mock, 'qa-interleave1-1');
    const executed = await consult({ cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(executed.state.phase, 'hands_executing');
    await assert.rejects(
      () => consult({ cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 }),
      /Brain consultation requires an approved approach; found hands_executing/
    );
    const state = await readState({ cwd });
    assert.equal(state.phase, 'hands_executing');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('consult while paused is a safe no-op that returns the paused state', async () => {
  const cwd = await createGitWorkspace('qa-paused-');
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-paused-1')),
    'hands-consult': consultApproved('qa-paused-1')
  });
  try {
    await reachHandsConsulting(cwd, mock, 'qa-paused-1');
    await runCommand(['pause'], { cwd });
    const outcome = await consult({ cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(outcome.state.phase, 'paused');
    assert.equal(outcome.error, undefined);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('consult while paused preserves the paused state as a safe no-op', async () => {
  const cwd = await createGitWorkspace('qa-paused2-');
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-paused2-1')),
    'hands-consult': consultApproved('qa-paused2-1')
  });
  try {
    await reachHandsConsulting(cwd, mock, 'qa-paused2-1');
    await runCommand(['pause'], { cwd });
    const outcome = await consult({ cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(outcome.state.phase, 'paused');
    assert.equal(outcome.error, undefined);
    const state = await readState({ cwd });
    assert.equal(state.phase, 'paused');
    assert.equal(state.resume_phase, 'hands_consulting');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('consult while blocked_user is a safe no-op that returns the blocked state', async () => {
  const cwd = await createGitWorkspace('qa-blocked2-');
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-blocked2-1')),
    'hands-consult': consultApproved('qa-blocked2-1')
  });
  try {
    await reachHandsConsulting(cwd, mock, 'qa-blocked2-1');
    await runCommand(['block', '--kind', 'needs_revision', 'A user decision is required before execution.'], { cwd });
    const outcome = await consult({ cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(outcome.state.phase, 'blocked_user');
    assert.equal(outcome.error, undefined);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('consult while blocked_user preserves the blocked state as a safe no-op', async () => {
  const cwd = await createGitWorkspace('qa-blocked3-');
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-blocked3-1')),
    'hands-consult': consultApproved('qa-blocked3-1')
  });
  try {
    await reachHandsConsulting(cwd, mock, 'qa-blocked3-1');
    await runCommand(['block', '--kind', 'needs_revision', 'A user decision is required before execution.'], { cwd });
    const outcome = await consult({ cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(outcome.state.phase, 'blocked_user');
    assert.equal(outcome.error, undefined);
    const state = await readState({ cwd });
    assert.equal(state.phase, 'blocked_user');
    assert.equal(state.block_kind, 'needs_revision');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('consult after the session is done refuses cleanly without corrupting state', async () => {
  const cwd = await createGitWorkspace('qa-done-');
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-done-1')),
    'hands-consult': consultApproved('qa-done-1'),
    'hands': async () => ok(handsCompleted('qa-done-1'))
  });
  try {
    await start('Done task', { cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    await approveRunner('Done approval', { cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
    await runCommand(['done', 'Done task complete'], { cwd });
    const done = await readState({ cwd });
    assert.equal(done.phase, 'done');
    await assert.rejects(
      () => consult({ cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 }),
      /Brain consultation requires an approved approach; found done/
    );
    const state = await readState({ cwd });
    assert.equal(state.phase, 'done');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('events seq stays contiguous and state stays valid across five propose-approve-consult-execute-complete cycles', async () => {
  const cwd = await createGitWorkspace('qa-loop-');
  const assignments = new Set();
  const mock = makeMock({
    'hands-propose': async () => ok(proposeSnapshot('qa-loop-1')),
    'hands-consult': consultApproved('qa-loop-1'),
    'hands': async () => ok(handsCompleted('qa-loop-1'))
  });
  try {
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      const proposed = await start('Loop task', { cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
      assert.equal(proposed.state.phase, 'brain_approving');
      let state = await readState({ cwd });
      assert.equal(state.phase, 'brain_approving');
      assignments.add(state.assignment_id);
      assert.equal(state.revision, 1);
      const approved = await approveRunner('Loop approval ' + cycle, { cwd, runProcess: mock, retryAttempts: 1, retryDelayMs: 0 });
      assert.equal(approved.state.phase, 'brain_reviewing');
      state = await readState({ cwd });
      assert.equal(state.phase, 'brain_reviewing');
      assert.equal(state.hands_session_id, 'qa-loop-1');
      assert.equal(state.consultation.assignment_id, state.assignment_id);
      assert.equal(state.consultation.revision, state.revision);
      await runCommand(['done', 'Loop done ' + cycle], { cwd });
      state = await readState({ cwd });
      assert.equal(state.phase, 'done');
    }
    const finalState = await readState({ cwd });
    const events = (await fs.readFile(path.join(cwd, '.bridge', 'events.jsonl'), 'utf8'))
      .trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    assert.ok(events.length > 10);
    let previous = -1;
    for (const event of events) {
      assert.equal(event.seq, previous + 1, 'events seq must be strictly contiguous');
      previous = event.seq;
    }
    assert.equal(finalState.event_seq, events[events.length - 1].seq);
    assert.equal(assignments.size, 5, 'every cycle gets a fresh assignment id');
    const dirNames = await fs.readdir(path.join(cwd, '.bridge'));
    assert.ok(!dirNames.some(name => name.endsWith('.tmp')), 'no temporary files may be left behind: ' + dirNames.join(', '));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});