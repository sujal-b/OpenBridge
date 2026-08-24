'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runProcess } = require('../bridge-adapter');
const {
  isBrainConsultationEvent,
  isTransientConsultationBlock,
  validateConsultation,
  parseStructuredResult,
  readState,
  runCommand,
  consult
} = require('../bridge-runner');

const coordinator = path.resolve(__dirname, '..', 'bridge-coordinator.js');

// ---------------------------------------------------------------------------
// QA harness: seed a real coordinator state at hands_consulting, then drive
// consult() with a provider mock that emits raw event shapes through onEvent.
// ---------------------------------------------------------------------------
async function createGitWorkspace(prefix) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.writeFile(path.join(cwd, '.gitignore'), '.bridge/\n', 'utf8');
  await fs.writeFile(path.join(cwd, 'README.md'), '# Test project\n', 'utf8');
  const git = args => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, 'git ' + args.join(' ') + ' failed: ' + result.stderr);
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'runner@example.invalid']);
  git(['config', 'user.name', 'Mind-Limb Runner']);
  git(['add', '.']);
  git(['commit', '-qm', 'baseline']);
  return cwd;
}

async function seedConsulting(cwd, sessionId) {
  const run = args => runProcess(process.execPath, [coordinator, ...args], { cwd, timeoutMs: 30000 });
  await run(['init']);
  await run(['start', 'Consult the approved chunk']);
  await run(['approach', 'Add focused validation', '--files', 'src/app.js', '--manual']);
  await run(['bind-session', sessionId]);
  await run(['approve']);
}

function consultationFor(args, sessionID) {
  const prompt = String(args.at(-1) || '');
  const assignment_id = (prompt.match(/Assignment ID: ([^\r\n]+)/) || [])[1];
  const revision = Number((prompt.match(/Revision: (\d+)/) || [])[1]);
  return {
    decision: 'approved',
    assignment_id,
    revision,
    summary: 'Brain confirmed the approved chunk.',
    brain_answer: 'Proceed with the approved files and focused validation.',
    sessionID
  };
}

// Provider mock: coordinator subprocess passes through, agent calls emit the
// given event shape (plus optional rawLine) through onEvent, then return a
// valid consultation result. override can replace the stdout.
function eventProvider(shape, rawLine, override) {
  return async (command, args, options) => {
    if (command === process.execPath && args[0] === coordinator) return runProcess(command, args, options);
    if (rawLine !== undefined) {
      if (options.onEvent) await options.onEvent(shape, rawLine);
    } else if (options.onEvent) {
      await options.onEvent(shape, typeof shape === 'string' ? shape : JSON.stringify(shape));
    }
    const output = override || { decision: 'approved', ...consultationFor(args, 'consult-session') };
    return { ok: true, code: 0, signal: null, stdout: JSON.stringify(output), stderr: '', timed_out: false };
  };
}

// ---------------------------------------------------------------------------
// MISSION A — isBrainConsultationEvent detection matrix
// ---------------------------------------------------------------------------

test('A1 true: tool.completed with tool ask_codex', () => {
  assert.equal(isBrainConsultationEvent({ type: 'tool.completed', tool: 'ask_codex' }), true);
});

test('A2 true: tool_use with name ask_codex and input payload', () => {
  assert.equal(isBrainConsultationEvent({ type: 'tool_use', name: 'ask_codex', input: {} }), true);
});

test('A3 true: tool event named ask-codex (dash)', () => {
  assert.equal(isBrainConsultationEvent({ type: 'tool', name: 'ask-codex' }), true);
});

test('A4 true: event envelope with tool plus action completed', () => {
  assert.equal(isBrainConsultationEvent({ type: 'event', tool: 'ask_codex', action: 'completed' }), true);
});

test('A5 true: nested provider envelope item.toolUse.name', () => {
  assert.equal(isBrainConsultationEvent({ item: { toolUse: { name: 'ask_codex' } } }), true);
});

test('A6 true: message.content array of tool_use parts', () => {
  assert.equal(isBrainConsultationEvent({ message: { content: [{ type: 'tool_use', name: 'ask_codex' }] } }), true);
});

test('A7 true: event array where one item is the ask_codex call', () => {
  assert.equal(isBrainConsultationEvent([{ type: 'message', item: { text: 'thinking' } }, { type: 'tool.completed', tool: 'ask_codex' }]), true);
});

test('A8 true: AskCodex caps matches case-insensitively', () => {
  assert.equal(isBrainConsultationEvent({ type: 'tool_use', name: 'AskCodex', input: {} }), true);
});

// REGRESSION-PROTECTED (was a genuine bug; fixed): regex ask[_-]?codex does not match the dotted
// form ask.codex, so the call is invisible to the gate.
test('A9 true: ask.codex dotted tool name is detected', () => {
  assert.equal(
    isBrainConsultationEvent({ type: 'tool_use', name: 'ask.codex', input: {} }),
    true,
    'dotted ask.codex is an ask_codex call'
  );
});

test('A10 true: tool id toolu_ask_codex next to a name field', () => {
  assert.equal(isBrainConsultationEvent({ type: 'tool_use', name: 'ask_codex', id: 'toolu_abc123' }), true);
});

// REGRESSION-PROTECTED (was a genuine bug; fixed): the id key is not in the keyHint whitelist
// (tool|target|name|type|event|action|function|text|message|payload|data),
// so an event carrying only the tool id is invisible.
test('A10b true: tool id toolu_ask_codex alone is detected', () => {
  assert.equal(
    isBrainConsultationEvent({ type: 'tool_use', id: 'toolu_ask_codex' }),
    true,
    'toolu_ask_codex id identifies the ask_codex call'
  );
});

test('A11 true: rawLine JSON parsed when event is null', () => {
  assert.equal(isBrainConsultationEvent(null, '{"type":"tool.completed","tool":"ask_codex"}'), true);
});

test('A11b true: rawLine JSONL wrapper object {"data": {...}}', () => {
  assert.equal(isBrainConsultationEvent(null, '{"data": {"type":"tool.completed","tool":"ask_codex"}}'), true);
});

// REGRESSION-PROTECTED (was a genuine bug; fixed): SSE style "data: {json}" lines are not valid
// JSON, JSON.parse throws, and the rawLine fallback gives up.
test('A12 true: SSE rawLine wrapper "data: {...}" is detected', () => {
  assert.equal(
    isBrainConsultationEvent(null, 'data: {"type":"tool.completed","tool":"ask_codex"}'),
    true,
    'SSE data: wrapper still carries the tool event'
  );
});

// REGRESSION-PROTECTED (was a genuine bug; fixed): a JSON-string event param is not inspected;
// only the rawLine fallback would catch it and rawLine may be absent.
test('A13 true: JSON-string event parameter is detected', () => {
  assert.equal(
    isBrainConsultationEvent('{"type":"tool.completed","tool":"ask_codex"}'),
    true,
    'stringified event is still a tool event'
  );
});

test('A14 false: ask_codex only in agent text message (not a tool call)', () => {
  assert.equal(isBrainConsultationEvent({ type: 'message', item: { text: 'I will now call ask_codex' } }), false);
});

test('A15 false: ask_codex only in a summary text field', () => {
  assert.equal(isBrainConsultationEvent({ type: 'message', text: 'Summary: ask_codex reviewed the chunk' }), false);
});

test('A15b false: ask_codex in a structured message summary value', () => {
  assert.equal(isBrainConsultationEvent({ type: 'message', item: { text: '{"decision":"approved","summary":"ask_codex ok"}' } }), false);
});

test('A16 false: error message mentioning ask_codex is not a call', () => {
  assert.equal(isBrainConsultationEvent({ type: 'error', message: 'ask_codex crashed during review' }), false);
});

test('A17 false: different tool ask_codereview (prefix) is not ask_codex', () => {
  assert.equal(isBrainConsultationEvent({ type: 'tool', name: 'ask_codereview' }), false);
});

// REGRESSION-PROTECTED (was a genuine bug; fixed): substring match /ask[_-]?codex/ stamps
// ask_codex_extra as a consultation event — a false positive that lets a
// consultation count as consulted when no Brain call happened.
test('A18 false: different tool ask_codex_extra (suffix) is not ask_codex', () => {
  assert.equal(
    isBrainConsultationEvent({ type: 'tool', name: 'ask_codex_extra' }),
    false,
    'ask_codex_extra is a different tool'
  );
});

// REGRESSION-PROTECTED (was a genuine bug; fixed): not_ask_codex contains the ask_codex
// substring and is rubber-stamped.
test('A19 false: not_ask_codex is not ask_codex', () => {
  assert.equal(
    isBrainConsultationEvent({ type: 'tool', name: 'not_ask_codex' }),
    false,
    'not_ask_codex is a different tool'
  );
});

test('A20 false: bare codex without ask prefix is not a call', () => {
  assert.equal(isBrainConsultationEvent({ type: 'tool', name: 'codex' }), false);
});

test('A21 false: full-width underscore lookalike ask＿codex is not ask_codex', () => {
  assert.equal(isBrainConsultationEvent({ type: 'tool', name: 'ask\uFF3Fcodex' }), false);
});

test('A22 false: ask-c0dex with zero digit is not ask_codex', () => {
  assert.equal(isBrainConsultationEvent({ type: 'tool', name: 'ask-c0dex' }), false);
});

test('A23 false: frequentlyAskCodex as identifier in text is not a call', () => {
  assert.equal(isBrainConsultationEvent({ type: 'message', item: { text: 'frequentlyAskCodex is our helper' } }), false);
});

// REGRESSION-PROTECTED (was a genuine bug; fixed): identifier containing AskCodex as a tool name
// hits the substring match.
test('A24 false: frequentlyAskCodex as a tool name is not ask_codex', () => {
  assert.equal(
    isBrainConsultationEvent({ type: 'tool', name: 'frequentlyAskCodex' }),
    false,
    'frequentlyAskCodex is a helper identifier, not the Brain tool'
  );
});

test('A25 false: read tool result output mentioning ask_codex in file content', () => {
  assert.equal(isBrainConsultationEvent({ type: 'tool.completed', tool: 'read', output: '// TODO: call ask_codex here\n' }), false);
});

test('A26 false: read tool input content field mentioning ask_codex', () => {
  assert.equal(isBrainConsultationEvent({ type: 'tool_use', name: 'Read', input: { content: 'mentions ask_codex in a comment' } }), false);
});

test('A27 false: rawLine that is plain non-JSON text mentioning ask_codex', () => {
  assert.equal(isBrainConsultationEvent(null, 'ask_codex was discussed during planning'), false);
});

// REGRESSION-PROTECTED (was a genuine bug; fixed): part: envelopes are read by the telemetry
// layer (providerEventRecord reads part.tool/part.name) but the detector
// keyHint whitelist omits "part", so the envelope is invisible.
test('A28 true: part envelope with tool name is detected', () => {
  assert.equal(
    isBrainConsultationEvent({ type: 'tool_use', part: { name: 'ask_codex' } }),
    true,
    'part.name identifies the tool call'
  );
});

test('B1-B3 false: output and non-tool ids do not spoof consultation evidence', () => {
  assert.equal(isBrainConsultationEvent({ type: 'tool.completed', tool: 'read', output: '{"tool":"ask_codex"}' }), false);
  assert.equal(isBrainConsultationEvent({ type: 'message', id: 'msg_ask_codex_114' }), false);
  assert.equal(isBrainConsultationEvent({ type: 'tool_use', id: 'toolu_ask_codex_helper_x', name: 'read' }), false);
});

test('B4-B7 true: ids and data payload variants remain supported', () => {
  assert.equal(isBrainConsultationEvent({ type: 'tool_use', id: 'toolu_ask_codex' }), true);
  assert.equal(isBrainConsultationEvent(null, 'DATA: {"type":"tool.completed","tool":"ask_codex"}'), true);
  assert.equal(isBrainConsultationEvent(null, 'data: {"type":"message"}\ndata: {"tool":"ask_codex"}'), true);
  assert.equal(isBrainConsultationEvent(null, 'data: [{"type":"tool_use","name":"ask_codex"}]'), true);
});

test('B8: deeply nested input is bounded without throwing', () => {
  let value = {};
  for (let index = 0; index < 10000; index++) value = { child: value };
  assert.equal(isBrainConsultationEvent(value), false);
});

// ---------------------------------------------------------------------------
// MISSION A — end-to-end gating through consult()
// ---------------------------------------------------------------------------

async function consultGate(assertPhase, shape, rawLine, override) {
  const cwd = await createGitWorkspace('qa-askcodex-');
  try {
    await seedConsulting(cwd, 'consult-session');
    const result = await consult({ cwd, runProcess: eventProvider(shape, rawLine, override), retryAttempts: 1, retryDelayMs: 0 });
    return { cwd, result };
  } catch (error) {
    return { cwd, error };
  }
}

test('E1 gate: tool.completed event lets consult approve into hands_executing', async () => {
  const { cwd, result, error } = await consultGate(null, { type: 'tool.completed', tool: 'ask_codex' });
  try {
    assert.equal(error, undefined, 'consult must succeed');
    assert.equal(result.state.phase, 'hands_executing');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('E2 gate: tool_use name shape lets consult approve', async () => {
  const { cwd, result, error } = await consultGate(null, { type: 'tool_use', name: 'ask_codex', input: {} });
  try {
    assert.equal(error, undefined, 'consult must succeed');
    assert.equal(result.state.phase, 'hands_executing');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('E3 gate: dash tool name let consult approve', async () => {
  const { cwd, result, error } = await consultGate(null, { type: 'tool', name: 'ask-codex' });
  try {
    assert.equal(error, undefined, 'consult must succeed');
    assert.equal(result.state.phase, 'hands_executing');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('E4 gate: nested item.toolUse envelope lets consult approve', async () => {
  const { cwd, result, error } = await consultGate(null, { item: { toolUse: { name: 'ask_codex' } } });
  try {
    assert.equal(error, undefined, 'consult must succeed');
    assert.equal(result.state.phase, 'hands_executing');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('E5 gate: message.content tool_use array lets consult approve', async () => {
  const { cwd, result, error } = await consultGate(null, { message: { content: [{ type: 'tool_use', name: 'ask_codex' }] } });
  try {
    assert.equal(error, undefined, 'consult must succeed');
    assert.equal(result.state.phase, 'hands_executing');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('E6 gate: array of events lets consult approve', async () => {
  const { cwd, result, error } = await consultGate(null, [{ type: 'message', item: { text: 'thinking' } }, { type: 'tool.completed', tool: 'ask_codex' }]);
  try {
    assert.equal(error, undefined, 'consult must succeed');
    assert.equal(result.state.phase, 'hands_executing');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('E7 gate: AskCodex caps lets consult approve', async () => {
  const { cwd, result, error } = await consultGate(null, { type: 'tool_use', name: 'AskCodex', input: {} });
  try {
    assert.equal(error, undefined, 'consult must succeed');
    assert.equal(result.state.phase, 'hands_executing');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('E8 gate: event envelope with action lets consult approve', async () => {
  const { cwd, result, error } = await consultGate(null, { type: 'event', tool: 'ask_codex', action: 'completed' });
  try {
    assert.equal(error, undefined, 'consult must succeed');
    assert.equal(result.state.phase, 'hands_executing');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// REGRESSION-PROTECTED (was a genuine bug; fixed): ask.codex is invisible to the detector, so a
// genuinely consulted run is rejected with brain_consultation_missing.
test('E9 gate: ask.codex dotted name still counts as consulted', async () => {
  const { cwd, result, error } = await consultGate(null, { type: 'tool_use', name: 'ask.codex', input: {} });
  try {
    assert.equal(error, undefined, 'a real ask.codex call must count as a consultation');
    assert.equal(result.state.phase, 'hands_executing');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('F1 gate: text-only mention fails with brain_consultation_missing', async () => {
  const { cwd, result, error } = await consultGate(null, { type: 'message', item: { text: 'I will now call ask_codex' } });
  try {
    assert.equal(error, undefined, 'consult should not throw synchronously');
    assert.equal(result.state.phase, 'blocked_user');
    assert.match(result.error, /ask_codex Brain call/i);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('F2 gate: summary text mention fails with brain_consultation_missing', async () => {
  const { cwd, result, error } = await consultGate(null, { type: 'message', text: 'Summary: ask_codex reviewed the chunk' });
  try {
    assert.equal(error, undefined, 'consult should not throw synchronously');
    assert.equal(result.state.phase, 'blocked_user');
    assert.match(result.error, /ask_codex Brain call/i);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// REGRESSION-PROTECTED (was a genuine bug; fixed): ask_codex_extra is rubber-stamped by the
// detector, so a consultation with NO Brain call is approved for execution —
// the false positive gates the flow in the wrong direction.
test('F3 gate: ask_codex_extra must NOT satisfy the consultation gate', async () => {
  const { cwd, result, error } = await consultGate(null, { type: 'tool', name: 'ask_codex_extra' });
  try {
    assert.equal(error, undefined, 'consult should not throw synchronously');
    assert.equal(result.state.phase, 'blocked_user', 'a different tool must not count as consulted');
    assert.match(result.error, /ask_codex Brain call/i);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('F4 gate: error mention fails with brain_consultation_missing', async () => {
  const { cwd, result, error } = await consultGate(null, { type: 'error', message: 'ask_codex crashed during review' });
  try {
    assert.equal(error, undefined, 'consult should not throw synchronously');
    assert.equal(result.state.phase, 'blocked_user');
    assert.match(result.error, /ask_codex Brain call/i);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// MISSION B — isTransientConsultationBlock classifier
// ---------------------------------------------------------------------------

test('B1 transient: transient:true flag alone', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', transient: true }), true);
});

test('B2 transient: retryable:true flag alone', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', retryable: true }), true);
});

test('B3 material: transient:false flag alone with no text is not transient', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', transient: false }), false);
});

test('B4 transient: question with temporarily unavailable and spawn failed', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', question: 'ask_codex is temporarily unavailable.\nContext: spawn failed' }), true);
});

test('B5 transient: context field only', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', context: 'mcp server unavailable during spawn' }), true);
});

test('B6 transient: message field only', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', message: 'ask_codex timeout during startup' }), true);
});

test('B7 transient: summary field only', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', summary: 'tool failed to launch' }), true);
});

test('B8 transient: error field with uppercase ECONNREFUSED', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', question: 'ask_codex connection error', error: 'ECONNREFUSED' }), true);
});

test('B9 transient: mcp unavailable wording', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', question: 'MCP server is unavailable' }), true);
});

test('B10 transient: tool timeout wording', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', question: 'the tool timed out waiting for a connection' }), true);
});

test('B11 transient: ask-codex launch failure', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', question: 'ask-codex launch failed' }), true);
});

// Borderline: the transient classifier regex is ask[_-]?codex (no space),
// while the coordinator legacy regex accepts ask[_ -]?codex (space variant).
// Spaced "ask codex" is therefore invisible here. Asserting current behavior.
test('B12 current behavior: "ask codex" spaced variant is not classified transient (FLAGGED)', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', question: 'ask codex spawn error' }), false);
});

test('B13 transient: uppercase ASK_CODEX TIMEOUT', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', question: 'ASK_CODEX TIMEOUT' }), true);
});

test('B14 transient: MCP startup error', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', question: 'MCP startup error' }), true);
});

test('B15 material: destructive ask_codex escalation is not transient', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', question: 'ask_codex rejected a destructive change; escalate' }), false);
});

test('B16 material: guarantee violation is not transient', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', question: 'ask_codex violated the fixed validation guarantee; escalate' }), false);
});

// FLAG in report: current regex treats "denied" as transient evidence, so a
// permanent tool-policy denial is classified retryable. Asserting current
// behavior; design decision is questionable.
test('B17 current behavior: policy denial is classified transient (FLAGGED)', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', question: 'tool policy denied the ask_codex call' }), true);
});

test('B18 material: no mention of ask_codex/mcp/tool at all', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', question: 'The warehouse is on fire' }), false);
});

// Borderline: ask_codex_tool is glued with underscores, so the \b boundary
// rejects it; the transient classifier and the event detector (substring)
// disagree on the same token family.
test('B19 material: ask_codex_tool underscore-glued token is not transient (FLAGGED)', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', question: 'ask_codex_tool spawn failure' }), false);
});

test('B20 material: toolbox mention is not a tool term', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', question: 'toolbox malfunction' }), false);
});

// Borderline: the explicit transient:false flag does not suppress text
// evidence; message-detectable wording still wins. Asserting current behavior.
test('B21 current behavior: transient:false flag with transient wording (FLAGGED)', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', transient: false, question: 'ask_codex temporarily unavailable' }), true);
});

test('B22 transient: transient:true flag overrides destructive content (FLAGGED)', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', transient: true, question: 'ask_codex destructive escalation' }), true);
});

test('B23 material: missing transient marker with escalation wording', () => {
  assert.equal(isTransientConsultationBlock({ decision: 'blocked', question: 'ask_codex guarantee violation: escalation required' }), false);
});

// ---------------------------------------------------------------------------
// MISSION B — transient consultation E2E
// ---------------------------------------------------------------------------

test('T1 gate: transient block consult fails with transient_consultation_failure and blocks consultation_retry', async () => {
  const cwd = await createGitWorkspace('qa-transient-');
  try {
    await seedConsulting(cwd, 'consult-session');
    const transient = {
      decision: 'blocked',
      question: 'ask_codex is temporarily unavailable.\nContext: spawn failed',
      sessionID: 'consult-session'
    };
    const result = await consult({ cwd, runProcess: eventProvider(null, null, transient), retryAttempts: 1, retryDelayMs: 0 });
    assert.equal(result.state.phase, 'blocked_user');
    assert.equal(result.state.block_kind, 'consultation_retry');
    assert.equal(result.state.resume_phase, 'hands_consulting');
    assert.match(result.error, /temporarily unavailable/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// MISSION B — coordinator legacy classifier consistency (runner side)
// ---------------------------------------------------------------------------

test('L1 legacy: fresh consultation_retry block persists without double migration', async () => {
  const cwd = await createGitWorkspace('qa-legacy-fresh-');
  try {
    await seedConsulting(cwd, 'consult-session');
    const state = await runCommand(['block', '--kind', 'consultation_retry', 'ask_codex MCP tool startup error'], { cwd });
    assert.equal(state.block_kind, 'consultation_retry');
    assert.equal(state.resume_phase, 'hands_consulting');
    const again = await readState({ cwd });
    assert.equal(again.block_kind, 'consultation_retry', 'no double migration may rewrite the kind');
    assert.equal(again.resume_phase, 'hands_consulting');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('L2 legacy: fresh needs_revision tagged ask_codex error migrates to consultation_retry via readState', async () => {
  const cwd = await createGitWorkspace('qa-legacy-migrate-');
  try {
    await seedConsulting(cwd, 'consult-session');
    const state = await runCommand(['block', '--kind', 'needs_revision', 'ask_codex MCP tool startup error'], { cwd });
    assert.equal(state.block_kind, 'consultation_retry');
    assert.equal(state.resume_phase, 'hands_consulting');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('L3 legacy: policy denial reason stays needs_revision (not legacy-retry shaped)', async () => {
  const cwd = await createGitWorkspace('qa-legacy-denial-');
  try {
    await seedConsulting(cwd, 'consult-session');
    const state = await runCommand(['block', '--kind', 'needs_revision', 'ask_codex tool policy denied'], { cwd });
    assert.equal(state.block_kind, 'needs_revision', 'denial is not a legacy transient-consult retry');
    assert.equal((await readState({ cwd })).block_kind, 'needs_revision');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Adapter integrity: parseStructuredResult must not misread event envelopes
// ---------------------------------------------------------------------------

test('P1 parse: JSONL tool events do not hide the final decision', () => {
  const output = [
    JSON.stringify({ type: 'tool.completed', tool: 'ask_codex' }),
    JSON.stringify({ type: 'message', item: { text: '{"decision":"approved","assignment_id":"a1","revision":0,"summary":"ok","brain_answer":"go"}' } })
  ].join('\n');
  const result = parseStructuredResult(output);
  assert.equal(result.decision, 'approved');
  assert.equal(result.brain_answer, 'go');
});

test('P2 parse: tool.completed output containing a decision-shaped object is treated as a result (FLAGGED)', () => {
  const output = JSON.stringify({ type: 'tool.completed', tool: 'ask_codex', output: '{"decision":"approved","assignment_id":"a1","revision":0,"summary":"ok","brain_answer":"go"}' });
  const result = parseStructuredResult(output);
  assert.equal(result.decision, 'approved');
});

test('P3 parse: validateConsultation contract still enforced', () => {
  const state = { assignment_id: 'a1', revision: 1 };
  assert.throws(() => validateConsultation({ decision: 'approved', assignment_id: 'a1', revision: 2, summary: 'ok', brain_answer: 'go' }, state), /valid Brain decision/i);
  assert.doesNotThrow(() => validateConsultation({ decision: 'approved', assignment_id: 'a1', revision: 1, summary: 'ok', brain_answer: 'go' }, state));
});
