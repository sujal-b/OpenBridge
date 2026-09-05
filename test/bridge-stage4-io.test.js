'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { httpPost } = require('../bridge-brain');
const coordinatorLib = require('../bridge-coordinator');
const { loadProvidersJson, saveProvidersJson } = require('../bridge-config');
const { invalidate: invalidateFsCache } = require('../bridge-fscache');
const { lastEvent } = require('../bridge-state');

async function withWorkspace(fn) {
  const base = path.join(process.cwd(), '.tmp-test-workspaces');
  await fs.mkdir(base, { recursive: true });
  const cwd = await fs.mkdtemp(path.join(base, 'stage4-io-'));
  try {
    return await fn(cwd);
  } finally {
    invalidateFsCache();
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

test('brain httpPost reuses one keep-alive connection across calls', async () => {
  let connections = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  server.on('connection', () => { connections += 1; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const first = await httpPost('http://127.0.0.1:' + port + '/v1/chat', { prompt: 'one' }, {}, 5000);
    const second = await httpPost('http://127.0.0.1:' + port + '/v1/chat', { prompt: 'two' }, {}, 5000);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(connections, 1, 'expected connection reuse, saw ' + connections + ' connections');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('config cache serves fresh reads after direct file rewrites (mtime/size key)', async () => {
  await withWorkspace(async cwd => {
    const providersPath = path.join(cwd, '.bridge', 'providers.json');
    await fs.mkdir(path.dirname(providersPath), { recursive: true });
    await fs.writeFile(providersPath, JSON.stringify({ version: 1, brain: { active: 'zen', custom: {} }, hands: { active: null } }), 'utf8');
    assert.equal((await loadProvidersJson(cwd)).brain.active, 'zen');
    // Rewrite through plain fs (not saveProvidersJson): the mtime/size key must
    // pick up the change on the next read.
    await fs.writeFile(providersPath, JSON.stringify({ version: 1, brain: { active: 'openai', custom: {} }, hands: { active: null } }), 'utf8');
    assert.equal((await loadProvidersJson(cwd)).brain.active, 'openai');
  });
});

test('saveProvidersJson invalidates the cached entry', async () => {
  await withWorkspace(async cwd => {
    await saveProvidersJson(cwd, { version: 1, brain: { active: 'zen', custom: {} }, hands: { active: null } });
    assert.equal((await loadProvidersJson(cwd)).brain.active, 'zen');
    await saveProvidersJson(cwd, { version: 1, brain: { active: 'groq', custom: {} }, hands: { active: null } });
    assert.equal((await loadProvidersJson(cwd)).brain.active, 'groq');
  });
});

test('config cache key is mtime+size: identical-size rewrites stay stale until invalidated', async () => {
  await withWorkspace(async cwd => {
    const providersPath = path.join(cwd, '.bridge', 'providers.json');
    await fs.mkdir(path.dirname(providersPath), { recursive: true });
    const v1 = JSON.stringify({ version: 1, brain: { active: 'groq', custom: {} }, hands: { active: null } });
    const v2 = JSON.stringify({ version: 1, brain: { active: 'grog', custom: {} }, hands: { active: null } });
    assert.equal(v1.length, v2.length, 'test fixture requires equal-length bodies');
    await fs.writeFile(providersPath, v1, 'utf8');
    // Normalize both mtimes to whole seconds so the two writes share a key.
    const truncate = async () => {
      const stat = await fs.stat(providersPath);
      const wholeSecond = new Date(Math.floor(stat.mtimeMs / 1000) * 1000);
      await fs.utimes(providersPath, wholeSecond, wholeSecond);
    };
    await truncate();
    assert.equal((await loadProvidersJson(cwd)).brain.active, 'groq');
    await fs.writeFile(providersPath, v2, 'utf8');
    await truncate();
    // Same size, same second: the documented pathological case is served stale…
    assert.equal((await loadProvidersJson(cwd)).brain.active, 'groq');
    // …and explicit invalidation is the escape hatch.
    invalidateFsCache(providersPath);
    assert.equal((await loadProvidersJson(cwd)).brain.active, 'grog');
  });
});

test('lastEvent returns the max seq and its session id from a long log', async () => {
  await withWorkspace(async cwd => {
    const bridgeDir = path.join(cwd, '.bridge');
    await fs.mkdir(bridgeDir, { recursive: true });
    const lines = [];
    for (let seq = 1; seq <= 400; seq++) {
      lines.push(JSON.stringify({ seq, session_id: 'sess-' + seq, type: 'activity_updated' }));
    }
    // Trailing partial line (a reader can observe one during append).
    lines.push('{"seq":401,"session_i');
    await fs.writeFile(path.join(bridgeDir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');
    const info = await lastEvent(cwd);
    assert.equal(info.seq, 400);
    assert.equal(info.session_id, 'sess-400');
  });
});

test('lastEvent tolerates a missing events log', async () => {
  await withWorkspace(async cwd => {
    const info = await lastEvent(cwd);
    assert.deepEqual(info, { seq: -1, session_id: null });
  });
});

test('commit skips the plan.md rewrite when the rendered plan is unchanged', async () => {
  await withWorkspace(async cwd => {
    await coordinatorLib.handleCommand(['init'], { cwd });
    const planFile = path.join(cwd, '.bridge', 'plan.md');
    const mtimeOf = async () => (await fs.stat(planFile)).mtimeMs;
    // activity does not alter the rendered plan: no rewrite should occur.
    await coordinatorLib.handleCommand(['activity', 'hands', 'Working'], { cwd });
    const before = await mtimeOf();
    await new Promise(resolve => setTimeout(resolve, 20));
    await coordinatorLib.handleCommand(['activity', 'hands', 'Still working'], { cwd });
    assert.equal(await mtimeOf(), before, 'plan.md was rewritten for a plan-neutral mutation');
    // start changes the task, so the plan must be rewritten.
    await new Promise(resolve => setTimeout(resolve, 20));
    await coordinatorLib.handleCommand(['start', 'Build the login page'], { cwd });
    assert.notEqual(await mtimeOf(), before, 'plan.md was not rewritten for a plan-changing mutation');
    const plan = await fs.readFile(planFile, 'utf8');
    assert.match(plan, /Build the login page/);
  });
});

test('coordinator log renders the requested number of tail events in order', async () => {
  await withWorkspace(async cwd => {
    await coordinatorLib.handleCommand(['init'], { cwd });
    for (let i = 1; i <= 6; i++) {
      await coordinatorLib.handleCommand(['activity', 'hands', 'Event number ' + i], { cwd });
    }
    const outcome = await coordinatorLib.handleCommand(['log', '3'], { cwd });
    const lines = outcome.text.trim().split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /Event number 4/);
    assert.match(lines[2], /Event number 6/);
  });
});
