
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runProcess } = require('../bridge-adapter');
const { start } = require('../bridge-runner');

async function workspace() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-auto-'));
  await fs.writeFile(path.join(cwd, '.gitignore'), '.bridge/\n.opencode/\n', 'utf8');
  await fs.writeFile(path.join(cwd, 'README.md'), '# autonomous test\n', 'utf8');
  const git = args => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q']);
  git(['config', 'user.name', 'Bridge Test']);
  git(['config', 'user.email', 'bridge@example.invalid']);
  git(['add', '.']);
  git(['commit', '-qm', 'baseline']);
  return cwd;
}

test('default runner is autonomous: Brain revises, approves, evaluates, and finishes without human approval', async () => {
  const cwd = await workspace();
  const coordinator = path.resolve(__dirname, '..', 'bridge-coordinator.js');
  const calls = [];
  let proposals = 0;
  let consultations = 0;
  const sessionID = 'auto-session-1';
  const mockedProcess = async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    const agent = args[2];
    calls.push(agent);
    if (agent === 'hands-propose') {
      proposals += 1;
      return { ok: true, code: 0, stdout: JSON.stringify({
        decision: 'propose',
        role: 'frontend UX engineer',
        summary: proposals === 1 ? 'First bounded slice' : 'Revised bounded slice',
        files: ['README.md'],
        tests: ['node --check README.md'],
        sessionID
      }), stderr: '', timed_out: false };
    }
    if (agent === 'hands-consult') {
      consultations += 1;
      if (options.onEvent) await options.onEvent({ type: 'tool.completed', tool: 'ask_codex' });
      const prompt = String(args.at(-1) || '');
      const assignment = (prompt.match(/Assignment ID: ([^\r\n]+)/) || [])[1];
      const revision = Number((prompt.match(/Revision: (\d+)/) || [])[1]);
      if (consultations === 1) return { ok: true, code: 0, stdout: JSON.stringify({ decision: 'revise', summary: 'Narrow the first slice and keep the UX role.' }), stderr: '', timed_out: false };
      if (consultations === 2) return { ok: true, code: 0, stdout: JSON.stringify({ decision: 'approved', summary: 'Brain approved the revised slice.', brain_answer: 'Proceed with the bounded UX change.' }), stderr: '', timed_out: false };
      if (consultations === 3) return { ok: true, code: 0, stdout: JSON.stringify({ decision: 'approved', assignment_id: assignment, revision, summary: 'Brain confirmed execution.', brain_answer: 'Proceed with approved files.' }), stderr: '', timed_out: false };
      return { ok: true, code: 0, stdout: JSON.stringify({ decision: 'passed', summary: 'Brain accepted the evaluated result.' }), stderr: '', timed_out: false };
    }
    if (agent === 'hands-evaluate') {
      return { ok: true, code: 0, stdout: JSON.stringify({ decision: 'passed', summary: 'Read-only checks passed.', tests: ['node --check README.md'], risks: [] }), stderr: '', timed_out: false };
    }
    if (agent === 'hands') {
      return { ok: true, code: 0, stdout: JSON.stringify({ decision: 'completed', summary: 'Executed bounded slice.', files: ['README.md'], tests: ['node --check README.md'], sessionID }), stderr: '', timed_out: false };
    }
    throw new Error('Unexpected agent: ' + agent);
  };
  try {
    const result = await start('Improve the dashboard presentation', { cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    assert.equal(result.state.phase, 'done');
    assert.equal(result.state.autonomy.mode, 'brain_approved');
    assert.equal(result.state.autonomy.approved_by, 'brain');
    assert.equal(result.state.evaluation.status, 'passed');
    assert.equal(result.state.revision, 3);
    assert.equal(proposals, 2);
    assert.equal(consultations, 4);
    assert.ok(!calls.includes('approve'));
    assert.match(result.state.approach.role, /frontend UX engineer/i);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

 test('legacy approve cannot bypass an autonomous Brain proposal', async () => {
  const cwd = await workspace();
  const coordinator = path.resolve(__dirname, '..', 'bridge-coordinator.js');
  try {
    assert.equal((await runProcess(process.execPath, [coordinator, 'init'], { cwd })).ok, true);
    assert.equal((await runProcess(process.execPath, [coordinator, 'start', 'Guard approval boundary'], { cwd })).ok, true);
    assert.equal((await runProcess(process.execPath, [coordinator, 'approach', 'Role: reliability architect\nBounded check', '--files', 'README.md'], { cwd })).ok, true);
    const result = await runProcess(process.execPath, [coordinator, 'approve'], { cwd });
    assert.equal(result.ok, false);
    assert.match(result.stderr, /Ordinary approval is disabled/i);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('autonomous Brain continue runs a fresh bounded chunk before complete', async () => {
  const cwd = await workspace();
  const coordinator = path.resolve(__dirname, '..', 'bridge-coordinator.js');
  let proposals = 0;
  let executions = 0;
  let resultReviews = 0;
  const consultations = [];
  const sessionID = 'loop-session-1';
  const mockedProcess = async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    const agent = args[2];
    const prompt = String(args.at(-1) || '');
    if (agent === 'hands-propose') {
      proposals += 1;
      return { ok: true, code: 0, stdout: JSON.stringify({ decision: 'propose', role: 'reliability architect', summary: 'Chunk ' + proposals, files: ['README.md'], tests: ['read README.md'], sessionID }), stderr: '', timed_out: false };
    }
    if (agent === 'hands-evaluate') {
      return { ok: true, code: 0, stdout: JSON.stringify({ decision: 'passed', summary: 'Focused checks passed.', tests: ['read README.md'], risks: [] }), stderr: '', timed_out: false };
    }
    if (agent === 'hands') {
      executions += 1;
      return { ok: true, code: 0, stdout: JSON.stringify({ decision: 'completed', summary: 'Chunk ' + executions + ' complete.', files: ['README.md'], tests: ['read README.md'], sessionID }), stderr: '', timed_out: false };
    }
    if (agent === 'hands-consult') {
      await options.onEvent?.({ type: 'tool.completed', tool: 'ask_codex' });
      if (prompt.includes('Phase: proposal_review')) {
        return { ok: true, code: 0, stdout: JSON.stringify({ decision: 'approved', summary: 'Proposal is bounded.' }), stderr: '', timed_out: false };
      }
      if (prompt.includes('Phase: result_review')) {
        resultReviews += 1;
        return { ok: true, code: 0, stdout: JSON.stringify({ decision: resultReviews === 1 ? 'continue' : 'complete', summary: resultReviews === 1 ? 'Continue with the next bounded chunk.' : 'All chunks complete.' }), stderr: '', timed_out: false };
      }
      const assignment = (prompt.match(/Assignment ID: ([^\r\n]+)/) || [])[1];
      const revision = Number((prompt.match(/Revision: (\d+)/) || [])[1]);
      consultations.push(revision);
      return { ok: true, code: 0, stdout: JSON.stringify({ decision: 'approved', assignment_id: assignment, revision, summary: 'Brain confirmed chunk ' + revision, brain_answer: 'Proceed with the approved files.' }), stderr: '', timed_out: false };
    }
    throw new Error('Unexpected agent: ' + agent);
  };
  try {
    const result = await start('Run all bounded chunks', { cwd, runProcess: mockedProcess, retryDelayMs: 0 });
    assert.equal(result.state.phase, 'done');
    assert.equal(proposals, 2);
    assert.equal(executions, 2);
    assert.equal(resultReviews, 2);
    assert.deepEqual(consultations, [1, 2]);
    assert.equal(result.state.revision, 2);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});