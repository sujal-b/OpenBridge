'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { brainConsultChunk } = require('../bridge-brain');

function makeState() {
  return {
    task: 'Fix the login bug',
    assignment_id: 'a1',
    revision: 1,
    approach: { summary: 'Patch auth guard', files: ['src/auth.js'], style: 'standard', risks: [], assumptions: [] }
  };
}

async function withBrainServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-brain-'));
  const prevBase = process.env.MIND_LIMB_BRAIN_BASE_URL;
  process.env.MIND_LIMB_BRAIN_BASE_URL = 'http://127.0.0.1:' + port;
  try {
    // cwd = empty dir so the repo's own .bridge/brain.json cannot override the test baseURL.
    return await fn({ provider: 'custom', apiKey: 'test-key', timeoutMs: 5000, cwd });
  } finally {
    if (prevBase === undefined) delete process.env.MIND_LIMB_BRAIN_BASE_URL;
    else process.env.MIND_LIMB_BRAIN_BASE_URL = prevBase;
    await fs.rm(cwd, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

function brainBody(decision) {
  return JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] });
}

const options = { provider: 'custom', apiKey: 'test-key', timeoutMs: 5000 };

test('brainConsultChunk approves when approved is true', async () => {
  await withBrainServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(brainBody({ approved: true, guidance: 'Proceed' }));
  }, async opts => {
    const result = await brainConsultChunk(makeState(), opts);
    assert.equal(result.guidance, 'Proceed');
  });
});

test('brainConsultChunk rejects malformed response missing approved field', async () => {
  await withBrainServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(brainBody({ guidance: 'I did not decide' }));
  }, async opts => {
    await assert.rejects(
      brainConsultChunk(makeState(), opts),
      error => error.code === 'brain_api_failed'
    );
  });
});

test('brainConsultChunk rejects when approved is false', async () => {
  await withBrainServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(brainBody({ approved: false, concerns: ['too broad'] }));
  }, async opts => {
    await assert.rejects(
      brainConsultChunk(makeState(), opts),
      error => error.code === 'brain_rejected'
    );
  });
});

test('brainConsultChunk retries transient 429 and succeeds', async () => {
  let attempts = 0;
  await withBrainServer((req, res) => {
    attempts += 1;
    if (attempts === 1) {
      res.writeHead(429, { 'Retry-After': '0' });
      res.end('rate limited');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(brainBody({ approved: true, guidance: 'ok' }));
  }, async opts => {
    const result = await brainConsultChunk(makeState(), opts);
    assert.equal(result.guidance, 'ok');
    assert.equal(attempts, 2);
  });
});

test('brainConsultChunk gives up after 3 attempts on persistent 500', async () => {
  let attempts = 0;
  await withBrainServer((req, res) => {
    attempts += 1;
    res.writeHead(500, {});
    res.end('boom');
  }, async opts => {
    await assert.rejects(
      brainConsultChunk(makeState(), opts),
      error => error.code === 'brain_api_failed' && error.statusCode === 500
    );
    assert.equal(attempts, 3);
  });
});
