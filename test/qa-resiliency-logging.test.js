'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { autoAdvance, readState } = require('../bridge-runner');
const coordinator = path.join(__dirname, '..', 'bridge-coordinator.js');

async function makeTestRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-resiliency-'));
  spawnSync('git', ['init'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'README.md'), '# Test\n', 'utf8');
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: dir });

  // Init coordinator
  spawnSync(process.execPath, [coordinator, 'init'], { cwd: dir });
  return dir;
}

test('autoAdvance: approval-gate dirty tree blocks as dirty_tree without crashing', async () => {
  const cwd = await makeTestRepo();

  // Create an assignment and submit proposal
  spawnSync(process.execPath, [coordinator, 'start', 'Add feature'], { cwd });
  spawnSync(process.execPath, [coordinator, 'approach', 'Update README', '--files', 'README.md'], { cwd });

  // Make the git working tree dirty behind the scenes
  await fs.writeFile(path.join(cwd, 'unrelated.txt'), 'dirty tree content', 'utf8');

  // Run autoAdvance with a mock brainReviewProposal that approves
  const proposedState = await readState({ cwd });
  const result = await autoAdvance({ state: proposedState }, {
    cwd,
    brainReviewProposal: async () => ({ decision: 'approved', summary: 'Looks good' })
  });

  // A dirty tree is a retryable environment block, not a proposal failure: the
  // block kind must let resume re-enter approval after cleanup, and the reason
  // must list the offending files.
  assert.equal(result.state.phase, 'blocked_user');
  assert.equal(result.state.block_kind, 'dirty_tree');
  assert.match(result.error, /dirty/i);

  const finalState = await readState({ cwd });
  assert.equal(finalState.phase, 'blocked_user');
  assert.equal(finalState.block_kind, 'dirty_tree');
  assert.match(finalState.blocked_reason, /dirty/i);
  assert.match(finalState.blocked_reason, /unrelated\.txt/);
  assert.equal(finalState.resume_phase, 'brain_approving');

  // Clean up
  await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
});

test('autoAdvance: non-environmental transition failures still block as escalation', async () => {
  const cwd = await makeTestRepo();

  spawnSync(process.execPath, [coordinator, 'start', 'Add feature'], { cwd });
  // No --files: the approval gate rejects the approach for a reason no amount
  // of tree cleanup can fix, so escalation (revise) is the correct outcome.
  spawnSync(process.execPath, [coordinator, 'approach', 'Update README'], { cwd });

  const proposedState = await readState({ cwd });
  const result = await autoAdvance({ state: proposedState }, {
    cwd,
    brainReviewProposal: async () => ({ decision: 'approved', summary: 'Looks good' })
  });

  assert.equal(result.state.phase, 'blocked_user');
  assert.equal(result.state.block_kind, 'escalation');
  assert.match(result.error, /at least one file/i);

  await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
});
