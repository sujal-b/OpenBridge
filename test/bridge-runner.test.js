const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runProcess } = require('../bridge-adapter');
const { spawnSync } = require('node:child_process');
const { runAgent, proposalPrompt, proposalReviewPrompt, consultationPrompt, evaluationPrompt, resultReviewPrompt, executionPrompt, start: startRunner, resume: resumeRunner, revise: reviseRunner, approve, reviewProposal, invokeAgent, invokeAgentWithRetry, unlockAgent, AgentBusyError } = require('../bridge-runner');

// Legacy contract tests keep the explicit manual path; autonomous defaults are covered separately.
const start = (task, options = {}) => startRunner(task, { ...options, autonomous: false, manual: true });
const resume = (options = {}) => resumeRunner({ ...options, autonomous: false, manual: true });
const revise = (summary, options = {}) => reviseRunner(summary, { ...options, autonomous: false, manual: true });

const coordinator = path.resolve(__dirname, '..', 'bridge-coordinator.js');

async function markBrainConsultation(args, options) {
  if (args[2] === 'hands-consult' && options && options.onEvent) {
    await options.onEvent({ type: 'tool.completed', tool: 'ask_codex' });
  }
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

test('proposal prompt is explicitly read-only and structured', () => {
  const prompt = proposalPrompt({ task: 'Add validation', revision: 2, approach: null });
  assert.match(prompt, /read-only/i);
  assert.match(prompt, /do not edit/i);
  assert.match(prompt, /decision/);
  assert.match(prompt, /Add validation/);
  assert.match(prompt, /sensible defaults.*assumptions/i);
});

test('execution prompt includes only the approved approach', () => {
  const prompt = executionPrompt({
    task: 'Add validation',
    approach: { summary: 'Validate before saving', files: ['src/save.js'] }
  });
  assert.match(prompt, /approved approach/i);
  assert.match(prompt, /Validate before saving/);
  assert.match(prompt, /src\/save\.js/);
  assert.match(prompt, /do not start another bridge session/i);
  assert.match(prompt, /first non-whitespace character must be \{/i);
});

test('runAgent accepts a structured proposal from a mocked provider', async () => {
  const result = await runAgent('hands-propose', 'prompt', {
    runProcess: fakeProcess(JSON.stringify({ decision: 'propose', summary: 'Inspect first', files: ['src/app.js'] }))
  });
  assert.equal(result.decision, 'propose');
  assert.deepEqual(result.files, ['src/app.js']);
});

test('runAgent parses a JSONL provider envelope', async () => {
  const output = [
    JSON.stringify({ type: 'tool.completed' }),
    JSON.stringify({ type: 'message', item: { text: '{"decision":"completed","summary":"tests pass"}' } })
  ].join('\n');
  const result = await runAgent('hands', 'prompt', { runProcess: fakeProcess(output) });
  assert.deepEqual(result, { decision: 'completed', summary: 'tests pass' });
});

test('runAgent rejects failed providers and timeouts', async () => {
  await assert.rejects(
    () => runAgent('hands', 'prompt', { runProcess: fakeProcess('', { ok: false, code: 9, stderr: 'failed' }) }),
    /hands failed: failed/
  );
  await assert.rejects(
    () => runAgent('hands', 'prompt', { runProcess: fakeProcess('', { ok: false, timed_out: true, stderr: 'timeout' }) }),
    /timed out/
  );
});

test('mocked runner enforces proposal then approval then execution', async () => {
  const cwd = await createGitWorkspace('');
  let agentCalls = 0;
  const calls = [];
  const mockedProcess = async (command, args, options) => {
    calls.push({ command, args });
    if (command === process.execPath && args[0] === coordinator) {
      return runProcess(command, args, options);
    }
    await markBrainConsultation(args, options);
    agentCalls += 1;
    const output = args[2] === 'hands-propose'
      ? { decision: 'propose', summary: 'Validate before saving', files: ['src/save.js'], tests: ['node --test'], sessionID: 'hands-session-1' }
      : args[2] === 'hands-consult'
        ? consultationFor(args, 'hands-session-1')
        : { decision: 'completed', summary: 'Validation added', files: ['src/save.js'], tests: ['node --test'], sessionID: 'hands-session-1' };
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify(output), stderr: '', timed_out: false };
  };

  try {
    const proposed = await start('Add save validation', { cwd, runProcess: mockedProcess });
    assert.equal(proposed.state.phase, 'brain_approving');
    assert.equal(proposed.state.approval, 'pending');
    assert.equal(proposed.state.hands_session_id, 'hands-session-1');
    const executed = await approve('Approved by MIND', { cwd, runProcess: mockedProcess });
    assert.equal(executed.state.phase, 'brain_reviewing');
    assert.equal(executed.state.git_status, 'clean_after_execution');
    assert.deepEqual(calls.filter(call => call.command !== process.execPath).map(call => call.args[2]), ['hands-propose', 'hands-consult', 'hands']);
    assert.ok(calls.some(call => call.args.includes('--session') && call.args.includes('hands-session-1')));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('Brain review can request the next chunk through revise', async () => {
  const cwd = await createGitWorkspace('');
  let agentCalls = 0;
  const mockedProcess = async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    await markBrainConsultation(args, options);
    agentCalls += 1;
    const output = args[2] === 'hands-propose'
      ? (agentCalls === 1
        ? { decision: 'propose', summary: 'First small chunk', files: ['src/one.js'], tests: ['node --test'], sessionID: 'hands-session-review' }
        : { decision: 'propose', summary: 'Next small chunk', files: ['src/two.js'], tests: ['node --test'], sessionID: 'hands-session-review' })
      : args[2] === 'hands-consult'
        ? consultationFor(args, 'hands-session-review')
        : { decision: 'completed', summary: 'First chunk complete', files: ['src/one.js'], tests: ['node --test'], sessionID: 'hands-session-review' };
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify(output), stderr: '', timed_out: false };
  };
  try {
    await start('Build in reviewable chunks', { cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    const reviewed = await approve('Approve first chunk', { cwd, runProcess: mockedProcess });
    assert.equal(reviewed.state.phase, 'brain_reviewing');
    const next = await revise('Keep the same style and add the next focused slice.', { cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    assert.equal(next.state.phase, 'brain_approving');
    assert.match(next.state.approach.summary, /^Next small chunk/);
    assert.equal(agentCalls, 4);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
test('start retries a proposal left in planning instead of restarting it', async () => {
  const cwd = await createGitWorkspace('');
  let agentCalls = 0;
  const mockedProcess = async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    await markBrainConsultation(args, options);
    agentCalls += 1;
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ decision: 'propose', summary: 'Retry safely', files: ['README.md'], tests: ['read README'], sessionID: 'hands-session-retry' }), stderr: '', timed_out: false };
  };
  try {
    await runProcess(process.execPath, [coordinator, 'init'], { cwd });
    await runProcess(process.execPath, [coordinator, 'start', 'Retry this task'], { cwd });
    const result = await start('Retry this task', { cwd, runProcess: mockedProcess });
    assert.equal(result.state.phase, 'brain_approving');
    assert.equal(agentCalls, 1);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('agent lock prevents parallel provider calls', async () => {
  const cwd = await createGitWorkspace('');
  let started;
  let release;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const releasePromise = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const mockedProcess = async () => {
    calls += 1;
    started();
    await releasePromise;
    return { ok: true, code: 0, signal: null, stdout: '{"decision":"propose","summary":"safe"}', stderr: '', timed_out: false };
  };
  try {
    const first = runAgent('hands-propose', 'prompt', { cwd, runProcess: mockedProcess });
    await startedPromise;
    await assert.rejects(
      () => runAgent('hands-propose', 'prompt', { cwd, runProcess: mockedProcess }),
      error => error instanceof AgentBusyError && error.code === 'agent_busy'
    );
    release();
    await first;
    assert.equal(calls, 1);
  } finally {
    release();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
test('resume retries a blocked proposal and returns to Brain approval', async () => {
  const cwd = await createGitWorkspace('');
  let providerCalls = 0;
  const mockedProcess = async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    providerCalls += 1;
    if (providerCalls <= 2) return { ok: true, code: 0, signal: null, stdout: '', stderr: '', timed_out: false };
    return {
      ok: true,
      code: 0,
      signal: null,
      stdout: JSON.stringify({ decision: 'propose', summary: 'Retry proposal safely', files: ['src/app.js'], tests: ['node --test'], sessionID: 'hands-session-resume' }),
      stderr: '',
      timed_out: false
    };
  };

  try {
    const blocked = await start('Resume retry task', { cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    assert.equal(blocked.state.phase, 'blocked_user');
    assert.match(blocked.error, /structured decision/i);

    const resumed = await resume({ cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    assert.equal(resumed.state.phase, 'brain_approving');
    assert.equal(resumed.state.approval, 'pending');
    assert.equal(resumed.state.hands_session_id, 'hands-session-resume');
    assert.equal(providerCalls, 3);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
test('oversized proposals stop before Brain approval', async () => {
  const cwd = await createGitWorkspace('');
  const mockedProcess = async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    return {
      ok: true,
      code: 0,
      signal: null,
      stdout: JSON.stringify({
        decision: 'propose',
        summary: 'Build the complete application',
        files: ['a.js', 'b.js', 'c.js', 'd.js'],
        tests: ['build'],
        sessionID: 'hands-session-large'
      }),
      stderr: '',
      timed_out: false
    };
  };
  try {
    const result = await start('Build the application', { cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    assert.equal(result.state.phase, 'blocked_user');
    assert.match(result.error, /at most 3|smaller chunk/i);
    assert.equal(result.state.recovery_required, false);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('proposal assumptions do not hard-block a complete proposal', async () => {
  const cwd = await createGitWorkspace('');
  let providerCalls = 0;
  const mockedProcess = async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    providerCalls += 1;
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ decision: 'propose', summary: 'Use the minimal implementation style', files: ['README.md'], tests: ['read README'], assumptions: ['Prefer the smallest implementation that meets the stated task.'], questions: ['Should this favor minimal code or maximum performance?'], sessionID: 'hands-session-feedback' }), stderr: '', timed_out: false };
  };
  try {
    const proposed = await start('Choose an implementation style', { cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    assert.equal(proposed.state.phase, 'brain_approving');
    assert.match(proposed.state.approach.summary, /Assumptions: Prefer the smallest implementation/);
    assert.equal(proposed.state.blocked_reason, null);
    assert.equal(providerCalls, 1);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});


function proposalReviewState(sessionID = 'proposal-review-session') {
  return {
    task: 'Review a bounded proposal',
    assignment_id: 'assignment-review',
    revision: 0,
    hands_session_id: sessionID,
    approach: {
      role: 'reliability engineer',
      summary: 'A bounded, reviewable chunk.',
      files: ['README.md']
    }
  };
}

test('proposal review accepts without ask_codex when validation is explicitly disabled', async () => {
  const cwd = await createGitWorkspace('');
  let calls = 0;
  const mockedProcess = async () => {
    calls += 1;
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ decision: 'approved', summary: 'Safe bounded proposal' }), stderr: '', timed_out: false };
  };
  try {
    const details = await reviewProposal(proposalReviewState('proposal-review-default'), { cwd, runProcess: mockedProcess, requireBrainEvent: false, retryAttempts: 2, retryDelayMs: 0 });
    assert.equal(details.result.decision, 'approved');
    assert.equal(calls, 1);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
test('proposal review retries missing ask_codex proof with an explicit repair prompt', async () => {
  const cwd = await createGitWorkspace('');
  let calls = 0;
  const prompts = [];
  const mockedProcess = async (command, args, options) => {
    calls += 1;
    prompts.push(String(args.at(-1)));
    if (calls === 2) {
      await options.onEvent?.(
        { type: 'tool.completed' },
        JSON.stringify({ type: 'tool.completed', part: { name: 'ask_codex' } }),
        'stdout'
      );
    }
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ decision: 'approved', summary: 'Safe bounded proposal' }), stderr: '', timed_out: false };
  };
  try {
    const details = await reviewProposal(proposalReviewState(), { cwd, runProcess: mockedProcess, requireBrainEvent: true, retryAttempts: 2, retryDelayMs: 0 });
    assert.equal(details.result.decision, 'approved');
    assert.equal(calls, 2);
    assert.match(prompts[1], /omitted observable ask_codex evidence/i);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('proposal review escalates precisely after missing ask_codex proof exhausts retries', async () => {
  const cwd = await createGitWorkspace('');
  let calls = 0;
  const mockedProcess = async () => {
    calls += 1;
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ decision: 'approved', summary: 'Safe bounded proposal' }), stderr: '', timed_out: false };
  };
  try {
    await assert.rejects(
      () => reviewProposal(proposalReviewState('proposal-review-exhausted'), { cwd, runProcess: mockedProcess, requireBrainEvent: true, retryAttempts: 2, retryDelayMs: 0 }),
      error => error.code === 'brain_review_missing'
        && /approval proof is missing/i.test(error.message)
        && /after 2 attempts/i.test(error.message)
    );
    assert.equal(calls, 2);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('proposal review recognizes ask_codex in a nested raw provider event', async () => {
  const cwd = await createGitWorkspace('');
  let calls = 0;
  const mockedProcess = async (command, args, options) => {
    calls += 1;
    await options.onEvent?.(
      { type: 'tool.completed' },
      JSON.stringify({ type: 'tool.completed', payload: { tool_name: 'ask_codex' } }),
      'stdout'
    );
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ decision: 'approved', summary: 'Safe bounded proposal' }), stderr: '', timed_out: false };
  };
  try {
    const details = await reviewProposal(proposalReviewState('proposal-review-nested'), { cwd, runProcess: mockedProcess, requireBrainEvent: true, retryAttempts: 2, retryDelayMs: 0 });
    assert.equal(details.result.decision, 'approved');
    assert.equal(calls, 1);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('consultation without ask_codex is rejected', async () => {
  const cwd = await createGitWorkspace('');
  let providerCalls = 0;
  const mockedProcess = async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    providerCalls += 1;
    const output = args[2] === 'hands-propose'
      ? { decision: 'propose', summary: 'Small chunk', files: ['src/app.js'], tests: ['node --test'], sessionID: 'hands-session-no-consult' }
      : consultationFor(args, 'hands-session-no-consult');
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify(output), stderr: '', timed_out: false };
  };
  try {
    await start('Require Brain consultation', { cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    const result = await approve('Approve small chunk', { cwd, runProcess: mockedProcess });
    assert.equal(result.state.phase, 'blocked_user');
    assert.match(result.error, /ask_codex/i);
    assert.equal(result.state.recovery_required, false);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
test('execution timeout requires recovery before resume can rerun HANDS', async () => {
  const cwd = await createGitWorkspace('');
  let providerCalls = 0;
  const mockedProcess = async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    await markBrainConsultation(args, options);
    providerCalls += 1;
    if (args[2] === 'hands-propose') {
      return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ decision: 'propose', summary: 'Safe chunk', files: ['src/app.js'], tests: ['node --test'], sessionID: 'hands-session-timeout' }), stderr: '', timed_out: false };
    }
    if (args[2] === 'hands-consult') {
      return { ok: true, code: 0, signal: null, stdout: JSON.stringify(consultationFor(args, 'hands-session-timeout')), stderr: '', timed_out: false };
    }
    if (providerCalls === 3) {
      return { ok: false, code: null, signal: 'SIGTERM', stdout: JSON.stringify({ type: 'step_start', sessionID: 'hands-session-timeout' }), stderr: '', timed_out: true };
    }
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ decision: 'completed', summary: 'Safe chunk completed', files: ['src/app.js'], tests: ['node --test'], sessionID: 'hands-session-timeout' }), stderr: '', timed_out: false };
  };
  try {
    const proposed = await start('Run a safe chunk', { cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    assert.equal(proposed.state.phase, 'brain_approving');
    const failed = await approve('Approved safe chunk', { cwd, runProcess: mockedProcess });
    assert.equal(failed.state.phase, 'blocked_user');
    assert.equal(failed.state.recovery_required, true);
    const refused = await resume({ cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    assert.equal(refused.state.phase, 'blocked_user');
    assert.match(refused.error, /bridge recover/i);
    assert.equal(providerCalls, 3);
    await runProcess(process.execPath, [coordinator, 'recover'], { cwd });
    const recovered = await resume({ cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    assert.equal(recovered.state.phase, 'brain_reviewing');
    assert.equal(providerCalls, 5);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('timeout errors keep partial provider output bounded', async () => {
  const output = 'x'.repeat(20000);
  await assert.rejects(
    () => invokeAgent('hands', 'prompt', {
      timeoutMs: 10,
      runProcess: async () => ({ ok: false, code: null, signal: 'SIGTERM', stdout: output, stderr: '', timed_out: true })
    }),
    error => error.code === 'provider_timeout'
      && error.message.length < 2200
      && error.message.includes('Provider process exceeded the configured timeout')
      && !error.message.includes('x'.repeat(1000))
  );
});
test('invalid proposal output retries with the configured fallback model', async () => {
  const calls = [];
  const mockedProcess = async (command, args) => {
    calls.push(args);
    if (calls.length === 1) {
      return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ sessionID: 'proposal-fallback-session', message: 'partial output' }), stderr: '', timed_out: false };
    }
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ decision: 'propose', summary: 'Fallback proposal', files: ['README.md'], tests: ['read README'] }), stderr: '', timed_out: false };
  };
  const details = await invokeAgentWithRetry('hands-propose', 'prompt', {
    runProcess: mockedProcess,
    retryAttempts: 2,
    retryDelayMs: 0
  });
  assert.equal(details.result.decision, 'propose');
  assert.deepEqual(calls[1].slice(calls[1].indexOf('--model'), calls[1].indexOf('--model') + 2), ['--model', 'opencode/big-pickle']);
  assert.deepEqual(calls[1].slice(calls[1].indexOf('--session'), calls[1].indexOf('--session') + 2), ['--session', 'proposal-fallback-session']);
});

 test('recent malformed agent locks are protected and stale ones can be unlocked', async () => {
  const cwd = await createGitWorkspace('');
  const file = path.join(cwd, '.bridge', 'agent.lock');
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '', 'utf8');
    await assert.rejects(() => unlockAgent({ cwd }), /invalid|too recent|stale/i);
    const old = new Date(Date.now() - 60000);
    await fs.utimes(file, old, old);
    const result = await unlockAgent({ cwd });
    assert.equal(result.unlocked, true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('provider retry is bounded and reuses a discovered session', async () => {
  let calls = 0;
  const mockedProcess = async (command, args) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(args.includes('--session'), false);
      return { ok: true, code: 0, signal: null, stdout: '{"sessionID":"provider-session-1","message":"partial"}', stderr: '', timed_out: false };
    }
    assert.deepEqual(args.slice(args.indexOf('--session'), args.indexOf('--session') + 2), ['--session', 'provider-session-1']);
    return { ok: true, code: 0, signal: null, stdout: '{"decision":"propose","summary":"Recovered proposal"}', stderr: '', timed_out: false };
  };

  const details = await invokeAgentWithRetry('hands-propose', 'prompt', {
    runProcess: mockedProcess,
    retryAttempts: 2,
    retryDelayMs: 0
  });
  assert.equal(details.result.decision, 'propose');
  assert.equal(calls, 2);
});

test('provider retry does not repeat non-retryable failures', async () => {
  let calls = 0;
  await assert.rejects(
    () => invokeAgentWithRetry('hands-propose', 'prompt', {
      runProcess: async () => {
        calls += 1;
        return { ok: false, code: 1, signal: null, stdout: '', stderr: 'permission denied', timed_out: false };
      },
      retryAttempts: 3,
      retryDelayMs: 0
    }),
    /permission denied/
  );
  assert.equal(calls, 1);
});
test('provider timeout retries once before escalating', async () => {
  let calls = 0;
  const details = await invokeAgentWithRetry('hands-propose', 'prompt', {
    runProcess: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, code: null, signal: 'SIGTERM', stdout: '', stderr: 'timeout', timed_out: true };
      return { ok: true, code: 0, signal: null, stdout: '{"decision":"propose","summary":"Recovered after timeout"}', stderr: '', timed_out: false };
    },
    retryAttempts: 2,
    retryDelayMs: 0
  });
  assert.equal(details.result.summary, 'Recovered after timeout');
  assert.equal(calls, 2);
});
test('resume is idempotent when a previous resume already left planning active', async () => {
  const cwd = await createGitWorkspace('');
  let providerCalls = 0;
  const mockedProcess = async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    providerCalls += 1;
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ decision: 'propose', summary: 'Continued proposal', files: ['README.md'], tests: ['read README'], sessionID: 'hands-session-planning' }), stderr: '', timed_out: false };
  };
  try {
    await runProcess(process.execPath, [coordinator, 'init'], { cwd });
    await runProcess(process.execPath, [coordinator, 'start', 'Already planning task'], { cwd });
    const result = await resume({ cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    assert.equal(result.state.phase, 'brain_approving');
    assert.equal(providerCalls, 1);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
test('proposal blockers preserve their question and require revision', async () => {
  const cwd = await createGitWorkspace('');
  let providerCalls = 0;
  const mockedProcess = async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    providerCalls += 1;
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ decision: 'blocked', question: 'Which storage backend is required?', context: 'The selected backend changes the public API.', sessionID: 'hands-session-blocked' }), stderr: '', timed_out: false };
  };
  try {
    const blocked = await start('Add persistent storage', { cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    assert.equal(blocked.state.phase, 'blocked_user');
    assert.equal(blocked.state.block_kind, 'needs_revision');
    assert.match(blocked.state.blocked_reason, /Which storage backend is required\?/);
    const resumed = await resume({ cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    assert.equal(resumed.state.phase, 'blocked_user');
    assert.match(resumed.error, /bridge revise/i);
    assert.equal(providerCalls, 1);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('consultation blocks material Brain divergence before execution', async () => {
  const cwd = await createGitWorkspace('');
  const mockedProcess = async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    await markBrainConsultation(args, options);
    const output = args[2] === 'hands-propose'
      ? { decision: 'propose', summary: 'Add focused validation', files: ['src/app.js'], tests: ['node --test'], sessionID: 'hands-session-divergence' }
      : { decision: 'blocked', question: 'Brain requires an API redesign before this chunk.', context: 'That is outside the approved scope.', sessionID: 'hands-session-divergence' };
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify(output), stderr: '', timed_out: false };
  };
  try {
    await start('Add validation', { cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    const blocked = await approve('Approve focused validation', { cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    assert.equal(blocked.state.phase, 'blocked_user');
    assert.equal(blocked.state.block_kind, 'needs_revision');
    assert.match(blocked.state.blocked_reason, /API redesign/);
    assert.match(consultationPrompt({ task: 'Add validation', assignment_id: 'assignment', revision: 0, approach: { summary: 'Add focused validation', files: ['src/app.js'] } }), /materially changes.*return decision blocked/i);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('malformed retry preserves the provider session and requests JSON repair', async () => {
  const cwd = await createGitWorkspace('');
  let providerCalls = 0;
  const mockedProcess = async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    providerCalls += 1;
    if (providerCalls === 1) return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ sessionID: 'retry-session-1', part: { text: 'not a decision' } }), stderr: '', timed_out: false };
    assert.deepEqual(args.slice(args.indexOf('--session'), args.indexOf('--session') + 2), ['--session', 'retry-session-1']);
    assert.match(args.at(-1), /previous response was unusable/i);
    return { ok: true, code: 0, signal: null, stdout: 'still not a decision', stderr: '', timed_out: false };
  };
  try {
    const result = await start('Recover malformed provider output', { cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    assert.equal(result.state.phase, 'blocked_user');
    assert.equal(result.state.hands_session_id, 'retry-session-1');
    assert.equal(providerCalls, 2);
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});
test('transient ask_codex tool failures retry in the existing HANDS session', async () => {
  const cwd = await createGitWorkspace('');
  let consultationCalls = 0;
  const sessions = [];
  const mockedProcess = async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    if (args[2] === 'hands-propose') {
      return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ decision: 'propose', summary: 'Add focused validation', files: ['src/app.js'], tests: ['node --test'], sessionID: 'hands-session-transient' }), stderr: '', timed_out: false };
    }
    if (args[2] === 'hands-consult') {
      consultationCalls += 1;
      sessions.push(args.slice(args.indexOf('--session'), args.indexOf('--session') + 2));
      if (consultationCalls === 1) {
        return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ decision: 'blocked', question: 'ask_codex MCP tool spawn failed', context: 'Temporary tool startup failure.', sessionID: 'hands-session-transient' }), stderr: '', timed_out: false };
      }
      await markBrainConsultation(args, options);
      return { ok: true, code: 0, signal: null, stdout: JSON.stringify(consultationFor(args, 'hands-session-transient')), stderr: '', timed_out: false };
    }
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ decision: 'completed', summary: 'Validation added', files: ['src/app.js'], tests: ['node --test'], sessionID: 'hands-session-transient' }), stderr: '', timed_out: false };
  };
  try {
    await start('Add validation', { cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    const completed = await approve('Approve focused validation', { cwd, runProcess: mockedProcess, retryAttempts: 2, retryDelayMs: 0 });
    assert.equal(completed.state.phase, 'brain_reviewing');
    assert.equal(consultationCalls, 2);
    assert.deepEqual(sessions, [['--session', 'hands-session-transient'], ['--session', 'hands-session-transient']]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('exhausted transient consultation failures resume in the existing HANDS session', async () => {
  const cwd = await createGitWorkspace('');
  let consultationCalls = 0;
  const sessions = [];
  const mockedProcess = async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    if (args[2] === 'hands-propose') {
      return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ decision: 'propose', summary: 'Add focused validation', files: ['src/app.js'], tests: ['node --test'], sessionID: 'hands-session-resumable-consult' }), stderr: '', timed_out: false };
    }
    if (args[2] === 'hands-consult') {
      consultationCalls += 1;
      sessions.push(args.slice(args.indexOf('--session'), args.indexOf('--session') + 2));
      if (consultationCalls === 1) {
        return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ decision: 'blocked', transient: true, question: 'ask_codex is temporarily unavailable', context: 'MCP tool startup error.', sessionID: 'hands-session-resumable-consult' }), stderr: '', timed_out: false };
      }
      await markBrainConsultation(args, options);
      return { ok: true, code: 0, signal: null, stdout: JSON.stringify(consultationFor(args, 'hands-session-resumable-consult')), stderr: '', timed_out: false };
    }
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ decision: 'completed', summary: 'Validation added', files: ['src/app.js'], tests: ['node --test'], sessionID: 'hands-session-resumable-consult' }), stderr: '', timed_out: false };
  };
  try {
    await start('Add validation', { cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    const blocked = await approve('Approve focused validation', { cwd, runProcess: mockedProcess, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(blocked.state.phase, 'blocked_user');
    assert.equal(blocked.state.block_kind, 'consultation_retry');
    assert.equal(blocked.state.resume_phase, 'hands_consulting');
    const resumed = await resume({ cwd, runProcess: mockedProcess, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(resumed.state.phase, 'brain_reviewing');
    assert.equal(consultationCalls, 2);
    assert.deepEqual(sessions, [['--session', 'hands-session-resumable-consult'], ['--session', 'hands-session-resumable-consult']]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
test('exhausted provider timeouts during consultation block for a consult retry', async () => {
  const cwd = await createGitWorkspace('');
  let consultationCalls = 0;
  const mockedProcess = async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    if (args[2] === 'hands-propose') {
      return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ decision: 'propose', summary: 'Add focused validation', files: ['src/app.js'], tests: ['node --test'], sessionID: 'hands-session-provider-timeout' }), stderr: '', timed_out: false };
    }
    if (args[2] === 'hands-consult') {
      consultationCalls += 1;
      return { ok: false, code: null, signal: 'SIGTERM', stdout: '', stderr: '', timed_out: true };
    }
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ decision: 'completed', summary: 'Validation added', files: ['src/app.js'], tests: ['node --test'], sessionID: 'hands-session-provider-timeout' }), stderr: '', timed_out: false };
  };
  try {
    await start('Add validation', { cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    const blocked = await approve('Approve focused validation', { cwd, runProcess: mockedProcess, retryAttempts: 2, retryDelayMs: 0 });
    assert.equal(blocked.state.phase, 'blocked_user');
    assert.equal(blocked.state.block_kind, 'consultation_retry');
    assert.equal(blocked.state.resume_phase, 'hands_consulting');
    assert.match(blocked.error, /timeout/i);
    assert.equal(consultationCalls, 2);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
test('resume migrates a raw legacy transient consultation block before rejecting revisions', async () => {
  const cwd = await createGitWorkspace('');
  let consultationCalls = 0;
  const mockedProcess = async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    if (args[2] === 'hands-consult') {
      consultationCalls += 1;
      await markBrainConsultation(args, options);
      return { ok: true, code: 0, signal: null, stdout: JSON.stringify(consultationFor(args, 'hands-session-legacy-consult')), stderr: '', timed_out: false };
    }
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify({ decision: 'completed', summary: 'Validation added', files: ['src/app.js'], tests: ['node --test'], sessionID: 'hands-session-legacy-consult' }), stderr: '', timed_out: false };
  };
  try {
    await runProcess(process.execPath, [coordinator, 'init'], { cwd });
    await runProcess(process.execPath, [coordinator, 'start', 'Resume legacy consultation'], { cwd });
    await runProcess(process.execPath, [coordinator, 'approach', 'Add focused validation', '--files', 'src/app.js', '--manual'], { cwd });
    await runProcess(process.execPath, [coordinator, 'bind-session', 'hands-session-legacy-consult'], { cwd });
    await runProcess(process.execPath, [coordinator, 'approve'], { cwd });
    const stateFile = path.join(cwd, '.bridge', 'state.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    await fs.writeFile(stateFile, JSON.stringify({
      ...state,
      phase: 'blocked_user',
      active_agent: 'user',
      block_kind: 'needs_revision',
      recovery_required: false,
      resume_phase: 'hands_consulting',
      blocked_reason: 'ask_codex MCP tool spawn failed. Temporary tool startup failure.'
    }, null, 2) + '\n', 'utf8');

    const resumed = await resume({ cwd, runProcess: mockedProcess, retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(resumed.state.phase, 'brain_reviewing');
    assert.equal(consultationCalls, 1);
    assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).block_kind, null);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});


test('phase prompts use compact role-aware JSON protocols', () => {
  const state = { task: 'Add validation', assignment_id: 'a1', revision: 1, approach: { summary: 'Small chunk', files: ['src/app.js'] } };
  assert.match(proposalReviewPrompt(state), /Role: BRAIN-REVIEW/);
  assert.match(proposalReviewPrompt(state), /"decision":"approved\\|revise\\|escalate"/);
  assert.match(evaluationPrompt(state, { decision: 'completed' }), /Role: HANDS-EVALUATE/);
  assert.match(resultReviewPrompt(state, { decision: 'completed' }, { decision: 'passed' }), /Role: BRAIN-RESULT-REVIEW/);
});


test('start defaults to Brain-first autonomous review and evaluation', async () => {
  const cwd = await createGitWorkspace('');
  const mockedProcess = async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    const role = args[2];
    const prompt = String(args.at(-1) || '');
    if (role === 'hands-propose') return { ok: true, code: 0, stdout: JSON.stringify({ decision: 'propose', summary: 'Small autonomous chunk', files: ['README.md'], tests: ['read README'], sessionID: 'auto-session' }), stderr: '', timed_out: false };
    if (role === 'hands-evaluate') return { ok: true, code: 0, stdout: JSON.stringify({ decision: 'passed', summary: 'Focused checks pass', tests: ['read README'] }), stderr: '', timed_out: false };
    if (role === 'hands') return { ok: true, code: 0, stdout: JSON.stringify({ decision: 'completed', summary: 'Chunk complete', sessionID: 'auto-session' }), stderr: '', timed_out: false };
    if (prompt.includes('proposal_review')) {
      await options.onEvent?.({ type: 'tool.completed', tool: 'ask_codex' });
      return { ok: true, code: 0, stdout: JSON.stringify({ decision: 'approved', summary: 'Safe bounded proposal' }), stderr: '', timed_out: false };
    }
    if (prompt.includes('result_review')) {
      await options.onEvent?.({ type: 'tool.completed', tool: 'ask_codex' });
      return { ok: true, code: 0, stdout: JSON.stringify({ decision: 'passed', summary: 'Result accepted' }), stderr: '', timed_out: false };
    }
    await options.onEvent?.({ type: 'tool.completed', tool: 'ask_codex' });
    return { ok: true, code: 0, stdout: JSON.stringify(consultationFor(args, 'auto-session')), stderr: '', timed_out: false };
  };
  try {
    const result = await startRunner('Autonomous chunk', { cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    assert.equal(result.state.phase, 'done');
    assert.equal(result.state.autonomy.mode, 'brain_approved');
    assert.equal(result.state.evaluation.status, 'passed');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
