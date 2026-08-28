const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '..', 'bridge.js');
const coordinator = path.resolve(__dirname, '..', 'bridge-coordinator.js');
const { controlsFor, controlAllowed } = require('../bridge');
const { computeMaxRunTimeoutMs } = require('../bridge-adapter');

function git(cwd, args, expected = 0) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, expected, `git ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

function runCoordinator(cwd, args, expected = 0) {
  const result = spawnSync(process.execPath, [coordinator, ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, expected, `coordinator ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

function run(cwd, args, expected = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, expected, `${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

test('public help exposes short commands and hides implementation paths', () => {
  const result = run(process.cwd(), ['help']);
  assert.match(result.stdout, /bridge new/);
  assert.match(result.stdout, /bridge run/);
  assert.match(result.stdout, /bridge watch/);
  assert.match(result.stdout, /bridge doctor/);
  assert.match(result.stdout, /bridge done/);
  assert.match(result.stdout, /bridge recover/);
  assert.match(result.stdout, /bridge unlock/);
  assert.match(result.stdout, /bridge unlock-agent/);
  assert.match(result.stdout, /bridge inspect/);
  assert.match(result.stdout, /bridge policy/);
  assert.doesNotMatch(result.stdout, /bridge-coordinator\.js/);
});

test('autonomous dashboard removes ordinary approval shortcut', () => {
  const controls = controlsFor({ phase: 'brain_approving', autonomy: { mode: 'brain_approved' } });
  assert.doesNotMatch(controls, /approve/);
  assert.equal(controlAllowed('approve', { phase: 'brain_approving', autonomy: { mode: 'brain_approved' } }), false);
  assert.match(controls, /quit/);
});

test('watch uses a single repainting terminal frame', async () => {
  const source = await fs.readFile(cli, 'utf8');
  assert.match(source, /\\x1b\[\?1049h/);
  assert.match(source, /\\x1b\[\?1049l/);
  assert.match(source, /\\x1b\[H\\x1b\[2J/);
  assert.match(source, /MIND_LIMB_BRIDGE_TIMEOUT_MS/);
  assert.match(source, /controlsFor/);
  assert.match(source, /recover/);
});

test('outer bridge kill timeout covers every runner timeout variable plus headroom', () => {
  assert.equal(computeMaxRunTimeoutMs({}), 630000);
  assert.equal(computeMaxRunTimeoutMs({ MIND_LIMB_EXECUTION_TIMEOUT_MS: '1200000' }), 1230000);
  assert.equal(computeMaxRunTimeoutMs({ MIND_LIMB_PROPOSAL_TIMEOUT_MS: '900000' }), 930000);
  assert.equal(computeMaxRunTimeoutMs({ MIND_LIMB_CONSULT_TIMEOUT_MS: '900000' }), 930000);
  assert.equal(computeMaxRunTimeoutMs({ MIND_LIMB_AGENT_TIMEOUT_MS: '900000' }), 930000);
  assert.equal(
    computeMaxRunTimeoutMs({ MIND_LIMB_AGENT_TIMEOUT_MS: '900000', MIND_LIMB_EXECUTION_TIMEOUT_MS: '60000' }),
    930000,
    'a high AGENT_TIMEOUT alone must raise the wrapper kill above the execution default'
  );
});

test('bridge wrapper timeout: explicit 0 or unset falls back to the computed runner maximum', async () => {
  const source = await fs.readFile(cli, 'utf8');
  assert.match(source, /MIND_LIMB_BRIDGE_TIMEOUT_MS\)\s*\|\|\s*computeMaxRunTimeoutMs\(process\.env\)/);
});


test('bridge new creates a ready mock project', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-new-cli-'));
  const cwd = path.join(parent, 'Bridge-Mock-E2E');
  try {
    const result = run(process.cwd(), ['new', cwd, '--name', 'Sujal Barwad', '--email', 'sujal.barwad27@gmail.com']);
    assert.match(result.stdout, /Baseline commit ready/);
    assert.equal(await fs.readFile(path.join(cwd, 'README.md'), 'utf8'), '# Bridge-Mock-E2E\n');
    assert.match(await fs.readFile(path.join(cwd, '.gitignore'), 'utf8'), /^\.bridge\/$/m);
    assert.equal(JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'state.json'), 'utf8')).phase, 'idle');
    assert.equal(git(cwd, ['log', '-1', '--pretty=%s']).stdout.trim(), 'baseline');
    assert.equal(git(cwd, ['status', '--porcelain']).stdout, '');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('bridge open prepares a selected project and status accepts --project', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-cli-'));
  try {
    run(cwd, ['open', cwd]);
    const profiles = path.join(cwd, '.opencode', 'agents');
    assert.match(await fs.readFile(path.join(profiles, 'hands-consult.md'), 'utf8'), /ask-codex_\*: allow/);
    assert.match(await fs.readFile(path.join(profiles, 'hands.md'), 'utf8'), /ask-codex_\*: deny/);
    const evaluator = await fs.readFile(path.join(profiles, 'hands-evaluate.md'), 'utf8');
    assert.match(evaluator, /HANDS-EVALUATE/);
    assert.match(evaluator, /decision.*passed\|failed/);
    assert.match(evaluator, /edit: deny/);
    assert.match(evaluator, /ask-codex_\*: deny/);
    await fs.writeFile(path.join(profiles, 'hands-consult.md'), 'user-owned profile\n', 'utf8');
    run(cwd, ['open', cwd]);
    assert.equal(await fs.readFile(path.join(profiles, 'hands-consult.md'), 'utf8'), 'user-owned profile\n');
    const status = run(process.cwd(), ['status', '--project', cwd]);
    assert.match(status.stdout, /Phase: idle/);
    assert.match(status.stdout, /Last: Bridge initialized/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
test('bridge open provisions an idempotent runtime .gitignore', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-ignore-cli-'));
  try {
    await fs.writeFile(path.join(cwd, '.gitignore'), '# keep this\ncustom-cache/\n.bridge/\n', 'utf8');
    run(cwd, ['open', cwd]);
    const first = await fs.readFile(path.join(cwd, '.gitignore'), 'utf8');
    assert.match(first, /^# keep this$/m);
    assert.match(first, /^custom-cache\/$/m);
    for (const entry of ['.bridge/', '.opencode/', 'node_modules/', 'dist/']) {
      assert.match(first, new RegExp('^' + entry.replace('.', '\\.') + '$', 'm'));
    }
    run(cwd, ['open', cwd]);
    assert.equal(await fs.readFile(path.join(cwd, '.gitignore'), 'utf8'), first);
    git(cwd, ['init', '-q']);
    git(cwd, ['config', 'user.email', 'evaluation@example.invalid']);
    git(cwd, ['config', 'user.name', 'Mind-Limb Evaluation']);
    git(cwd, ['add', '.']);
    git(cwd, ['commit', '-qm', 'baseline']);
    runCoordinator(cwd, ['start', 'Approve from a clean baseline']);
    runCoordinator(cwd, ['approach', 'Change one approved file', '--files', 'app.txt', '--manual']);
    runCoordinator(cwd, ['approve']);
    const state = JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'state.json'), 'utf8'));
    assert.equal(state.phase, 'hands_consulting');
    assert.equal(state.git_status, 'clean_before_execution');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('bridge stop reports unavailable after cancellation', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-stop-cli-'));
  try {
    run(cwd, ['open', cwd]);
    run(process.cwd(), ['stop', '--project', cwd]);
    const result = run(process.cwd(), ['stop', '--project', cwd], 1);
    assert.match(result.stderr, /Stop is unavailable while the session is cancelled/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('bridge unlock routes stale lock cleanup', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-unlock-cli-'));
  try {
    run(cwd, ['open', cwd]);
    const bridgeDir = path.join(cwd, '.bridge');
    await fs.writeFile(path.join(bridgeDir, 'state.lock'), 'stale\n', 'utf8');
    const staleAt = new Date(Date.now() - 60000);
    await fs.utimes(path.join(bridgeDir, 'state.lock'), staleAt, staleAt);
    const coordinatorUnlock = run(process.cwd(), ['unlock', '--project', cwd]);
    assert.match(coordinatorUnlock.stdout, /Stale coordinator lock removed/);
    await fs.writeFile(path.join(bridgeDir, 'agent.lock'), JSON.stringify({ token: 'stale', role: 'hands' }) + '\n', 'utf8');
    await fs.utimes(path.join(bridgeDir, 'agent.lock'), staleAt, staleAt);
    const agentUnlock = run(process.cwd(), ['unlock-agent', '--project', cwd]);
    assert.match(agentUnlock.stdout, /unlocked/);
    await assert.rejects(fs.access(path.join(bridgeDir, 'state.lock')));
    await assert.rejects(fs.access(path.join(bridgeDir, 'agent.lock')));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('bridge policy exposes safe project defaults', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-policy-cli-'));
  try {
    run(cwd, ['open', cwd]);
    const result = run(process.cwd(), ['policy', '--project', cwd]);
    assert.match(result.stdout, /protected_paths/);
    assert.match(result.stdout, /\.env/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
test('bridge open seeds an empty Brain API key so the legacy fallback stays available', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-brainkey-cli-'));
  try {
    run(cwd, ['open', cwd]);
    const config = JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'brain.json'), 'utf8'));
    assert.equal(config.api_key, process.env.BRAIN_API_KEY || '');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('bridge run resumes an interrupted autonomous result review', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-review-cli-'));
  try {
    run(cwd, ['open', cwd]);
    // Unknown provider forces brain_config_error -> fallback to mocked hands-consult (no network).
    await fs.writeFile(path.join(cwd, '.bridge', 'brain.json'), JSON.stringify({ provider: '__test_noop__' }) + '\n', 'utf8');
    await fs.writeFile(path.join(cwd, 'run'), [
      "process.stdout.write(JSON.stringify({ type: 'tool.completed', tool: 'ask_codex' }) + String.fromCharCode(10));",
      "process.stdout.write(JSON.stringify({ decision: 'passed', summary: 'Focused checks pass' }) + String.fromCharCode(10));"
    ].join('\n') + '\n', 'utf8');
    git(cwd, ['init', '-q']);
    git(cwd, ['config', 'user.email', 'review@example.invalid']);
    git(cwd, ['config', 'user.name', 'Mind-Limb Review']);
    git(cwd, ['add', '.']);
    git(cwd, ['commit', '-qm', 'baseline']);

    runCoordinator(cwd, ['start', 'Resume the interrupted result review']);
    runCoordinator(cwd, ['approach', 'Update the README', '--files', 'README.md']);
    let state = JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'state.json'), 'utf8'));
    runCoordinator(cwd, ['bind-session', 'review-session']);
    runCoordinator(cwd, ['brain-approve', 'Brain approved the README chunk']);
    state = JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'state.json'), 'utf8'));
    runCoordinator(cwd, ['consult', JSON.stringify({
      decision: 'approved',
      assignment_id: state.assignment_id,
      revision: state.revision,
      summary: 'Brain confirmed the README chunk.',
      brain_answer: 'Proceed with the approved README change.'
    })]);
    state = JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'state.json'), 'utf8'));
    runCoordinator(cwd, ['claim-execution', state.execution_lease_id]);
    await fs.writeFile(path.join(cwd, 'README.md'), '# Resumed review\n', 'utf8');
    runCoordinator(cwd, ['complete', state.execution_lease_id, 'README chunk complete']);
    state = JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'state.json'), 'utf8'));
    assert.equal(state.phase, 'brain_reviewing');

    const result = spawnSync(process.execPath, [cli, 'run', '--project', cwd], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        MIND_LIMB_OPENCODE_COMMAND: process.execPath,
        MIND_LIMB_AGENT_TIMEOUT_MS: '10000',
        MIND_LIMB_AGENT_RETRY_DELAY_MS: '0'
      }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Phase: done/);
    assert.match(result.stdout, /Evaluation: passed/);
    state = JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'state.json'), 'utf8'));
    assert.equal(state.phase, 'done');
    assert.equal(state.evaluation.status, 'passed');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});