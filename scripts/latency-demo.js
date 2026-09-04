#!/usr/bin/env node
'use strict';
// Standalone demo: drives one chunk through the real CLI with a mock provider,
// then prints `bridge latency`. Run from the repo root:
//   node scripts/latency-demo.js
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const NODE = process.execPath;
const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bridge.js');
const COORD = path.join(REPO, 'bridge-coordinator.js');

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    console.error('FAIL:', cmd, args.join(' '), '\n', r.stdout, r.stderr);
    process.exit(1);
  }
  return r;
}

const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'lat-demo-'));
const cwd = path.join(parent, 'Demo');
try {
  sh(NODE, [CLI, 'new', cwd, '--name', 'Demo', '--email', 'demo@ex.invalid'], { cwd: REPO, stdio: 'ignore' });
  fs.writeFileSync(path.join(cwd, '.bridge', 'brain.json'), '{"provider":"__test_noop__"}\n');
  fs.writeFileSync(path.join(cwd, 'run'), [
    "process.stdout.write(JSON.stringify({ type: 'tool.completed', tool: 'ask_codex' }) + String.fromCharCode(10));",
    "process.stdout.write(JSON.stringify({ decision: 'passed', summary: 'Focused checks pass' }) + String.fromCharCode(10));",
    ''
  ].join('\n'));
  sh('git', ['add', '.'], { cwd, stdio: 'ignore' });
  sh('git', ['commit', '-qm', 'baseline2'], { cwd, stdio: 'ignore' });
  const coord = (args) => sh(NODE, [COORD, ...args], { cwd, stdio: 'ignore' });
  coord(['start', 'Demo task']);
  coord(['approach', 'Update README', '--files', 'README.md']);
  coord(['bind-session', 'demo-sess']);
  coord(['brain-approve', 'approved']);
  const st = () => JSON.parse(fs.readFileSync(path.join(cwd, '.bridge', 'state.json'), 'utf8'));
  const s1 = st();
  coord(['consult', JSON.stringify({ decision: 'approved', assignment_id: s1.assignment_id, revision: s1.revision, summary: 'ok', brain_answer: 'proceed' })]);
  const s2 = st();
  coord(['claim-execution', s2.execution_lease_id]);
  fs.writeFileSync(path.join(cwd, 'README.md'), '# Demo\n');
  coord(['complete', s2.execution_lease_id, 'done']);
  sh(NODE, [CLI, 'run', '--project', cwd], {
    cwd: REPO,
    stdio: 'ignore',
    env: { ...process.env, MIND_LIMB_OPENCODE_COMMAND: NODE, MIND_LIMB_AGENT_TIMEOUT_MS: '10000', MIND_LIMB_AGENT_RETRY_DELAY_MS: '0' }
  });
  console.log('=== bridge latency ===\n');
  const report = sh(NODE, [CLI, 'latency', '--project', cwd], { cwd: REPO });
  console.log(report.stdout);
} finally {
  fs.rmSync(parent, { recursive: true, force: true });
}
