const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { allowedControls, createInspectorServer, parseJsonLines, readSnapshot } = require('../bridge-inspector');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function makeWorkspace() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-inspector-'));
  await fs.mkdir(path.join(cwd, '.bridge'));
  const at = new Date().toISOString();
  await fs.writeFile(path.join(cwd, '.bridge', 'state.json'), JSON.stringify({
    session_id: 'session-1', assignment_id: 'assignment-1', phase: 'brain_approving', active_agent: 'mind',
    task: 'Inspector test', approval: 'pending', event_seq: 1, updated_at: at,
    activity: { agent: 'mind', action: 'Waiting for approval' }
  }));
  await fs.writeFile(path.join(cwd, '.bridge', 'events.jsonl'), JSON.stringify({ seq: 0, at, type: 'initialized', summary: 'ready' }) + '\n');
  await fs.writeFile(path.join(cwd, '.bridge', 'actions.jsonl'), '');
  return cwd;
}

test('inspector serves HTML, snapshots, and an initial SSE snapshot', async () => {
  const cwd = await makeWorkspace();
  const server = await createInspectorServer({ projectRoot: cwd, port: 0, intervalMs: 50 }).start();
  try {
    const html = await (await fetch(server.url)).text();
    assert.match(html, /Mind-Limb Bridge Inspector/);
    const snapshot = await (await fetch(server.url + 'api/snapshot')).json();
    assert.equal(snapshot.state.phase, 'brain_approving');
    assert.deepEqual(snapshot.controls, ['approve', 'revise', 'pause', 'stop']);
    const response = await fetch(server.url + 'api/stream');
    const reader = response.body.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    assert.match(text, /event: snapshot/);
    assert.match(text, /"controls":\[/);
    await reader.cancel();
  } finally {
    await server.close();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
test('allowed controls follow phase, clarification, and recovery state', () => {
  const cases = [
    [{ phase: 'brain_approving' }, ['approve', 'revise', 'pause', 'stop']],
    [{ phase: 'brain_approving', autonomy: { mode: 'brain_autonomous' } }, ['pause', 'stop']],
    [{ phase: 'brain_reviewing', autonomy: { mode: 'brain_approved' } }, ['pause', 'stop']],
    [{ phase: 'blocked_user', resume_phase: 'planning', block_kind: 'escalation', autonomy: { mode: 'brain_autonomous' } }, ['revise', 'pause', 'stop']],
    [{ phase: 'brain_reviewing' }, ['revise', 'done', 'pause', 'stop']],
    [{ phase: 'blocked_user', resume_phase: 'planning' }, ['revise', 'pause', 'resume', 'stop']],
    [{ phase: 'blocked_user', resume_phase: 'hands_proposing', block_kind: 'needs_revision' }, ['revise', 'pause', 'stop']],
    [{ phase: 'blocked_user', resume_phase: 'hands_consulting', block_kind: 'consultation_retry' }, ['pause', 'resume', 'stop']],
    [{ phase: 'blocked_user', resume_phase: 'hands_consulting', recovery_required: true }, ['pause', 'stop', 'recover']],
    [{ phase: 'hands_executing' }, ['recover']],
    [{ phase: 'hands_consulting' }, ['pause', 'stop']],
    [{ phase: 'paused' }, ['resume', 'stop']],
    [{ phase: 'done' }, []],
    [{ phase: 'unknown' }, []],
    [{ phase: 'cancelled' }, []]
  ];
  for (const [state, controls] of cases) assert.deepEqual(allowedControls(state), controls, state.phase);
});


test('inspector serializes simultaneous controls and enforces the phase', async () => {
  const cwd = await makeWorkspace();
  let calls = 0;
  const server = await createInspectorServer({
    projectRoot: cwd,
    port: 0,
    commandRunner: async () => { calls += 1; await delay(60); return { output: 'ok' }; }
  }).start();
  try {
    const post = () => fetch(server.url + 'api/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve' }) });
    const [first, second] = await Promise.all([post(), post()]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(calls, 1);
  } finally {
    await server.close();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('inspector enforces recovery-aware controls without changing state', async () => {
  const cwd = await makeWorkspace();
  const stateFile = path.join(cwd, '.bridge', 'state.json');
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  state.phase = 'blocked_user';
  state.recovery_required = true;
  state.resume_phase = 'hands_consulting';
  await fs.writeFile(stateFile, JSON.stringify(state));
  let calls = 0;
  const server = await createInspectorServer({
    projectRoot: cwd,
    port: 0,
    commandRunner: async () => { calls += 1; return { output: 'ok' }; }
  }).start();
  try {
    const snapshot = await (await fetch(server.url + 'api/snapshot')).json();
    assert.deepEqual(snapshot.controls, ['pause', 'stop', 'recover']);
    const resume = await fetch(server.url + 'api/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'resume' }) });
    assert.equal(resume.status, 409);
    const recover = await fetch(server.url + 'api/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'recover' }) });
    assert.equal(recover.status, 200);
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')), state);
  } finally {
    await server.close();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('inspector ignores incomplete JSONL tails and bounds large logs', async () => {
  const cwd = await makeWorkspace();
  try {
    const eventFile = path.join(cwd, '.bridge', 'events.jsonl');
    const line = JSON.stringify({ seq: 1, at: new Date().toISOString(), type: 'activity', summary: 'x'.repeat(120) }) + '\n';
    await fs.writeFile(eventFile, line.repeat(6000) + '{"partial":');
    const parsed = parseJsonLines('{"ok":1}\n{"partial":', 'events.jsonl');
    assert.deepEqual(parsed.values, [{ ok: 1 }]);
    const snapshot = await readSnapshot(cwd);
    assert.ok(snapshot.events.length < 6000);
    assert.ok(snapshot.warnings.some(item => item.type === 'truncated'));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});