#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const readline = require('node:readline');
const path = require('node:path');
const { runProcess } = require('./bridge-adapter');
const { startInspectorServer } = require('./bridge-inspector');

const bridgeRoot = __dirname;
const coordinator = path.join(bridgeRoot, 'bridge-coordinator.js');
const runner = path.join(bridgeRoot, 'bridge-runner.js');
const ANSI = { clear: '\x1b[2J\x1b[H', bold: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', reset: '\x1b[0m' };

const localAgentProfiles = {
  'hands.md': [
    '---',
    'description: Bridge execution agent. Edits only the approved chunk.',
    'mode: primary',
    'model: opencode/deepseek-v4-flash-free',
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
    'Execute only the chunk and files supplied by bridge-runner.js.',
    'Do not call ask_codex, start subagents, or broaden the approved scope.'
  ].join('\n') + '\n',
  'hands-propose.md': [
    '---',
    'description: Bridge read-only proposal agent.',
    'mode: primary',
    'model: opencode/deepseek-v4-flash-free',
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
    'Read the repository and return one small structured proposal.',
    'Do not edit files or launch tools outside the read-only permissions.'
  ].join('\n') + '\n',
  'hands-consult.md': [
    '---',
    'description: Bridge consultation gate. Calls Brain before execution.',
    'mode: primary',
    'model: opencode/deepseek-v4-flash-free',
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
    'Read the approved chunk, call ask_codex once, and return its guidance.',
    'Do not edit files or run commands.'
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
      await fs.access(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.writeFile(file, contents, 'utf8');
      created.push(name);
    }
  }
  return created;
}

async function prepareProject(cwd) {
  await invoke(coordinator, ['init'], cwd);
  const createdProfiles = await ensureLocalAgentProfiles(cwd);
  console.log('Project ready: ' + cwd);
  console.log(createdProfiles.length
    ? 'OpenCode bridge profiles ready: ' + createdProfiles.join(', ')
    : 'OpenCode bridge profiles already present.');
}
async function readState(cwd) {
  return JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'state.json'), 'utf8'));
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

function printRunner(text) {
  const value = parseRunnerOutput(text);
  const state = value.state || value;
  console.log('Phase: ' + (state.phase || 'unknown'));
  console.log('Task: ' + (state.task || '(none)'));
  if (value.result?.summary) console.log('HANDS: ' + value.result.summary);
  if (value.error) console.log('Waiting: ' + value.error);
}

function nextAction(state) {
  return {
    planning: 'HANDS is preparing a proposal',
    hands_proposing: 'HANDS is preparing a proposal',
    brain_approving: 'Waiting for Brain approval',
    hands_consulting: 'HANDS is consulting Brain before execution',
    hands_executing: 'HANDS is executing the approved chunk',
    brain_reviewing: 'Waiting for Brain review',
    blocked_user: 'Waiting for the user',
    paused: 'Paused by the user',
    done: 'Session complete',
    cancelled: 'Session stopped'
  }[state.phase] || 'Idle';
}

function displayAgent(agent) {
  if (agent === 'hands-propose') return 'HANDS · proposal';
  if (agent === 'hands-consult') return 'HANDS / Brain consultation';
  if (agent === 'hands') return 'HANDS · execution';
  if (agent === 'mind') return 'MIND · Brain';
  if (agent === 'user') return 'USER';
  return 'IDLE';
}

function shorten(value, maxWidth) {
  const text = String(value || '').replace(/\s+/g, ' ');
  return text.length > maxWidth ? text.slice(0, maxWidth - 3) + '...' : text;
}

function controlsFor(state) {
  if (state.phase === 'hands_consulting') return '[q] quit';
  if (state.phase === 'hands_executing') return '[c] recover  [q] quit';
  if (state.phase === 'blocked_user' && state.recovery_required) return '[c] recover  [s] stop  [q] quit';
  if (state.phase === 'brain_approving') return '[a] approve  [p] pause  [s] stop  [q] quit';
  if (['paused', 'blocked_user'].includes(state.phase)) return '[r] resume  [s] stop  [q] quit';
  if (['done', 'cancelled'].includes(state.phase)) return '[q] quit';
  return '[p] pause  [s] stop  [q] quit';
}

function controlAllowed(command, phase) {
  if (command === 'approve') return phase === 'brain_approving';
  if (command === 'resume') return ['paused', 'blocked_user'].includes(phase);
  if (command === 'pause') return ['planning', 'hands_proposing', 'brain_approving', 'brain_reviewing', 'blocked_user'].includes(phase);
  if (command === 'stop') return !['hands_consulting', 'hands_executing', 'done', 'cancelled'].includes(phase);
  if (command === 'recover') return phase === 'hands_executing' || phase === 'blocked_user';
  return false;
}

function renderDashboard(state, events, cwd, actions = []) {
  const activity = state.activity || { agent: state.active_agent, action: state.last_summary };
  const maxWidth = Math.max(40, Math.min(process.stdout.columns || 80, 118) - 2);
  const recent = [...events.map(event => ({ ...event, source: 'lifecycle', label: event.type })), ...actions.map(action => ({ ...action, source: 'action', label: action.kind }))]
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .slice(-10)
    .map(event => {
      const time = new Date(event.at).toLocaleTimeString();
      return shorten(`${time}  ${String(event.agent || event.active_agent || 'system').padEnd(16)} ${String(event.label || 'event').padEnd(22)} ${event.summary || ''}`, maxWidth);
    }).join('\n') || '(no activity)';
  const statusColor = ['done', 'cancelled'].includes(state.phase) ? ANSI.green : state.phase === 'blocked_user' ? ANSI.red : ANSI.cyan;
  const pulse = ['|', '/', '-', '\\'][Math.floor(Date.now() / 500) % 4];
  const lines = [
    ANSI.bold + ANSI.cyan + ' MIND-LIMB BRIDGE ' + ANSI.reset + statusColor + ' [' + pulse + ' ' + state.phase.toUpperCase() + ']' + ANSI.reset,
    ANSI.dim + ' ' + shorten(cwd, maxWidth) + ANSI.reset,
    '',
    ANSI.bold + ' TASK ' + ANSI.reset,
    ' ' + shorten(state.task || '(none)', maxWidth),
    '',
    ' Agent      ' + displayAgent(activity.agent),
    ' Now        ' + shorten(activity.action || state.last_summary, maxWidth - 12),
    ' Next       ' + shorten(nextAction(state), maxWidth - 12),
    ' Approval   ' + state.approval,
    ' Git        ' + state.git_status,
    ' Live       ' + new Date().toLocaleTimeString() + '  ' + pulse
  ];
  if (state.blocked_reason) lines.push(ANSI.yellow + ' Waiting    ' + shorten(state.blocked_reason, maxWidth - 12) + ANSI.reset);
  lines.push('', ANSI.bold + ' RECENT ACTIVITY ' + ANSI.reset, ANSI.dim + recent + ANSI.reset, '', ANSI.bold + ' ' + controlsFor(state) + ANSI.reset);
  return lines.join('\n');
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
        output = ANSI.red + 'No bridge session. Run: bridge open .' + ANSI.reset + '\n\n' + error.message;
      }
      if (notice) output += '\n\n' + ANSI.yellow + shorten(notice, 100) + ANSI.reset;
      if (frameLines) readline.moveCursor(process.stdout, 0, -frameLines);
      readline.cursorTo(process.stdout, 0);
      readline.clearScreenDown(process.stdout);
      process.stdout.write(output + '\n');
      frameLines = output.split('\n').length;
    } finally {
      rendering = false;
    }
  };  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
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
      if (!controlAllowed(command, state.phase)) {
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
  process.stdout.write('\x1b[?25l');
  await render();
  timer = setInterval(render, 1000);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', chunk => {
    const key = String(chunk).toLowerCase();
    if (key.includes('\u0003') || key.includes('q')) return cleanup();
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
  console.log('Bridge command installed in ' + bin);
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
  const checks = [];
  for (const [name, command, args] of [['Node', process.execPath, ['--version']], ['Git', 'git', ['--version']], ['OpenCode', 'opencode', ['--version']]]) {
    const result = await runProcess(command, args, { cwd, timeoutMs: 10000 });
    checks.push([name, result.ok ? 'OK ' + result.stdout.trim() : 'MISSING']);
  }
  const profileNames = ['hands.md', 'hands-propose.md', 'hands-consult.md'];
  const profileChecks = await Promise.all(profileNames.map(async name => {
    try {
      await fs.access(path.join(cwd, '.opencode', 'agents', name));
      return true;
    } catch { return false; }
  }));
  checks.push(['Profiles', profileChecks.every(Boolean) ? 'OK bridge profiles' : 'RUN bridge open .']);
  const agents = await runProcess('opencode', ['agent', 'list'], { cwd, timeoutMs: 15000 });
  checks.push(['Agents', agents.ok && agents.stdout.includes('hands') && agents.stdout.includes('hands-propose') && agents.stdout.includes('hands-consult') ? 'OK hands + hands-propose + hands-consult' : 'CHECK opencode agent list']);
  const mcp = await runProcess('opencode', ['mcp', 'list'], { cwd, timeoutMs: 15000 });
  checks.push(['MCP', mcp.ok && /ask-codex/i.test(mcp.stdout) ? 'OK ask-codex' : 'CHECK ask-codex MCP']);
  for (const [name, result] of checks) console.log(name.padEnd(10) + result);
}

function help() {
  console.log([
    'bridge — Mind-Limb workflow', '',
    '  bridge install                 Install the global bridge command',
    '  bridge open [folder]           Prepare a project',
    '  bridge run "task"              Start or continue work',
    '  bridge watch                   Open the live terminal dashboard',
    '  bridge inspect                 Start the live browser inspector',
    '  bridge approve                 Approve and execute the proposal',
    '  bridge revise "feedback"       Request a revised proposal',
    '  bridge done "summary"          Finish after review',
    '  bridge recover                 Recover an interrupted HANDS run',
    '  bridge pause | resume | stop   Control the active session',
    '  bridge status | history        Inspect state or recent activity',
    '  bridge policy                  Show the project safety policy',
    '  bridge doctor                  Check local installation', '',
    'Most commands accept: --project <folder>'
  ].join('\n'));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift() || 'help';
  if (command === 'help' || command === '--help' || command === '-h') return help();
  if (command === 'install') { const installArgs = args.slice(); const explicitProject = installArgs.includes('--project'); const target = explicitProject ? projectPath(installArgs) : (installArgs[0] ? path.resolve(installArgs[0]) : null); await install(); if (target) return prepareProject(target); return; }
  const cwd = projectPath(args);
  if (command === 'open' || command === 'init') return prepareProject(path.resolve(args[0] || cwd));
  if (command === 'watch') return watch(cwd);
  if (command === 'inspect') return inspect(cwd);
  if (command === 'doctor') return doctor(cwd);
  if (command === 'run' || command === 'start') {
    const task = args.join(' ').trim();
    if (task) return printRunner(await invoke(runner, ['start', task], cwd));
    const state = await readState(cwd);
    if (['planning', 'hands_proposing'].includes(state.phase)) return printRunner(await invoke(runner, ['propose'], cwd));
    if (state.phase === 'hands_consulting') return printRunner(await invoke(runner, ['consult'], cwd));
    if (state.phase === 'hands_executing') return printRunner(await invoke(runner, ['execute'], cwd));
    return printRunner(JSON.stringify(state));
  }
  if (command === 'approve') return printRunner(await invoke(runner, ['approve', ...args], cwd));
  if (command === 'revise') return printRunner(await invoke(runner, ['revise', args.join(' ')], cwd));
  if (command === 'pause' || command === 'resume' || command === 'stop') return printRunner(await invoke(runner, [command === 'stop' ? 'cancel' : command, ...args], cwd));
  if (command === 'done') return printRunner(await invoke(runner, ['done', ...args], cwd));
  if (command === 'recover') return console.log(await invoke(coordinator, ['recover'], cwd));
  if (command === 'status') return console.log(await invoke(coordinator, ['status'], cwd));
  if (command === 'policy') return showPolicy(cwd);
  if (command === 'history' || command === 'logs' || command === 'log') return console.log(await invoke(coordinator, ['log', args[0] || '20'], cwd));
  throw new Error('Unknown command: ' + command);
}

if (require.main === module) {
  main().catch(error => { console.error('Error: ' + error.message); process.exitCode = 1; });
}

module.exports = { readJsonLines };