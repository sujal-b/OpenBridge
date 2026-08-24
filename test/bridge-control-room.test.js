const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createInspectorServer } = require('../bridge-inspector');

const inspectorFile = path.join(__dirname, '..', 'inspector.html');

async function readInspector() {
  return fs.readFile(inspectorFile, 'utf8');
}

async function makeWorkspace() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-control-room-'));
  await fs.mkdir(path.join(cwd, '.bridge'));
  await fs.writeFile(path.join(cwd, '.bridge', 'state.json'), JSON.stringify({
    phase: 'brain_approving',
    active_agent: 'mind',
    task: 'Control Room test',
    updated_at: new Date().toISOString()
  }));
  await fs.writeFile(path.join(cwd, '.bridge', 'events.jsonl'), '');
  await fs.writeFile(path.join(cwd, '.bridge', 'actions.jsonl'), '');
  return cwd;
}

test('Control Room keeps agent panels, controls, freshness, and safe detail rendering', async () => {
  const html = (await readInspector()).replace(/\s+/g, ' ');
  const script = await fs.readFile(path.join(__dirname, '..', 'inspector-control-room.js'), 'utf8');

  assert.match(html, /(?:data-agent|data-panel|id|class)=["'][^"']*(?:mind|brain)[^"']*["']|>\s*MIND\s*</i);
  assert.match(html, /(?:data-agent|data-panel|id|class)=["'][^"']*hands[^"']*["']|>\s*HANDS\s*</i);
  assert.match(html, /(?:one control at a time|single control|control[^<]{0,80}(?:busy|running|locked)|(?:busy|running|locked)[^<]{0,80}control)/i);

  for (const control of ['approve', 'revise', 'pause', 'resume', 'recover', 'done', 'stop']) {
    assert.match(html, new RegExp(`data-control=["']${control}["']`));
  }

  for (const marker of ['liveText', 'liveDot', 'RECONNECTING', 'OFFLINE', 'generated_at', 'EventSource']) {
    assert.match(html, new RegExp(marker));
  }

  assert.match(html, /Expanded detail/);
  assert.match(html, /renderDetail\(/);
  assert.match(html, /addEventListener\(['"]click['"]|onclick/);
  assert.match(html, /textContent/);
  assert.match(html, /replaceChildren\(\)/);
  assert.match(html, /bridge-snapshot/);
  assert.match(html, /inspector-control-room\.js/);
  assert.match(script, /bridge-snapshot/);
  assert.doesNotMatch(script, /new EventSource/);
  assert.match(html, /createElement\(/);
  assert.doesNotMatch(html, /\.innerHTML\s*=/);
});

test('duplicate inspector controls are rejected while the first control is busy', async () => {
  const cwd = await makeWorkspace();
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const server = createInspectorServer({
    projectRoot: cwd,
    commandRunner: async () => {
      enter();
      await blocked;
      return { output: 'ok' };
    }
  });

  try {
    const first = server.control('approve');
    await entered;
    assert.equal(server.controlBusy, true);
    await assert.rejects(server.control('revise'), error => error.statusCode === 409 && /already running/.test(error.message));
    release();
    await first;
    assert.equal(server.controlBusy, false);
  } finally {
    release();
    await server.close();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('inspector serves the live Control Room asset from the same local server', async () => {
  const cwd = await makeWorkspace();
  const server = await createInspectorServer({ projectRoot: cwd, port: 0 }).start();
  try {
    const response = await fetch(server.url + 'inspector-control-room.js');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.match(await response.text(), /Live MIND and HANDS control room/);
  } finally {
    await server.close();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});