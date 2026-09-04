'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { readJsonlTail, readJsonlPair } = require('../bridge-read');
const { renderSessionError } = require('../bridge');

async function withTempDir(fn) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-read-'));
  try {
    return await fn(cwd);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

function line(i) {
  return JSON.stringify({ seq: i, at: '2026-01-01T00:00:' + String(i % 60).padStart(2, '0') + 'Z', summary: 'event ' + i }) + '\n';
}

test('tail window honoured, first partial line discarded', async () => {
  await withTempDir(async cwd => {
    const file = path.join(cwd, 'events.jsonl');
    let text = '';
    for (let i = 0; i < 200; i += 1) text += line(i);
    await fs.writeFile(file, text, 'utf8');
    const full = await readJsonlTail(file, { maxBytes: 512 * 1024, source: 'events.jsonl' });
    assert.equal(full.values.length, 200);
    const small = await readJsonlTail(file, { maxBytes: 800, source: 'events.jsonl' });
    assert.equal(small.truncated, true);
    assert.ok(small.values.length < 200 && small.values.length > 0);
    assert.equal(small.values[small.values.length - 1].seq, 199);
  });
});

test('row cap applied before parse', async () => {
  await withTempDir(async cwd => {
    const file = path.join(cwd, 'actions.jsonl');
    let text = '';
    for (let i = 0; i < 500; i += 1) text += line(i);
    await fs.writeFile(file, text, 'utf8');
    const originalParse = JSON.parse;
    let parses = 0;
    JSON.parse = (...args) => { parses += 1; return originalParse(...args); };
    try {
      const capped = await readJsonlTail(file, { maxBytes: 512 * 1024, limit: 160, source: 'actions.jsonl' });
      assert.equal(capped.values.length, 160);
      assert.equal(capped.parseCount, 160);
      assert.equal(capped.values[159].seq, 499);
      assert.ok(parses <= 170, 'expected ~160 parses, got ' + parses);
    } finally {
      JSON.parse = originalParse;
    }
  });
});

test('limit:0 returns empty without parsing', async () => {
  await withTempDir(async cwd => {
    const file = path.join(cwd, 'actions.jsonl');
    let text = '';
    for (let i = 0; i < 10; i += 1) text += line(i);
    await fs.writeFile(file, text, 'utf8');
    const result = await readJsonlTail(file, { maxBytes: 512 * 1024, limit: 0, source: 'actions.jsonl' });
    assert.deepEqual(result.values, []);
    assert.equal(result.parseCount, 0);
  });
});

test('torn final line skipped, malformed mid-line warns with line number', async () => {
  await withTempDir(async cwd => {
    const file = path.join(cwd, 'events.jsonl');
    await fs.writeFile(
      file,
      JSON.stringify({ seq: 1 }) + '\n' + '{broken\n' + JSON.stringify({ seq: 3 }) + '\n' + '{"seq":4',
      'utf8'
    );
    const result = await readJsonlTail(file, { source: 'events.jsonl' });
    assert.deepEqual(result.values.map(v => v.seq), [1, 3]);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].line, 2);
    assert.equal(result.warnings[0].type, 'malformed');
  });
});

test('ENOENT returns available:false without throwing', async () => {
  await withTempDir(async cwd => {
    const result = await readJsonlTail(path.join(cwd, 'nope.jsonl'), { source: 'nope.jsonl' });
    assert.equal(result.available, false);
    assert.deepEqual(result.values, []);
  });
});

test('TUI limits preserved on large files', async () => {
  await withTempDir(async cwd => {
    await fs.mkdir(path.join(cwd, '.bridge'), { recursive: true });
    let text = '';
    for (let i = 0; i < 1000; i += 1) text += line(i);
    await fs.writeFile(path.join(cwd, '.bridge', 'events.jsonl'), text, 'utf8');
    await fs.writeFile(path.join(cwd, '.bridge', 'actions.jsonl'), text, 'utf8');
    const tails = await readJsonlPair(cwd, {
      events: { maxBytes: 256 * 1024, limit: 120 },
      actions: { maxBytes: 256 * 1024, limit: 160 }
    });
    assert.ok(tails.events.values.length <= 120);
    assert.ok(tails.actions.values.length <= 160);
    assert.equal(tails.events.values[tails.events.values.length - 1].seq, 999);
  });
});

test('empty-state message survives on ENOENT', () => {
  const missing = new Error("ENOENT: no such file or directory, open '.bridge/state.json'");
  missing.code = 'ENOENT';
  assert.match(renderSessionError(missing), /No bridge session\. Run: bridge open \./);
  const cooldown = new Error('state.json is unreadable; repair already failed and is on cooldown.');
  cooldown.code = 'STATE_REPAIR_COOLDOWN';
  assert.match(renderSessionError(cooldown), /repair on cooldown/);
});

test('TUI window matches inspector tail within window', async () => {
  await withTempDir(async cwd => {
    await fs.mkdir(path.join(cwd, '.bridge'), { recursive: true });
    let text = '';
    for (let i = 0; i < 300; i += 1) text += line(i);
    await fs.writeFile(path.join(cwd, '.bridge', 'events.jsonl'), text, 'utf8');
    await fs.writeFile(path.join(cwd, '.bridge', 'actions.jsonl'), text, 'utf8');
    const tui = await readJsonlPair(cwd, {
      events: { maxBytes: 256 * 1024, limit: 120 },
      actions: { maxBytes: 256 * 1024, limit: 160 }
    });
    const full = await readJsonlPair(cwd, {
      events: { maxBytes: 512 * 1024 },
      actions: { maxBytes: 512 * 1024 }
    });
    assert.deepEqual(
      tui.events.values.map(v => v.seq),
      full.events.values.map(v => v.seq).slice(-120)
    );
    assert.deepEqual(
      tui.actions.values.map(v => v.seq),
      full.actions.values.map(v => v.seq).slice(-160)
    );
  });
});
