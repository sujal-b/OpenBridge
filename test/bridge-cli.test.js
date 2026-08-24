const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '..', 'bridge.js');

function run(cwd, args, expected = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, expected, `${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

test('public help exposes short commands and hides implementation paths', () => {
  const result = run(process.cwd(), ['help']);
  assert.match(result.stdout, /bridge run/);
  assert.match(result.stdout, /bridge watch/);
  assert.match(result.stdout, /bridge doctor/);
  assert.match(result.stdout, /bridge done/);
  assert.match(result.stdout, /bridge recover/);
  assert.match(result.stdout, /bridge inspect/);
  assert.match(result.stdout, /bridge policy/);
  assert.doesNotMatch(result.stdout, /bridge-coordinator\.js/);
});

test('watch uses a single repainting terminal frame', async () => {
  const source = await fs.readFile(cli, 'utf8');
  assert.match(source, /readline\.moveCursor/);
  assert.match(source, /readline\.clearScreenDown/);
  assert.match(source, /MIND_LIMB_BRIDGE_TIMEOUT_MS/);
  assert.match(source, /controlsFor/);
  assert.match(source, /recover/);
});

test('bridge open prepares a selected project and status accepts --project', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-cli-'));
  try {
    run(cwd, ['open', cwd]);
    const profiles = path.join(cwd, '.opencode', 'agents');
    assert.match(await fs.readFile(path.join(profiles, 'hands-consult.md'), 'utf8'), /ask-codex_\*: allow/);
    assert.match(await fs.readFile(path.join(profiles, 'hands.md'), 'utf8'), /ask-codex_\*: deny/);
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