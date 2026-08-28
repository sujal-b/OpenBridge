const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyAction, mergePolicy, protectedPath, resolvePolicyMode, policyGate } = require('../bridge-policy');

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

test('wildcard **/ patterns protect root-level and nested secret files', () => {
  const policy = mergePolicy();
  assert.equal(protectedPath('secret.pem', policy), true);
  assert.equal(protectedPath('certs/server.pem', policy), true);
  assert.equal(protectedPath('id_rsa', policy), true);
  assert.equal(protectedPath('.ssh/id_rsa', policy), true);
  assert.equal(protectedPath('.env', policy), true);
  assert.equal(protectedPath('.env.local', policy), true);
  assert.equal(protectedPath('src/index.js', policy), false);
});

test('policyGate maps mode and risk to proceed or block', () => {
  const expected = {
    off: { critical: 'proceed', high: 'proceed', low: 'proceed' },
    enforce: { critical: 'block', high: 'block', low: 'proceed' },
    escalate: { critical: 'block', high: 'block', low: 'proceed' }
  };
  for (const mode of Object.keys(expected)) {
    for (const risk of ['critical', 'high', 'low']) {
      assert.equal(policyGate({ risk }, mode), expected[mode][risk], mode + '/' + risk);
    }
  }
});

test('resolvePolicyMode defaults to enforce and rejects invalid modes', () => {
  assert.equal(resolvePolicyMode(null, {}), 'enforce');
  assert.equal(resolvePolicyMode(mergePolicy({ policy_mode: 'escalate' }), {}), 'escalate');
  assert.equal(resolvePolicyMode(mergePolicy({ policy_mode: 'off' }), { MIND_LIMB_POLICY_MODE: 'enforce' }), 'enforce');
  assert.throws(() => resolvePolicyMode(mergePolicy({ policy_mode: 'yolo' }), {}), /Invalid bridge policy mode/);
  assert.throws(() => resolvePolicyMode(null, { MIND_LIMB_POLICY_MODE: 'nope' }), /Invalid bridge policy mode/);
});
