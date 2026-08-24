#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { runProcess, parseStructuredResult, extractSessionId, buildOpencodeArgs } = require('./bridge-adapter');
const { appendAction } = require('./bridge-actions');
const { loadPolicy, classifyAction } = require('./bridge-policy');
const { isBrainConsultationEvent, isLegacyConsultationRetry } = require('./bridge-state');
const { brainConsultChunk, brainReviewProposal, brainReviewResult } = require('./bridge-brain');

const root = process.cwd();
const coordinator = path.join(__dirname, 'bridge-coordinator.js');
const opencodeCommand = process.env.MIND_LIMB_OPENCODE_COMMAND || 'opencode';
const sharedTimeoutMs = Number(process.env.MIND_LIMB_AGENT_TIMEOUT_MS);
const defaultProposalTimeoutMs = Number.isFinite(sharedTimeoutMs) && sharedTimeoutMs > 0
  ? sharedTimeoutMs
  : Number(process.env.MIND_LIMB_PROPOSAL_TIMEOUT_MS) || 180000;
const defaultExecutionTimeoutMs = Number.isFinite(sharedTimeoutMs) && sharedTimeoutMs > 0
  ? sharedTimeoutMs
  : Number(process.env.MIND_LIMB_EXECUTION_TIMEOUT_MS) || 600000;
const defaultConsultTimeoutMs = Number.isFinite(sharedTimeoutMs) && sharedTimeoutMs > 0
  ? sharedTimeoutMs
  : Number(process.env.MIND_LIMB_CONSULT_TIMEOUT_MS) || 300000;
const maxChunkFiles = Math.min(8, Math.max(1, Number(process.env.MIND_LIMB_MAX_CHUNK_FILES) || 3));
const defaultRetryAttempts = Math.min(3, Math.max(1, Number(process.env.MIND_LIMB_AGENT_RETRY_ATTEMPTS) || 2));
const defaultRetryDelayMs = Math.max(0, Number(process.env.MIND_LIMB_AGENT_RETRY_DELAY_MS) || 250);
const staleLockMaxAgeMs = Math.max(1000, Number(process.env.MIND_LIMB_STALE_LOCK_MS) || 30000);
const maxAutoRevisions = Math.min(4, Math.max(0, Number(process.env.MIND_LIMB_MAX_AUTO_REVISIONS) || 2));
const maxAutoChunks = Math.min(32, Math.max(1, Number(process.env.MIND_LIMB_MAX_AUTO_CHUNKS) || 8));

class AgentBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentBusyError';
    this.code = 'agent_busy';
  }
}

function bridgePath(cwd, name) {
  return path.join(cwd || root, '.bridge', name);
}

async function loadTelemetryPolicy(cwd) {
  try {
    return await loadPolicy(cwd);
  } catch {
    return null;
  }
}

async function recordTelemetry(event, options = {}) {
  try {
    return await appendAction(event, { cwd: options.cwd || root });
  } catch {
    // Observability must not block the coordinator or provider call.
    return null;
  }
}

function scalar(...values) {
  return values.find(value => typeof value === 'string' || typeof value === 'number') ?? null;
}

function shorten(value, max = 80) {
  const text = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, Math.max(3, max - 1)) + '…';
}

function formatToolSummary(toolName, targetPath, command, query, status) {
  const name = String(toolName || 'tool').toLowerCase().replace(/[_-]/g, '');
  const prefix = status === 'error' ? 'err: ' : '';
  if (name.includes('read') || name.includes('view') || name.includes('cat')) {
    return prefix + 'read ' + (targetPath || 'file');
  }
  if (name.includes('edit') || name.includes('write') || name.includes('patch')) {
    return prefix + 'edit ' + (targetPath || 'file');
  }
  if (name.includes('bash') || name.includes('exec') || name.includes('command') || name.includes('terminal') || name.includes('sh')) {
    return prefix + 'bash ' + (command ? shorten(command, 50) : 'command');
  }
  if (name.includes('glob') || name.includes('list') || name.includes('dir') || name.includes('find') || name.includes('ls')) {
    return prefix + 'glob ' + (targetPath || query || '*');
  }
  if (name.includes('grep') || name.includes('search')) {
    return prefix + 'grep ' + (query || targetPath || 'pattern');
  }
  if (name.includes('lsp') || name.includes('symbol')) {
    return prefix + 'lsp ' + (targetPath || 'symbol');
  }
  if (targetPath) return prefix + (toolName || 'file') + ' ' + targetPath;
  if (command) return prefix + (toolName || 'cmd') + ' ' + shorten(command, 50);
  return (prefix || 'tool: ') + (toolName || 'action');
}

function providerEventRecord(event, context) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const type = String(scalar(event.type, event.event, event.kind, event.name) || 'provider-event');
  const part = event.part && typeof event.part === 'object' ? event.part : {};
  const item = event.item && typeof event.item === 'object' ? event.item : {};
  const functionInfo = event.function && typeof event.function === 'object' ? event.function : {};
  const target = scalar(
    event.tool,
    event.tool_name,
    event.toolName,
    event.command,
    event.action,
    functionInfo.name,
    part.tool,
    part.name,
    item.tool,
    item.name
  );
  const useful = target || /tool|function|command|action|step|task|patch|file|session/i.test(type);
  if (!useful || /text|message|reasoning|thinking|thought|delta/i.test(type) && !target) return null;

  const status = /error|fail|denied|reject/i.test(type)
    ? 'error'
    : /start|begin|call|pending|running/i.test(type)
      ? 'start'
      : /complete|finish|success|done/i.test(type)
        ? 'finish'
        : 'event';
  const kind = /tool|function|command/i.test(type) || target ? 'tool' : 'action';

  const rawInput = event.input || event.args || event.arguments || part.input || part.args || item.input || item.args || {};
  let parsedInput = {};
  if (typeof rawInput === 'string') {
    try { parsedInput = JSON.parse(rawInput); } catch {}
  } else if (rawInput && typeof rawInput === 'object') {
    parsedInput = rawInput;
  }

  const command = scalar(
    event.command, event.request, event.cmd,
    part.command, item.command,
    parsedInput.command, parsedInput.cmd, parsedInput.script
  );
  const targetPath = scalar(
    event.path, event.file, event.filePath, event.targetPath,
    part.path, part.file, item.path, item.file,
    parsedInput.path, parsedInput.file, parsedInput.filepath, parsedInput.filePath,
    parsedInput.target, parsedInput.filename, parsedInput.targetFile
  );
  const query = scalar(
    event.query, event.pattern,
    part.query, item.query,
    parsedInput.query, parsedInput.pattern, parsedInput.search
  );

  const classification = classifyAction({ kind, target: target || type, path: targetPath, command, request: command }, context.policy || undefined);
  const summary = kind === 'tool'
    ? formatToolSummary(target || type, targetPath, command, query, status)
    : (status === 'error' ? 'Failed: ' : '') + (target || type);

  return {
    session_id: context.session_id,
    assignment_id: context.assignment_id,
    chunk: context.chunk,
    agent: context.agent,
    kind: (kind === 'tool' && target) ? String(target).toLowerCase() : kind,
    phase: context.phase,
    target: target || type,
    summary,
    status,
    duration_ms: scalar(event.duration_ms, event.durationMs, part.duration_ms, item.duration_ms),
    risk: classification.risk,
    approval: context.approval,
    detail_ref: scalar(event.id, event.event_id, event.eventId) ? 'provider-event:' + scalar(event.id, event.event_id, event.eventId) : undefined
  };
}

function actionContext(state, agent, target, risk, policy) {
  return {
    session_id: state.session_id,
    assignment_id: state.assignment_id,
    chunk: state.revision,
    revision: state.revision,
    provider_session_id: state.hands_session_id,
    agent,
    kind: 'action',
    phase: state.phase,
    target,
    risk,
    approval: state.approval,
    policy
  };
}

function actionSummary(context, outcome) {
  const result = outcome && outcome.result;
  return result
    ? context.target + ' finished: ' + textOf(result, 'Provider returned a structured result.')
    : context.target + ' finished.';
}

async function runTelemetryAction(context, options, work) {
  const started = Date.now();
  await recordTelemetry({ ...context, status: 'start', summary: context.target + ' started', duration_ms: null }, options);
  try {
    const outcome = await work();
    const finalState = outcome && outcome.state;
    await recordTelemetry({
      ...context,
      phase: finalState?.phase || context.phase,
      approval: finalState?.approval || context.approval,
      status: 'finish',
      summary: actionSummary(context, outcome),
      duration_ms: Date.now() - started
    }, options);
    return outcome;
  } catch (error) {
    await recordTelemetry({
      ...context,
      status: 'error',
      summary: context.target + ' failed: ' + error.message,
      duration_ms: Date.now() - started
    }, options);
    throw error;
  }
}

function combineCallbacks(first, second) {
  if (!first) return second;
  if (!second) return first;
  return async (...args) => {
    try { await first(...args); } catch {}
    try { await second(...args); } catch {}
  };
}

async function readState(options = {}) {
  const cwd = options.cwd || root;
  const file = bridgePath(cwd, 'state.json');
  let state;
  try {
    state = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const processRunner = options.runProcess || runProcess;
    const result = await processRunner(process.execPath, [coordinator, 'status'], {
      cwd,
      timeoutMs: 30000
    });
    if (!result.ok) throw new Error((result.stderr || result.stdout || 'Coordinator command failed').trim());
    state = JSON.parse(await fs.readFile(file, 'utf8'));
  }
  if (!isLegacyConsultationRetry(state)) return state;

  // Ask the coordinator to migrate and persist only the precisely identifiable
  // legacy transient-consultation state. Re-read the file directly to avoid
  // recursing through runCommand/readState.
  const processRunner = options.runProcess || runProcess;
  const result = await processRunner(process.execPath, [coordinator, 'status'], {
    cwd,
    timeoutMs: 30000
  });
  if (!result.ok) throw new Error((result.stderr || result.stdout || 'Coordinator command failed').trim());
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function runCommand(args, options = {}) {
  const cwd = options.cwd || root;
  const processRunner = options.runProcess || runProcess;
  const result = await processRunner(process.execPath, [coordinator, ...args], {
    cwd,
    timeoutMs: 30000
  });
  if (!result.ok) {
    throw new Error((result.stderr || result.stdout || 'Coordinator command failed').trim());
  }
  return readState(options);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function readLockOwner(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    try { return JSON.parse(text); } catch { return {}; }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return {};
  }
}

function lockPid(owner) {
  const pid = owner && Number(owner.pid);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function staleAgentLock(file, owner) {
  const pid = lockPid(owner);
  if (pid) return !processAlive(pid);
  try {
    const stat = await fs.stat(file);
    return Date.now() - stat.mtimeMs >= staleLockMaxAgeMs;
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

async function acquireAgentLock(options = {}, agent = 'hands') {
  const cwd = options.cwd || root;
  const file = bridgePath(cwd, 'agent.lock');
  const token = crypto.randomBytes(16).toString('hex');
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    const handle = await fs.open(file, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, token, agent, started_at: new Date().toISOString() }) + '\n', 'utf8');
    await handle.close();
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new AgentBusyError('Another HANDS provider call is active. Wait for it to finish; use "unlock-agent" only after a crash.');
    }
    throw error;
  }
  return { file, token };
}

async function releaseAgentLock(lock) {
  if (!lock) return;
  const owner = await readLockOwner(lock.file);
  if (!owner || owner.token !== lock.token) return;
  await fs.unlink(lock.file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function withAgentLock(options, agent, action) {
  const lock = await acquireAgentLock(options, agent);
  try {
    return await action();
  } finally {
    await releaseAgentLock(lock);
  }
}

async function invokeAgent(agent, prompt, options = {}) {
  const args = buildOpencodeArgs(prompt, {
    agent,
    cwd: options.cwd || root,
    sessionId: options.sessionId,
    model: options.model
  });
  const processRunner = options.runProcess || runProcess;
  const providerEvents = options.actionContext
    ? async event => {
      const record = providerEventRecord(event, options.actionContext);
      if (record) {
        await recordTelemetry(record, options);
        if (record.summary && options.actionContext?.agent) {
          await runCommand(['activity', options.actionContext.agent, record.summary], options).catch(() => {});
        }
      }
    }
    : null;
  const timeoutMs = options.timeoutMs ?? (agent === 'hands' ? defaultExecutionTimeoutMs : defaultProposalTimeoutMs);
  const processOptions = {
    cwd: options.cwd || root,
    timeoutMs,
    ...(options.env ? { env: options.env } : {}),
    ...(options.input !== undefined ? { input: options.input } : {})
  };
  if (options.onLine) processOptions.onLine = options.onLine;
  if (options.onEvent || providerEvents) processOptions.onEvent = combineCallbacks(options.onEvent, providerEvents);
  const result = await processRunner(options.command || opencodeCommand, args, processOptions);
  const sessionId = extractSessionId(result.stdout);
  if (!result.ok) {
    const rawDetail = (result.timed_out
      ? (result.stderr || 'Provider process exceeded the configured timeout.')
      : (result.stderr || result.stdout || 'Agent command failed')).trim();
    const detail = rawDetail.length > 1400
      ? rawDetail.slice(0, 280) + ' ... [provider output truncated] ... ' + rawDetail.slice(-900)
      : rawDetail;
    const suffix = sessionId ? ' [session ' + sessionId + ']' : '';
    const timing = result.timed_out ? ' after ' + Math.round(timeoutMs / 1000) + 's' : '';
    const error = new Error(agent + ' failed' + (result.timed_out ? ' (timed out)' : '') + timing + suffix + ': ' + detail);
    error.code = result.timed_out ? 'provider_timeout' : 'provider_failed';
    error.sessionId = sessionId;
    error.output_truncated = rawDetail.length > detail.length;
    throw error;
  }
  try {
    return {
      result: parseStructuredResult(result.stdout),
      sessionId
    };
  } catch (error) {
    const wrapped = new Error(agent + ' returned no valid structured result: ' + error.message);
    wrapped.code = 'invalid_provider_result';
    wrapped.sessionId = sessionId;
    throw wrapped;
  }
}

function retryableProviderError(error) {
  if (!error || ['agent_busy', 'stale_state', 'invalid_transition'].includes(error.code)) return false;
  const message = String(error.message || '').toLowerCase();
  if (/different hands session|no hands session|permission denied|user decision/.test(message)) return false;
  return ['provider_timeout', 'provider_failed', 'invalid_provider_result', 'transient_consultation_failure', 'brain_review_missing'].includes(error.code)
    || /timed out|returned no valid structured|temporarily unavailable|connection reset|econnreset|econnrefused/.test(message);
}

function waitMs(milliseconds) {
  if (!milliseconds) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function invokeAgentWithRetry(agent, prompt, options = {}) {
  const configuredAttempts = Number(options.retryAttempts);
  const attempts = Math.min(3, Math.max(1, Number.isFinite(configuredAttempts) ? Math.trunc(configuredAttempts) : defaultRetryAttempts));
  const delayMs = Math.max(0, Number.isFinite(Number(options.retryDelayMs)) ? Number(options.retryDelayMs) : defaultRetryDelayMs);
  let sessionId = options.sessionId;
  const fallbackModel = agent === 'hands-propose'
    ? (options.proposalFallbackModel || process.env.MIND_LIMB_PROPOSAL_FALLBACK_MODEL || 'opencode/big-pickle')
    : null;
  let lastError;
  const rememberSession = async discovered => {
    if (!discovered || discovered === sessionId) return;
    sessionId = discovered;
    if (typeof options.onSession === 'function') await options.onSession(sessionId);
  };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const retryPrompt = attempt > 1 && lastError
        ? lastError.code === 'invalid_provider_result'
          ? prompt + '\nYour previous response was unusable. Return the required JSON object only.'
          : lastError.code === 'brain_review_missing'
            ? prompt + '\nYour previous review omitted observable ask_codex evidence. Retry the protocol: call ask_codex exactly once, then return the required JSON object only. Do not approve without an ask_codex event.'
            : prompt
        : prompt;
      const useFallbackModel = agent === 'hands-propose'
        && attempt > 1
        && lastError?.code === 'invalid_provider_result'
        && fallbackModel
        && options.model !== fallbackModel;
      const details = await invokeAgent(agent, retryPrompt, {
        ...options,
        sessionId,
        ...(useFallbackModel ? { model: fallbackModel } : {})
      });
      await rememberSession(details.sessionId);
      if (typeof options.validateResult === 'function') await options.validateResult(details.result);
      return details;
    } catch (error) {
      lastError = error;
      await rememberSession(error.sessionId);
      if (attempt >= attempts || !retryableProviderError(error)) {
        if (attempts > 1 && retryableProviderError(error)) {
          error.message += ' (after ' + attempt + ' attempts)';
        }
        if (sessionId) error.sessionId = sessionId;
        throw error;
      }
      if (typeof options.onRetry === 'function') {
        await options.onRetry({ attempt, nextAttempt: attempt + 1, attempts, error });
      }
      await waitMs(delayMs);
    }
  }
  throw lastError;
}

async function runAgentDetails(agent, prompt, options = {}) {
  return withAgentLock(options, agent, () => invokeAgent(agent, prompt, options));
}

async function runAgent(agent, prompt, options = {}) {
  return (await runAgentDetails(agent, prompt, options)).result;
}

function listOf(result, key) {
  return Array.isArray(result[key])
    ? result[key].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim())
    : [];
}

function filesOf(result) {
  return listOf(result, 'files');
}


function validateProposal(result) {
  const files = filesOf(result);
  if (!files.length) {
    throw new Error('HANDS proposal must name at least one file or inspected path.');
  }
  if (files.length > maxChunkFiles) {
    throw new Error('HANDS proposed ' + files.length + ' files, but a reviewable chunk may contain at most ' + maxChunkFiles + '. Ask HANDS for a smaller chunk.');
  }
  const tests = listOf(result, 'tests');
  if (!tests.length) {
    throw new Error('HANDS proposal must include at least one focused validation check.');
  }
  const summary = typeof result.summary === 'string' ? result.summary.trim() : '';
  if (summary.length > 1200) {
    throw new Error('HANDS proposal is too broad. Ask for one small, reviewable chunk with a shorter summary.');
  }
}

function formatProposal(result) {
  const lines = [textOf(result, 'HANDS proposed an approach.')];
  if (typeof result.role === 'string' && result.role.trim()) lines.push('Role: ' + result.role.trim());
  if (typeof result.scope === 'string' && result.scope.trim()) lines.push('Scope: ' + result.scope.trim());
  if (typeof result.style === 'string' && result.style.trim()) lines.push('Style: ' + result.style.trim());
  const assumptions = listOf(result, 'assumptions');
  const tests = listOf(result, 'tests');
  const risks = listOf(result, 'risks');
  if (assumptions.length) lines.push('Assumptions: ' + assumptions.join(' | '));
  if (tests.length) lines.push('Validation: ' + tests.join(' | '));
  if (risks.length) lines.push('Risks: ' + risks.join(' | '));
  return lines.join('\n');
}

function textOf(result, fallback) {
  for (const key of ['question', 'summary', 'approach', 'message', 'feedback', 'reason', 'context']) {
    if (typeof result[key] === 'string' && result[key].trim()) return result[key].trim();
  }
  return fallback;
}

function isTransientConsultationBlock(result) {
  if (result && (result.transient === true || result.retryable === true)) return true;
  const detail = ['question', 'context', 'message', 'summary', 'error']
    .map(key => typeof result?.[key] === 'string' ? result[key] : '')
    .join(' ')
    .toLowerCase();
  return /\b(?:ask[_-]?codex|mcp|tool)\b/.test(detail)
    && /\b(?:spawn|start|launch|unavailable|temporar(?:y|ily)|fail(?:ed|ure)?|error|timeout|connection|econn\w*|denied)\b/.test(detail);
}

function rolePrompt(role, phase, instructions, schema) {
  return [
    'Role: ' + role + '. Phase: ' + phase + '.',
    'Act only in this role; do not edit files unless the phase explicitly permits it.',
    instructions,
    'Return one compact JSON object only: ' + schema
  ].join('\n');
}

function proposalReviewPrompt(state) {
  return rolePrompt(
    'BRAIN-REVIEW',
    'proposal_review',
    'Call ask_codex to review the HANDS proposal against the task. Approve safe, bounded work; request revision for scope, risk, or missing validation; escalate only for security, destructive, or unresolved decisions. No shell, edits, or subagents.',
    '{"decision":"approved|revise|escalate","summary":"short reason","feedback":"revision guidance"}'
  ) + '\nTask: ' + state.task
    + '\nAssignment: ' + state.assignment_id
    + '\nRevision: ' + state.revision
    + '\nRole: ' + (state.approach?.role || 'task-matched engineer')
    + '\nProposal: ' + JSON.stringify(state.approach);
}

function evaluationPrompt(state, execution) {
  return rolePrompt(
    'HANDS-EVALUATE',
    'evaluation',
    'Read the approved files and inspect the execution result. Do not edit files, run mutating commands, or broaden scope. Report only focused validation and whether the chunk is safe to review.',
    '{"decision":"passed|failed|blocked","summary":"short result","tests":["focused check"],"risks":["risk"]}'
  ) + '\nTask: ' + state.task
    + '\nApproved: ' + JSON.stringify(state.approach)
    + '\nExecution: ' + JSON.stringify(execution);
}

function resultReviewPrompt(state, execution, evaluation) {
  return rolePrompt(
    'BRAIN-RESULT-REVIEW',
    'result_review',
    'Call ask_codex to review HANDS execution and evaluation against the approved chunk. After a successful chunk, choose continue when another bounded chunk remains or complete when the task is finished. Request revision for a bounded fix; escalate security, destructive, or unresolved issues. Legacy passed/approved means complete.',
    '{"decision":"continue|complete|passed|revise|escalate","summary":"short reason","feedback":"next action"}'
  ) + '\nTask: ' + state.task
    + '\nApproved: ' + JSON.stringify(state.approach)
    + '\nExecution: ' + JSON.stringify(execution)
    + '\nEvaluation: ' + JSON.stringify(evaluation)
    + '\nLegacy decision aliases: {"decision":"passed|revise|escalate"}.';
}

function isEscalationResult(result) {
  return result?.decision === 'escalate'
    || result?.decision === 'blocked' && (result.escalate === true || /security|destructive|unresolved|human/i.test(String(result.question || result.context || result.summary || '')));
}

function reviewDecision(result) {
  const decision = String(result?.decision || '').toLowerCase();
  if (decision === 'approve' || decision === 'approved' || decision === 'pass' || decision === 'passed') return 'approved';
  if (decision === 'revise' || decision === 'revision' || decision === 'fail' || decision === 'failed') return 'revise';
  if (decision === 'escalate' || decision === 'blocked') return 'escalate';
  return null;
}

function resultReviewDecision(result) {
  const decision = String(result?.decision || '').toLowerCase();
  if (decision === 'continue') return 'continue';
  if (decision === 'complete') return 'complete';
  return reviewDecision(result);
}

async function coordinatorCommandFallback(commands, options = {}) {
  let lastError;
  for (const args of commands) {
    try { return await runCommand(args, options); } catch (error) {
      lastError = error;
      if (!/unknown command|unsupported|invalid transition/i.test(String(error.message || ''))) throw error;
    }
  }
  throw lastError;
}

function proposalPrompt(state) {
  const previous = state.approach
    ? '\nPrevious proposal to improve:\n' + state.approach.summary
    : '';
  const feedback = state.mind_feedback
    ? '\nBrain feedback or answers to apply:\n' + state.mind_feedback
    : '';
  return [
    'Role: HANDS-PROPOSE. Phase: proposal. Return only the compact proposal JSON schema below.',
    'You are HANDS-PROPOSE in the Mind-Limb Bridge.',
    'Read the repository and design exactly the next small, reviewable implementation chunk for Brain approval.',
    'Never propose or plan the whole project in one chunk. A greenfield project must be split into multiple chunks.',
    'Limit the chunk to one cohesive outcome and no more than ' + maxChunkFiles + ' files.',
    'Choose one primary role matching the task (for example frontend UX engineer, reliability architect, security reviewer, or QA evaluator) and state it.',
    'State the intended coding style and performance choices explicitly.',
    'Brain consultation happens only after approval and is unavailable in this phase. Use sensible defaults for ordinary implementation choices and record them in assumptions; only return decision blocked when no safe, reviewable proposal can be made.',
    'This is read-only: do not edit, write, patch, run shell commands, launch subagents, or change any file.',
    'If dependency setup is part of the chunk, include the generated lockfile (for example package-lock.json) in the approved files; keep node_modules/ and build output such as dist/ ignored artifacts.',
    'Return exactly one JSON object and no markdown. Its first non-whitespace character must be { and its last must be }; emit no prose before or after it.',
    'Proposal shape: {"decision":"propose","role":"primary role","summary":"one small chunk","scope":"one cohesive outcome","style":"coding and performance choices","files":["path"],"tests":["validation"],"risks":["risk"],"assumptions":["assumption"]}.',
    'Only if a material decision is required before a safe proposal, return {"decision":"blocked","question":"specific question","context":"why it matters"}.',
    'Task: ' + state.task,
    'Revision: ' + state.revision + previous + feedback
  ].join('\n');
}

function consultationPrompt(state, brainGuidance) {
  // When brainGuidance is pre-loaded by the bridge via direct API call, bake the
  // IDs and answer into the prompt so the model cannot hallucinate stale values.
  if (brainGuidance) {
    const guidanceStr = String(brainGuidance.guidance || '').replace(/"/g, "'");
    return [
      'Role: HANDS-CONSULT. Phase: consultation. Return only the compact approval JSON schema below.',
      'You are HANDS-CONSULT in the Mind-Limb Bridge.',
      'Brain has already reviewed this chunk via a direct API call. Its guidance is provided below.',
      'Confirm the guidance fits the approved scope. Do not call any external tools or edit any files.',
      'If the guidance materially conflicts with scope, return decision blocked.',
      'Return exactly one JSON object and no markdown. Its first non-whitespace character must be { and its last must be }.',
      'Approved shape (copy the assignment_id and revision exactly as given):',
      '{"decision":"approved","assignment_id":"' + state.assignment_id + '","revision":' + state.revision + ',"summary":"one sentence confirming guidance fits scope","brain_answer":"' + guidanceStr.slice(0, 200) + '"}',
      'Blocked shape: {"decision":"blocked","question":"specific conflict","context":"short context"}.',
      'Task: ' + state.task,
      'Assignment ID: ' + state.assignment_id,
      'Revision: ' + state.revision,
      'Approved approach / chunk: ' + state.approach.summary,
      'Approved files: ' + state.approach.files.join(', '),
      'Brain guidance: ' + JSON.stringify(brainGuidance)
    ].join('\n');
  }
  return [
    'Role: HANDS-CONSULT. Phase: consultation. Return only the compact approval JSON schema below.',
    'You are HANDS-CONSULT in the Mind-Limb Bridge.',
    'This is a read-only gate before execution. Call ask_codex exactly once with the approved chunk, assignment ID, revision, coding style, performance constraints, and validation plan. If Brain guidance materially changes the approved scope, files, style, performance constraints, or validation plan, return decision blocked rather than approving execution. If ask_codex or its MCP tool cannot start transiently, return decision blocked with "transient":true so the bridge can retry; do not use that marker for a material disagreement.',
    'Do not edit, write, patch, delete, run shell commands, launch subagents, or change any file.',
    'Return exactly one JSON object and no markdown. Its first non-whitespace character must be { and its last must be }; emit no prose before or after it.',
    'Approved shape: {"decision":"approved","assignment_id":"exact ID","revision":0,"summary":"Brain guidance for this chunk","brain_answer":"short answer returned by ask_codex"}.',
    'Blocked shape: {"decision":"blocked","question":"specific question","context":"short context"}.',
    'Task: ' + state.task,
    'Assignment ID: ' + state.assignment_id,
    'Revision: ' + state.revision,
    'Approved approach / chunk: ' + state.approach.summary,
    'Approved files: ' + state.approach.files.join(', ')
  ].join('\n');
}

function validateConsultation(result, state) {
  if (!result || result.decision !== 'approved'
    || result.assignment_id !== state.assignment_id
    || Number(result.revision) !== state.revision
    || typeof result.summary !== 'string'
    || !result.summary.trim()
    || typeof result.brain_answer !== 'string'
    || !result.brain_answer.trim()) {
    throw new Error('HANDS consultation did not return a valid Brain decision for the active assignment and revision.');
  }
}

function executionPrompt(state) {
  return [
    'Role: HANDS. Phase: execution. Return only the compact completion JSON schema below.',
    'You are HANDS in the Mind-Limb Bridge.',
    'Execute only the single approved chunk below. Do not implement the whole project, future chunks, unrelated cleanup, or extra files.',
    'Brain consultation has already completed in a separate read-only phase. ask_codex is unavailable during execution. If anything is unclear or the chunk grows beyond scope, return decision blocked before editing.',
    'Stay within the approved files and scope.',
    'Run only the required focused validation for this chunk.',
    'Do not start another bridge session, invoke another HANDS agent, or spawn subagents.',
    'When finished, return exactly one JSON object and no markdown. Its first non-whitespace character must be { and its last must be }; emit no prose before or after it.',
    'Success shape: {"decision":"completed","summary":"what changed","files":["path"],"tests":["command and result"]}.',
    'Blocked shape: {"decision":"blocked","question":"question","context":"short context"}.',
    'Task: ' + state.task,
    'Approved approach / chunk: ' + state.approach.summary,
    'Approved files: ' + state.approach.files.join(', '),
    'Verified Brain consultation: ' + JSON.stringify(state.consultation)
  ].join('\n');
}

async function reviewProposal(state, options = {}) {
  const agent = options.proposalReviewerAgent || 'hands-consult';
  return withAgentLock(options, agent, async () => {
    let brainCall = false;
    const details = await invokeAgentWithRetry(agent, proposalReviewPrompt(state), {
      ...options,
      sessionId: options.sessionId || state.hands_session_id,
      onEvent: (event, rawLine) => { if (isBrainConsultationEvent(event, rawLine)) brainCall = true; },
      validateResult: result => {
        if (agent === 'hands-consult' && options.requireBrainEvent !== false && !brainCall) {
          const error = new Error('Brain proposal review produced no observable ask_codex event; approval proof is missing.');
          error.code = 'brain_review_missing';
          throw error;
        }
        if (typeof options.validateResult === 'function') return options.validateResult(result);
      },
      onRetry: async info => {
        brainCall = false;
        if (typeof options.onRetry === 'function') await options.onRetry(info);
      },
      retryAttempts: options.retryAttempts ?? options.proposalRetryAttempts,
      retryDelayMs: options.retryDelayMs ?? options.proposalRetryDelayMs
    });
    return details;
  });
}

async function autoApprove(state, options = {}) {
  const summary = options.summary || 'Brain approved the HANDS proposal automatically.';
  return coordinatorCommandFallback([
    ['brain-approve', summary],
    ['approve-auto', summary],
    ['approve', summary]
  ], options);
}

async function markEvaluation(evaluation, options = {}) {
  try {
    return await coordinatorCommandFallback([
      ['evaluate', JSON.stringify(evaluation)],
      ['evaluation', JSON.stringify(evaluation)]
    ], options);
  } catch (error) {
    if (/unknown command|unsupported/i.test(String(error.message || ''))) return readState(options);
    throw error;
  }
}

async function snapshotApprovedFiles(state, cwd) {
  const files = Array.isArray(state.approach?.files) ? state.approach.files : [];
  const entries = {};
  for (const relative of files) {
    const target = path.join(cwd, relative);
    try {
      entries[relative] = await fs.readFile(target, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') entries[relative] = null;
      else throw error;
    }
  }
  return entries;
}

function snapshotsEqual(left, right) {
  const keys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
  for (const key of keys) {
    if ((left || {})[key] !== (right || {})[key]) return false;
  }
  return true;
}

async function invokeEvaluator(state, execution, options = {}) {
  const preferred = options.evaluatorAgent || 'hands-evaluate';
  const beforeEvaluation = await snapshotApprovedFiles(state, options.cwd || root);
  const beforeTree = await snapshotWorkingTree(options.cwd || root);
  const invoke = agent => withAgentLock(options, agent, () => invokeAgentWithRetry(
    agent,
    evaluationPrompt(state, execution && execution.result || execution),
    {
      ...options,
      sessionId: options.sessionId || state.hands_session_id,
      retryAttempts: options.retryAttempts ?? options.executionRetryAttempts,
      retryDelayMs: options.retryDelayMs ?? options.executionRetryDelayMs,
      requireBrainEvent: false
    }
  ));
  try { return await invoke(preferred); }
  catch (error) {
    if (preferred !== 'hands-evaluate' || !['provider_failed', 'invalid_provider_result'].includes(error.code)) throw error;
    return invoke('hands-consult');
  }
}

async function snapshotWorkingTree(cwd) {
  try {
    const result = await runProcess('git', ['status', '--porcelain'], { cwd: cwd || root, timeoutMs: 30000 });
    return result.ok ? result.stdout : null;
  } catch { return null; }
}

async function reviewResult(execution, options = {}) {
  const state = await readState(options);
  if (state.phase !== 'brain_reviewing') return { state, result: execution };
  await runCommand(['activity', 'mind', 'Reviewing completed execution result and evaluation'], options).catch(() => {});
  const beforeEvaluation = await snapshotApprovedFiles(state, options.cwd || root);
  const beforeTree = await snapshotWorkingTree(options.cwd || root);
  let evaluationDetails;
  try { evaluationDetails = await invokeEvaluator(state, execution, options); }
  catch (error) {
    const reason = 'HANDS evaluation failed: ' + error.message;
    return { state: await blockForUser(reason, options, 'escalation'), error: reason };
  }
  const evaluation = evaluationDetails.result;
  const afterEvaluation = await snapshotApprovedFiles(state, options.cwd || root);
  const afterTree = await snapshotWorkingTree(options.cwd || root);
  if (!snapshotsEqual(beforeEvaluation, afterEvaluation) || beforeTree !== null && afterTree !== null && beforeTree !== afterTree) {
    const reason = 'HANDS evaluation changed an approved file; escalation required.';
    return { state: await blockForUser(reason, options, 'escalation'), error: reason, evaluation };
  }
  if (evaluation.decision === 'completed' || evaluation.decision === 'pass') evaluation.decision = 'passed';
  if (evaluation.decision === 'fail') evaluation.decision = 'failed';
  if (evaluation.decision === 'escalate') evaluation.decision = 'blocked';
  if (!['passed', 'failed', 'blocked'].includes(evaluation.decision)) {
    return { state: await blockForUser('HANDS evaluation returned an invalid decision.', options, 'escalation'), error: 'Invalid HANDS evaluation decision.', evaluation };
  }
  await markEvaluation(evaluation, options);
  if (evaluation.decision === 'blocked') {
    const reason = textOf(evaluation, 'HANDS evaluation requires escalation.');
    return { state: await blockForUser(reason, options, 'escalation'), error: reason, evaluation };
  }
  // Use direct Brain API call for result review — with fallback if unconfigured/mocked.
  let brainResult;
  try {
    if (options.brainReviewResult) {
      brainResult = await options.brainReviewResult(state, execution && execution.result || execution, evaluation, options);
    } else {
      try {
        brainResult = await brainReviewResult(state, execution && execution.result || execution, evaluation, options);
      } catch (err) {
        if (err.code === 'brain_config_error' || options.runProcess) {
          const reviewerAgent = options.resultReviewerAgent || 'hands-consult';
          let brainCall = false;
          const brainDetails = await withAgentLock(options, reviewerAgent, () => invokeAgentWithRetry(
            reviewerAgent,
            resultReviewPrompt(state, execution && execution.result || execution, evaluation),
            {
              ...options,
              sessionId: options.sessionId || state.hands_session_id,
              onEvent: (event, rawLine) => {
                if (isBrainConsultationEvent(event, rawLine)) brainCall = true;
                if (typeof options.onEvent === 'function') options.onEvent(event, rawLine);
              },
              validateResult: result => {
                if (!brainCall) {
                  const error = new Error('Brain result review produced no observable ask_codex event; approval proof is missing.');
                  error.code = 'brain_review_missing';
                  throw error;
                }
                if (typeof options.validateResult === 'function') return options.validateResult(result);
              },
              onRetry: async info => {
                brainCall = false;
                if (typeof options.onRetry === 'function') await options.onRetry(info);
              },
              retryAttempts: options.retryAttempts ?? options.proposalRetryAttempts,
              retryDelayMs: options.retryDelayMs ?? options.proposalRetryDelayMs
            }
          ));
          brainResult = brainDetails.result;
        } else {
          throw err;
        }
      }
    }
  } catch (error) {
    const reason = 'Brain result review failed: ' + error.message;
    return { state: await blockForUser(reason, options, 'escalation'), error: reason, evaluation };
  }
  const decision = resultReviewDecision(brainResult);
  if (!decision || isEscalationResult(brainResult)) {
    const reason = textOf(brainResult, 'Brain could not safely review the result.');
    return { state: await blockForUser(reason, options, 'escalation'), result: brainResult, evaluation };
  }
  if (decision === 'revise' || evaluation.decision === 'failed') {
    const feedback = textOf(brainResult, textOf(evaluation, 'Focused validation failed.'));
    const revisionCount = Number(options._autoRevisionCount || 0) + 1;
    if (revisionCount > maxAutoRevisions) {
      const reason = 'Brain result review exceeded the automatic revision limit (' + maxAutoRevisions + ').';
      return { state: await blockForUser(reason, options, 'escalation'), error: reason, evaluation };
    }
    await coordinatorCommandFallback([['revise', feedback]], options);
    const proposed = await propose({ ...options, autonomous: false });
    return autoAdvance(proposed, { ...options, _autoRevisionCount: revisionCount });
  }
  if (decision === 'continue') {
    const completedChunks = Number(options._autoChunkCount || 1);
    if (completedChunks >= maxAutoChunks) {
      const reason = 'Brain result review reached the automatic chunk limit (' + maxAutoChunks + ').';
      return { state: await blockForUser(reason, options, 'escalation'), error: reason, evaluation };
    }
    const feedback = textOf(brainResult, 'Brain requested the next bounded chunk.');
    await coordinatorCommandFallback([['continue', feedback], ['revise', feedback]], options);
    const proposed = await propose({ ...options, autonomous: false });
    return autoAdvance(proposed, { ...options, _autoRevisionCount: 0, _autoChunkCount: completedChunks });
  }
  const summary = textOf(brainResult, 'Brain reviewed the completed chunk.');
  const done = await runCommand(['done', summary], options);
  return { state: done, result: brainResult, evaluation };
}
async function autoAdvance(proposed, options = {}) {
  let outcome = proposed;
  let revisions = Number(options._autoRevisionCount || 0);
  while (outcome?.state?.phase === 'brain_approving') {
    const state = await readState(options);
    await runCommand(['activity', 'mind', 'Reviewing proposal: validating scope, files, and safety constraints'], options).catch(() => {});
    let review;
    try {
      if (options.brainReviewProposal) {
        review = await options.brainReviewProposal(state, options);
      } else {
        try {
          review = await brainReviewProposal(state, options);
        } catch (err) {
          if (err.code === 'brain_config_error' || options.runProcess) {
            review = (await reviewProposal(state, options)).result;
          } else {
            throw err;
          }
        }
      }
    } catch (error) {
      const reason = error.message;
      return { state: await blockForUser(reason, options, 'escalation'), error: reason };
    }
    const decision = reviewDecision(review);
    if (isEscalationResult(review) || !decision) {
      const reason = textOf(review, 'Brain requires human escalation before this chunk can run.');
      return { state: await blockForUser(reason, options, 'escalation'), result: review, error: reason };
    }
    if (decision === 'revise') {
      if (revisions >= maxAutoRevisions) {
        const reason = 'Brain proposal review exceeded the automatic revision limit (' + maxAutoRevisions + ').';
        return { state: await blockForUser(reason, options, 'escalation'), result: review, error: reason };
      }
      revisions += 1;
      const feedback = textOf(review, 'Brain requested a safer, smaller proposal.');
      await runCommand(['activity', 'mind', 'Revision requested: ' + shorten(feedback, 80)], options).catch(() => {});
      await coordinatorCommandFallback([['revise', feedback]], options);
      outcome = await propose({ ...options, autonomous: false });
      continue;
    }
    const approvalSummary = textOf(review, 'Brain approved the HANDS proposal automatically.');
    await autoApprove(state, { ...options, summary: approvalSummary });
    const consulted = await consult({ ...options, autonomous: false });
    if (consulted.state?.phase !== 'hands_executing') return consulted;
    return execute({ ...options, autonomous: options.autonomous !== false, _autoRevisionCount: revisions, _autoChunkCount: Number(options._autoChunkCount || 0) + 1 });
  }
  return outcome;
}

async function blockForUser(reason, options = {}, blockKind) {
  const state = await readState(options);
  if (['blocked_user', 'paused', 'done', 'cancelled'].includes(state.phase)) return state;
  try {
    return await runCommand(blockKind ? ['block', '--kind', blockKind, reason] : ['block', reason], options);
  } catch (error) {
    if (/only valid while HANDS is consulting/i.test(String(error.message || ''))) return readState(options);
    // Older coordinators do not know escalation; retain the safe block.
    if (blockKind && /unsupported block kind|unknown command|invalid transition/i.test(String(error.message || ''))) {
      return runCommand(['block', reason], options);
    }
    throw error;
  }
}
async function bindSessionIfNeeded(state, sessionId, options = {}) {
  if (!sessionId && state.hands_session_id) return state;
  if (!sessionId) throw new Error('Provider did not return a HANDS session ID; refusing to start a second conversation.');
  if (state.hands_session_id && state.hands_session_id !== sessionId) {
    throw new Error('Provider returned a different HANDS session ID; refusing to fork the bridge conversation.');
  }
  if (!state.hands_session_id) return runCommand(['bind-session', sessionId], options);
  return state;
}

function staleStateError(expected, current) {
  const error = new Error('Bridge state changed while the agent was starting: expected ' + expected.phase + '/' + expected.assignment_id + ', found ' + current.phase + '/' + current.assignment_id + '.');
  error.code = 'stale_state';
  error.state = current;
  return error;
}

async function requireCurrentState(expected, options, phases) {
  const current = await readState(options);
  const sameIdentity = current.session_id === expected.session_id
    && current.assignment_id === expected.assignment_id
    && current.revision === expected.revision
    && (!expected.hands_session_id || current.hands_session_id === expected.hands_session_id)
    && (!expected.execution_lease_id || current.execution_lease_id === expected.execution_lease_id);
  if (!sameIdentity || !phases.includes(current.phase)) throw staleStateError(expected, current);
  return current;
}

async function propose(options = {}) {
  const initial = await readState(options);
  if (!['planning', 'hands_proposing'].includes(initial.phase)) {
    throw new Error('Proposal requires planning or hands_proposing; found ' + initial.phase + '.');
  }
  try {
    return await withAgentLock(options, 'hands-propose', async () => {
      const state = await requireCurrentState(initial, options, ['planning', 'hands_proposing']);
      const policy = await loadTelemetryPolicy(options.cwd || root);
      const context = actionContext(
        state,
        'hands-propose',
        'hands-proposal',
        classifyAction({ kind: 'action', target: 'hands-proposal' }, policy || undefined).risk,
        policy
      );
      return runTelemetryAction(context, options, async () => {
        await runCommand(['activity', 'hands-propose', 'Reading repository and preparing proposal'], options);
        const details = await invokeAgentWithRetry('hands-propose', proposalPrompt(state), {
          ...options,
          sessionId: options.sessionId || state.hands_session_id,
          retryAttempts: options.retryAttempts ?? options.proposalRetryAttempts,
          retryDelayMs: options.retryDelayMs ?? options.proposalRetryDelayMs,
          onSession: async sessionId => {
            const current = await requireCurrentState(state, options, ['planning', 'hands_proposing']);
            await bindSessionIfNeeded(current, sessionId, options);
          },
          onRetry: async ({ nextAttempt, attempts, error }) => {
            await requireCurrentState(state, options, ['planning', 'hands_proposing']);
            await runCommand(['activity', 'hands-propose', 'Retrying proposal (' + nextAttempt + '/' + attempts + ') after provider failure: ' + String(error.message).slice(0, 160)], options);
            await recordTelemetry({ ...context, status: 'retry', summary: 'hands-proposal retry ' + nextAttempt + '/' + attempts, duration_ms: null }, options);
          },
          actionContext: context
        });
        const current = await requireCurrentState(state, options, ['planning', 'hands_proposing']);
        const bound = await bindSessionIfNeeded(current, details.sessionId, options);
        const result = details.result;
        if (result.decision === 'blocked') {
          const reason = textOf(result, 'HANDS needs a user decision.') + (result.context ? ' Context: ' + result.context : '');
          return { state: await blockForUser(reason, options, 'needs_revision'), result };
        }
        if (result.decision !== 'propose') throw new Error('Expected decision "propose", found "' + result.decision + '".');
        try {
          validateProposal(result);
        } catch (error) {
          return { state: await blockForUser(error.message, options, 'needs_revision'), error: error.message };
        }
        const summary = formatProposal(result);
        const approachArgs = ['approach', summary, '--files', filesOf(result).join(',')];
        if (options.manual === true) approachArgs.push('--manual');
        const next = await runCommand(approachArgs, options);
        return { state: next, result, hands_session_id: bound.hands_session_id || details.sessionId };
      });
    });
  } catch (error) {
    if (error.code === 'agent_busy') throw error;
    if (error.code === 'stale_state') return { state: error.state || await readState(options), error: error.message };
    return { state: await blockForUser(error.message, options), error: error.message };
  }
}

async function consult(options = {}) {
  const initial = await readState(options);
  if (initial.phase === 'paused' || initial.phase === 'blocked_user') {
    return { state: initial, error: undefined };
  }
  if (initial.phase !== 'hands_consulting' || !initial.approach) {
    throw new Error('Brain consultation requires an approved approach; found ' + initial.phase + '.');
  }
  try {
    return await withAgentLock(options, 'hands-consult', async () => {
      const state = await requireCurrentState(initial, options, ['hands_consulting']);
      if (!state.hands_session_id) {
        return { state: await blockForUser('No HANDS session is bound; restart through bridge-runner start.', options), error: 'No HANDS session is bound.' };
      }
      const policy = await loadTelemetryPolicy(options.cwd || root);
      const context = actionContext(
        state,
        'hands-consult',
        'hands-consultation',
        classifyAction({ kind: 'action', target: 'hands-consultation' }, policy || undefined).risk,
        policy
      );
      return runTelemetryAction(context, options, async () => {
        await runCommand(['activity', 'hands-consult', 'Calling Brain directly to review the approved chunk'], options);
        // Call Brain via direct API — no MCP, no ask_codex required.
        let brainGuidance;
        try {
          brainGuidance = await brainConsultChunk(state, options);
        } catch (brainError) {
          if (brainError.code === 'brain_config_error') {
            // No API key configured — fall back to legacy ask_codex flow so the
            // bridge does not hard-fail when Brain config is absent.
            brainGuidance = null;
          } else {
            throw brainError;
          }
        }
        let attemptBrainConsulted = false;
        const details = await invokeAgentWithRetry('hands-consult', consultationPrompt(state, brainGuidance), {
          ...options,
          timeoutMs: options.timeoutMs ?? defaultConsultTimeoutMs,
          sessionId: options.sessionId || state.hands_session_id,
          onEvent: brainGuidance
            ? undefined
            : (event, rawLine) => { if (isBrainConsultationEvent(event, rawLine)) attemptBrainConsulted = true; },
          validateResult: result => {
            if (!brainGuidance && !isTransientConsultationBlock(result)) return;
            if (!brainGuidance && isTransientConsultationBlock(result)) {
              const error = new Error(textOf(result, 'ask_codex is temporarily unavailable.') + (result.context ? ' Context: ' + result.context : ''));
              error.code = 'transient_consultation_failure';
              throw error;
            }
          },
          onRetry: async ({ nextAttempt, attempts, error }) => {
            attemptBrainConsulted = false;
            await requireCurrentState(state, options, ['hands_consulting']);
            await runCommand(['activity', 'hands-consult', 'Retrying Brain consultation (' + nextAttempt + '/' + attempts + '): ' + String(error.message).slice(0, 160)], options);
          },
          retryAttempts: options.retryAttempts ?? options.proposalRetryAttempts,
          retryDelayMs: options.retryDelayMs ?? options.proposalRetryDelayMs,
          actionContext: context
        });
        await requireCurrentState(state, options, ['hands_consulting']);
        if (details.sessionId && details.sessionId !== state.hands_session_id) {
          throw new Error('Provider returned a different HANDS session ID during consultation; refusing to fork the bridge conversation.');
        }
        const result = details.result;
        if (result.decision === 'blocked') {
          const reason = textOf(result, 'HANDS consultation is blocked.') + (result.context ? ' Context: ' + result.context : '');
          return { state: await blockForUser(reason, options, 'needs_revision'), result };
        }
        // Skip brainConsulted check when Brain was called directly by the bridge.
        if (!brainGuidance && !attemptBrainConsulted) {
          const error = new Error('HANDS consultation completed without an ask_codex Brain call.');
          error.code = 'brain_consultation_missing';
          throw error;
        }
        validateConsultation(result, state);
        const next = await runCommand(['consult', JSON.stringify(result)], options);
        return { state: next, result };
      });
    });
  } catch (error) {
    if (error.code === 'agent_busy') throw error;
    if (error.code === 'stale_state') return { state: error.state || await readState(options), error: error.message };
    return { state: await blockForUser(error.message, options, ['transient_consultation_failure', 'provider_timeout', 'provider_failed', 'invalid_provider_result', 'brain_consultation_missing'].includes(error.code) ? 'consultation_retry' : undefined), error: error.message };
  }
}

async function continueAfterConsult(options = {}) {
  const consulted = await consult(options);
  return consulted.state && consulted.state.phase === 'hands_executing'
    ? execute(options)
    : consulted;
}

async function execute(options = {}) {
  const initial = await readState(options);
  if (initial.phase !== 'hands_executing' || !initial.approach) {
    throw new Error('Execution requires an approved approach; found ' + initial.phase + '.');
  }
  if (!initial.revision_consumed || !initial.execution_lease_id || !initial.consultation) {
    const error = new Error('Execution lease is missing. Brain consultation must complete before HANDS can edit.');
    error.code = 'execution_lease_missing';
    return { state: await blockForUser(error.message, options), error: error.message };
  }
  if (initial.execution_claimed) {
    const error = new Error('This execution lease was already claimed. Run bridge recover, inspect the working tree, then resume for a fresh Brain consultation.');
    error.code = 'execution_claimed';
    return { state: await blockForUser(error.message, options), error: error.message };
  }
  try {
    const executed = await withAgentLock(options, 'hands', async () => {
      const state = await requireCurrentState(initial, options, ['hands_executing']);
      if (!state.hands_session_id) {
        return { state: await blockForUser('No HANDS session is bound; restart through bridge-runner start.', options), error: 'No HANDS session is bound.' };
      }
      const policy = await loadTelemetryPolicy(options.cwd || root);
      const context = actionContext(
        state,
        'hands',
        'hands-execution',
        classifyAction({ kind: 'action', target: 'hands-execution' }, policy || undefined).risk,
        policy
      );
      return runTelemetryAction(context, options, async () => {
        const claimed = await runCommand(['claim-execution', state.execution_lease_id], options);
        await runCommand(['activity', 'hands', 'Executing the consulted chunk'], options);
        const details = await invokeAgent('hands', executionPrompt(claimed), {
          ...options,
          sessionId: options.sessionId || claimed.hands_session_id,
          actionContext: context
        });
        await requireCurrentState(claimed, options, ['hands_executing']);
        if (details.sessionId && details.sessionId !== claimed.hands_session_id) {
          throw new Error('Provider returned a different HANDS session ID during execution; refusing to fork the bridge conversation.');
        }
        const result = details.result;
        if (result.decision === 'blocked') {
          const reason = textOf(result, 'HANDS is blocked.') + (result.context ? ' Context: ' + result.context : '');
          return { state: await blockForUser(reason, options), result };
        }
        if (result.decision !== 'completed') throw new Error('Expected decision "completed", found "' + result.decision + '".');
        const next = await runCommand(['complete', claimed.execution_lease_id, textOf(result, 'HANDS completed the approved chunk.')], options);
        return { state: next, result };
      });
    });
    if (options.autonomous !== false && executed?.state?.phase === 'brain_reviewing') return reviewResult(executed, options);
    return executed;
  } catch (error) {
    if (error.code === 'agent_busy') throw error;
    if (error.code === 'stale_state') return { state: error.state || await readState(options), error: error.message };
    const reason = error.code === 'provider_timeout'
      ? error.message + ' HANDS may have partially changed files. Inspect the working tree, then run bridge recover before resuming.'
      : error.message;
    return { state: await blockForUser(reason, options), error: reason };
  }
}
async function unlockAgent(options = {}) {
  const file = bridgePath(options.cwd, 'agent.lock');
  const owner = await readLockOwner(file);
  if (!owner) return { unlocked: false, warning: 'No agent lock found.' };
  const pid = lockPid(owner);
  if (pid && processAlive(pid)) {
    throw new Error('Agent lock belongs to live process ' + pid + '; refusing to remove it.');
  }
  if (!(await staleAgentLock(file, owner))) {
    throw new Error('Agent lock metadata is invalid or too recent; refusing to remove it until it is stale.');
  }
  await fs.unlink(file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  return { unlocked: true, warning: 'Stale agent lock removed.' };
}

async function start(task, options = {}) {
  if (!task) throw new Error('A task description is required.');
  let state;
  try {
    state = await readState(options);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await runCommand(['init'], options);
    state = await readState(options);
  }
  if (['planning', 'hands_proposing'].includes(state.phase)) {
    if (state.task && state.task !== task) {
      throw new Error('A different task is already active. Finish or stop it before starting another task.');
    }
    const proposed = await propose({ ...options, autonomous: false });
    return options.autonomous === false ? proposed : autoAdvance(proposed, options);
  }
  if (state.phase === 'hands_consulting') {
    throw new Error('HANDS is consulting Brain for the current chunk. Wait for the consultation to finish.');
  }
  if (state.phase === 'hands_executing') {
    throw new Error('HANDS is still executing the current task. Wait for the chunk to finish before starting another task.');
  }
  if (['brain_approving', 'blocked_user', 'paused'].includes(state.phase)) {
    throw new Error('The current task is ' + state.phase + '. Finish or resume it before starting another task.');
  }
  await runCommand(['start', task], options);
  const proposed = await propose({ ...options, autonomous: false });
  return options.autonomous === false ? proposed : autoAdvance(proposed, options);
}
async function resume(options = {}) {
  const current = await readState(options);
  if (current.phase === 'blocked_user' && current.recovery_required) {
    return {
      state: current,
      error: 'Execution recovery is required. Inspect the working tree and run bridge recover before bridge resume.'
    };
  }
  if (current.phase === 'blocked_user' && ['needs_revision', 'escalation'].includes(current.block_kind)) {
    return {
      state: current,
      error: 'This block requires a revised proposal. Run bridge revise with Brain guidance before resuming.'
    };
  }
  if (['planning', 'hands_proposing'].includes(current.phase)) {
    const proposed = await propose({ ...options, autonomous: false });
    return options.autonomous === false ? proposed : autoAdvance(proposed, options);
  }
  if (current.phase === 'brain_approving') {
    return options.autonomous === false ? { state: current } : autoAdvance({ state: current }, options);
  }
  if (current.phase === 'hands_consulting') return continueAfterConsult(options);
  if (current.phase === 'hands_executing') {
    return execute({ ...options, autonomous: options.autonomous !== false });
  }
  if (current.phase === 'brain_reviewing') {
    return options.autonomous === false ? { state: current } : reviewResult({ state: current }, options);
  }
  if (!['paused', 'blocked_user'].includes(current.phase)) {
    return { state: current, message: 'No resume needed while the session is ' + current.phase + '.' };
  }
  const resumed = await runCommand(['resume'], options);
  if (['planning', 'hands_proposing'].includes(resumed.phase)) {
    const proposed = await propose({ ...options, autonomous: false });
    return options.autonomous === false ? proposed : autoAdvance(proposed, options);
  }
  if (resumed.phase === 'brain_approving') {
    return options.autonomous === false ? { state: resumed } : autoAdvance({ state: resumed }, options);
  }
  if (resumed.phase === 'hands_consulting') return continueAfterConsult(options);
  if (resumed.phase === 'hands_executing') {
    return execute({ ...options, autonomous: options.autonomous !== false });
  }
  if (resumed.phase === 'brain_reviewing') {
    return options.autonomous === false ? { state: resumed } : reviewResult({ state: resumed }, options);
  }
  return { state: resumed };
}

async function approve(summary, options = {}) {
  await runCommand(['approve', summary || 'MIND approved the HANDS approach.'], options);
  const consulted = await consult(options);
  return consulted.state && consulted.state.phase === 'hands_executing'
    ? execute({ ...options, autonomous: false })
    : consulted;
}

async function revise(summary, options = {}) {
  await runCommand(['revise', summary || 'MIND requested a clearer approach.'], options);
  const proposed = await propose({ ...options, autonomous: false });
  return options.autonomous === false ? proposed : autoAdvance(proposed, options);
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function help() {
  console.log([
    'Mind-Limb Bridge runner', '',
    '  start <task>                 Start task, Brain-review the proposal, and run safe chunks',
    '  propose                      Ask HANDS for a read-only proposal',
    '  approve [summary]            Legacy manual approval (auto mode is the default)',
    '  revise [summary]             Ask for a revised proposal',
    '  consult                      Ask Brain to confirm the approved chunk',
    '  status | log [count]         Inspect coordinator state or audit log',
    '  done [summary]               Mark the reviewed session complete',
    '  block <reason>               Wait for the user',
    '  pause | resume | cancel      User controls',
    '  unlock-agent                 Remove a lock only after a crash'
  ].join('\n'));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift() || 'help';
  if (command === 'help') return help();
  if (command === 'start') return print(await start(args.join(' ')));
  if (command === 'propose') return print(await propose());
  if (command === 'approve') return print(await approve(args.join(' ')));
  if (command === 'revise' || command === 'steer') return print(await revise(args.join(' ')));
  if (command === 'consult') return print(await continueAfterConsult());
  if (command === 'review') return print(await reviewResult());
  if (command === 'unlock-agent') return print(await unlockAgent());
  if (command === 'resume') return print(await resume());
  if (command === 'status' || command === 'log' || command === 'done' || command === 'block' || command === 'pause' || command === 'cancel') {
    return print(await runCommand([command, ...args]));
  }
  throw new Error('Unknown command: ' + command);
}

if (require.main === module) {
  main().catch(error => {
    console.error('Error: ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = { readState, runCommand, runAgent, runAgentDetails, invokeAgent, invokeAgentWithRetry, retryableProviderError, proposalPrompt, proposalReviewPrompt, brainReviewPrompt: proposalReviewPrompt, consultationPrompt, evaluationPrompt, evaluatePrompt: evaluationPrompt, resultReviewPrompt, brainResultReviewPrompt: resultReviewPrompt, executionPrompt, validateConsultation, parseStructuredResult, isBrainConsultationEvent, isTransientConsultationBlock, propose, reviewProposal, reviewResult, invokeEvaluator, autoAdvance, consult, execute, start, resume, approve, revise, steer: revise, unlockAgent, withAgentLock, AgentBusyError };
