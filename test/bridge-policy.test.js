const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyAction, mergePolicy, protectedPath } = require('../bridge-policy');

test('policy protects common secret paths and permits ordinary source files', () => {
  const policy = mergePolicy();
  assert.equal(protectedPath('.env', policy), true);
  assert.equal(protectedPath('certs/server.pem', policy), true);
  assert.equal(protectedPath('src/main.js', policy), false);
});

test('policy classifies destructive, install, and network actions as gated', () => {
  const policy = mergePolicy();
  assert.equal(classifyAction({ kind: 'file_delete', target: 'src/old.js' }, policy).requires_approval, true);
  assert.equal(classifyAction({ kind: 'command', command: 'npm install three' }, policy).risk, 'high');
  assert.equal(classifyAction({ kind: 'network_request', target: 'https://example.com' }, policy).risk, 'high');
  assert.equal(classifyAction({ kind: 'file_read', target: 'src/main.js' }, policy).requires_approval, false);
});

test('project policy extends rather than weakens safe defaults', () => {
  const policy = mergePolicy({ protected_paths: ['config/private.json'], approved_domains: ['api.example.com'] });
  assert.equal(protectedPath('config/private.json', policy), true);
  assert.equal(protectedPath('.env', policy), true);
  assert.deepEqual(policy.approved_domains, ['api.example.com']);
});
