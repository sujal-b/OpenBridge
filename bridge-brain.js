'use strict';

const https = require('node:https');
const http = require('node:http');
const { parseStructuredResult, runProcess, buildOpencodeArgs } = require('./bridge-adapter');
const { getActiveBrainProviderSync } = require('./bridge-config');
const latency = require('./bridge-latency');

function roundMs(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

const PROVIDERS = {
  gemini: {
    endpoint: function(model) { return 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent'; },
    buildBody: function(prompt) { return { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 1024 } }; },
    extractText: function(data) { var c = data.candidates; return c && c[0] && c[0].content && c[0].content.parts && c[0].content.parts[0] ? c[0].content.parts[0].text || '' : ''; },
    headers: function(key) { return { 'x-goog-api-key': key }; },
    defaultModel: 'gemini-2.0-flash'
  },
  openrouter: {
    endpoint: function() { return 'https://openrouter.ai/api/v1/chat/completions'; },
    buildBody: function(prompt, model) { return { model: model || 'google/gemma-3-12b-it:free', messages: [{ role: 'user', content: prompt }], max_tokens: 1024, temperature: 0.1 }; },
    extractText: function(data) { var c = data.choices; return c && c[0] && c[0].message ? c[0].message.content || '' : ''; },
    headers: function(key) { return { Authorization: 'Bearer ' + key, 'HTTP-Referer': 'mind-limb-bridge' }; },
    defaultModel: 'google/gemma-3-12b-it:free'
  },
  groq: {
    endpoint: function() { return 'https://api.groq.com/openai/v1/chat/completions'; },
    buildBody: function(prompt, model) { return { model: model || 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], max_tokens: 1024, temperature: 0.1 }; },
    extractText: function(data) { var c = data.choices; return c && c[0] && c[0].message ? c[0].message.content || '' : ''; },
    headers: function(key) { return { Authorization: 'Bearer ' + key }; },
    defaultModel: 'llama-3.1-8b-instant'
  },
  ollama: {
    endpoint: function() { return 'http://localhost:11434/api/generate'; },
    buildBody: function(prompt, model) { return { model: model || 'qwen2.5:7b', prompt: prompt, stream: false }; },
    extractText: function(data) { return data.response || ''; },
    requiresKey: false,
    defaultModel: 'qwen2.5:7b'
  },
  openai: {
    endpoint: function() { return 'https://api.openai.com/v1/chat/completions'; },
    buildBody: function(prompt, model) { return { model: model || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 1024, temperature: 0.1 }; },
    extractText: function(data) { var c = data.choices; return c && c[0] && c[0].message ? c[0].message.content || '' : ''; },
    headers: function(key) { return { Authorization: 'Bearer ' + key }; },
    defaultModel: 'gpt-4o-mini'
  },
  custom: {
    endpoint: function(model, key, config) {
      var base = (config && (config.baseURL || config.base_url || config.endpoint)) || process.env.MIND_LIMB_BRAIN_BASE_URL;
      if (!base) throw Object.assign(new Error('Custom provider requires a baseURL. Set it in .bridge/providers.json or via MIND_LIMB_BRAIN_BASE_URL'), { code: 'brain_config_error' });
      return base.replace(/\/+$/, '') + '/chat/completions';
    },
    buildBody: function(prompt, model) { return { model: model || 'bd/deepseek-v4-pro-0813', messages: [{ role: 'user', content: prompt }], max_tokens: 2048, temperature: 0.1 }; },
    extractText: function(data) {
      var c = data.choices;
      return (c && c[0] && c[0].message) ? (c[0].message.content || c[0].message.reasoning_content || '') : '';
    },
    headers: function(key) { return { Authorization: 'Bearer ' + key }; },
    defaultModel: 'bd/deepseek-v4-pro-0813'
  },
  anthropic: {
    endpoint: function() { return 'https://api.anthropic.com/v1/messages'; },
    buildBody: function(prompt, model) { return { model: model || 'claude-haiku-3-5', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }; },
    extractText: function(data) { return data.content && data.content[0] ? data.content[0].text || '' : ''; },
    headers: function(key) { return { 'x-api-key': key, 'anthropic-version': '2023-06-01' }; },
    defaultModel: 'claude-haiku-3-5'
  },
  zen: {
    viaOpencode: true,
    requiresKey: false,
    defaultModel: 'opencode/muse-spark-1.3-contributor-free'
  }
};

function loadBrainConfig(cwd) {
  try {
    var raw = require('node:fs').readFileSync(require('node:path').join(cwd || process.cwd(), '.bridge', 'brain.json'), 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, '').trim());
  } catch (e) { return {}; }
}

function resolveConfig(options) {
  options = options || {};
  var providerConfig = getActiveBrainProviderSync(options.cwd);
  var legacyConfig = loadBrainConfig(options.cwd);
  var config = (providerConfig && providerConfig.config) || (providerConfig ? {} : legacyConfig) || {};
  var provider = options.provider || config.provider || (providerConfig && providerConfig.name) || process.env.MIND_LIMB_BRAIN_PROVIDER || (config.baseURL || config.base_url ? 'custom' : null);
  if (!provider) throw Object.assign(new Error('No Brain provider configured. Run: bridge config brain add <provider>'), { code: 'brain_config_error' });
  var spec = PROVIDERS[provider];
  if (!spec) throw Object.assign(new Error('Unknown Brain provider: ' + provider + '. Valid: ' + Object.keys(PROVIDERS).join(', ')), { code: 'brain_config_error' });
  var model = options.model || config.model || process.env.MIND_LIMB_BRAIN_MODEL || spec.defaultModel;
  var apiKey = options.apiKey || config.api_key || config.apiKey || process.env.MIND_LIMB_BRAIN_API_KEY || process.env.BRAIN_API_KEY || process.env.GEMINI_API_KEY || '';
  if (!apiKey && spec.requiresKey !== false && !spec.viaOpencode) throw Object.assign(new Error('Brain API key not set. Set MIND_LIMB_BRAIN_API_KEY or configure .bridge/providers.json'), { code: 'brain_config_error' });
  // Explicit env previously lost to stored config on every opened project
  // (see docs P1-5): config.timeout_ms is always written by `bridge open`, so
  // MIND_LIMB_BRAIN_TIMEOUT_MS could never take effect.
  var timeoutMs = options.timeoutMs
    || Number(process.env.MIND_LIMB_BRAIN_TIMEOUT_MS)
    || config.timeout_ms
    || config.timeoutMs
    || 60000;
  return { spec: spec, model: model, apiKey: apiKey, timeoutMs: timeoutMs, provider: provider, config: config };
}

// Short classification calls should not be able to stall a chunk for minutes.
// Per-call env knobs let a slow local router be tuned without weakening the
// proposal review.
function callTimeoutMs(options, call) {
  var perCall = Number(process.env['MIND_LIMB_BRAIN_' + call.toUpperCase() + '_TIMEOUT_MS']);
  return Number(options && options.timeoutMs)
    || Number(process.env.MIND_LIMB_BRAIN_TIMEOUT_MS)
    || (Number.isFinite(perCall) && perCall > 0 ? perCall : null);
}

function httpPost(url, body, extraHeaders, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var urlObj = new URL(url);
    var isHttp = urlObj.protocol === 'http:';
    var lib = isHttp ? http : https;
    var bodyStr = JSON.stringify(body);
    var baseHeaders = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) };
    var reqHeaders = Object.assign(baseHeaders, extraHeaders || {});

    var startedAt = latency.now();
    var dnsMs = null;
    var connectMs = null;
    var ttfbMs = null;
    var spanDone = false;
    function recordHttpSpan(extra) {
      if (spanDone) return;
      spanDone = true;
      latency.record('brain.http', latency.now() - startedAt, {
        kind: 'http',
        host: urlObj.hostname,
        ok: Boolean(extra && extra.ok),
        dns_ms: roundMs(dnsMs),
        connect_ms: roundMs(connectMs),
        ttfb_ms: roundMs(ttfbMs),
        status: extra && extra.status !== undefined ? extra.status : null,
        request_bytes: Buffer.byteLength(bodyStr),
        response_bytes: extra && extra.responseBytes !== undefined ? extra.responseBytes : null,
        ...(extra && extra.error ? { error: String(extra.error).slice(0, 200) } : {})
      });
    }

    var req = lib.request({ method: 'POST', hostname: urlObj.hostname, port: urlObj.port || (isHttp ? 80 : 443), path: urlObj.pathname + urlObj.search, headers: reqHeaders }, function(res) {
      ttfbMs = latency.now() - startedAt;
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('error', function(err) {
        clearTimeout(timer);
        req.destroy();
        recordHttpSpan({ ok: false, error: err && err.message, responseBytes: Buffer.byteLength(data) });
        reject(Object.assign(err, { code: err.code || 'brain_api_failed' }));
      });
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          var retryAfterMs = Number(res.headers['retry-after']);
          var err = Object.assign(new Error('Brain API HTTP ' + res.statusCode + ': ' + data.slice(0, 300)), { code: 'brain_api_failed', statusCode: res.statusCode });
          if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) err.retryAfterMs = retryAfterMs * 1000;
          recordHttpSpan({ ok: false, status: res.statusCode, error: 'HTTP ' + res.statusCode, responseBytes: Buffer.byteLength(data) });
          reject(err);
        } else {
          try {
            var text = data.trim();
            var jsonMatch = text.match(/\{[\s\S]*\}/);
            var parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
            recordHttpSpan({ ok: true, status: res.statusCode, responseBytes: Buffer.byteLength(data) });
            resolve(parsed);
          }
          catch (e) {
            recordHttpSpan({ ok: false, status: res.statusCode, error: 'invalid JSON', responseBytes: Buffer.byteLength(data) });
            reject(Object.assign(new Error('Brain API returned invalid JSON: ' + data.slice(0, 200)), { code: 'brain_api_failed' }));
          }
        }
      });
    });
    req.on('socket', function(socket) {
      socket.once('lookup', function() { dnsMs = latency.now() - startedAt; });
      socket.once('connect', function() { connectMs = latency.now() - startedAt; });
    });
    req.on('error', function(err) {
      recordHttpSpan({ ok: false, error: err && err.message });
      reject(Object.assign(err, { code: err.code || 'brain_api_failed' }));
    });
    var timer = setTimeout(function() {
      req.destroy();
      recordHttpSpan({ ok: false, error: 'timeout after ' + timeoutMs + 'ms' });
      reject(Object.assign(new Error('Brain API timed out after ' + Math.round(timeoutMs / 1000) + 's'), { code: 'brain_api_timeout' }));
    }, timeoutMs);
    timer.unref();
    req.write(bodyStr);
    req.end();
  });
}

async function httpPostWithRetry(url, body, extraHeaders, timeoutMs) {
  const maxAttempts = 3;
  const startedAt = latency.now();
  let backoffTotalMs = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      const value = await httpPost(url, body, extraHeaders, timeoutMs);
      latency.record('brain.retry', latency.now() - startedAt, {
        kind: 'http', ok: true, attempts: attempt, backoff_ms: roundMs(backoffTotalMs)
      });
      return value;
    } catch (error) {
      const retryable = error.code === 'brain_api_timeout' ||
        (error.statusCode !== undefined && (error.statusCode === 429 || error.statusCode >= 500));
      if (!retryable || attempt >= maxAttempts) {
        latency.record('brain.retry', latency.now() - startedAt, {
          kind: 'http', ok: false, attempts: attempt, backoff_ms: roundMs(backoffTotalMs),
          status: error.statusCode !== undefined ? error.statusCode : null,
          error: String(error.message || '').slice(0, 160)
        });
        throw error;
      }
      // A server-supplied Retry-After is honoured verbatim; our own exponential
      // backoff is jittered. Without jitter every chunk retries in lockstep, so
      // a briefly overloaded provider gets a synchronised thundering herd and
      // then sits idle until the next wave arrives.
      const baseBackoffMs = Math.min(error.retryAfterMs || 1000 * Math.pow(2, attempt - 1), 30000);
      const backoffMs = error.retryAfterMs
        ? baseBackoffMs
        : Math.round(baseBackoffMs * (0.5 + Math.random() * 0.5));
      backoffTotalMs += backoffMs;
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
}

function extractBrainText(stdout) {
  var source = String(stdout || '').replace(/^\uFEFF/, '').trim();
  if (!source) return '';
  var texts = [];
  var lines = source.split(/\r?\n/).map(function(l) { return l.trim(); }).filter(Boolean);
  for (var i = 0; i < lines.length; i++) {
    try {
      var evt = JSON.parse(lines[i]);
      var stack = [evt];
      var seen = 0;
      while (stack.length && seen < 100) {
        var cur = stack.pop();
        seen++;
        if (typeof cur === 'string') {
          if (cur.trim().length > 0 && cur.trim().length < 200000) texts.push(cur.trim());
          continue;
        }
        if (!cur || typeof cur !== 'object') continue;
        if (Array.isArray(cur)) {
          for (var k = 0; k < cur.length; k++) stack.push(cur[k]);
          continue;
        }
        if (typeof cur.type === 'string' && /tool|function|step/i.test(cur.type)) continue;
        var keys = ['text', 'content', 'message', 'output', 'result', 'part', 'data', 'value'];
        for (var j = 0; j < keys.length; j++) {
          if (cur[keys[j]] !== undefined) stack.push(cur[keys[j]]);
        }
      }
    } catch (e) {
      texts.push(lines[i]);
    }
  }
  if (!texts.length) texts.push(source);
  var joined = texts.join('\n').trim();
  return joined.slice(0, 20000);
}

async function callBrainViaOpencode(prompt, options, resolved) {
  var cwd = (options && options.cwd) || process.cwd();
  var timeoutMs = resolved.timeoutMs || 60000;
  var model = resolved.model || 'opencode/muse-spark-1.3-contributor-free';
  var command = process.env.MIND_LIMB_OPENCODE_COMMAND || 'opencode';
  var runProcessFn = (options && options.runProcess) || runProcess;
  var args = buildOpencodeArgs(prompt, { agent: 'brain', cwd: cwd, model: model });
  var result = await runProcessFn(command, args, { cwd: cwd, timeoutMs: timeoutMs });
  if (!result || !result.ok) {
    var raw = ((result && (result.stderr || result.stdout)) || 'Brain opencode subprocess failed').trim();
    var detail = raw.length > 1000 ? raw.slice(0, 1000) : raw;
    throw Object.assign(new Error('Brain opencode failed: ' + detail), { code: 'brain_api_failed' });
  }
  var text = extractBrainText(result.stdout);
  if (!text) throw Object.assign(new Error('Brain opencode returned empty output'), { code: 'brain_api_failed' });
  return text;
}

async function callBrainInner(prompt, options) {
  var resolved = resolveConfig(options);
  var spec = resolved.spec; var model = resolved.model; var apiKey = resolved.apiKey; var timeoutMs = resolved.timeoutMs;
  if (spec.viaOpencode || resolved.provider === 'zen') {
    return callBrainViaOpencode(prompt, options || {}, resolved);
  }
  var url = typeof spec.endpoint === 'function' ? spec.endpoint(model, apiKey, resolved.config) : spec.endpoint;
  var body = spec.buildBody(prompt, model);
  var extraHeaders = typeof spec.headers === 'function' ? spec.headers(apiKey) : {};
  var data = await httpPostWithRetry(url, body, extraHeaders, timeoutMs);
  return spec.extractText(data);
}

async function callBrain(prompt, options) {
  var label = (options && options.brainCall) || 'call';
  var span = latency.startSpan('brain.' + label, { kind: 'http' });
  try {
    var text = await callBrainInner(prompt, options);
    span.end({
      prompt_bytes: Buffer.byteLength(String(prompt)),
      response_bytes: Buffer.byteLength(String(text))
    });
    return text;
  } catch (error) {
    span.fail(error, { prompt_bytes: Buffer.byteLength(String(prompt)) });
    throw error;
  }
}

function parseBrainJson(text) {
  if (!text) return null;
  var src = String(text).replace(/^\uFEFF/, '').trim();
  try { return JSON.parse(src); } catch (e) {}
  var match = src.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (e) {}
  }
  try { return parseStructuredResult(text); } catch (e) { return null; }
}

async function brainConsultChunk(state, options) {
  var parts = [
    'You are Brain, the senior architect. Review this HANDS implementation chunk before execution.',
    'Task: ' + state.task,
    'Assignment ID: ' + state.assignment_id,
    'Revision: ' + state.revision,
    'Chunk: ' + state.approach.summary,
    'Files: ' + state.approach.files.join(', '),
    'Style: ' + (state.approach.style || 'standard'),
    'Risks: ' + (Array.isArray(state.approach.risks) ? state.approach.risks.join(', ') : ''),
    'Assumptions: ' + (Array.isArray(state.approach.assumptions) ? state.approach.assumptions.join(', ') : ''),
    '',
    'Set approved to true if safe, false to reject.',
    'Return JSON only, no prose. Schema: {"approved":true,"guidance":"notes max 300 chars","concerns":[]}'
  ];
  var text = await callBrain(parts.join('\n'), { ...(options || {}), brainCall: 'consult', timeoutMs: callTimeoutMs(options, 'consult') });
  var result = parseBrainJson(text);
  if (!result || result.approved !== true && result.approved !== false) {
    throw Object.assign(new Error('Brain consult returned no valid decision: ' + text.slice(0, 300)), { code: 'brain_api_failed' });
  }
  if (result.approved === false) {
    var rc = Array.isArray(result.concerns) && result.concerns.length ? result.concerns.join('; ') : '';
    throw Object.assign(new Error('Brain rejected the chunk' + (rc ? ': ' + rc : '.')), { code: 'brain_rejected', brainResult: result });
  }
  return { guidance: String(result.guidance || 'Proceed with the approved chunk as specified.').slice(0, 600), concerns: Array.isArray(result.concerns) ? result.concerns : [] };
}

async function brainReviewProposal(state, options) {
  var parts = [
    'You are Brain, the senior architect. Review this HANDS proposal.',
    'Task: ' + state.task,
    'Assignment ID: ' + state.assignment_id,
    'Revision: ' + state.revision,
    'Role: ' + ((state.approach && state.approach.role) || 'engineer'),
    'Proposal: ' + JSON.stringify(state.approach),
    '',
    'Approve safe bounded reviewable work. Decision: approved, revise, or escalate.',
    'Return JSON only, no prose. Schema: {"decision":"approved","summary":"short reason","feedback":"guidance if revise"}'
  ];
  var text = await callBrain(parts.join('\n'), { ...(options || {}), brainCall: 'proposal_review', timeoutMs: callTimeoutMs(options, 'proposal_review') });
  var result = parseBrainJson(text);
  if (!result) {
    throw Object.assign(new Error('Brain proposal review returned no valid JSON: ' + text.slice(0, 300)), { code: 'brain_api_failed' });
  }
  return result;
}

async function brainReviewResult(state, execution, evaluation, options) {
  var parts = [
    'You are Brain, the senior architect. Review HANDS execution result.',
    'Task: ' + state.task,
    'Approved chunk: ' + JSON.stringify(state.approach),
    'Execution: ' + JSON.stringify(execution),
    'Evaluation: ' + JSON.stringify(evaluation),
    '',
    'Decision: continue (more work), complete (task done), revise (bounded fix), escalate (security only).',
    'Return JSON only, no prose. Schema: {"decision":"complete","summary":"short reason","feedback":"next action"}'
  ];
  var text = await callBrain(parts.join('\n'), { ...(options || {}), brainCall: 'result_review', timeoutMs: callTimeoutMs(options, 'result_review') });
  var result = parseBrainJson(text);
  if (!result) {
    throw Object.assign(new Error('Brain result review returned no valid JSON: ' + text.slice(0, 300)), { code: 'brain_api_failed' });
  }
  return result;
}

module.exports = { callBrain, brainConsultChunk, brainReviewProposal, brainReviewResult, resolveConfig, PROVIDERS };