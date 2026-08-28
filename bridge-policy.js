'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const policyFileName = path.join('.bridge', 'policy.json');

const defaultPolicy = Object.freeze({
  protected_paths: ['.env', '.env.*', '**/*.pem', '**/*.key', '**/id_rsa*'],
  protected_commands: ['git reset --hard', 'git clean -fd', 'rm -rf', 'Remove-Item -Recurse', 'format '],
  approved_domains: [],
  blocked_domains: []
});

function mergePolicy(value = {}) {
  return {
    policy_mode: value.policy_mode,
    protected_paths: [...new Set([...(defaultPolicy.protected_paths || []), ...(value.protected_paths || [])])],
    protected_commands: [...new Set([...(defaultPolicy.protected_commands || []), ...(value.protected_commands || [])])],
    approved_domains: [...new Set(value.approved_domains || [])],
    blocked_domains: [...new Set(value.blocked_domains || [])]
  };
}

async function loadPolicy(cwd) {
  try {
    return mergePolicy(JSON.parse(await fs.readFile(path.join(cwd, policyFileName), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return mergePolicy();
    throw new Error('Invalid bridge policy: ' + error.message);
  }
}

function wildcard(pattern, value) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$', 'i').test(value);
}

function protectedPath(target, policy) {
  const normalized = String(target || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return policy.protected_paths.some(pattern => wildcard(pattern, normalized) || wildcard(pattern, path.posix.basename(normalized)));
}

function commandRisk(command, policy) {
  const text = String(command || '');
  if (policy.protected_commands.some(item => text.toLowerCase().includes(String(item).toLowerCase()))) return 'critical';
  if (/\b(npm|pnpm|yarn|bun|pip|cargo)\s+(install|add|remove)\b/i.test(text)) return 'high';
  if (/\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b/i.test(text)) return 'high';
  return 'low';
}

function classifyAction(action, policy = mergePolicy()) {
  const value = action || {};
  const target = value.target || value.path || '';
  const command = value.command || value.request || '';
  const kind = String(value.kind || '').toLowerCase();
  let risk = 'low';
  if (protectedPath(target, policy)) risk = 'critical';
  if (kind.includes('delete') || kind.includes('network') || kind.includes('install')) risk = risk === 'critical' ? risk : 'high';
  const commandLevel = commandRisk(command, policy);
  if (['critical', 'high'].includes(commandLevel)) risk = commandLevel === 'critical' ? 'critical' : (risk === 'critical' ? risk : 'high');
  return {
    risk,
    requires_approval: ['high', 'critical'].includes(risk),
    protected_target: protectedPath(target, policy),
    policy_version: 1
  };
}

const policyModes = ['enforce', 'escalate', 'off'];

function resolvePolicyMode(policy, env) {
  const raw = (env && env.MIND_LIMB_POLICY_MODE) || (policy && policy.policy_mode) || 'enforce';
  const mode = String(raw).trim().toLowerCase();
  if (!policyModes.includes(mode)) {
    throw new Error('Invalid bridge policy mode: ' + raw + '. Valid modes: enforce, escalate, off.');
  }
  return mode;
}

function policyGate(classified, mode) {
  if (mode === 'off') return 'proceed';
  return classified && ['critical', 'high'].includes(classified.risk) ? 'block' : 'proceed';
}

module.exports = { defaultPolicy, mergePolicy, loadPolicy, classifyAction, protectedPath, commandRisk, resolvePolicyMode, policyGate, policyFileName };
