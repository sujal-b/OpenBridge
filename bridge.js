#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const readline = require('node:readline');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { runProcess, computeMaxRunTimeoutMs } = require('./bridge-adapter');
const { startInspectorServer, allowedControls } = require('./bridge-inspector');
const { readJsonlTail, readJsonlPair } = require('./bridge-read');
const bridgeConfig = require('./bridge-config');
const latency = require('./bridge-latency');
const { renameWithRetry } = require('./bridge-atomic');

const bridgeRoot = __dirname;
const coordinator = path.join(bridgeRoot, 'bridge-coordinator.js');
const coordinatorLib = require('./bridge-coordinator');
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

if (process.env.NO_COLOR) {
  Object.keys(ANSI).forEach(k => { ANSI[k] = ''; });
}

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
  provider: 'zen',
  api_key: '',
  model: 'opencode/muse-spark-1.3-contributor-free',
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
    'model: ' + bridgeConfig.DEFAULT_HANDS_MODEL.provider + '/' + bridgeConfig.DEFAULT_HANDS_MODEL.model,
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
    'model: ' + bridgeConfig.DEFAULT_HANDS_MODEL.provider + '/' + bridgeConfig.DEFAULT_HANDS_MODEL.model,
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
    'model: ' + bridgeConfig.DEFAULT_HANDS_MODEL.provider + '/' + bridgeConfig.DEFAULT_HANDS_MODEL.model,
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
    'model: ' + bridgeConfig.DEFAULT_HANDS_MODEL.provider + '/' + bridgeConfig.DEFAULT_HANDS_MODEL.model,
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
  ].join('\n') + '\n',
  'brain.md': [
    '---',
    'description: Bridge Brain architect. Reviews proposals and chunks via opencode.',
    'mode: primary',
    'model: opencode/muse-spark-1.3-contributor-free',
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
    'You are BRAIN, the senior architect. Review HANDS proposals and chunks.',
    'Return JSON only, no prose.'
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
      || computeMaxRunTimeoutMs(process.env)
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
      if (existing.includes('opencode/deepseek-v4-flash-free') || existing.includes('oc/x-preview-f-free') || existing.includes('local-router/bd/Deepseek-V4-Flash-0731') || existing.includes('local-router/bd/deepseek')) {
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
    await rememberScaffoldFile(cwd, 'opencode.json', JSON.stringify(defaultOpencodeConfig, null, 2) + '\n');
    return true;
  }
  return false;
}

// Scaffold provenance: files the bridge itself created (opencode.json) are
// recorded with a content hash in .bridge/scaffold.json. The runner's dirty-tree
// preflight auto-commits scaffold files that are still untracked and unchanged,
// so freshly scaffolded projects never block on the bridge's own configuration
// files. User-authored files are never listed here and never auto-committed.
async function rememberScaffoldFile(cwd, relPath, contents) {
  try {
    const manifestPath = path.join(cwd, '.bridge', 'scaffold.json');
    let manifest = { version: 1, files: {} };
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      if (!manifest.files || typeof manifest.files !== 'object') manifest.files = {};
    } catch {}
    manifest.version = 1;
    manifest.files[relPath] = {
      sha256: crypto.createHash('sha256').update(String(contents)).digest('hex'),
      created_at: new Date().toISOString()
    };
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  } catch {}
}

async function ensureProvidersConfig(cwd) {
  const file = path.join(cwd, '.bridge', 'providers.json');
  try {
    await fs.access(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const initial = {
      version: bridgeConfig.MODULE_VERSION,
      brain: { active: 'zen', custom: {} },
      hands: { active: { ...bridgeConfig.DEFAULT_HANDS_MODEL } }
    };
    await fs.writeFile(file, JSON.stringify(initial, null, 2) + '\n', 'utf8');
    return true;
  }
  return false;
}

async function migrateProject(cwd, options = {}) {
  const gen = bridgeConfig.detectGenerationSync(cwd);

  if (gen.providersCorrupt) {
    throw Object.assign(new Error('Corrupt providers.json: cannot migrate invalid JSON.'), { code: 'providers_corrupt' });
  }

  // Idempotent no-op when current
  if (gen.generation === 'gen3' && !gen.isDeadDefault && gen.version === bridgeConfig.MODULE_VERSION) {
    process.stdout.write(ANSI.success + '  ✓' + ANSI.reset + '  Project is already current (gen3). No migration needed.\n');
    return { migrated: false, generation: 'gen3', backups: [] };
  }

  // Dirty working tree guard unless --force
  const gitResult = await runProcess('git', ['status', '--porcelain'], { cwd, timeoutMs: 15000 }).catch(() => null);
  if (gitResult && gitResult.ok && gitResult.stdout.trim() && !options.force) {
    throw Object.assign(new Error('Working tree is dirty. Commit or stash changes before migrating, or use --force.'), { code: 'migration_dirty_tree' });
  }

  // Active phase guard unless --force
  try {
    const state = await readState(cwd);
    if (ACTIVE_PHASES.has(state.phase) && !options.force) {
      throw Object.assign(new Error('Session is active in phase ' + state.phase + '. Stop or complete chunk before migrating, or use --force.'), { code: 'migration_active_phase' });
    }
  } catch (e) {
    if (e.code === 'migration_active_phase') throw e;
  }

  const backups = [];
  const filesToCheck = [
    path.join(cwd, '.bridge', 'brain.json'),
    path.join(cwd, '.bridge', 'providers.json'),
    path.join(cwd, 'opencode.json')
  ];
  const ts = Date.now();

  for (const file of filesToCheck) {
    try {
      await fs.access(file);
      const bak = file + '.bak.' + ts;
      if (options.dryRun) {
        process.stdout.write('[DRY RUN] Would backup: ' + file + ' -> ' + bak + '\n');
      } else {
        await fs.copyFile(file, bak);
        process.stdout.write(ANSI.muted + '  Backup created: ' + bak + ANSI.reset + '\n');
        backups.push(bak);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  if (options.dryRun) {
    process.stdout.write('[DRY RUN] Would migrate project ' + cwd + ' to canonical gen3 (active=zen, version=' + bridgeConfig.MODULE_VERSION + ')\n');
    return { migrated: true, dryRun: true, backups: [] };
  }

  if (gen.isIntentionalCustom) {
    // Intentional-custom: ensure version is written to providers.json, but DO NOT touch custom active or baseURL
    const provData = await bridgeConfig.loadProvidersJson(cwd);
    provData.version = bridgeConfig.MODULE_VERSION;
    await bridgeConfig.saveProvidersJson(cwd, provData);
    process.stdout.write(ANSI.success + '  ✓' + ANSI.reset + '  Intentional custom configuration preserved; updated version to ' + bridgeConfig.MODULE_VERSION + '.\n');
  } else {
    // Canonical migration to zen
    const provData = await bridgeConfig.loadProvidersJson(cwd);
    provData.brain.active = 'zen';
    provData.version = bridgeConfig.MODULE_VERSION;
    await bridgeConfig.saveProvidersJson(cwd, provData);

    // Update opencode.json if dead router or missing
    const ocfgPath = path.join(cwd, 'opencode.json');
    let ocfg;
    try {
      ocfg = JSON.parse(await fs.readFile(ocfgPath, 'utf8'));
    } catch {
      ocfg = defaultOpencodeConfig;
    }
    if (ocfg.provider && ocfg.provider['local-router']) {
      const lrOpts = ocfg.provider['local-router'].options;
      if (lrOpts && (/router\.nilovr\.web\.id/i.test(lrOpts.baseURL || '') || lrOpts.apiKey === 'sk-legacy-123')) {
        ocfg.provider['local-router'].options = {
          baseURL: 'http://localhost:20128/v1',
          apiKey: '{env:OPENCODE_API_KEY}'
        };
        const tmpOcfg = ocfgPath + '.tmp.' + Date.now();
        await fs.writeFile(tmpOcfg, JSON.stringify(ocfg, null, 2) + '\n', 'utf8');
        await renameWithRetry(tmpOcfg, ocfgPath);
      }
    }

    // Ensure profiles
    await ensureLocalAgentProfiles(cwd);
  }

  // Write migration event to .bridge/events.jsonl if it exists
  const eventsPath = path.join(cwd, '.bridge', 'events.jsonl');
  try {
    await fs.access(eventsPath);
    // Monotonic seq: the max lives in the tail window.
    const tail = await readJsonlTail(eventsPath, { source: 'events.jsonl', maxBytes: 64 * 1024 });
    let maxSeq = -1;
    for (const ev of tail.values) {
      if (Number.isInteger(ev.seq) && ev.seq > maxSeq) maxSeq = ev.seq;
    }
    const migrationEvent = JSON.stringify({
      seq: maxSeq + 1,
      event: 'migration',
      from: gen.generation,
      to: 'gen3',
      timestamp: new Date().toISOString(),
      backups: backups
    }) + '\n';
    await fs.appendFile(eventsPath, migrationEvent, 'utf8');
  } catch {}

  process.stdout.write(ANSI.success + '  ✓' + ANSI.reset + '  Project migrated to gen3 (active=zen).\n');
  return { migrated: true, generation: 'gen3', backups };
}

async function ensureGitignore(cwd) {
  const file = path.join(cwd, '.gitignore');
  // The bridge's own runtime dirs plus common agent tooling — their session
  // and cache data must never count as project dirt (mirrors the coordinator's
  // runtime exemption, which covers projects scaffolded before this list).
  const required = [...new Set([
    '.bridge/', '.opencode/', 'node_modules/', 'dist/',
    ...coordinatorLib.DEFAULT_RUNTIME_DIRS
  ])];
  let contents = '';
  try {
    contents = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const existing = new Set(contents.split(/\r?\n/).map(line => line.trim().replace(/\/+$/, '')));
  const missing = required.filter(entry => !existing.has(entry.replace(/\/+$/, '')));
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

async function prepareProject(cwd, options = {}) {
  const span = latency.startSpan('startup.prepare', { kind: 'phase' });
  let gitignoreUpdated = false;
  let createdProfiles = [];
  try {
    const autoMigrate = Boolean(options.autoMigrate || process.env.MIND_LIMB_BRIDGE_AUTO_MIGRATE === '1');
    const gate = bridgeConfig.enforceVersionGate(cwd, { autoMigrate: autoMigrate });
    if (gate.action === 'auto_migrate') {
      await migrateProject(cwd, options);
    } else if (gate.action === 'warn_custom') {
      process.stderr.write(ANSI.warn + '  [WARN]  ' + ANSI.reset + gate.message + '\n');
    }

    await ensureGitRepo(cwd);
    // When the store is complete the init step is pure startup tax: the
    // coordinator's ensureStore lazily completes any missing store file on the
    // next command, including crash-journal reconciliation. The readiness
    // predicate is the same four files ensureStore checks — directory
    // existence is not enough, because latency flushes create .bridge/
    // (latency.jsonl) independently of the store. For fresh or partial stores,
    // init runs in-process, concurrently with the idempotent config writes —
    // each writer creates its own directories, so there are no ordering
    // dependencies between them.
    const storeNames = ['state.json', 'events.jsonl', 'plan.md', 'policy.json'];
    const storeReady = (await Promise.all(
      storeNames.map(name => fs.access(path.join(cwd, '.bridge', name)).then(() => true, () => false))
    )).every(Boolean);
    const results = await Promise.all([
      storeReady ? Promise.resolve(null) : coordinatorLib.handleCommand(['init'], { cwd }),
      ensureGitignore(cwd),
      ensureLocalAgentProfiles(cwd),
      ensureBrainConfig(cwd),
      ensureOpencodeConfig(cwd),
      ensureProvidersConfig(cwd)
    ]);
    gitignoreUpdated = results[1];
    createdProfiles = results[2];
    span.end({});
  } catch (error) {
    span.fail(error);
    throw error;
  }
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
    '  ' + ANSI.success + '✓' + ANSI.reset + '  Providers config  .bridge/providers.json',
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

const REPAIR_COOLDOWN_MS = 5000;
let repairInFlight = null;
let repairCoolUntil = 0;

// The coordinator invocation that rebuilds a corrupt state.json. Extracted so a
// test can count repairs without spawning a 30s subprocess — this is the only
// seam. readState(cwd) keeps its signature; production callers never touch it.
const defaultRepairRunner = cwd => runProcess(process.execPath, [coordinator, 'status'], { cwd, timeoutMs: 30000 });
let repairRunner = defaultRepairRunner;
function setRepairRunner(fn) { repairRunner = fn || defaultRepairRunner; }

// Deliberately not a bare SyntaxError: while the cooldown is in effect the session
// does exist, it is unreadable. Callers key off `code` to say "corrupt, retrying"
// instead of "no session".
function repairCooldownError() {
  const error = new Error('state.json is unreadable; repair already failed and is on cooldown.');
  error.code = 'STATE_REPAIR_COOLDOWN';
  return error;
}

async function readState(cwd) {
  try {
    return JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'state.json'), 'utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    if (repairInFlight) return repairInFlight;
    if (Date.now() < repairCoolUntil) throw repairCooldownError();
    repairInFlight = (async () => {
      const result = await repairRunner(cwd);
      if (!result.ok) throw new Error((result.stderr || result.stdout || 'Coordinator command failed').trim());
      return JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'state.json'), 'utf8'));
    })();
    try {
      return await repairInFlight;
    } catch (repairError) {
      repairCoolUntil = Date.now() + REPAIR_COOLDOWN_MS;
      throw repairError;
    } finally {
      repairInFlight = null;
    }
  }
}

// Delegates to the shared tail reader (bridge-read.js) so there is exactly one
// JSONL implementation. Kept as the parameterised entry point because TUI callers
// and tests need windows other than the two fixed ones below.
async function readJsonLines(cwd, name, limit = 120, maxBytes = 256 * 1024) {
  const result = await readJsonlTail(path.join(cwd, '.bridge', name), { maxBytes, limit, source: name });
  return result.values;
}

function processAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function readRunnerPid(cwd) {
  try {
    const raw = (await fs.readFile(path.join(cwd, '.bridge', 'runner.pid'), 'utf8')).trim();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    const pid = parsed ? Number(parsed.pid) : parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function runnerIsAlive(cwd) {
  const pid = await readRunnerPid(cwd);
  if (!pid) return true;
  if (!processAlive(pid)) return false;
  // A recycled PID reports alive after the real runner is gone. A live runner
  // moves state.json at least once per provider call, so an alive pid with both
  // the pid file and the state file idle past the longest single provider call
  // (computeMaxRunTimeoutMs: execution timeout + headroom) is a recycled pid.
  const staleAfterMs = computeMaxRunTimeoutMs(process.env, { chunks: 1 });
  const age = async file => {
    try { return Date.now() - (await fs.stat(file)).mtimeMs; } catch { return null; }
  };
  const pidAge = await age(path.join(cwd, '.bridge', 'runner.pid'));
  const stateAge = await age(path.join(cwd, '.bridge', 'state.json'));
  if (pidAge === null || stateAge === null) return true;
  return !(pidAge > staleAfterMs && stateAge > staleAfterMs);
}

const TUI_EVENTS = { maxBytes: 256 * 1024, limit: 120 };
const TUI_ACTIONS = { maxBytes: 256 * 1024, limit: 160 };

async function readEvents(cwd) {
  return readJsonLines(cwd, 'events.jsonl', TUI_EVENTS.limit, TUI_EVENTS.maxBytes);
}
async function readActions(cwd) {
  return readJsonLines(cwd, 'actions.jsonl', TUI_ACTIONS.limit, TUI_ACTIONS.maxBytes);
}

function parseRunnerOutput(text) {
  try { return JSON.parse(text); } catch { return { text }; }
}

/** Colored structured output for non-TUI commands (status, pause, revise, etc.) */
function printState(stateOrText, cwd = process.cwd()) {
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
  if ((state.phase === 'hands_executing' || (state.phase === 'blocked_user' && state.recovery_required)) && hasValidInFlightChanges(state, cwd)) {
    lines.push(ANSI.primary + '  Hint: In-flight changes are within chunk scope. Run bridge recover --review to advance directly to Brain review.' + ANSI.reset);
  }
  if (value.message) lines.push(ANSI.muted + '  ' + value.message + ANSI.reset);

  lines.push('');
  process.stdout.write(lines.join('\n'));
}

/** Back-compat alias — called from invoke() return paths */
function printRunner(text, cwd = process.cwd()) { printState(text, cwd); }

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
      : state.block_kind === 'dirty_tree'
        ? 'Clean the working tree, then resume'
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

function hasValidInFlightChanges(state, cwd = process.cwd()) {
  if (state?.in_flight_scope_valid !== undefined) return Boolean(state.in_flight_scope_valid);
  if (!state) return false;
  const isRecovery = state.phase === 'hands_executing' || (state.phase === 'blocked_user' && Boolean(state.recovery_required));
  if (!isRecovery) return false;
  const scope = Array.isArray(state.attempt_scope) && state.attempt_scope.length
    ? state.attempt_scope
    : (state.approach?.files || []);
  if (!scope.length || !state.git_before) return false;

  try {
    const { execFileSync } = require('node:child_process');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (head !== state.git_before) return false;
    const statusOut = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = statusOut.split(/\r?\n/).filter(Boolean);
    const split = coordinatorLib.splitTreeLines(lines, coordinatorLib.treeIgnorePaths(cwd));
    if (!split.blocking.length) return false;
    const changed = [...new Set(split.blocking.flatMap(coordinatorLib.statusPaths))];
    if (!changed.length) return false;
    const approved = new Set(scope.map(coordinatorLib.repoPath).filter(Boolean));
    const outOfScope = changed.filter(file => !approved.has(coordinatorLib.repoPath(file)));
    return outOfScope.length === 0;
  } catch {
    return false;
  }
}

function controlsFor(state, cwd = process.cwd()) {
  const controls = allowedControls(state);
  if (['needs_revision', 'escalation'].includes(state.block_kind)) {
    return ANSI.warn + 'bridge revise "guidance"' + ANSI.reset + ANSI.muted + '  [i] steer  [s] stop  [q] quit' + ANSI.reset;
  }
  if (state.block_kind === 'consultation_retry' || state.block_kind === 'dirty_tree') {
    return ANSI.warn + 'bridge resume' + ANSI.reset + ANSI.muted + '  [r] resume  [p] pause  [s] stop  [q] quit' + ANSI.reset;
  }
  if ((state.phase === 'hands_executing' || (state.phase === 'blocked_user' && state.recovery_required)) && hasValidInFlightChanges(state, cwd)) {
    return ANSI.warn + 'bridge recover --review' + ANSI.reset + ANSI.muted + '  [c] recover  [p] pause  [s] stop  [q] quit' + ANSI.reset;
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

function renderDashboard(state, events, cwd, actions = [], runnerAlive = true) {
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
    ...actions.map(a => ({ at: a.at, agent: a.agent || 'system', label: a.kind, summary: a.path || a.summary || a.target || '' }))
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

  // Blocked reason / Runner stopped alert
  if (isActive && runnerAlive === false) {
    rows.push(boxDiv(W));
    rows.push(boxRow(ANSI.error + ANSI.bold + '⚠ RUNNER STOPPED  ' + ANSI.reset + ANSI.warn + 'Background worker exited. Check .bridge/runner.log' + ANSI.reset, W));
  } else if (state.blocked_reason) {
    rows.push(boxDiv(W));
    rows.push(boxRow(ANSI.warn + '⚠  ' + shorten(state.blocked_reason, W - 8) + ANSI.reset, W));
  }

  // Activity log
  rows.push(boxDiv(W));
  rows.push(boxRow(ANSI.bold + 'RECENT ACTIVITY' + ANSI.reset, W));
  rows.push(...activityRows);

  // Controls
  rows.push(boxDiv(W));
  rows.push(boxRow(controlsFor(state, cwd), W));
  rows.push(boxBot(W));

  return rows.join('\n');
}

function renderSessionError(error) {
  if (error && error.code === 'STATE_REPAIR_COOLDOWN') {
    return ANSI.warn + '  state.json is corrupt; repair on cooldown. Retrying.' + ANSI.reset + '\n' + ANSI.muted + '  ' + error.message + ANSI.reset;
  }
  return ANSI.error + '  No bridge session. Run: bridge open .' + ANSI.reset + '\n' + ANSI.muted + '  ' + error.message + ANSI.reset;
}

function hasWatchStateChanged(prev, current) {
  if (!prev) return true;
  return prev.stateKey !== current.stateKey
    || prev.eventCount !== current.eventCount
    || prev.actionCount !== current.actionCount
    || prev.lastEventSeq !== current.lastEventSeq
    || prev.lastActionSeq !== current.lastActionSeq
    || prev.notice !== current.notice
    || prev.runnerAlive !== current.runnerAlive;
}

async function watch(cwd) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('bridge watch needs an interactive terminal.');
  let closed = false;
  let busy = false;
  let steerActive = false;
  let timer;
  let notice = '';
  let rendering = false;
  let lastSnapshot = null;
  const render = async () => {
    if (closed || rendering) return;
    rendering = true;
    let stateChanged = false;
    const span = latency.startSpan('tui.render', { kind: 'phase' });
    try {
      let output;
      try {
        const [state, tails] = await Promise.all([
          readState(cwd),
          readJsonlPair(cwd, { events: TUI_EVENTS, actions: TUI_ACTIONS })
        ]);
        const events = tails.events.values;
        const actions = tails.actions.values;
        let runnerAlive = true;
        if (ACTIVE_PHASES.has(state.phase)) {
          runnerAlive = await runnerIsAlive(cwd);
        }
        const eventCount = events.length;
        const actionCount = actions.length;
        const snapshot = {
          stateKey: JSON.stringify(state),
          eventCount,
          actionCount,
          lastEventSeq: eventCount > 0 ? events[eventCount - 1]?.seq : null,
          lastActionSeq: actionCount > 0 ? actions[actionCount - 1]?.seq : null,
          notice,
          runnerAlive
        };
        if (hasWatchStateChanged(lastSnapshot, snapshot)) {
          stateChanged = true;
          lastSnapshot = snapshot;
        }
        output = renderDashboard(state, events, cwd, actions, runnerAlive);
      } catch (error) {
        const snapshot = {
          stateKey: 'error:' + (error && error.code) + ':' + (error && error.message),
          eventCount: 0,
          actionCount: 0,
          lastEventSeq: null,
          lastActionSeq: null,
          notice,
          runnerAlive: false
        };
        if (hasWatchStateChanged(lastSnapshot, snapshot)) {
          stateChanged = true;
          lastSnapshot = snapshot;
        }
        output = renderSessionError(error);
      }
      if (notice) output += '\n\n' + ANSI.warn + '  ' + shorten(notice, 100) + ANSI.reset;
      process.stdout.write('\x1b[H\x1b[2J' + output + '\n');
    } finally {
      rendering = false;
      if (stateChanged) {
        span.end({});
      }
    }
  };

  const onResize = () => render();
  process.stdout.on('resize', onResize);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    process.stdout.removeListener('resize', onResize);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    process.stdout.write(ANSI.reset + '\x1b[?25h\x1b[?1049l');
  };
  const onSignal = () => { cleanup(); process.exit(0); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
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
    if (steerActive || busy) return;
    steerActive = true;
    busy = true;
    clearInterval(timer);
    const rows = process.stdout.rows || 24;
    // Position cursor at bottom of screen inside alternate buffer, show cursor
    process.stdout.write('\x1b[' + (rows - 1) + ';0H\x1b[2K\x1b[?25h');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const prompt = ANSI.bold + ANSI.primary + '  Steer' + ANSI.reset + ANSI.muted + ' (guidance · Enter submit · Ctrl+C cancel): ' + ANSI.reset;

    let closedPrompt = false;
    const done = (msg) => {
      if (closedPrompt) return;
      closedPrompt = true;
      rl.close();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
      }
      process.stdout.write('\x1b[?25l');
      notice = msg;
      steerActive = false;
      busy = false;
      timer = setInterval(render, 1000);
      render();
    };

    rl.on('SIGINT', () => done('Steer cancelled.'));

    rl.question(prompt, async input => {
      if (closedPrompt) return;
      const text = (input || '').trim();
      if (text) {
        try {
          await invoke(runner, ['revise', text], cwd);
          done('Steered: ' + text);
        } catch (e) {
          done('Error steering: ' + e.message);
        }
      } else {
        done('Steer cancelled.');
      }
    });
  };

  // Enter alternate screen, hide cursor, initial render
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
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
    const gen = bridgeConfig.detectGenerationSync(cwd);
    if (gen.isLegacy) {
      process.stderr.write(ANSI.warn + '  [WARN]  Project is using ' + gen.generation + ' legacy configuration. Run: bridge config migrate' + ANSI.reset + '\n\n');
    }
    const state = await readState(cwd);
    printState(state, cwd);
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

async function showLatency(cwd, args = []) {
  const file = latency.latencyFile(cwd);
  if (args.includes('--clear')) {
    await fs.rm(file, { force: true });
    await fs.rm(file + '.1', { force: true });
    process.stdout.write('Cleared ' + file + '\n');
    return;
  }
  const spans = await latency.readSpans(cwd);
  const summary = latency.summarize(spans);
  if (args.includes('--json')) {
    const state = await readState(cwd).catch(() => null);
    summary.schema_version = state?.schema_version || bridgeConfig.MODULE_VERSION;
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return;
  }
  process.stdout.write('\n' + ANSI.bold + ANSI.primary + '  bridge latency' + ANSI.reset + '\n\n');
  process.stdout.write(latency.formatReport(summary) + '\n\n');
  process.stdout.write(ANSI.muted + '  ' + file + ANSI.reset + '\n');
  process.stdout.write(ANSI.muted + '  --json for machine-readable output, --clear to reset' + ANSI.reset + '\n\n');
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
  const profileNames = ['hands.md', 'hands-propose.md', 'hands-consult.md', 'hands-evaluate.md', 'brain.md'];
  const profileChecks = await Promise.all(profileNames.map(async n => {
    try { await fs.access(path.join(cwd, '.opencode', 'agents', n)); return true; } catch { return false; }
  }));
  const profilesOk = profileChecks.every(Boolean);
  const missingProfiles = profileNames.filter((_, i) => !profileChecks[i]);
  checks.push({ name: 'Profiles', ok: profilesOk, detail: profilesOk ? '5 bridge agents ready' : 'missing: ' + missingProfiles.join(', '), fix: profilesOk ? null : 'bridge open .' });

  // Agent list check
  const agents = await runProcess('opencode', ['agent', 'list'], { cwd, timeoutMs: 15000 });
  const agentsOk = agents.ok && ['hands', 'hands-propose', 'hands-consult', 'hands-evaluate', 'brain'].every(a => agents.stdout.includes(a));
  checks.push({ name: 'Agents', ok: agentsOk, detail: agentsOk ? 'hands · hands-propose · hands-consult · hands-evaluate · brain' : 'run: opencode agent list', fix: agentsOk ? null : 'opencode agent list' });

  // Config files
  const brainOk = await fs.access(path.join(cwd, '.bridge', 'brain.json')).then(() => true, () => false);
  checks.push({ name: 'Brain', ok: brainOk, detail: brainOk ? '.bridge/brain.json configured' : 'missing', fix: brainOk ? null : 'bridge open .' });

  const ocfgOk = await fs.access(path.join(cwd, 'opencode.json')).then(() => true, () => false);
  checks.push({ name: 'OpenCode', ok: ocfgOk, detail: ocfgOk ? 'opencode.json configured' : 'missing', fix: ocfgOk ? null : 'bridge open .' });

  // Lifecycle & Generation check
  const gen = bridgeConfig.detectGenerationSync(cwd);
  if (gen.codeTooOld) {
    checks.push({ name: 'Lifecycle', ok: false, detail: 'schema_version ' + gen.schema_version + ' > ' + bridgeConfig.MODULE_VERSION + ' (code too old)', fix: 'update mind-limb-bridge' });
  } else if (gen.isLegacy) {
    checks.push({ name: 'Lifecycle', ok: false, detail: gen.generation + ' legacy configuration detected', fix: 'bridge config migrate' });
  } else if (gen.isIntentionalCustom) {
    checks.push({ name: 'Lifecycle', ok: true, detail: 'gen3 (custom provider: ' + gen.active + ')', fix: null });
  } else {
    checks.push({ name: 'Lifecycle', ok: true, detail: 'gen3 (canonical zen)', fix: null });
  }

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
    cmd('bridge recover [--review]',   'Recover interrupted HANDS run'),
    cmd('bridge unlock',               'Remove stale coordinator lock'),
    cmd('bridge unlock-agent',         'Remove stale HANDS agent lock'),

    section('Inspect'),
    cmd('bridge status',               'Show current session state'),
    cmd('bridge history [n]',          'Show last n audit log entries'),
    cmd('bridge policy',               'Show project safety policy'),
    cmd('bridge latency [--json]',     'P50/P95 per phase from .bridge/latency.jsonl'),

    section('Config'),
    cmd('bridge config',               'Show current Brain + Hands config'),
    cmd('bridge config migrate',       'Migrate legacy project to gen3'),
    cmd('bridge config brain list',    'List available Brain providers'),
    cmd('bridge config brain add <n>', 'Add a custom Brain provider (interactive)'),
    cmd('bridge config brain rm <n>',  'Remove a custom Brain provider'),
    cmd('bridge config brain use <n>', 'Set active Brain provider'),
    cmd('bridge config hands list',    'List Hands providers from opencode.json'),
    cmd('bridge config hands add <p> <m>',  'Add a Hands model'),
    cmd('bridge config hands use <p> <m>',  'Set active Hands model'),
    '',
    ANSI.muted + '  Most commands accept:  --project <folder>' + ANSI.reset,
    ANSI.muted + '  Keyboard shortcuts in dashboard:  [i] steer  [a] approve  [p] pause  [r] resume  [s] stop  [q] quit' + ANSI.reset,
    '',
    cmd('bridge --version | -v',          'Show version number'),
    '',
  ].join('\n'));
}

// Bounded wait for a freshly spawned runner to make its first state mark. Resolves
// on the first of: state.json's updated_at changing past `previousUpdated`, the
// process dying, or the cap expiring. The cap (MIND_LIMB_RUNNER_READY_MS, default
// 5 s) exists so a hung runner still hands control to watch(), which surfaces
// failures from runner.log.
async function waitForRunnerReady(bridgeDir, pid, options = {}) {
  if (!pid) return;
  const intervalMs = options.intervalMs ?? 25;
  const envCap = Number(process.env.MIND_LIMB_RUNNER_READY_MS);
  const capMs = options.capMs ?? (envCap > 0 ? envCap : 5000);
  const stateFile = path.join(bridgeDir, 'state.json');
  const previousUpdated = options.previousUpdated ?? null;
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    if (!processAlive(pid)) break;
    try {
      const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      if (state.updated_at && state.updated_at !== previousUpdated) break;
    } catch {}
  }
}

/**
 * Spawn bridge-runner in background (detached), then return — caller enters watch() immediately.
 * The runner writes progress to .bridge/state.json which watch() polls.
 */
async function spawnRunner(runnerArgs, cwd) {
  const span = latency.startSpan('startup.spawn_runner', { kind: 'phase' });
  try {
    const bridgeDir = path.join(cwd, '.bridge');
    await fs.mkdir(bridgeDir, { recursive: true });
    // Baseline must be read before the child can write — otherwise a fast
    // runner's first mark could be mistaken for the pre-existing state.
    let previousUpdated = null;
    try {
      previousUpdated = JSON.parse(await fs.readFile(path.join(bridgeDir, 'state.json'), 'utf8')).updated_at;
    } catch {}
    const logPath = path.join(bridgeDir, 'runner.log');
    const outFd = fsSync.openSync(logPath, 'a');
    // Hoisted so the readiness poll below can see it even when spawn fails
    // (waitForRunnerReady treats null as "nothing to wait for").
    let pid = null;
    try {
      const now = new Date().toISOString();
      fsSync.writeSync(outFd, '\n--- Runner started at ' + now + ' (args: ' + runnerArgs.join(' ') + ') ---\n');
      const child = spawn(process.execPath, [runner, ...runnerArgs], {
        cwd,
        detached: true,
        stdio: ['ignore', outFd, outFd],
        env: { ...process.env }
      });
      pid = child.pid;
      if (pid) {
        fsSync.writeSync(outFd, '--- Runner PID: ' + pid + ' ---\n');
        await fs.writeFile(
          path.join(bridgeDir, 'runner.pid'),
          JSON.stringify({ pid, started_at: Date.now(), token: crypto.randomBytes(12).toString('hex') }) + '\n',
          'utf8'
        ).catch(() => {});
      }
      child.unref();
    } finally {
      fsSync.closeSync(outFd);
    }
    // Readiness poll instead of a fixed 400 ms sleep: return as soon as the
    // runner touches state.json (its first coordinator command lands) or dies.
    await waitForRunnerReady(bridgeDir, pid, { previousUpdated });
    span.end({});
  } catch (error) {
    span.fail(error);
    throw error;
  }
}

/** Prompt user for input. Returns trimmed string. */
function ask(rl, question, masked) {
  return new Promise(resolve => {
    if (masked) {
      process.stdout.write(question);
      const stdin = process.stdin;
      const wasRaw = stdin.isTTY && stdin.isRaw;
      if (stdin.isTTY) stdin.setRawMode(true);
      let value = '';
      const onData = chunk => {
        const str = String(chunk);
        for (const ch of str) {
          if (ch === '\r' || ch === '\n') {
            if (stdin.isTTY) stdin.setRawMode(wasRaw || false);
            stdin.removeListener('data', onData);
            process.stdout.write('\n');
            resolve(value.trim());
            return;
          }
          if (ch === '\u0003') { // Ctrl+C
            if (stdin.isTTY) stdin.setRawMode(wasRaw || false);
            stdin.removeListener('data', onData);
            process.stdout.write('\n');
            resolve('');
            return;
          }
          if (ch === '\u007F' || ch === '\b') {
            if (value.length > 0) {
              value = value.slice(0, -1);
              process.stdout.write('\b \b');
            }
          } else {
            value += ch;
            process.stdout.write('*');
          }
        }
      };
      stdin.on('data', onData);
    } else {
      rl.question(question, answer => resolve(answer.trim()));
    }
  });
}

async function config(cwd, args) {
  const sub = (args.shift() || 'show').toLowerCase();

  if (sub === 'show' || sub === '') {
    // ── Show current config ──────────────────────────────────────────────
    // Brain resolves to null in a project with no providers.json/brain.json/env;
    // the display must render "(none)" rather than crash on it.
    const activeBrain = (await bridgeConfig.getActiveBrainProvider(cwd)) || { name: null, builtin: false, config: null };
    const activeHandsModel = await bridgeConfig.getActiveHandsModel(cwd);

    const lines = [
      '',
      ANSI.bold + ANSI.primary + '  Bridge Config' + ANSI.reset,
      '',
      ANSI.bold + '  Brain' + ANSI.reset,
      '    Provider:  ' + ANSI.accent + (activeBrain.name || '(none)') + ANSI.reset + (activeBrain.builtin ? ANSI.muted + ' (built-in)' + ANSI.reset : ''),
      '    Model:     ' + (activeBrain.config?.model || activeBrain.config?.defaultModel || ANSI.muted + '(default)' + ANSI.reset),
    ];
    if (activeBrain.config?.api_key || activeBrain.config?.apiKey) {
      const key = String(activeBrain.config.api_key || activeBrain.config.apiKey);
      lines.push('    API Key:   ' + ANSI.muted + key.slice(0, 4) + '****' + key.slice(-4) + ANSI.reset);
    } else {
      lines.push('    API Key:   ' + ANSI.muted + '(not set)' + ANSI.reset);
    }
    if (activeBrain.config?.baseURL || activeBrain.config?.base_url || activeBrain.config?.endpoint) {
      lines.push('    Base URL:  ' + (activeBrain.config.baseURL || activeBrain.config.base_url || activeBrain.config.endpoint));
    }

    lines.push('');
    lines.push(ANSI.bold + '  Hands' + ANSI.reset);
    if (activeHandsModel) {
      lines.push('    Provider:  ' + ANSI.primary + activeHandsModel.provider + ANSI.reset);
      lines.push('    Model:     ' + activeHandsModel.model);
    } else {
      lines.push('    ' + ANSI.muted + '(no active model)' + ANSI.reset);
    }

    const handsProviders = await bridgeConfig.listHandsProviders(cwd);
    const providerNames = Object.keys(handsProviders);
    if (providerNames.length) {
      lines.push('');
      lines.push(ANSI.bold + '  Available Hands Providers' + ANSI.reset);
      for (const pName of providerNames) {
        const p = handsProviders[pName];
        const models = p.models ? Object.keys(p.models) : [];
        const isActive = activeHandsModel && activeHandsModel.provider === pName;
        const marker = isActive ? ANSI.success + ' *' + ANSI.reset : '  ';
        lines.push('    ' + marker + ' ' + ANSI.primary + pName + ANSI.reset + (models.length ? ANSI.muted + '  (' + models.join(', ') + ')' + ANSI.reset : ''));
      }
    }

    lines.push('');
    process.stdout.write(lines.join('\n'));
    return;
  }

  if (sub === 'brain') {
    const action = (args.shift() || 'list').toLowerCase();

    if (action === 'list') {
      const providers = await bridgeConfig.listBrainProviders(cwd);
      const active = await bridgeConfig.getActiveBrainProvider(cwd);
      const lines = ['', ANSI.bold + '  Brain Providers' + ANSI.reset, ''];
      for (const [name, info] of Object.entries(providers)) {
        const marker = active.name === name ? ANSI.success + ' *' + ANSI.reset : '  ';
        const tag = info.builtin ? ANSI.muted + ' (built-in)' + ANSI.reset : '';
        const model = info.config?.model ? ANSI.muted + '  ' + info.config.model : '';
        lines.push('    ' + marker + ' ' + ANSI.accent + name + ANSI.reset + tag + (model ? model + ANSI.reset : ''));
      }
      lines.push('');
      process.stdout.write(lines.join('\n'));
      return;
    }

    if (action === 'add') {
      const name = args[0];
      if (!name) throw new Error('Usage: bridge config brain add <name>');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const apiKey = await ask(rl, ANSI.bold + '  API Key: ' + ANSI.reset);
        const model = await ask(rl, ANSI.bold + '  Model: ' + ANSI.reset);
        const baseURL = await ask(rl, ANSI.bold + '  Base URL (optional, Enter to skip): ' + ANSI.reset);
        const providerConfig = { api_key: apiKey, model: model };
        if (baseURL) providerConfig.baseURL = baseURL;
        await bridgeConfig.addBrainProvider(cwd, name, providerConfig);
        process.stdout.write(ANSI.success + '  ✓  ' + ANSI.reset + 'Brain provider "' + name + '" added.\n');
      } finally {
        rl.close();
      }
      return;
    }

    if (action === 'remove') {
      const name = args[0];
      if (!name) throw new Error('Usage: bridge config brain remove <name>');
      await bridgeConfig.removeBrainProvider(cwd, name);
      process.stdout.write(ANSI.success + '  ✓  ' + ANSI.reset + 'Brain provider "' + name + '" removed.\n');
      return;
    }

    if (action === 'use') {
      const name = args[0];
      if (!name) throw new Error('Usage: bridge config brain use <name>');
      await bridgeConfig.setActiveBrainProvider(cwd, name);
      process.stdout.write(ANSI.success + '  ✓  ' + ANSI.reset + 'Active Brain provider: ' + ANSI.accent + name + ANSI.reset + '\n');
      return;
    }

    throw new Error('Unknown brain config action: ' + action + '. Use: list, add, remove, use');
  }

  if (sub === 'hands') {
    const action = (args.shift() || 'list').toLowerCase();

    if (action === 'list') {
      const providers = await bridgeConfig.listHandsProviders(cwd);
      const activeModel = await bridgeConfig.getActiveHandsModel(cwd);
      const lines = ['', ANSI.bold + '  Hands Providers (opencode.json)' + ANSI.reset, ''];
      for (const [pName, pConfig] of Object.entries(providers)) {
        const models = pConfig.models ? Object.keys(pConfig.models) : [];
        const isProviderActive = activeModel && activeModel.provider === pName;
        const marker = isProviderActive ? ANSI.success + ' *' + ANSI.reset : '  ';
        lines.push('    ' + marker + ' ' + ANSI.primary + pName + ANSI.reset);
        for (const m of models) {
          const isModelActive = activeModel && activeModel.provider === pName && activeModel.model === m;
          const mMarker = isModelActive ? ANSI.success + '   *' + ANSI.reset : '    ';
          lines.push('    ' + mMarker + ' ' + m);
        }
      }
      if (!Object.keys(providers).length) lines.push('    ' + ANSI.muted + '(no providers in opencode.json)' + ANSI.reset);
      lines.push('');
      process.stdout.write(lines.join('\n'));
      return;
    }

    if (action === 'add') {
      const provider = args[0];
      const model = args[1];
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const providerName = provider || await ask(rl, ANSI.bold + '  Provider name: ' + ANSI.reset);
        const modelName = model || await ask(rl, ANSI.bold + '  Model name: ' + ANSI.reset);
        if (!providerName || !modelName) throw new Error('Provider name and model name are required.');
        await bridgeConfig.addHandsProvider(cwd, providerName, { models: { [modelName]: { name: modelName } } });
        process.stdout.write(ANSI.success + '  ✓  ' + ANSI.reset + 'Hands model "' + modelName + '" added under "' + providerName + '".\n');
      } finally {
        rl.close();
      }
      return;
    }

    if (action === 'use') {
      const provider = args[0];
      const model = args[1];
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const providerName = provider || await ask(rl, ANSI.bold + '  Provider name: ' + ANSI.reset);
        const modelName = model || await ask(rl, ANSI.bold + '  Model name: ' + ANSI.reset);
        if (!providerName || !modelName) throw new Error('Provider name and model name are required.');
        await bridgeConfig.setActiveHandsModel(cwd, providerName, modelName);
        process.stdout.write(ANSI.success + '  ✓  ' + ANSI.reset + 'Active Hands model: ' + ANSI.primary + providerName + '/' + modelName + ANSI.reset + '\n');
      } finally {
        rl.close();
      }
      return;
    }

    throw new Error('Unknown hands config action: ' + action + '. Use: list, add, use');
  }

  if (sub === 'migrate') {
    const dryRun = args.includes('--dry-run');
    const force = args.includes('--force');
    const autoMigrate = args.includes('--auto-migrate');
    return migrateProject(cwd, { dryRun, force, autoMigrate });
  }

  throw new Error('Unknown config subcommand: ' + sub + '. Use: show, brain, hands, migrate');
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift() || 'help';
  if (command === 'help' || command === '--help' || command === '-h') return help();
  if (command === '--version' || command === '-v') {
    const pkg = JSON.parse(fsSync.readFileSync(path.join(bridgeRoot, 'package.json'), 'utf8'));
    process.stdout.write('mind-limb-bridge v' + pkg.version + '\n');
    return;
  }
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
  // CLI-side spans (startup, TUI render) join the runner/coordinator spans in
  // latency.jsonl. No-op for library requires and non-entry usage.
  latency.install(cwd);
  if (command === 'open' || command === 'init') {
    const isCheck = args.includes('--check');
    const isMigrate = args.includes('--migrate');
    const autoMigrate = args.includes('--auto-migrate');
    const targetDir = path.resolve(args.find(a => !a.startsWith('-')) || cwd);
    if (isCheck) {
      const gen = bridgeConfig.detectGenerationSync(targetDir);
      process.stdout.write('\n' + ANSI.bold + '  Project Generation: ' + ANSI.reset + ANSI.primary + gen.generation + ANSI.reset + '\n');
      process.stdout.write('  Legacy: ' + (gen.isLegacy ? ANSI.warn + 'yes' : ANSI.success + 'no') + ANSI.reset + '\n');
      process.stdout.write('  Active Brain: ' + (gen.active || '(none)') + '\n');
      if (gen.isLegacy) {
        process.stdout.write('  ' + ANSI.warn + '→ Run: bridge config migrate --project ' + targetDir + ANSI.reset + '\n\n');
      }
      return;
    }
    if (isMigrate) {
      await migrateProject(targetDir, { force: args.includes('--force') });
    }
    return prepareProject(targetDir, { autoMigrate });
  }
  if (command === 'watch') return watch(cwd);
  if (command === 'inspect') return inspect(cwd);
  if (command === 'doctor') return doctor(cwd);
  if (command === 'latency') return showLatency(cwd, args);
  if (command === 'config') return config(cwd, args);

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
    // bridge resume --commit [message]: one-step dirty-tree remedy. Flag value
    // optional; default message keeps the keystrokes minimal.
    let resumeCommitMessage;
    if (command === 'resume') {
      const flagIndex = args.indexOf('--commit');
      if (flagIndex >= 0) {
        const next = args[flagIndex + 1];
        if (next && !next.startsWith('-')) {
          resumeCommitMessage = next;
          args.splice(flagIndex, 2);
        } else {
          resumeCommitMessage = 'chore: pre-bridge checkpoint';
          args.splice(flagIndex, 1);
        }
      }
    }
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
      await spawnRunner(['resume', ...(resumeCommitMessage !== undefined ? ['--commit', resumeCommitMessage] : [])], cwd);
      return watch(cwd);
    }
    if (command === 'resume' && resumeCommitMessage !== undefined) {
      return printRunner(await invoke(runner, ['resume', '--commit', resumeCommitMessage], cwd));
    }
    return printRunner(await invoke(runner, [command === 'stop' ? 'cancel' : command, ...args], cwd));
  }
  if (command === 'done') return printRunner(await invoke(runner, ['done', ...args], cwd));
  if (command === 'recover') {
    const out = await invoke(coordinator, ['recover', ...args], cwd);
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
  process.on('uncaughtException', (err) => {
    process.stderr.write(ANSI.error + '  FATAL  ' + ANSI.reset + err.message + '\n');
    if (err.stack) process.stderr.write(err.stack + '\n');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : '';
    process.stderr.write(ANSI.error + '  FATAL  ' + ANSI.reset + msg + '\n');
    if (stack) process.stderr.write(stack + '\n');
    process.exit(1);
  });
  main().catch(error => {
    process.stderr.write(ANSI.error + '  Error  ' + ANSI.reset + error.message + '\n');
    process.exitCode = 1;
  });
}

module.exports = { readJsonLines, readState, setRepairRunner, renderSessionError, controlsFor, controlAllowed, runnerIsAlive, waitForRunnerReady, spawnRunner, hasWatchStateChanged, hasValidInFlightChanges };
