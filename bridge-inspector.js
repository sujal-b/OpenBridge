'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { runProcess } = require('./bridge-adapter');

const CONTROL_COMMANDS = new Set(['approve', 'revise', 'done', 'pause', 'resume', 'stop', 'recover']);
const SESSION_PHASES = new Set([
  'idle', 'planning', 'hands_proposing', 'brain_approving', 'hands_consulting', 'hands_executing', 'brain_reviewing', 'blocked_user', 'paused', 'done', 'cancelled'
]);
const root = __dirname;

function allowedControls(state) {
  if (!state || typeof state !== 'object') return [];
  const { phase, recovery_required: recoveryRequired, resume_phase: resumePhase, block_kind: blockKind } = state;
  if (!SESSION_PHASES.has(phase)) return [];
  const autonomous = ['brain_autonomous', 'brain_approved'].includes(state.autonomy?.mode);
  const consultationRetry = phase === 'blocked_user' && blockKind === 'consultation_retry';
  return [
    phase === 'brain_approving' && !autonomous && 'approve',
    ((phase === 'brain_approving' || phase === 'brain_reviewing') ? !autonomous : (phase === 'blocked_user' && !recoveryRequired && !consultationRetry && ['planning', 'hands_proposing', 'hands_consulting'].includes(resumePhase))) && 'revise',
    phase === 'brain_reviewing' && !autonomous && 'done',
    ['planning', 'hands_proposing', 'brain_approving', 'hands_consulting', 'brain_reviewing', 'blocked_user'].includes(phase) && 'pause',
    ['paused', 'blocked_user'].includes(phase) && !recoveryRequired && !['needs_revision', 'escalation'].includes(blockKind) && 'resume',
    !['hands_executing', 'done', 'cancelled'].includes(phase) && 'stop',
    (phase === 'hands_executing' || (phase === 'blocked_user' && recoveryRequired)) && 'recover'
  ].filter(Boolean);
}

function controlAllowed(action, state) {
  return allowedControls(state).includes(action);
}

function sourcePath(projectRoot, name) {
  return path.join(projectRoot, '.bridge', name);
}

async function readSource(file, maxBytes = 512 * 1024) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(Number(stat.size - start));
    if (buffer.length) await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    const truncated = start > 0;
    if (truncated) {
      const firstBreak = text.indexOf('\n');
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : '';
    }
    return { available: true, text, truncated };
  } catch (error) {
    if (error.code === 'ENOENT') return { available: false, error: 'File not found.' };
    return { available: false, error: error.message };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}
function parseJsonLines(text, source) {
  const lines = text.split(/\r?\n/);
  const complete = text.endsWith('\n') || text.endsWith('\r');
  const values = [];
  const warnings = [];
  const last = complete ? lines.length : lines.length - 1;
  for (let index = 0; index < last; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      warnings.push({ source, type: 'malformed', line: index + 1, message: 'Malformed JSON ignored.' });
    }
  }
  return { values, warnings };
}

async function readSnapshot(projectRoot = process.cwd()) {
  const cwd = path.resolve(projectRoot);
  const files = {
    state: sourcePath(cwd, 'state.json'),
    events: sourcePath(cwd, 'events.jsonl'),
    actions: sourcePath(cwd, 'actions.jsonl')
  };
  const [stateSource, eventsSource, actionsSource] = await Promise.all([
    readSource(files.state, 128 * 1024),
    readSource(files.events, 512 * 1024),
    readSource(files.actions, 512 * 1024)
  ]);
  const warnings = [];
  const state = stateSource.available
    ? (() => {
      try {
        return JSON.parse(stateSource.text);
      } catch {
        warnings.push({ source: 'state.json', type: 'malformed', message: 'Malformed JSON; state is unavailable.' });
        return null;
      }
    })()
    : null;
  if (!stateSource.available) warnings.push({ source: 'state.json', type: 'missing', message: stateSource.error });

  const events = eventsSource.available ? parseJsonLines(eventsSource.text, 'events.jsonl') : { values: [], warnings: [] };
  const actions = actionsSource.available ? parseJsonLines(actionsSource.text, 'actions.jsonl') : { values: [], warnings: [] };
  warnings.push(...events.warnings, ...actions.warnings);
  if (eventsSource.truncated) warnings.push({ source: 'events.jsonl', type: 'truncated', message: 'Showing the newest events only.' });
  if (actionsSource.truncated) warnings.push({ source: 'actions.jsonl', type: 'truncated', message: 'Showing the newest actions only.' });
  if (!eventsSource.available) warnings.push({ source: 'events.jsonl', type: 'missing', message: eventsSource.error });
  const lastErrorEvent = [...events.values].reverse().find(e => e.type === 'session_blocked' || e.type === 'action_failed' || e.status === 'error' || e.error);
  const error = (state && (state.error || state.block_reason))
    || (state && state.phase === 'blocked_user' && state.last_summary)
    || (lastErrorEvent ? (lastErrorEvent.error || lastErrorEvent.summary || lastErrorEvent.reason) : null);

  return {
    project: cwd,
    generated_at: new Date().toISOString(),
    state,
    error: error || null,
    controls: allowedControls(state),
    events: events.values,
    actions: actions.values,
    warnings,
    files: {
      state: { path: files.state, available: stateSource.available },
      events: { path: files.events, available: eventsSource.available },
      actions: { path: files.actions, available: actionsSource.available }
    }
  };
}

function snapshotKey(snapshot) {
  const signature = values => {
    const last = values[values.length - 1] || {};
    return { length: values.length, seq: last.seq ?? null, id: last.id ?? null, at: last.at ?? null };
  };
  return JSON.stringify({
    state: snapshot.state && { updated_at: snapshot.state.updated_at, event_seq: snapshot.state.event_seq, phase: snapshot.state.phase, block_reason: snapshot.state.block_reason, error: snapshot.state.error },
    error: snapshot.error,
    controls: snapshot.controls,
    events: signature(snapshot.events),
    actions: signature(snapshot.actions),
    warnings: snapshot.warnings,
    files: Object.fromEntries(Object.entries(snapshot.files).map(([key, value]) => [key, value.available]))
  });
}

function jsonResponse(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  response.end(body);
}

function textResponse(response, status, body, contentType) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  response.end(body);
}

function writeEvent(response, event, id, value) {
  try {
    if (response.destroyed || response.writableEnded) return false;
    return response.write('id: ' + id + '\n' + 'event: ' + event + '\n' + 'data: ' + JSON.stringify(value) + '\n\n');
  } catch {
    return false;
  }
}

function readBody(request, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > limit) {
        reject(new Error('Request body is too large.'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function commandFor(action, payload) {
  const command = action === 'stop' ? 'cancel' : action;
  const script = action === 'recover' ? path.join(root, 'bridge-coordinator.js') : path.join(root, 'bridge-runner.js');
  const args = [command];
  if (['approve', 'revise', 'done'].includes(action)) args.push(payload.summary || ({ approve: 'Approved from bridge inspector.', revise: 'Revision requested from bridge inspector.', done: 'Finished from bridge inspector.' }[action]));
  if (action === 'stop') args.push(payload.summary || 'Stopped from bridge inspector.');
  return { script, args };
}

async function runControl(projectRoot, action, payload = {}, options = {}) {
  const { script, args } = commandFor(action, payload);
  const processRunner = options.runProcess || runProcess;
  const result = await processRunner(process.execPath, [script, ...args], {
    cwd: projectRoot,
    timeoutMs: options.timeoutMs || 180000
  });
  if (!result.ok) throw new Error((result.stderr || result.stdout || 'Bridge control failed').trim());
  return { output: (result.stdout || '').trim() };
}

function createInspectorServer(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const inspectorFile = options.inspectorFile || path.join(root, 'inspector.html');
  const host = options.host || '127.0.0.1';
  const requestedPort = Number.isInteger(options.port) ? options.port : Number(options.port || 0);
  const intervalMs = Math.max(50, Number(options.intervalMs) || 250);
  const commandRunner = options.commandRunner || ((action, payload) => runControl(projectRoot, action, payload, options));
  const clients = new Set();
  let server;
  let timer;
  let heartbeat;
  let closed = false;
  let refreshPromise;
  let currentSnapshot;
  let currentKey;
  let version = 0;
  let controlBusy = false;

  async function refresh(force = false) {
    if (closed) return currentSnapshot;
    if (refreshPromise) {
      if (!force) return refreshPromise;
      await refreshPromise;
      return refresh(true);
    }
    const current = (async () => {
      const next = await readSnapshot(projectRoot);
      const nextKey = snapshotKey(next);
      const changed = force || nextKey !== currentKey;
      currentSnapshot = next;
      currentKey = nextKey;
      if (changed) {
        version += 1;
        for (const client of [...clients]) {
          if (!writeEvent(client, 'update', version, currentSnapshot)) {
            clients.delete(client);
            client.destroy();
          }
        }
      }
      return currentSnapshot;
    })();
    refreshPromise = current;
    try {
      return await current;
    } finally {
      if (refreshPromise === current) refreshPromise = null;
    }
  }

    async function control(action, payload = {}) {
    if (!CONTROL_COMMANDS.has(action)) {
      const error = new Error('Unknown inspector control: ' + action);
      error.statusCode = 400;
      throw error;
    }
    if (controlBusy) {
      const error = new Error('Another inspector control is already running.');
      error.statusCode = 409;
      throw error;
    }
    controlBusy = true;
    try {
      const snapshot = await readSnapshot(projectRoot);
      const phase = snapshot.state && snapshot.state.phase;
      if (!snapshot.state) {
        const error = new Error('No valid bridge state is available.');
        error.statusCode = 409;
        throw error;
      }
      if (!controlAllowed(action, snapshot.state)) {
        const error = new Error(action + ' is unavailable while the session is ' + phase + '.');
        error.statusCode = 409;
        throw error;
      }
      const result = await commandRunner(action, payload, { projectRoot, phase });
      await refresh(true);
      return { action, phase, result, snapshot: currentSnapshot || await readSnapshot(projectRoot) };
    } finally {
      controlBusy = false;
    }
  }

  async function handleRequest(req, response) {
    const url = new URL(req.url || '/', 'http://' + host);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/inspector.html')) {
      try {
        const body = await fs.readFile(inspectorFile, 'utf8');
        return textResponse(response, 200, body, 'text/html; charset=utf-8');
      } catch (error) {
        return jsonResponse(response, 500, { error: 'Inspector page unavailable.', detail: error.message });
      }
    }
    if (req.method === 'GET' && url.pathname === '/inspector-control-room.js') {
      try {
        const body = await fs.readFile(path.join(root, 'inspector-control-room.js'), 'utf8');
        return textResponse(response, 200, body, 'application/javascript; charset=utf-8');
      } catch (error) {
        return jsonResponse(response, 404, { error: 'Control Room asset unavailable.', detail: error.message });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/snapshot') {
      return jsonResponse(response, 200, currentSnapshot || await readSnapshot(projectRoot));
    }
    if (req.method === 'GET' && (url.pathname === '/api/stream' || url.pathname === '/events')) {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      response.write('retry: 1000\n\n');
      if (!writeEvent(response, 'snapshot', version, currentSnapshot || await readSnapshot(projectRoot))) return response.end();
      clients.add(response);
      const remove = () => clients.delete(response);
      response.on('close', remove);
      response.on('error', remove);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/control') {
      try {
        const body = await readBody(req);
        const payload = body ? JSON.parse(body) : {};
        const result = await control(payload.action, payload);
        return jsonResponse(response, 200, { ok: true, ...result });
      } catch (error) {
        return jsonResponse(response, error.statusCode || (error instanceof SyntaxError ? 400 : 500), { ok: false, error: error.message });
      }
    }
    return jsonResponse(response, 404, { error: 'Not found.' });
  }

  async function start() {
    if (server) return controller;
    currentSnapshot = await readSnapshot(projectRoot);
    currentKey = snapshotKey(currentSnapshot);
    server = http.createServer((req, response) => {
      handleRequest(req, response).catch(error => {
        if (!response.headersSent) jsonResponse(response, 500, { error: error.message });
        else response.destroy();
      });
    });
    await new Promise((resolve, reject) => {
      const onError = error => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(requestedPort, host);
    });
    timer = setInterval(() => { void refresh(); }, intervalMs);
    heartbeat = setInterval(() => {
      for (const client of [...clients]) {
        if (!writeEvent(client, 'ping', version, {})) {
          clients.delete(client);
          client.destroy();
        }
      }
    }, 15000);
    return controller;
  }

  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearInterval(heartbeat);
    for (const client of clients) client.end();
    clients.clear();
    if (!server) return;
    await new Promise(resolve => server.close(() => resolve()));
    server = null;
  }

  const controller = {
    start,
    close,
    control,
    refresh,
    get server() { return server; },
    get url() {
      const address = server && server.address();
      const port = address && typeof address === 'object' ? address.port : requestedPort;
      return 'http://' + (host === '0.0.0.0' ? '127.0.0.1' : host) + ':' + port + '/';
    },
    get snapshot() { return currentSnapshot; },
    get controlBusy() { return controlBusy; }
  };
  return controller;
}

async function startInspectorServer(options = {}) {
  const inspector = createInspectorServer(options);
  await inspector.start();
  return inspector;
}

module.exports = {
  allowedControls,
  controlAllowed,
  createInspectorServer,
  parseJsonLines,
  readSnapshot,
  runControl,
  startInspectorServer
};
