const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readJsonLines } = require('../bridge');

test('bridge watch reads only a bounded tail of long JSONL logs', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-watch-'));
  try {
    await fs.mkdir(path.join(cwd, '.bridge'));
    const lines = Array.from({ length: 1000 }, (_, seq) => JSON.stringify({ seq, summary: 'x'.repeat(80) })).join('\n') + '\n';
    await fs.writeFile(path.join(cwd, '.bridge', 'events.jsonl'), lines);
    const values = await readJsonLines(cwd, 'events.jsonl', 5, 1024);
    assert.ok(values.length > 0);
    assert.ok(values.length <= 5);
    assert.equal(values.at(-1).seq, 999);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('bridge watch returns an empty list for a missing log', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-watch-missing-'));
  try {
    await fs.mkdir(path.join(cwd, '.bridge'));
    assert.deepEqual(await readJsonLines(cwd, 'missing.jsonl'), []);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
