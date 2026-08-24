const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runProcess } = require('../bridge-adapter');
const { spawnSync } = require('node:child_process');
const { runAgent, proposalPrompt, executionPrompt, start, resume, revise, approve, invokeAgent, invokeAgentWithRetry, AgentBusyError } = require('../bridge-runner');

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

test('Brain answers are carried into a revised proposal', async () => {
  const cwd = await createGitWorkspace('');
  let providerCalls = 0;
  const prompts = [];
  const mockedProcess = async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    providerCalls += 1;
    prompts.push(args[args.length - 1]);
    const result = providerCalls === 1
      ? { decision: 'propose', summary: 'Choose an implementation style', files: ['README.md'], tests: ['read README'], questions: ['Should this favor minimal code or maximum performance?'], sessionID: 'hands-session-feedback' }
      : { decision: 'propose', summary: 'Use the minimal implementation style', files: ['README.md'], tests: ['read README'], sessionID: 'hands-session-feedback' };
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify(result), stderr: '', timed_out: false };
  };
  try {
    const blocked = await start('Choose an implementation style', { cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    assert.equal(blocked.state.phase, 'blocked_user');
    const revised = await revise('Use minimal code with focused validation.', { cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    assert.equal(revised.state.phase, 'brain_approving');
    assert.match(prompts[1], /Brain feedback or answers/);
    assert.match(prompts[1], /Use minimal code/);
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