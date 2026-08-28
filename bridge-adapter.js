'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fsSync = require('node:fs');


function resolveExecutable(command) {
  if (process.platform !== 'win32' || path.isAbsolute(command) || path.extname(command)) return command;
  const appData = process.env.APPDATA || path.join(require('node:os').homedir(), 'AppData', 'Roaming');
  const candidates = [
    path.join(appData, 'npm', command + '.exe'),
    path.join(appData, 'npm', 'node_modules', command + '-ai', 'bin', command + '.exe')
  ];
  return candidates.find(candidate => fsSync.existsSync(candidate)) || command;
}
function terminateProcessTree(child) {
  if (!child || !child.pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise(resolve => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('close', code => { if (code !== 0) { try { child.kill(); } catch {} } finish(); });
      killer.once('error', () => { try { child.kill(); } catch {} finish(); });
      setTimeout(finish, 2000).unref();
    });
  }
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000).unref();
  return Promise.resolve();
}

function runProcess(command, args = [], options = {}) {
  const timeoutMs = options.timeoutMs ?? 120000;
  const env = options.env ? { ...process.env, ...options.env } : process.env;
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const lineBuffers = { stdout: '', stderr: '' };
    let callbackChain = Promise.resolve();
    let timedOut = false;
    let settled = false;
    let termination = Promise.resolve();
    const child = spawn(resolveExecutable(command), args, {
      cwd: options.cwd,
      env,
      shell: false,
      windowsHide: true
    });

    function queueLine(stream, line) {
      const parsed = (() => {
        try { return JSON.parse(line); } catch { return null; }
      })();
      callbackChain = callbackChain.then(async () => {
        try {
          if (typeof options.onLine === 'function') await options.onLine(line, stream);
          if (parsed !== null && typeof options.onEvent === 'function') await options.onEvent(parsed, line, stream);
        } catch {
          // Streaming telemetry must not change process success, timeout, or parse behavior.
        }
      });
    }

    function consumeLines(stream, chunk, flush = false) {
      const carriageReturn = String.fromCharCode(13);
      const newline = String.fromCharCode(10);
      lineBuffers[stream] += chunk.toString();
      const lines = lineBuffers[stream].split(new RegExp(carriageReturn + '?' + newline));
      lineBuffers[stream] = lines.pop() || '';
      for (const line of lines) queueLine(stream, line.endsWith(carriageReturn) ? line.slice(0, -1) : line);
      if (flush && lineBuffers[stream]) {
        queueLine(stream, lineBuffers[stream].endsWith(carriageReturn) ? lineBuffers[stream].slice(0, -1) : lineBuffers[stream]);
        lineBuffers[stream] = '';
      }
    }
    const timer = setTimeout(() => {
      timedOut = true;
      termination = terminateProcessTree(child);
      const killGraceMs = Math.max(0, Number(options.killGraceMs ?? 500));
      const grace = new Promise(resolveGrace => setTimeout(resolveGrace, killGraceMs));
      Promise.race([termination, grace]).then(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, code: null, signal: 'SIGTERM', stdout, stderr, timed_out: true });
      });
    }, timeoutMs);

    child.stdout?.on('data', chunk => {
      stdout += chunk.toString();
      consumeLines('stdout', chunk);
    });
    child.stderr?.on('data', chunk => {
      stderr += chunk.toString();
      consumeLines('stderr', chunk);
    });
    child.once('error', error => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      consumeLines('stdout', '', true);
      consumeLines('stderr', '', true);
      const callbackTimeoutMs = Math.max(0, Number(options.callbackTimeoutMs ?? 1000));
      let callbackTimer;
      const callbackDeadline = new Promise(resolveCallback => {
        callbackTimer = setTimeout(resolveCallback, callbackTimeoutMs);
      });
      Promise.allSettled([termination, Promise.race([callbackChain, callbackDeadline])]).then(() => {
        clearTimeout(callbackTimer);
        if (settled) return;
        settled = true;
        resolve({
          ok: code === 0 && !timedOut,
          code,
          signal,
          stdout,
          stderr,
          timed_out: timedOut
        });
      });
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function isResult(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && typeof value.decision === 'string';
}

function parseJsonResult(text) {
  try {
    const value = JSON.parse(String(text).trim());
    return isResult(value) ? value : null;
  } catch {
    return null;
  }
}

function balancedJsonFragments(text) {
  const source = String(text);
  const fragments = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' && depth === 0) {
      const next = source.slice(index + 1).match(/\S/)?.[0];
      // A prose brace cannot start a JSON object; ignore it so it cannot hide
      // a later structured decision.
      if (next !== '"' && next !== '}') continue;
      start = index;
      depth += 1;
    } else if (character === '{' || character === '[') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' || character === ']') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        fragments.push(source.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return fragments;
}

function decisionJsonFragments(text) {
  const source = String(text);
  const fragments = [];
  const pattern = /\{\s*"decision"\s*:/g;
  let match;
  while ((match = pattern.exec(source))) {
    const fragment = balancedJsonFragments(source.slice(match.index))[0];
    if (fragment) fragments.push(fragment);
  }
  return fragments;
}

function parseTextResult(text) {
  const source = String(text).replace(/^\uFEFF/, '').trim();
  if (!source) return null;

  const direct = parseJsonResult(source);
  if (direct) return direct;

  const fence = String.fromCharCode(96);
  const fenced = source.match(new RegExp('^' + fence + '{3}(?:json)?\\s*([\\s\\S]*?)\\s*' + fence + '{3}$', 'i'));
  if (fenced) {
    const fencedResult = parseTextResult(fenced[1]);
    if (fencedResult) return fencedResult;
  }

  for (const fragment of balancedJsonFragments(source).reverse()) {
    const result = parseJsonResult(fragment);
    if (result) return result;
    try {
      const decoded = JSON.parse(fragment);
      if (typeof decoded === 'string') {
        const decodedResult = parseTextResult(decoded);
        if (decodedResult) return decodedResult;
      }
    } catch {
      // Keep scanning other fragments.
    }
  }
  for (const fragment of decisionJsonFragments(source).reverse()) {
    const result = parseJsonResult(fragment);
    if (result) return result;
  }
  return null;
}

function collectResultCandidates(value, candidates, state) {
  if (state.nodes >= state.maxNodes) return;
  state.nodes += 1;

  if (typeof value === 'string') {
    if (value.length <= state.maxStringLength) candidates.push(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (isResult(value)) candidates.push(value);
  if (Array.isArray(value)) {
    for (const item of value) collectResultCandidates(item, candidates, state);
    return;
  }

  // Check known OpenCode/Codex event envelopes first.
  const priorityKeys = ['result', 'output', 'text', 'content', 'message', 'part', 'item', 'data'];
  const keys = [...priorityKeys, ...Object.keys(value).filter(key => !priorityKeys.includes(key))];
  for (const key of keys) collectResultCandidates(value[key], candidates, state);
}

function isToolishEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.type === 'string' && /tool|function|step|error/i.test(value.type)) return true;
  return value.tool !== undefined || (value.name !== undefined && value.input !== undefined) || value.output !== undefined;
}

function parseStructuredResult(text) {
  const source = String(text);
  const candidates = [];
  const limits = { maxNodes: 250, maxStringLength: 2 * 1024 * 1024 };

  // OpenCode --format json emits JSONL event envelopes, not one final object.
  // Apply the traversal bound per event so earlier tool telemetry cannot hide
  // the final text event in a long provider stream.
  // Tool envelopes carry untrusted tool output (e.g. repo file content echoed
  // back by read/grep), so their subtrees are never scanned for decisions and
  // they also suppress the whole-source fallback, which could otherwise
  // scavenge a forged decision from the raw event text.
  let sawToolEvent = false;
  for (const line of source.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (isToolishEvent(event)) {
        sawToolEvent = true;
        continue;
      }
      collectResultCandidates(event, candidates, { nodes: 0, ...limits });
    } catch {
      candidates.push(line);
    }
  }
  if (!sawToolEvent) candidates.push(source);

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    const result = typeof candidate === 'string' ? parseTextResult(candidate) : candidate;
    if (result && isResult(result)) return result;
  }
  throw new Error('No valid structured decision object found in agent output.');
}


function extractSessionId(text) {
  const source = String(text);
  let found = null;
  const state = { nodes: 0, maxNodes: 500, maxStringLength: 2 * 1024 * 1024 };
  const visit = value => {
    if (state.nodes >= state.maxNodes || value === null || value === undefined) return;
    state.nodes += 1;
    if (typeof value === 'string') {
      const candidate = value.trim();
      if (!candidate || candidate.length > state.maxStringLength) return;
      try {
        visit(JSON.parse(candidate));
        return;
      } catch {}
      for (const fragment of balancedJsonFragments(candidate)) {
        try { visit(JSON.parse(fragment)); } catch {}
      }
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const key of ['sessionID', 'sessionId', 'session_id']) {
      const candidate = typeof value[key] === 'string' ? value[key].trim() : '';
      if (candidate && !/^session-/i.test(candidate)) found = candidate;
    }
    for (const child of Object.values(value)) visit(child);
  };
  for (const line of source.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    try { visit(JSON.parse(line)); } catch { visit(line); }
  }
  try { visit(JSON.parse(source)); } catch {}
  for (const fragment of decisionJsonFragments(source)) {
    try { visit(JSON.parse(fragment)); } catch {}
  }
  return found;
}

function buildCodexArgs(prompt, options = {}) {
  if (!prompt) throw new Error('Codex prompt is required.');
  const args = ['exec'];
  if (options.sessionId) args.push('resume', String(options.sessionId));
  if (options.model) args.push('-m', String(options.model));
  if (options.sandbox) args.push('-s', String(options.sandbox));
  if (options.cwd) args.push('-C', String(options.cwd));
  if (options.json !== false) args.push('--json');
  if (options.skipGitRepoCheck) args.push('--skip-git-repo-check');
  args.push(String(prompt));
  return args;
}

function buildOpencodeArgs(prompt, options = {}) {
  if (!prompt) throw new Error('opencode prompt is required.');
  const args = ['run', '--agent', String(options.agent || 'hands'), '--format', 'json'];
  if (options.model) args.push('--model', String(options.model));
  if (options.sessionId) args.push('--session', String(options.sessionId));
  if (options.cwd) args.push('--dir', String(options.cwd));
  args.push(String(prompt));
  return args;
}

module.exports = { runProcess, resolveExecutable, parseStructuredResult, extractSessionId, buildCodexArgs, buildOpencodeArgs };