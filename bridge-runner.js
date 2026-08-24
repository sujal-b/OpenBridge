#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { runProcess, parseStructuredResult, extractSessionId, buildOpencodeArgs } = require('./bridge-adapter');
const { appendAction } = require('./bridge-actions');
const { loadPolicy, classifyAction } = require('./bridge-policy');

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
const maxChunkFiles = Math.min(8, Math.max(1, Number(process.env.MIND_LIMB_MAX_CHUNK_FILES) || 3));
const defaultRetryAttempts = Math.min(3, Math.max(1, Number(process.env.MIND_LIMB_AGENT_RETRY_ATTEMPTS) || 2));
const defaultRetryDelayMs = Math.max(0, Number(process.env.MIND_LIMB_AGENT_RETRY_DELAY_MS) || 250);

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
  const command = scalar(event.command, event.request, part.command, item.command);
  const targetPath = scalar(event.path, event.file, part.path, item.path);
  const classification = classifyAction({ kind, target: target || type, path: targetPath, command, request: command }, context.policy || undefined);
  return {
    session_id: context.session_id,
    assignment_id: context.assignment_id,
    chunk: context.chunk,
    agent: context.agent,
    kind,
    phase: context.phase,
    target: target || type,
    summary: (kind === 'tool' ? 'Provider tool ' : 'Provider action ') + status + ': ' + (target || type),
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
  return JSON.parse(await fs.readFile(bridgePath(options.cwd, 'state.json'), 'utf8'));
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
      if (record) await recordTelemetry(record, options);
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

function isBrainConsultationEvent(event) {
  if (!event || typeof event !== 'object') return false;
  const part = event.part && typeof event.part === 'object' ? event.part : {};
  const item = event.item && typeof event.item === 'object' ? event.item : {};
  const functionInfo = event.function && typeof event.function === 'object' ? event.function : {};
  const names = [
    event.tool, event.tool_name, event.toolName, event.name,
    part.tool, part.tool_name, part.toolName, part.name,
    item.tool, item.tool_name, item.toolName, item.name,
    functionInfo.name, functionInfo.tool
  ];
  return names.some(value => typeof value === 'string' && /ask[_-]?codex/i.test(value));
}
function retryableProviderError(error) {
  if (!error || ['agent_busy', 'stale_state', 'invalid_transition'].includes(error.code)) return false;
  const message = String(error.message || '').toLowerCase();
  if (/different hands session|no hands session|permission denied|user decision/.test(message)) return false;
  return ['provider_timeout', 'provider_failed', 'invalid_provider_result'].includes(error.code)
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
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await invokeAgent(agent, prompt, { ...options, sessionId });
    } catch (error) {
      lastError = error;
      if (error.sessionId) sessionId = error.sessionId;
      if (attempt >= attempts || !retryableProviderError(error)) {
        if (attempts > 1 && retryableProviderError(error)) {
          error.message += ' (after ' + attempt + ' attempts)';
        }
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

function questionsOf(result) {
  return listOf(result, 'questions');
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
  for (const key of ['summary', 'approach', 'message']) {
    if (typeof result[key] === 'string' && result[key].trim()) return result[key].trim();
  }
  return fallback;
}

function proposalPrompt(state) {
  const previous = state.approach
    ? '\nPrevious proposal to improve:\n' + state.approach.summary
    : '';
  const feedback = state.mind_feedback
    ? '\nBrain feedback or answers to apply:\n' + state.mind_feedback
    : '';
  return [
    'You are HANDS-PROPOSE in the Mind-Limb Bridge.',
    'Read the repository and design exactly the next small, reviewable implementation chunk for Brain approval.',
    'Never propose or plan the whole project in one chunk. A greenfield project must be split into multiple chunks.',
    'Limit the chunk to one cohesive outcome and no more than ' + maxChunkFiles + ' files.',
    'State the intended coding style and performance choices explicitly.',
    'If architecture, style, dependency, API, data shape, performance, or test behavior is materially unclear, use ask_codex if available and wait for Brain guidance. If it remains unclear, return decision blocked instead of guessing.',
    'This is read-only: do not edit, write, patch, run shell commands, launch subagents, or change any file.',
    'Return exactly one JSON object and no markdown.',
    'Proposal shape: {"decision":"propose","summary":"one small chunk","scope":"one cohesive outcome","style":"coding and performance choices","files":["path"],"tests":["validation"],"risks":["risk"],"assumptions":["assumption"],"questions":[]}.',
    'If Brain input is required, return {"decision":"blocked","question":"specific question","context":"why it matters"}.',
    'Task: ' + state.task,
    'Revision: ' + state.revision + previous + feedback
  ].join('\n');
}

function consultationPrompt(state) {
  return [
    'You are HANDS-CONSULT in the Mind-Limb Bridge.',
    'This is a read-only gate before execution. Call ask_codex exactly once with the approved chunk, assignment ID, revision, coding style, performance constraints, and validation plan.',
    'Do not edit, write, patch, delete, run shell commands, launch subagents, or change any file.',
    'Return exactly one JSON object and no markdown.',
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
    'You are HANDS in the Mind-Limb Bridge.',
    'Execute only the single approved chunk below. Do not implement the whole project, future chunks, unrelated cleanup, or extra files.',
    'Brain consultation has already completed in a separate read-only phase. ask_codex is unavailable during execution. If anything is unclear or the chunk grows beyond scope, return decision blocked before editing.',
    'Stay within the approved files and scope.',
    'Run only the required focused validation for this chunk.',
    'Do not start another bridge session, invoke another HANDS agent, or spawn subagents.',
    'When finished, return exactly one JSON object and no markdown.',
    'Success shape: {"decision":"completed","summary":"what changed","files":["path"],"tests":["command and result"]}.',
    'Blocked shape: {"decision":"blocked","question":"question","context":"short context"}.',
    'Task: ' + state.task,
    'Approved approach / chunk: ' + state.approach.summary,
    'Approved files: ' + state.approach.files.join(', '),
    'Verified Brain consultation: ' + JSON.stringify(state.consultation)
  ].join('\n');
}
async function blockForUser(reason, options = {}) {
  const state = await readState(options);
  if (['blocked_user', 'paused', 'done', 'cancelled'].includes(state.phase)) return state;
  return runCommand(['block', reason], options);
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
          onRetry: async ({ nextAttempt, attempts, error }) => {
            await requireCurrentState(state, options, ['planning', 'hands_proposing']);
            await runCommand(['activity', 'hands-propose', 'Retrying proposal (' + nextAttempt + '/' + attempts + ') after provider failure: ' + String(error.message).slice(0, 160)], options);
            await recordTelemetry({ ...context, status: 'retry', summary: 'hands-proposal retry ' + nextAttempt + '/' + attempts, duration_ms: null }, options);
          },
          actionContext: context
        });
        await requireCurrentState(state, options, ['planning', 'hands_proposing']);
        const bound = await bindSessionIfNeeded(state, details.sessionId, options);
        const result = details.result;
        if (result.decision === 'blocked') {
          const reason = textOf(result, 'HANDS needs a user decision.') + (result.context ? ' Context: ' + result.context : '');
          return { state: await blockForUser(reason, options), result };
        }
        if (result.decision !== 'propose') throw new Error('Expected decision "propose", found "' + result.decision + '".');
        const questions = questionsOf(result);
        if (questions.length) {
          const reason = 'HANDS needs Brain guidance before this chunk: ' + questions.join(' | ');
          return { state: await blockForUser(reason, options), result };
        }
        validateProposal(result);
        const summary = formatProposal(result);
        const next = await runCommand(['approach', summary, '--files', filesOf(result).join(',')], options);
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
        await runCommand(['activity', 'hands-consult', 'Asking Brain to confirm the approved chunk'], options);
        let brainConsulted = false;
        const observeBrainConsultation = event => {
          if (isBrainConsultationEvent(event)) brainConsulted = true;
        };
        const details = await invokeAgentWithRetry('hands-consult', consultationPrompt(state), {
          ...options,
          sessionId: options.sessionId || state.hands_session_id,
          onEvent: observeBrainConsultation,
          onRetry: async ({ nextAttempt, attempts, error }) => {
            brainConsulted = false;
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
          return { state: await blockForUser(reason, options), result };
        }
        if (!brainConsulted) {
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
    return { state: await blockForUser(error.message, options), error: error.message };
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
    return await withAgentLock(options, 'hands', async () => {
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
  if (owner.pid && processAlive(Number(owner.pid))) {
    throw new Error('Agent lock belongs to live process ' + owner.pid + '; refusing to remove it.');
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
    return propose(options);
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
  return propose(options);
}
async function resume(options = {}) {
  const current = await readState(options);
  if (current.phase === 'blocked_user' && current.recovery_required) {
    return {
      state: current,
      error: 'Execution recovery is required. Inspect the working tree and run bridge recover before bridge resume.'
    };
  }
  if (['planning', 'hands_proposing'].includes(current.phase)) return propose(options);
  if (current.phase === 'hands_consulting') return continueAfterConsult(options);
  if (!['paused', 'blocked_user'].includes(current.phase)) {
    return { state: current, message: 'No resume needed while the session is ' + current.phase + '.' };
  }
  const resumed = await runCommand(['resume'], options);
  if (['planning', 'hands_proposing'].includes(resumed.phase)) return propose(options);
  if (resumed.phase === 'hands_consulting') return continueAfterConsult(options);
  return { state: resumed };
}

async function approve(summary, options = {}) {
  await runCommand(['approve', summary || 'MIND approved the HANDS approach.'], options);
  const consulted = await consult(options);
  return consulted.state && consulted.state.phase === 'hands_executing'
    ? execute(options)
    : consulted;
}

async function revise(summary, options = {}) {
  await runCommand(['revise', summary || 'MIND requested a clearer approach.'], options);
  return propose(options);
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function help() {
  console.log([
    'Mind-Limb Bridge runner', '',
    '  start <task>                 Start task and ask HANDS for a proposal',
    '  propose                      Ask HANDS for a read-only proposal',
    '  approve [summary]            Approve proposal and run HANDS',
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
  if (command === 'revise') return print(await revise(args.join(' ')));
  if (command === 'consult') return print(await continueAfterConsult());
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

module.exports = { readState, runCommand, runAgent, runAgentDetails, invokeAgent, invokeAgentWithRetry, retryableProviderError, proposalPrompt, consultationPrompt, executionPrompt, validateConsultation, propose, consult, execute, start, resume, approve, revise, unlockAgent, AgentBusyError };