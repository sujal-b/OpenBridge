'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const latency = require('../bridge-latency');

const cli = path.resolve(__dirname, '..', 'bridge.js');
const coordinatorPath = path.resolve(__dirname, '..', 'bridge-coordinator.js');

function git(cwd, args, expected = 0) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, expected, `git ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

function runCoordinator(cwd, args, expected = 0) {
  const result = spawnSync(process.execPath, [coordinatorPath, ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, expected, `coordinator ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

function runCli(cwd, args, env = {}, expected = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  assert.equal(result.status, expected, `${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function withTempCwd(fn) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-latency-'));
  latency.uninstall();
  latency.setEnabled(true);
  try {
    return await fn(cwd);
  } finally {
    latency.uninstall();
    latency.setEnabled(true);
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

async function readLines(cwd) {
  const raw = await fs.readFile(latency.latencyFile(cwd), 'utf8');
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('record + flush writes spans to .bridge/latency.jsonl after install', async () => {
  await withTempCwd(async cwd => {
    latency.install(cwd);
    latency.record('phase.propose', 123.456, { kind: 'phase' });
    await latency.flush();
    const lines = await readLines(cwd);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].name, 'phase.propose');
    assert.equal(lines[0].ms, 123.46);
    assert.equal(lines[0].kind, 'phase');
    assert.equal(typeof lines[0].at, 'string');
    assert.equal(typeof lines[0].pid, 'number');
  });
});

test('records nothing before install() is called', async () => {
  await withTempCwd(async cwd => {
    // No install: this is how library consumers (tests) must behave.
    latency.record('phase.propose', 10, { kind: 'phase' });
    latency.startSpan('agent.hands').end({ ok: true });
    latency.flushSync();
    await latency.flush();
    await assert.rejects(fs.readFile(latency.latencyFile(cwd), 'utf8'), /ENOENT/);
  });
});

test('startSpan measures elapsed time and end() is idempotent', async () => {
  await withTempCwd(async cwd => {
    latency.install(cwd);
    const span = latency.startSpan('brain.consult', { kind: 'http' });
    await new Promise(resolve => setTimeout(resolve, 15));
    const first = span.end({ prompt_bytes: 500 });
    assert.ok(first);
    const second = span.end();
    assert.equal(second, null);
    await latency.flush();
    const lines = await readLines(cwd);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].ms >= 10, 'duration should cover the sleep, got ' + lines[0].ms);
    assert.equal(lines[0].prompt_bytes, 500);
    assert.equal(lines[0].ok, true);
  });
});

test('span.fail records ok:false with the error message', async () => {
  await withTempCwd(async cwd => {
    latency.install(cwd);
    const span = latency.startSpan('coord.approach', { kind: 'coord' });
    span.fail(new Error('coordinator exploded'));
    await latency.flush();
    const lines = await readLines(cwd);
    assert.equal(lines[0].ok, false);
    assert.match(lines[0].error, /coordinator exploded/);
  });
});

test('timeAsync returns the value and records a span', async () => {
  await withTempCwd(async cwd => {
    latency.install(cwd);
    const value = await latency.timeAsync('phase.execute', async () => 'done', { kind: 'phase' });
    assert.equal(value, 'done');
    await latency.flush();
    const lines = await readLines(cwd);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].name, 'phase.execute');
    assert.equal(lines[0].ok, true);
  });
});

test('timeAsync rethrows and records the failure', async () => {
  await withTempCwd(async cwd => {
    latency.install(cwd);
    await assert.rejects(
      latency.timeAsync('phase.consult', async () => { throw new Error('boom'); }),
      /boom/
    );
    await latency.flush();
    const lines = await readLines(cwd);
    assert.equal(lines[0].ok, false);
    assert.match(lines[0].error, /boom/);
  });
});

test('setEnabled(false) disables all recording', async () => {
  await withTempCwd(async cwd => {
    latency.install(cwd);
    latency.setEnabled(false);
    latency.record('phase.propose', 5, { kind: 'phase' });
    latency.flushSync();
    await latency.flush();
    await assert.rejects(fs.readFile(latency.latencyFile(cwd), 'utf8'), /ENOENT/);
  });
});

test('summarize computes count, p50, p95, extras and counter totals', async () => {
  await withTempCwd(async cwd => {
    latency.install(cwd);
    // Ten spans 10..100ms plus one 1000ms outlier.
    for (let i = 1; i <= 10; i += 1) {
      latency.record('coord.activity', i * 10, { kind: 'coord', cold_start_ms: i });
    }
    latency.record('coord.activity', 1000, { kind: 'coord', cold_start_ms: 1000 });
    latency.record('brain.http', 250, { kind: 'http', ttfb_ms: 100, attempts: 1 });
    latency.count('telemetry.dropped', 3);
    latency.count('telemetry.dropped', 4);
    await latency.flush();

    const spans = await latency.readSpans(cwd);
    const summary = latency.summarize(spans);

    const activity = summary.spans.find(s => s.name === 'coord.activity');
    assert.equal(activity.count, 11);
    assert.equal(activity.p50, 60);
    // p95 of [10,20,...,100,1000] — the outlier must show up in max, not p50.
    assert.equal(activity.max, 1000);
    assert.ok(activity.p95 >= 100, 'p95 should be >= 100, got ' + activity.p95);
    assert.ok(activity.extras.cold_start_ms);
    assert.equal(activity.extras.cold_start_ms.p50, 6);

    const http = summary.spans.find(s => s.name === 'brain.http');
    assert.equal(http.count, 1);
    assert.equal(http.extras.ttfb_ms.p50, 100);

    const dropped = summary.counters.find(c => c.name === 'telemetry.dropped');
    assert.equal(dropped.total, 7);
    assert.equal(dropped.samples, 2);
  });
});

test('summarize orders spans by total descending', async () => {
  const summary = latency.summarize([
    { name: 'fast', kind: 'phase', ms: 5 },
    { name: 'slow', kind: 'phase', ms: 500 },
    { name: 'mid', kind: 'phase', ms: 50 }
  ]);
  assert.deepEqual(summary.spans.map(s => s.name), ['slow', 'mid', 'fast']);
});

test('formatReport renders a table and handles empty input', () => {
  const empty = latency.summarize([]);
  assert.match(latency.formatReport(empty), /No spans recorded yet/);

  const summary = latency.summarize([
    { name: 'phase.propose', kind: 'phase', ms: 1200, ok: true },
    { name: 'phase.execute', kind: 'phase', ms: 21000, ok: false },
    { name: 'git.snapshot', kind: 'git', ms: 80, ok: true, under_lock: true }
  ]);
  const text = latency.formatReport(summary);
  assert.match(text, /phase\.execute/);
  assert.match(text, /21\.00s/);
  assert.match(text, /1\.20s/);
  assert.match(text, /under_lock/);
});

test('buffer cap drops spans instead of growing unbounded', async () => {
  await withTempCwd(async cwd => {
    latency.install(cwd);
    for (let i = 0; i < 4500; i += 1) {
      latency.record('spam.' + (i % 5), 1, { kind: 'phase' });
    }
    latency.flushSync();
    const lines = await readLines(cwd);
    assert.equal(lines.length, 4000);
    assert.equal(latency.getSpansDropped(), 500);
  });
});

test('readSpans tolerates corrupt lines', async () => {
  await withTempCwd(async cwd => {
    await fs.mkdir(path.join(cwd, '.bridge'), { recursive: true });
    const file = latency.latencyFile(cwd);
    await fs.writeFile(file, '{"name":"ok","ms":5}\nnot json\n{"name":"also-ok","ms":6}\n', 'utf8');
    const spans = await latency.readSpans(cwd);
    assert.equal(spans.length, 2);
  });
});

test('readSpans returns [] when the file does not exist', async () => {
  await withTempCwd(async cwd => {
    const spans = await latency.readSpans(cwd);
    assert.deepEqual(spans, []);
  });
});

// End-to-end: a real autonomous run through the CLI must leave phase, agent,
// coordinator, and git spans in .bridge/latency.jsonl — and `bridge latency`
// must render them. This is the regression guard for the instrumentation
// itself: if a refactor silently breaks a span, this test catches it.
test('e2e: autonomous run records phase, agent, coord, and git spans', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-limb-latency-e2e-'));
  try {
    runCli(cwd, ['open', cwd]);
    // Unknown provider forces brain_config_error -> fallback consultation path (no network).
    await fs.writeFile(path.join(cwd, '.bridge', 'brain.json'), JSON.stringify({ provider: '__test_noop__' }) + '\n', 'utf8');
    await fs.writeFile(path.join(cwd, 'run'), [
      "process.stdout.write(JSON.stringify({ type: 'tool.completed', tool: 'ask_codex' }) + String.fromCharCode(10));",
      "process.stdout.write(JSON.stringify({ decision: 'passed', summary: 'Focused checks pass' }) + String.fromCharCode(10));"
    ].join('\n') + '\n', 'utf8');
    git(cwd, ['init', '-q']);
    git(cwd, ['config', 'user.email', 'latency@example.invalid']);
    git(cwd, ['config', 'user.name', 'Mind-Limb Latency']);
    git(cwd, ['add', '.']);
    git(cwd, ['commit', '-qm', 'baseline']);

    runCoordinator(cwd, ['start', 'Instrument the result review']);
    runCoordinator(cwd, ['approach', 'Update the README', '--files', 'README.md']);
    runCoordinator(cwd, ['bind-session', 'latency-session']);
    runCoordinator(cwd, ['brain-approve', 'Brain approved the README chunk']);
    let state = JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'state.json'), 'utf8'));
    runCoordinator(cwd, ['consult', JSON.stringify({
      decision: 'approved',
      assignment_id: state.assignment_id,
      revision: state.revision,
      summary: 'Brain confirmed the README chunk.',
      brain_answer: 'Proceed with the approved README change.'
    })]);
    state = JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'state.json'), 'utf8'));
    runCoordinator(cwd, ['claim-execution', state.execution_lease_id]);
    await fs.writeFile(path.join(cwd, 'README.md'), '# Instrumented review\n', 'utf8');
    runCoordinator(cwd, ['complete', state.execution_lease_id, 'README chunk complete']);
    state = JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'state.json'), 'utf8'));
    assert.equal(state.phase, 'brain_reviewing');

    const result = runCli(cwd, ['run', '--project', cwd], {
      MIND_LIMB_OPENCODE_COMMAND: process.execPath,
      MIND_LIMB_AGENT_TIMEOUT_MS: '10000',
      MIND_LIMB_AGENT_RETRY_DELAY_MS: '0'
    });
    assert.match(result.stdout, /Phase: done/);
    state = JSON.parse(await fs.readFile(path.join(cwd, '.bridge', 'state.json'), 'utf8'));
    assert.equal(state.phase, 'done');

    const spans = await latency.readSpans(cwd);
    assert.ok(spans.length >= 5, 'expected at least 5 spans, got ' + spans.length);
    const names = new Set(spans.map(span => span.name));
    assert.ok(names.has('phase.reviewResult'), 'missing phase.reviewResult in ' + [...names]);
    assert.ok(
      names.has('agent.hands-evaluate') || names.has('agent.hands-consult'),
      'missing agent span in ' + [...names]
    );
    assert.ok([...names].some(name => name.startsWith('coord.')), 'missing coord spans in ' + [...names]);
    assert.ok(names.has('git.snapshot'), 'missing git.snapshot in ' + [...names]);

    // gitSnapshot is sampled BEFORE mutate() takes state.lock (H3 hoist),
    // so samples must carry under_lock:false. This locks in the fix.
    const gitSpans = spans.filter(span => span.name === 'git.snapshot');
    assert.ok(gitSpans.length >= 1);
    for (const span of gitSpans) {
      assert.equal(span.under_lock, false);
      assert.ok(typeof span.ms === 'number');
    }

    // The report command must render what was recorded.
    const report = runCli(cwd, ['latency', '--project', cwd]);
    assert.match(report.stdout, /phase\.reviewResult/);
    assert.match(report.stdout, /git\.snapshot/);
    assert.match(report.stdout, /under_lock/);
    assert.match(report.stdout, /true/);

    const json = runCli(cwd, ['latency', '--project', cwd, '--json']);
    const summary = JSON.parse(json.stdout);
    assert.ok(Array.isArray(summary.spans));
    assert.ok(summary.spans.some(s => s.name === 'phase.reviewResult'));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
