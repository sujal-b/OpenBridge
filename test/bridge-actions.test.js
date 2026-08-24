const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { appendAction, normalizeAction, redact } = require('../bridge-actions');

test('action records are bounded and redact common secrets', () => {
  const record = normalizeAction({
    session_id: 'session-1',
    assignment_id: 'assignment-1',
    agent: 'hands',
    kind: 'command',
    phase: 'hands_executing',
    target: 'npm',
    summary: 'Authorization: Bearer super-secret-token'
  });
  assert.equal(record.session_id, 'session-1');
  assert.match(record.summary, /\[REDACTED\]/);
  assert.equal(redact('api_key=secret-value'), 'api_key=[REDACTED]');
  assert.ok(record.summary.length <= 240);
});

test('concurrent action appends remain valid, ordered JSONL', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-actions-'));
  try {
    await Promise.all(Array.from({ length: 40 }, (_, index) => appendAction({
      session_id: 'session-stress',
      assignment_id: 'assignment-stress',
      revision: index,
      agent: 'hands',
      kind: 'tool',
      phase: 'hands_executing',
      target: 'read:' + index,
      summary: 'Read source file ' + index,
      status: 'finish'
    }, { cwd })));
    const lines = (await fs.readFile(path.join(cwd, '.bridge', 'actions.jsonl'), 'utf8')).trim().split(/\r?\n/);
    const records = lines.map(line => JSON.parse(line));
    assert.equal(records.length, 40);
    assert.deepEqual(records.map(record => record.seq), Array.from({ length: 40 }, (_, index) => index));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
