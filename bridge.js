#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const readline = require('node:readline');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runProcess } = require('./bridge-adapter');
const { startInspectorServer, allowedControls } = require('./bridge-inspector');

const bridgeRoot = __dirname;
const coordinator = path.join(bridgeRoot, 'bridge-coordinator.js');
const runner = path.join(bridgeRoot, 'bridge-runner.js');

// ─── Semantic color system ────────────────────────────────────────────────────
const ANSI = {
  // Reset / modifiers
  reset:    '\x1b[0m',
  bold:     '\x1b[1m',
  dim:      '\x1b[2m',
  italic:   '\x1b[3m',
  under:    '\x1b[4m',
  // Semantic roles
  primary:  '\x1b[36m',    // cyan      — brand headers, active phases
  success:  '\x1b[32m',    // green     — done / ok / pass
  warn:     '\x1b[33m',    // yellow    — blocked / waiting / user action needed
  error:    '\x1b[31m',    // red       — error / cancelled / fail
  accent:   '\x1b[35m',    // magenta   — Brain agent, highlights
  muted:    '\x1b[2m',     // dim       — timestamps, paths, secondary info
  hi:       '\x1b[97m',    // bright wh — task text, foreground emphasis
  // Compat aliases kept for any existing internal references
  cyan:     '\x1b[36m',
  green:    '\x1b[32m',
  yellow:   '\x1b[33m',
  red:      '\x1b[31m',
  // Box drawing helpers (returns string, not escape)
  clear:    '\x1b[2J\x1b[H',
};

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ACTIVE_PHASES = new Set(['planning', 'hands_proposing', 'brain_approving', 'hands_consulting', 'hands_executing', 'brain_reviewing']);

function spinner() { return SPIN[Math.floor(Date.now() / 100) % SPIN.length]; }

/** Map phase → semantic ANSI color code */
function phaseColor(phase) {
  if (phase === 'done') return ANSI.success;
  if (phase === 'cancelled') return ANSI.error;
  if (phase === 'blocked_user') return ANSI.warn;
  if (phase === 'paused') return ANSI.muted;
  if (phase === 'brain_approving' || phase === 'brain_reviewing') return ANSI.accent;
  if (ACTIVE_PHASES.has(phase)) return ANSI.primary;
  return ANSI.dim;
}

/** Map event agent → color */
function agentColor(agent) {
  if (!agent || agent === 'system') return ANSI.muted;
  if (String(agent).startsWith('mind') || String(agent).startsWith('brain')) return ANSI.accent;
  if (String(agent).startsWith('hands')) return ANSI.primary;
  if (agent === 'user') return ANSI.warn;
  return ANSI.dim;
}

/** Box-drawing row helpers */
function boxTop(width) { return '\x1b[36m╭' + '─'.repeat(width - 2) + '╮\x1b[0m'; }
function boxBot(width) { return '\x1b[36m╰' + '─'.repeat(width - 2) + '╯\x1b[0m'; }
function boxDiv(width) { return '\x1b[36m├' + '─'.repeat(width - 2) + '┤\x1b[0m'; }
function boxRow(inner, width) {
  const max = Math.max(10, width - 4);
  const visible = inner.replace(/\x1b\[[0-9;]*m/g, '');
  const content = visible.length > max ? shorten(visible, max) : inner;
  const contentVisible = content.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, max - contentVisible.length);
  return '\x1b[36m│\x1b[0m ' + content + ' '.repeat(pad) + ' \x1b[36m│\x1b[0m';
}

const defaultBrainConfig = {
  provider: 'custom',
  baseURL: 'https://router.nilovr.web.id/v1',
  api_key: process.env.BRAIN_API_KEY || 'sk-your-brain-api-key',
  model: 'bd/deepseek-v4-pro-0813',
  timeout_ms: 60000
};

const defaultOpencodeConfig = {
  $schema: 'https://opencode.ai/config.json',
  provider: {
    'local-router': {
      npm: '@ai-sdk/openai-compatible',
      name: 'Local Router',
      options: {
        baseURL: 'http://localhost:20128/v1',
        apiKey: '{env:OPENCODE_API_KEY}'
      },
      models: {
        'bd/Deepseek-V4-Flash-0731': { name: 'Deepseek-V4-Flash-0731' },
        'oc/x-preview-f-free': { name: 'x-preview-f-free' },
        'bd/Kimi-k2.7-code': { name: 'Kimi-k2.7-code' }
      }
    }
  }
};

const localAgentProfiles = {
  'hands.md': [
    '---',
    'description: Bridge execution agent. Edits only the approved chunk.',
    'mode: primary',
    'model: local-router/bd/Deepseek-V4-Flash-0731',
    'permission:',
    '  "*": deny',
    '  read: allow',
    '  edit: allow',
    '  glob: allow',
    '  grep: allow',
    '  list: allow',
    '  lsp: allow',
    '  bash: allow',
    '  task: deny',
    '  skill: deny',
    '  external_directory: deny',
    '  question: deny',
    '  webfetch: deny',
    '  websearch: deny',
    '  todowrite: deny',
    '  ask-codex_*: deny',
    '---',
    '',
    'You are HANDS, the execution role. Execute only the chunk and files supplied by bridge-runner.js.',
    'Do not call ask_codex, start subagents, or broaden the approved scope.'
  ].join('\n') + '\n',
  'hands-propose.md': [
    '---',
    'description: Bridge read-only proposal agent.',
    'mode: primary',
    'model: local-router/bd/Deepseek-V4-Flash-0731',
    'permission:',
    '  "*": deny',
    '  read: allow',
    '  glob: allow',
    '  grep: allow',
    '  list: allow',
    '  lsp: allow',
    '  task: deny',
    '  skill: deny',
    '  external_directory: deny',
    '  edit: deny',
    '  bash: deny',
    '  ask-codex_*: deny',
    '---',
    '',
    'You are HANDS-PROPOSE, the read-only planning role. Read the repository and return one small structured proposal.',
    'Do not edit files or launch tools outside the read-only permissions.'
  ].join('\n') + '\n',
  'hands-consult.md': [
    '---',
    'description: Bridge consultation gate. Confirms Brain guidance injected by the bridge.',
    'mode: primary',
    'model: local-router/bd/Deepseek-V4-Flash-0731',
    'permission:',
    '  "*": deny',
    '  read: allow',
    '  glob: allow',
    '  grep: allow',
    '  list: allow',
    '  lsp: allow',
    '  task: deny',
    '  skill: deny',
    '  external_directory: deny',
    '  edit: deny',
    '  bash: deny',
    '  ask-codex_*: allow',
    '---',
    '',
    'You are HANDS-CONSULT, the read-only Brain handoff role. Confirm the Brain guidance matches scope.',
    'Do not edit files or run mutating commands.'
  ].join('\n') + '\n',
  'hands-evaluate.md': [
    '---',
    'description: Bridge read-only evaluator. Reviews one completed HANDS chunk.',
    'mode: primary',
    'model: local-router/bd/Deepseek-V4-Flash-0731',
    'permission:',
    '  "*": deny',
    '  read: allow',
    '  glob: allow',
    '  grep: allow',
    '  list: allow',
    '  lsp: allow',
    '  task: deny',
    '  skill: deny',
    '  external_directory: deny',
    '  edit: deny',
    '  bash: allow',
    '  ask-codex_*: deny',
    '---',
    '',
    'You are HANDS-EVALUATE. Read only the approved files and recorded validation.',
    'Return exactly one JSON object: {"decision":"passed|failed|blocked","summary":"short result","tests":["focused check"],"risks":["risk"]}.',
    'Run only supplied non-mutating checks. Do not edit files, call Brain, or expand the approved scope.'
  ].join('\n') + '\n'
};

function projectPath(args) {
  const index = args.indexOf('--project');
  if (index < 0) return process.cwd();
  const value = args[index + 1];
  if (!value) throw new Error('--project requires a folder path.');
  args.splice(index, 2);
  return path.resolve(value);
}

async function invoke(script, args, cwd) {
  const timeoutMs = script === runner
    ? Number(process.env.MIND_LIMB_BRIDGE_TIMEOUT_MS)
      || ((Number(process.env.MIND_LIMB_EXECUTION_TIMEOUT_MS) || 600000) + 30000)
    : 30000;
  const result = await runProcess(process.execPath, [script, ...args], { cwd, timeoutMs });
  if (!result.ok) {
    if (result.timed_out) throw new Error('Bridge command timed out after ' + Math.round(timeoutMs / 1000) + ' seconds.');
    throw new Error((result.stderr || result.stdout || 'Bridge command failed').trim());
  }
  return result.stdout.trim();
}

async function ensureLocalAgentProfiles(cwd) {
  const directory = path.join(cwd, '.opencode', 'agents');
  const created = [];
  await fs.mkdir(directory, { recursive: true });
  for (const [name, contents] of Object.entries(localAgentProfiles)) {
    const file = path.join(directory, name);
    try {
      const existing = await fs.readFile(file, 'utf8');
      if (existing.includes('opencode/deepseek-v4-flash-free') || existing.includes('oc/x-preview-f-free')) {
        await fs.writeFile(file, contents, 'utf8');
        created.push(name + ' (updated)');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.writeFile(file, contents, 'utf8');
      created.push(name);
    }
  }
  return created;
}

async function ensureBrainConfig(cwd) {
  const file = path.join(cwd, '.bridge', 'brain.json');
  try {
    await fs.access(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(defaultBrainConfig, null, 2) + '\n', 'utf8');
    return true;
  }
  return false;
}

async function ensureOpencodeConfig(cwd) {
  const file = path.join(cwd, 'opencode.json');
  try {
    await fs.access(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.writeFile(file, JSON.stringify(defaultOpencodeConfig, null, 2) + '\n', 'utf8');
    return true;
  }
  return false;
}

async function ensureGitignore(cwd) {
  const file = path.join(cwd, '.gitignore');
  const required = ['.bridge/', '.opencode/', 'node_modules/', 'dist/'];
  let contents = '';
  try {
    contents = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const existing = new Set(contents.split(/\r?\n/).map(line => line.trim().replace(/\/+$/, '')));
  const missing = required.filter(entry => !existing.has(entry.slice(0, -1)));
  if (!missing.length) return false;
  const separator = contents && !contents.endsWith('\n') && !contents.endsWith('\r') ? newline : '';
  await fs.writeFile(file, contents + separator + missing.join(newline) + newline, 'utf8');
  return true;
}

async function ensureGitRepo(cwd) {
  const gitDir = path.join(cwd, '.git');
  try {
    await fs.access(gitDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await runProcess('git', ['init'], { cwd });
    const name = (await gitConfig(cwd, 'user.name')) || 'Bridge User';
    const email = (await gitConfig(cwd, 'user.email')) || 'bridge@localhost';
    await runProcess('git', ['config', 'user.name', name], { cwd });
    await runProcess('git', ['config', 'user.email', email], { cwd });
    await ensureGitignore(cwd);
    await runProcess('git', ['add', '.'], { cwd });
    await runProcess('git', ['commit', '-m', 'baseline'], { cwd }).catch(() => {});
  }
}

async function prepareProject(cwd) {
  await ensureGitRepo(cwd);
  await invoke(coordinator, ['init'], cwd);
  const gitignoreUpdated = await ensureGitignore(cwd);
  const createdProfiles = await ensureLocalAgentProfiles(cwd);
  await ensureBrainConfig(cwd);
  await ensureOpencodeConfig(cwd);
  process.stdout.write([
    ANSI.bold + ANSI.primary + '  Bridge  ' + ANSI.reset + ANSI.muted + 'project ready' + ANSI.reset,
    ANSI.muted + '  ' + cwd + ANSI.reset,
    '',
    '  ' + ANSI.success + '✓' + ANSI.reset + '  Git repo          initialized',
    '  ' + ANSI.success + '✓' + ANSI.reset + '  Coordinator       ready',
    '  ' + (gitignoreUpdated ? ANSI.warn + '↑' : ANSI.success + '✓') + ANSI.reset + '  .gitignore        ' + (gitignoreUpdated ? 'updated' : 'ok'),
    '  ' + (createdProfiles.length ? ANSI.warn + '↑' : ANSI.success + '✓') + ANSI.reset + '  Agent profiles    ' + (createdProfiles.length ? createdProfiles.join(', ') : 'already present'),
    '  ' + ANSI.success + '✓' + ANSI.reset + '  Brain config      .bridge/brain.json',
    '  ' + ANSI.success + '✓' + ANSI.reset + '  OpenCode config   opencode.json',
    '',
  ].join('\n'));
}

async function runGit(cwd, args) {
  const result = await runProcess('git', args, { cwd, timeoutMs: 30000 });
  if (!result.ok) throw new Error((result.stderr || result.stdout || 'Git command failed').trim());
  return result.stdout.trim();
}

async function gitConfig(cwd, key) {
  const result = await runProcess('git', ['config', '--get', key], { cwd, timeoutMs: 10000 });
  return result.ok ? result.stdout.trim() : '';
}

function parseNewArgs(args) {
  let target = null;
  let name = null;
  let email = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const equal = argument.indexOf('=');
    const flag = equal >= 0 ? argument.slice(0, equal) : argument;
    let value = equal >= 0 ? argument.slice(equal + 1) : null;
    if (flag === '--name' || flag === '--email') {
      if (value === null) value = args[++index];
      if (!value) throw new Error(flag + ' requires a value.');
      if (flag === '--name') name = value;
      else email = value;
      continue;
    }
    if (argument.startsWith('--')) throw new Error('Unknown bridge new option: ' + argument);
    if (target) throw new Error('bridge new accepts one project folder.');
    target = argument;
  }
  if (!target) throw new Error('Usage: bridge new <folder> [--name "Git name"] [--email "Git email"]');
  return { target: path.resolve(target), name, email };
}

async function newProject(args) {
  const { target, name, email } = parseNewArgs(args);
  const gitName = name || await gitConfig(process.cwd(), 'user.name');
  const gitEmail = email || await gitConfig(process.cwd(), 'user.email');
  if (!gitName || !gitEmail) {
    throw new Error('Git identity is missing. Re-run with --name "Your name" --email "you@example.com", or configure git globally.');
  }
  let existed = true;
  try {
    const entries = await fs.readdir(target);
    if (entries.length) throw new Error('Target folder must be new or empty: ' + target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    existed = false;
    await fs.mkdir(target, { recursive: true });
  }
  try {
    await runGit(target, ['init']);
    await runGit(target, ['config', 'user.name', gitName]);
    await runGit(target, ['config', 'user.email', gitEmail]);
    await fs.writeFile(path.join(target, 'README.md'), '# ' + path.basename(target) + '\n', { flag: 'wx' });
    await prepareProject(target);
    await runGit(target, ['add', '.']);
    await runGit(target, ['commit', '-m', 'baseline']);
    process.stdout.write([
      '  ' + ANSI.success + '✓' + ANSI.reset + '  Baseline commit ready: ' + target,
      '',
      ANSI.bold + '  Next step' + ANSI.reset,
      ANSI.muted + '  cd "' + target + '"' + ANSI.reset,
      ANSI.primary + '  bridge run "your task"' + ANSI.reset,
      '',
    ].join('\n'));
  } catch (error) {
    if (!existed) await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function readState(cwd) {
  try {
    return JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'state.json'), 'utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const result = await runProcess(process.execPath, [coordinator, 'status'], { cwd, timeoutMs: 30000 });
    if (!result.ok) throw new Error((result.stderr || result.stdout || 'Coordinator command failed').trim());
    return JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'state.json'), 'utf8'));
  }
}

async function readJsonLines(cwd, name, limit = 120, maxBytes = 256 * 1024) {
  let handle;
  try {
    handle = await fs.open(path.join(cwd, '.bridge', name), 'r');
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(Number(stat.size - start));
    if (buffer.length) await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstBreak = text.indexOf('\n');
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : '';
    }
    const values = [];
    for (const line of text.split(/\r?\n/).filter(Boolean).slice(-limit)) {
      try { values.push(JSON.parse(line)); } catch {}
    }
    return values;
  } catch {
    return [];
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function readEvents(cwd) { return readJsonLines(cwd, 'events.jsonl', 120); }
async function readActions(cwd) { return readJsonLines(cwd, 'actions.jsonl', 160); }

function parseRunnerOutput(text) {
  try { return JSON.parse(text); } catch { return { text }; }
}

/** Colored structured output for non-TUI commands (status, pause, revise, etc.) */
function printState(stateOrText) {
  const value = typeof stateOrText === 'string' ? parseRunnerOutput(stateOrText) : stateOrText;
  const state = value.state || value;
  const phase = state.phase || 'unknown';
  const pColor = phaseColor(phase);
  const isActive = ACTIVE_PHASES.has(phase);
  const spin = isActive ? ' ' + spinner() : '';

  const lines = [
    '',
    ANSI.bold + ANSI.primary + ' MIND-LIMB' + ANSI.reset + '  ' + pColor + ANSI.bold + phase.toUpperCase() + ANSI.reset + ANSI.muted + spin + ANSI.reset,
    '',
    'Phase: ' + phase,
    'Task: ' + (state.task || '(none)'),
  ];

  const mode = state.autonomy?.mode || 'manual';
  lines.push('Flow: Brain ↔ HANDS (' + mode + ')');
  if (state.handoff?.status) lines.push('Handoff: ' + state.handoff.status);
  if (state.last_summary) lines.push('Last: ' + state.last_summary);
  if (state.activity?.action) lines.push('Now: ' + state.activity.action);
  if (state.evaluation?.status) lines.push('Evaluation: ' + state.evaluation.status);
  if (value.result?.summary) lines.push('HANDS: ' + value.result.summary);
  if (value.error) lines.push('Waiting: ' + value.error);
  if (state.blocked_reason) lines.push(ANSI.warn + '  ⚠  ' + state.blocked_reason + ANSI.reset);
  if (value.message) lines.push(ANSI.muted + '  ' + value.message + ANSI.reset);

  lines.push('');
  process.stdout.write(lines.join('\n'));
}

/** Back-compat alias — called from invoke() return paths */
function printRunner(text) { printState(text); }

function nextAction(state) {
  return {
    planning:          'HANDS preparing proposal',
    hands_proposing:   'HANDS preparing proposal',
    brain_approving:   'Brain evaluating proposal',
    hands_consulting:  'HANDS consulting Brain',
    hands_executing:   'HANDS executing chunk',
    brain_reviewing:   'Brain reviewing result',
    blocked_user: state.block_kind === 'consultation_retry'
      ? 'Retry Brain consultation'
      : ['needs_revision', 'escalation'].includes(state.block_kind)
        ? 'Awaiting revised guidance'
        : 'Awaiting user input',
    paused:    'Paused',
    done:      'Complete ✓',
    cancelled: 'Stopped'
  }[state.phase] || 'Idle';
}

function displayAgent(agent) {
  if (agent === 'hands-propose')  return 'HANDS  proposal';
  if (agent === 'hands-consult')  return 'HANDS  consult';
  if (agent === 'hands')          return 'HANDS  execution';
  if (agent === 'hands-evaluate') return 'HANDS  evaluate';
  if (agent === 'mind')           return 'MIND   Brain';
  if (agent === 'user')           return 'USER';
  return 'IDLE';
}

function shorten(value, maxWidth) {
  const text = String(value || '').replace(/\s+/g, ' ');
  return text.length > maxWidth ? text.slice(0, maxWidth - 1) + '…' : text;
}

function controlsFor(state) {
  const controls = allowedControls(state);
  if (['needs_revision', 'escalation'].includes(state.block_kind)) {
    return ANSI.warn + 'bridge revise "guidance"' + ANSI.reset + ANSI.muted + '  [i] steer  [s] stop  [q] quit' + ANSI.reset;
  }
  if (state.block_kind === 'consultation_retry') {
    return ANSI.warn + 'bridge resume' + ANSI.reset + ANSI.muted + '  [r] resume  [p] pause  [s] stop  [q] quit' + ANSI.reset;
  }
  const autonomous = ['brain_autonomous', 'brain_approved'].includes(state?.autonomy?.mode);
  const shortcuts = { approve: '[a] approve', pause: '[p] pause', resume: '[r] resume', stop: '[s] stop', recover: '[c] recover' };
  if (autonomous) delete shortcuts.approve;
  const keys = [];
  if (ACTIVE_PHASES.has(state.phase) || state.phase === 'paused' || state.phase === 'blocked_user') {
    keys.push(ANSI.primary + '[i] steer' + ANSI.reset);
  }
  keys.push(...controls.filter(c => shortcuts[c]).map(c => shortcuts[c]), '[q] quit');
  return ANSI.muted + keys.join('  ') + ANSI.reset;
}

function controlAllowed(command, state) {
  if (command === 'approve' && ['brain_autonomous', 'brain_approved'].includes(state?.autonomy?.mode)) return false;
  return allowedControls(state).includes(command);
}

function renderDashboard(state, events, cwd, actions = []) {
  const cols = process.stdout.columns || 80;
  const rowsAvailable = process.stdout.rows || 24;
  const W = Math.max(40, cols - 2);
  const activityLimit = Math.max(2, Math.min(10, rowsAvailable - 16));

  const activity = state.activity || { agent: state.active_agent, action: state.last_summary };
  const phase = state.phase || 'idle';
  const pColor = phaseColor(phase);
  const isActive = ACTIVE_PHASES.has(phase);
  const spin = isActive ? spinner() : (phase === 'done' ? '✓' : phase === 'cancelled' ? '✗' : '·');
  const time = new Date().toLocaleTimeString();

  // ── Header bar ─────────────────────────────────────────────────────────────
  const title = ' MIND-LIMB BRIDGE ';
  const badge = ' ' + spin + ' ' + phase.toUpperCase() + ' ';
  const titleFill = Math.max(1, W - 4 - title.length - badge.length);
  const headerInner =
    ANSI.bold + ANSI.primary + title + ANSI.reset +
    ANSI.muted + '─'.repeat(titleFill) + ANSI.reset +
    pColor + ANSI.bold + badge + ANSI.reset;

  // ── Recent activity log ────────────────────────────────────────────────────
  const merged = [
    ...events.map(e => ({ at: e.at, agent: e.agent || e.active_agent || 'system', label: e.type, summary: e.summary || '' })),
    ...actions.map(a => ({ at: a.at, agent: a.agent || 'system', label: a.kind, summary: a.summary || a.target || '' }))
  ].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-activityLimit);

  const activityRows = merged.length
    ? merged.map(ev => {
        const t = ANSI.muted + new Date(ev.at).toLocaleTimeString() + ANSI.reset;
        const ag = ev.agent || 'system';
        const agPad = shorten(ag, 12).padEnd(12);
        const agColored = agentColor(ag) + agPad + ANSI.reset;
        const rawLabel = String(ev.label || '');
        const lblColor = /read|view|cat/i.test(rawLabel) ? ANSI.success
          : /edit|write|patch/i.test(rawLabel) ? ANSI.warn
          : /bash|exec|cmd|sh/i.test(rawLabel) ? ANSI.primary
          : /brain|mind|review|approve|consult/i.test(rawLabel) ? ANSI.accent
          : ANSI.muted;
        const lbl = lblColor + shorten(rawLabel, 16).padEnd(16) + ANSI.reset;
        const avail = Math.max(8, W - 50);
        const sum = shorten(ev.summary, avail);
        return boxRow(t + '  ' + agColored + '  ' + lbl + '  ' + sum, W);
      })
    : [boxRow(ANSI.muted + '(no activity yet)' + ANSI.reset, W)];

  // ── Evaluation / git status ────────────────────────────────────────────────
  const evalStatus = state.evaluation?.status || 'pending';
  const evalColor = evalStatus === 'passed' ? ANSI.success : evalStatus === 'failed' ? ANSI.error : ANSI.muted;

  const rows = [
    boxTop(W),
    boxRow(headerInner, W),
    boxRow(ANSI.muted + shorten(cwd, W - 6) + ANSI.reset + ANSI.muted + '  ' + time + ANSI.reset, W),
    boxDiv(W),

    // Task
    boxRow(ANSI.bold + 'TASK  ' + ANSI.reset + ANSI.hi + shorten(state.task || '(none)', W - 10) + ANSI.reset, W),
    boxRow(ANSI.muted + 'FLOW  ' + ANSI.reset + 'Brain ↔ HANDS  ' + ANSI.muted + '(' + (state.autonomy?.mode || 'manual') + ')' + ANSI.reset, W),
    boxDiv(W),

    // Agent / current activity
    boxRow(ANSI.muted + 'AGENT ' + ANSI.reset + agentColor(activity.agent) + ANSI.bold + displayAgent(activity.agent) + ANSI.reset, W),
    boxRow(ANSI.muted + 'NOW   ' + ANSI.reset + shorten(activity.action || state.last_summary || '—', W - 10), W),
  ];

  if (state.mind_feedback) {
    rows.push(boxRow(ANSI.muted + 'BRAIN ' + ANSI.reset + ANSI.accent + shorten(state.mind_feedback, W - 10) + ANSI.reset, W));
  }

  rows.push(
    boxRow(ANSI.muted + 'NEXT  ' + ANSI.reset + ANSI.muted + nextAction(state) + ANSI.reset, W),
    boxRow(ANSI.muted + 'EVAL  ' + ANSI.reset + evalColor + evalStatus + ANSI.reset + '   ' + ANSI.muted + 'GIT ' + ANSI.reset + shorten(state.git_status || '—', W - 32), W)
  );

  // Blocked reason
  if (state.blocked_reason) {
    rows.push(boxDiv(W));
    rows.push(boxRow(ANSI.warn + '⚠  ' + shorten(state.blocked_reason, W - 8) + ANSI.reset, W));
  }

  // Activity log
  rows.push(boxDiv(W));
  rows.push(boxRow(ANSI.bold + 'RECENT ACTIVITY' + ANSI.reset, W));
  rows.push(...activityRows);

  // Controls
  rows.push(boxDiv(W));
  rows.push(boxRow(controlsFor(state), W));
  rows.push(boxBot(W));

  return rows.join('\n');
}

async function watch(cwd) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('bridge watch needs an interactive terminal.');
  let closed = false;
  let busy = false;
  let frameLines = 0;
  let timer;
  let notice = '';
  let rendering = false;
  const render = async () => {
    if (closed || rendering) return;
    rendering = true;
    try {
      let output;
      try {
        output = renderDashboard(await readState(cwd), await readEvents(cwd), cwd, await readActions(cwd));
      } catch (error) {
        output = ANSI.error + '  No bridge session. Run: bridge open .' + ANSI.reset + '\n' + ANSI.muted + '  ' + error.message + ANSI.reset;
      }
      if (notice) output += '\n\n' + ANSI.warn + '  ' + shorten(notice, 100) + ANSI.reset;
      if (frameLines) readline.moveCursor(process.stdout, 0, -frameLines);
      readline.cursorTo(process.stdout, 0);
      readline.clearScreenDown(process.stdout);
      process.stdout.write(output + '\n');
      frameLines = output.split('\n').length;
    } finally {
      rendering = false;
    }
  };

  const onResize = () => {
    frameLines = 0;
    readline.cursorTo(process.stdout, 0);
    readline.clearScreenDown(process.stdout);
    render();
  };
  process.stdout.on('resize', onResize);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    process.stdout.removeListener('resize', onResize);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    readline.cursorTo(process.stdout, 0);
    readline.clearScreenDown(process.stdout);
    process.stdout.write(ANSI.reset + '\x1b[?25h\n');
  };
  const control = async command => {
    if (busy) return;
    busy = true;
    notice = '';
    try {
      const state = await readState(cwd);
      if (!controlAllowed(command, state)) {
        notice = command + ' is not available while the session is ' + state.phase + '.';
        return;
      }
      const args = command === 'stop' ? ['cancel', 'Stopped from bridge watch'] : [command];
      await invoke(command === 'recover' ? coordinator : runner, args, cwd);
      notice = command + ' requested.';
    } catch (error) {
      notice = 'Error: ' + error.message;
    } finally {
      busy = false;
      await render();
    }
  };
  const promptSteer = () => {
    if (busy) return;
    busy = true;
    clearInterval(timer);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(ANSI.reset + '\x1b[?25h\n');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const prompt = ANSI.bold + ANSI.primary + '  Steer prompt' + ANSI.reset + ANSI.muted + ' (inject guidance · Enter or Ctrl+C to cancel): ' + ANSI.reset;

    let closedPrompt = false;
    const cancelPrompt = () => {
      if (closedPrompt) return;
      closedPrompt = true;
      rl.close();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
      }
      process.stdout.write('\x1b[?25l');
      notice = 'Steer cancelled.';
      busy = false;
      timer = setInterval(render, 1000);
      render();
    };

    rl.on('SIGINT', cancelPrompt);

    rl.question(prompt, async input => {
      if (closedPrompt) return;
      closedPrompt = true;
      rl.close();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
      }
      process.stdout.write('\x1b[?25l');
      const text = (input || '').trim();
      if (text) {
        try {
          await invoke(runner, ['revise', text], cwd);
          notice = 'Steered: ' + text;
        } catch (e) {
          notice = 'Error steering: ' + e.message;
        }
      } else {
        notice = 'Steer cancelled.';
      }
      busy = false;
      timer = setInterval(render, 1000);
      await render();
    });
  };

  process.stdout.write('\x1b[?25l');
  await render();
  timer = setInterval(render, 1000);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', chunk => {
    const key = String(chunk).toLowerCase();
    if (key.includes('\u0003') || key.includes('q')) return cleanup();
    if (key.includes('i')) return promptSteer();
    if (key.includes('a')) void control('approve');
    else if (key.includes('r')) void control('resume');
    else if (key.includes('p')) void control('pause');
    else if (key.includes('s')) void control('stop');
    else if (key.includes('c')) void control('recover');
  });
  await new Promise(resolve => process.stdin.once('close', resolve));
}

async function inspect(cwd) {
  const server = await startInspectorServer({ projectRoot: cwd });
  console.log('Inspector: ' + server.url);
  console.log('Press Ctrl+C to stop.');
  const shutdown = async () => { await server.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await new Promise(() => {});
}

async function install() {
  const bin = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm')
    : path.join(os.homedir(), '.local', 'bin');
  await fs.mkdir(bin, { recursive: true });
  const script = path.join(bridgeRoot, 'bridge.js');
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(bin, 'bridge.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
    await fs.writeFile(path.join(bin, 'bridge.ps1'), `& "${process.execPath}" "${script}" @args\r\n`, 'utf8');
  } else {
    const launcher = `#!/usr/bin/env sh\nexec "${process.execPath}" "${script}" "$@"\n`;
    const target = path.join(bin, 'bridge');
    await fs.writeFile(target, launcher, 'utf8');
    await fs.chmod(target, 0o755);
  }
  process.stdout.write(ANSI.success + '  ✓' + ANSI.reset + '  Bridge installed  ' + ANSI.muted + bin + ANSI.reset + '\n');
}

async function showStatus(cwd) {
  try {
    const state = await readState(cwd);
    printState(state);
  } catch (error) {
    // Fall back to coordinator output if state unreadable
    const output = await invoke(coordinator, ['status'], cwd);
    process.stdout.write(ANSI.muted + output + ANSI.reset + '\n');
  }
}

async function showPolicy(cwd) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'policy.json'), 'utf8'));
    console.log(JSON.stringify(value, null, 2));
  } catch (error) {
    throw new Error('No project policy found. Run: bridge open .');
  }
}

async function doctor(cwd = process.cwd()) {
  process.stdout.write('\n' + ANSI.bold + ANSI.primary + '  bridge doctor' + ANSI.reset + '\n\n');

  const checks = [];

  // Runtime checks
  for (const [name, command, cmdArgs] of [
    ['Node',     process.execPath, ['--version']],
    ['Git',      'git',            ['--version']],
    ['OpenCode', 'opencode',       ['--version']]
  ]) {
    const result = await runProcess(command, cmdArgs, { cwd, timeoutMs: 10000 });
    const ok = result.ok;
    const detail = ok ? result.stdout.trim().split('\n')[0] : 'not found';
    checks.push({ name, ok, detail, fix: null });
  }

  // Profile checks
  const profileNames = ['hands.md', 'hands-propose.md', 'hands-consult.md', 'hands-evaluate.md'];
  const profileChecks = await Promise.all(profileNames.map(async n => {
    try { await fs.access(path.join(cwd, '.opencode', 'agents', n)); return true; } catch { return false; }
  }));
  const profilesOk = profileChecks.every(Boolean);
  const missingProfiles = profileNames.filter((_, i) => !profileChecks[i]);
  checks.push({ name: 'Profiles', ok: profilesOk, detail: profilesOk ? '4 bridge agents ready' : 'missing: ' + missingProfiles.join(', '), fix: profilesOk ? null : 'bridge open .' });

  // Agent list check
  const agents = await runProcess('opencode', ['agent', 'list'], { cwd, timeoutMs: 15000 });
  const agentsOk = agents.ok && ['hands', 'hands-propose', 'hands-consult', 'hands-evaluate'].every(a => agents.stdout.includes(a));
  checks.push({ name: 'Agents', ok: agentsOk, detail: agentsOk ? 'hands · hands-propose · hands-consult · hands-evaluate' : 'run: opencode agent list', fix: agentsOk ? null : 'opencode agent list' });

  // Config files
  const brainOk = await fs.access(path.join(cwd, '.bridge', 'brain.json')).then(() => true, () => false);
  checks.push({ name: 'Brain', ok: brainOk, detail: brainOk ? '.bridge/brain.json configured' : 'missing', fix: brainOk ? null : 'bridge open .' });

  const ocfgOk = await fs.access(path.join(cwd, 'opencode.json')).then(() => true, () => false);
  checks.push({ name: 'OpenCode', ok: ocfgOk, detail: ocfgOk ? 'opencode.json configured' : 'missing', fix: ocfgOk ? null : 'bridge open .' });

  // Render
  const nameW = Math.max(...checks.map(c => c.name.length)) + 2;
  for (const { name, ok, detail, fix } of checks) {
    const icon = ok ? ANSI.success + '  ✓' : ANSI.error + '  ✗';
    const fixHint = fix ? ANSI.muted + '  →  ' + fix + ANSI.reset : '';
    process.stdout.write(icon + ANSI.reset + '  ' + name.padEnd(nameW) + (ok ? ANSI.muted : ANSI.warn) + detail + ANSI.reset + fixHint + '\n');
  }

  const allOk = checks.every(c => c.ok);
  process.stdout.write('\n' + (allOk
    ? ANSI.success + '  All checks passed.' + ANSI.reset + ANSI.muted + '  bridge run "your task"' + ANSI.reset
    : ANSI.warn + '  Some checks failed — fix the items marked ✗ above.' + ANSI.reset) + '\n\n');
}

function help() {
  const W = Math.min(process.stdout.columns || 80, 100);
  const cmd = (c, d) => '  ' + ANSI.primary + c.padEnd(32) + ANSI.reset + ANSI.muted + d + ANSI.reset;
  const section = (s) => '\n' + ANSI.bold + ' ' + s + ANSI.reset;

  process.stdout.write([
    '',
    ANSI.bold + ANSI.primary + ' MIND-LIMB BRIDGE' + ANSI.reset + ANSI.muted + '  Brain ↔ HANDS autonomous workflow' + ANSI.reset,
    ANSI.muted + ' ' + '─'.repeat(W - 2) + ANSI.reset,

    section('Setup'),
    cmd('bridge install',              'Install global bridge command'),
    cmd('bridge new <folder>',         'Create project with Git baseline'),
    cmd('bridge open [folder]',        'Prepare an existing project'),
    cmd('bridge doctor',               'Check installation health'),

    section('Run  (single terminal — no second window needed)'),
    cmd('bridge run "task"',           'Start task + open live dashboard'),
    cmd('bridge watch',                'Attach live dashboard to running session'),
    cmd('bridge inspect',              'Open browser-based inspector'),

    section('Control'),
    cmd('bridge steer "guidance"',     'Inject guidance / steer active workflow mid-flight'),
    cmd('bridge pause | resume | stop','Pause, continue, or cancel session'),
    cmd('bridge approve',              'Manual approval (legacy / compatibility)'),
    cmd('bridge revise "guidance"',    'Provide revised guidance after a block'),
    cmd('bridge done "summary"',       'Mark session complete'),

    section('Recovery'),
    cmd('bridge recover',              'Recover interrupted HANDS run'),
    cmd('bridge unlock',               'Remove stale coordinator lock'),
    cmd('bridge unlock-agent',         'Remove stale HANDS agent lock'),

    section('Inspect'),
    cmd('bridge status',               'Show current session state'),
    cmd('bridge history [n]',          'Show last n audit log entries'),
    cmd('bridge policy',               'Show project safety policy'),
    '',
    ANSI.muted + '  Most commands accept:  --project <folder>' + ANSI.reset,
    ANSI.muted + '  Keyboard shortcuts in dashboard:  [i] steer  [a] approve  [p] pause  [r] resume  [s] stop  [q] quit' + ANSI.reset,
    '',
  ].join('\n'));
}

/**
 * Spawn bridge-runner in background (detached), then return — caller enters watch() immediately.
 * The runner writes progress to .bridge/state.json which watch() polls.
 */
async function spawnRunner(runnerArgs, cwd) {
  const child = spawn(process.execPath, [runner, ...runnerArgs], {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env }
  });
  child.unref();
  // Brief wait so runner can begin initializing state before watch reads it
  await new Promise(resolve => setTimeout(resolve, 400));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift() || 'help';
  if (command === 'help' || command === '--help' || command === '-h') return help();
  if (command === 'install') {
    const installArgs = args.slice();
    const explicitProject = installArgs.includes('--project');
    const target = explicitProject ? projectPath(installArgs) : (installArgs[0] ? path.resolve(installArgs[0]) : null);
    await install();
    if (target) return prepareProject(target);
    return;
  }
  if (command === 'new') return newProject(args);
  const cwd = projectPath(args);
  if (command === 'open' || command === 'init') return prepareProject(path.resolve(args[0] || cwd));
  if (command === 'watch') return watch(cwd);
  if (command === 'inspect') return inspect(cwd);
  if (command === 'doctor') return doctor(cwd);

  if (command === 'run' || command === 'start') {
    await prepareProject(cwd);
    const task = args.join(' ').trim();

    // ── Single-terminal mode ──────────────────────────────────────────────────
    // If a task is provided: spawn runner as background process, open TUI here.
    // If no task: check current phase and either resume with TUI or show status.
    if (task) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        // Integrated mode: spawn runner detached, enter live dashboard in same terminal
        process.stdout.write(
          '\n' + ANSI.bold + ANSI.primary + '  Starting ' + ANSI.reset + ANSI.hi + shorten(task, 60) + ANSI.reset + '\n' +
          ANSI.muted + '  Runner launched · opening dashboard…' + ANSI.reset + '\n'
        );
        await spawnRunner(['start', task], cwd);
        return watch(cwd);
      } else {
        // Non-TTY (pipe, CI): fall back to blocking invoke + structured output
        return printRunner(await invoke(runner, ['start', task], cwd));
      }
    }

    // No task — show current state, resume background worker and attach watch
    const state = await readState(cwd);
    if (ACTIVE_PHASES.has(state.phase) || state.phase === 'blocked_user' || state.phase === 'paused') {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        process.stdout.write(
          '\n' + ANSI.primary + '  Session active  ' + ANSI.reset + phaseColor(state.phase) + ANSI.bold + state.phase.toUpperCase() + ANSI.reset +
          '\n' + ANSI.muted + '  Resuming worker · opening dashboard…' + ANSI.reset + '\n'
        );
        await spawnRunner(['resume'], cwd);
        return watch(cwd);
      }
    }
    if (['planning', 'hands_proposing'].includes(state.phase)) return printRunner(await invoke(runner, ['propose'], cwd));
    if (state.phase === 'hands_consulting') return printRunner(await invoke(runner, ['consult'], cwd));
    if (state.phase === 'hands_executing') return printRunner(await invoke(runner, ['execute'], cwd));
    if (state.phase === 'brain_reviewing' && ['brain_autonomous', 'brain_approved'].includes(state.autonomy?.mode)) {
      return printRunner(await invoke(runner, ['review'], cwd));
    }
    return printState(state);
  }

  if (command === 'approve' || command === 'approve-auto' || command === 'brain-approve') {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      process.stdout.write(
        '\n' + ANSI.primary + '  Approving chunk · opening dashboard…' + ANSI.reset + '\n'
      );
      await spawnRunner(['approve', ...args], cwd);
      return watch(cwd);
    }
    return printRunner(await invoke(runner, ['approve', ...args], cwd));
  }

  if (command === 'revise' || command === 'steer') {
    const guidance = args.join(' ').trim();
    if (!guidance) throw new Error('bridge ' + command + ' requires guidance text.');
    if (process.stdin.isTTY && process.stdout.isTTY) {
      process.stdout.write(
        '\n' + ANSI.bold + ANSI.primary + '  Applying guidance  ' + ANSI.reset + ANSI.hi + shorten(guidance, 60) + ANSI.reset + '\n' +
        ANSI.muted + '  Runner active · opening dashboard…' + ANSI.reset + '\n'
      );
      await spawnRunner(['revise', guidance], cwd);
      return watch(cwd);
    }
    return printRunner(await invoke(runner, ['revise', guidance], cwd));
  }
  if (command === 'pause' || command === 'resume' || command === 'stop') {
    if (command === 'stop') {
      const state = await readState(cwd);
      if (state.phase === 'done' || state.phase === 'cancelled') {
        throw new Error('Stop is unavailable while the session is ' + state.phase + '.');
      }
    }
    if (command === 'resume' && process.stdin.isTTY && process.stdout.isTTY) {
      process.stdout.write(
        '\n' + ANSI.primary + '  Resuming session…' + ANSI.reset + '\n'
      );
      await spawnRunner(['resume'], cwd);
      return watch(cwd);
    }
    return printRunner(await invoke(runner, [command === 'stop' ? 'cancel' : command, ...args], cwd));
  }
  if (command === 'done') return printRunner(await invoke(runner, ['done', ...args], cwd));
  if (command === 'recover') {
    const out = await invoke(coordinator, ['recover'], cwd);
    process.stdout.write(ANSI.success + '  ✓  ' + ANSI.reset + out.trim() + '\n');
    return;
  }
  if (command === 'unlock') {
    const out = await invoke(coordinator, ['unlock'], cwd);
    process.stdout.write(ANSI.success + '  ✓  ' + ANSI.reset + out.trim() + '\n');
    return;
  }
  if (command === 'unlock-agent') {
    const out = await invoke(runner, ['unlock-agent'], cwd);
    process.stdout.write(ANSI.success + '  ✓  ' + ANSI.reset + out.trim() + '\n');
    return;
  }
  if (command === 'status') return showStatus(cwd);
  if (command === 'policy') return showPolicy(cwd);
  if (command === 'history' || command === 'logs' || command === 'log') {
    const out = await invoke(coordinator, ['log', args[0] || '20'], cwd);
    process.stdout.write(ANSI.muted + out + ANSI.reset + '\n');
    return;
  }
  throw new Error('Unknown command: ' + command);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(ANSI.error + '  Error  ' + ANSI.reset + error.message + '\n');
    process.exitCode = 1;
  });
}

module.exports = { readJsonLines, controlsFor, controlAllowed };
