'use strict';

// Auto-commit of accepted chunks. After the Brain accepts a chunk result, the
// bridge commits exactly the accepted files so the next chunk starts from a
// clean tree with no human git round-trip. User edits, stray files, and
// pre-existing user staging must never land in the bridge's commit.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runner = require('../bridge-runner');
const { repoPath } = require('../bridge-coordinator');

async function createGitWorkspace(prefix, { identity = true } = {}) {
  const base = path.join(process.cwd(), '.tmp-test-workspaces');
  await fs.mkdir(base, { recursive: true });
  const cwd = await fs.mkdtemp(path.join(base, prefix || 'auto-commit-'));
  await fs.writeFile(path.join(cwd, '.gitignore'), '.bridge/\n', 'utf8');
  await fs.writeFile(path.join(cwd, 'README.md'), '# Test project\n', 'utf8');
  const git = args => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, 'git ' + args.join(' ') + ' failed: ' + result.stderr);
    return result;
  };
  git(['init', '-q']);
  if (identity) {
    git(['config', 'user.email', 'auto-commit@example.invalid']);
    git(['config', 'user.name', 'Auto Commit Tests']);
  }
  git(['add', '.']);
  git(['commit', '-qm', 'baseline']);
  return cwd;
}

function gitOut(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function head(cwd) {
  return gitOut(cwd, ['rev-parse', 'HEAD']).stdout.trim();
}

function reviewState(cwd, extra = {}) {
  return {
    schema_version: 1,
    session_id: 'session-auto-commit',
    assignment_id: 'assignment-auto-commit',
    phase: 'brain_reviewing',
    task: 'Auto commit task',
    active_agent: 'mind',
    activity: { agent: 'mind', action: 'Reviewing', started_at: new Date().toISOString() },
    revision: 1,
    hands_session_id: 'sess-auto-commit',
    approach: { summary: 'Update README', files: ['README.md'], risks: [], acceptance: [], revision: 1 },
    approval: 'approved',
    autonomy: { mode: 'brain_autonomous', approved_by: null, approved_at: null },
    consultation: null,
    execution_lease_id: null,
    git_before: head(cwd),
    git_after: head(cwd),
    git_status: 'changes_present',
    attempt_scope: [repoPath('README.md')],
    blocked_reason: null,
    block_kind: null,
    resume_phase: null,
    recovery_required: false,
    event_seq: 3,
    updated_at: new Date().toISOString(),
    ...extra
  };
}

test('autoCommitChunk commits accepted files and leaves user files uncommitted', async () => {
  const cwd = await createGitWorkspace('auto-commit-scope-');
  try {
    await fs.appendFile(path.join(cwd, 'README.md'), '\naccepted chunk change\n', 'utf8');
    await fs.writeFile(path.join(cwd, 'stray.txt'), 'user droppings\n', 'utf8');

    const result = await runner.autoCommitChunk(reviewState(cwd), { cwd });

    assert.equal(result.committed, true);
    const subject = gitOut(cwd, ['log', '-1', '--pretty=%s']).stdout.trim();
    assert.match(subject, /^bridge\(chunk\): Auto commit task$/);
    assert.match(gitOut(cwd, ['log', '-1', '--pretty=%b']).stdout, /assignment-auto-commit/);
    const remaining = gitOut(cwd, ['status', '--porcelain=v1', '--untracked-files=all']).stdout.trim();
    assert.equal(remaining, '?? stray.txt', 'only the out-of-scope user file may remain');
    assert.match(gitOut(cwd, ['show', '--pretty=format:', '--name-only', 'HEAD']).stdout, /README\.md/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('autoCommitChunk commits chunk-created untracked files inside the scope', async () => {
  const cwd = await createGitWorkspace('auto-commit-created-');
  try {
    await fs.writeFile(path.join(cwd, 'created-by-chunk.txt'), 'chunk output\n', 'utf8');
    const state = reviewState(cwd, { attempt_scope: [repoPath('README.md'), repoPath('created-by-chunk.txt')] });

    const result = await runner.autoCommitChunk(state, { cwd });

    assert.equal(result.committed, true);
    assert.equal(gitOut(cwd, ['status', '--porcelain=v1']).stdout.trim(), '');
    assert.match(gitOut(cwd, ['show', '--pretty=format:', '--name-only', 'HEAD']).stdout, /created-by-chunk\.txt/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('autoCommitChunk refuses to sweep in pre-existing user staging', async () => {
  const cwd = await createGitWorkspace('auto-commit-staging-');
  try {
    await fs.appendFile(path.join(cwd, 'README.md'), '\naccepted chunk change\n', 'utf8');
    await fs.writeFile(path.join(cwd, 'user-wip.txt'), 'half done\n', 'utf8');
    const staged = gitOut(cwd, ['add', 'user-wip.txt']);
    assert.equal(staged.status, 0);

    const result = await runner.autoCommitChunk(reviewState(cwd), { cwd });

    assert.equal(result.committed, false);
    assert.equal(result.skipped, 'user-staging-present');
    assert.equal(gitOut(cwd, ['rev-list', '--count', 'HEAD']).stdout.trim(), '1', 'no commit may be created');
    const stagedNow = gitOut(cwd, ['diff', '--cached', '--name-only']).stdout.trim();
    assert.equal(stagedNow, 'user-wip.txt', 'the user staging must survive untouched');
    assert.match(gitOut(cwd, ['status', '--porcelain=v1']).stdout, / M README\.md/, 'the chunk change stays in the worktree');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('autoCommitChunk is idempotent on an already clean tree', async () => {
  const cwd = await createGitWorkspace('auto-commit-clean-');
  try {
    const result = await runner.autoCommitChunk(reviewState(cwd), { cwd });
    assert.equal(result.committed, false);
    assert.equal(result.skipped, 'clean');
    assert.equal(gitOut(cwd, ['rev-list', '--count', 'HEAD']).stdout.trim(), '1');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('autoCommitChunk falls back to a bridge identity when none is configured', async () => {
  const cwd = await createGitWorkspace('auto-commit-identity-', { identity: false });
  const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
  const prevSystem = process.env.GIT_CONFIG_SYSTEM;
  try {
    // Hide machine-level git identity so the fallback is actually exercised.
    const emptyConfig = path.join(cwd, '.empty-gitconfig');
    await fs.writeFile(emptyConfig, '', 'utf8');
    process.env.GIT_CONFIG_GLOBAL = emptyConfig;
    process.env.GIT_CONFIG_SYSTEM = emptyConfig;
    await fs.appendFile(path.join(cwd, 'README.md'), '\naccepted chunk change\n', 'utf8');

    const result = await runner.autoCommitChunk(reviewState(cwd), { cwd });

    assert.equal(result.committed, true);
    assert.equal(gitOut(cwd, ['log', '-1', '--pretty=%an']).stdout.trim(), 'mind-limb-bridge');
  } finally {
    if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    if (prevSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = prevSystem;
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

async function writeState(cwd, state) {
  const file = path.join(cwd, '.bridge', 'state.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state) + '\n', 'utf8');
}

test('reviewResult done path auto-commits the accepted chunk', async () => {
  const cwd = await createGitWorkspace('auto-commit-review-');
  try {
    await fs.appendFile(path.join(cwd, 'README.md'), '\nexecuted chunk change\n', 'utf8');
    await writeState(cwd, reviewState(cwd));

    // Git runs for real (committing is a repository operation, not a provider
    // call); only the evaluator agent is stubbed.
    const runProcessStub = async (cmd, args) => {
      if (cmd !== 'opencode') throw new Error('unexpected command: ' + cmd);
      const agent = args[2];
      if (agent === 'hands-evaluate') {
        return {
          ok: true, code: 0, signal: null, timed_out: false, stderr: '',
          stdout: JSON.stringify({ decision: 'passed', summary: 'evaluation ok', tests: [], risks: [] })
        };
      }
      throw new Error('unexpected agent call: ' + agent);
    };

    const result = await runner.reviewResult({ result: 'executed' }, {
      cwd,
      runProcess: runProcessStub,
      brainReviewResult: async () => ({ decision: 'complete', summary: 'Brain accepted the chunk.' })
    });

    assert.equal(result.state.phase, 'done');
    assert.equal(result.chunkCommit.committed, true);
    assert.match(gitOut(cwd, ['log', '-1', '--pretty=%s']).stdout, /bridge\(chunk\): Auto commit task/);
    assert.equal(gitOut(cwd, ['status', '--porcelain=v1']).stdout.trim(), '');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('autoCommitChunk never stages runtime data', async () => {
  const cwd = await createGitWorkspace('runtime-commit-');
  try {
    await fs.appendFile(path.join(cwd, 'README.md'), '\naccepted chunk change\n', 'utf8');
    await fs.mkdir(path.join(cwd, '.omo', 'run-continuation'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.omo', 'run-continuation', 'ses_1.json'), '{}\n', 'utf8');

    const result = await runner.autoCommitChunk(reviewState(cwd), { cwd });

    assert.equal(result.committed, true);
    const committedFiles = gitOut(cwd, ['show', '--pretty=format:', '--name-only', 'HEAD']).stdout;
    assert.match(committedFiles, /README\.md/);
    assert.doesNotMatch(committedFiles, /\.omo/);
    assert.match(gitOut(cwd, ['status', '--porcelain=v1', '--untracked-files=all']).stdout, / \.omo\//, 'runtime data stays untracked');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
