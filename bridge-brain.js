'use strict';

const https = require('node:https');
const http = require('node:http');
const { parseStructuredResult } = require('./bridge-adapter');

const PROVIDERS = {
  gemini: {
    endpoint: function(model, key) { return 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key; },
    buildBody: function(prompt) { return { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 1024 } }; },
    extractText: function(data) { var c = data.candidates; return c && c[0] && c[0].content && c[0].content.parts && c[0].content.parts[0] ? c[0].content.parts[0].text || '' : ''; },
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
      var base = (config && (config.baseURL || config.base_url || config.endpoint)) || process.env.MIND_LIMB_BRAIN_BASE_URL || 'https://router.nilovr.web.id/v1';
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
  var config = loadBrainConfig(options.cwd);
  var provider = options.provider || config.provider || process.env.MIND_LIMB_BRAIN_PROVIDER || (config.baseURL || config.base_url ? 'custom' : 'gemini');
  var spec = PROVIDERS[provider];
  if (!spec) throw Object.assign(new Error('Unknown Brain provider: ' + provider + '. Valid: ' + Object.keys(PROVIDERS).join(', ')), { code: 'brain_config_error' });
  var model = options.model || config.model || process.env.MIND_LIMB_BRAIN_MODEL || spec.defaultModel;
  var apiKey = options.apiKey || config.api_key || config.apiKey || process.env.MIND_LIMB_BRAIN_API_KEY || process.env.GEMINI_API_KEY || '';
  if (!apiKey && spec.requiresKey !== false) throw Object.assign(new Error('Brain API key not set. Set MIND_LIMB_BRAIN_API_KEY or configure .bridge/brain.json'), { code: 'brain_config_error' });
  var timeoutMs = options.timeoutMs || config.timeout_ms || 60000;
  return { spec: spec, model: model, apiKey: apiKey, timeoutMs: timeoutMs, provider: provider, config: config };
}

function httpPost(url, body, extraHeaders, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var urlObj = new URL(url);
    var isHttp = urlObj.protocol === 'http:';
    var lib = isHttp ? http : https;
    var bodyStr = JSON.stringify(body);
    var baseHeaders = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) };
    var reqHeaders = Object.assign(baseHeaders, extraHeaders || {});
    var req = lib.request({ method: 'POST', hostname: urlObj.hostname, port: urlObj.port || (isHttp ? 80 : 443), path: urlObj.pathname + urlObj.search, headers: reqHeaders }, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(Object.assign(new Error('Brain API HTTP ' + res.statusCode + ': ' + data.slice(0, 300)), { code: 'brain_api_failed', statusCode: res.statusCode }));
        } else {
          try {
            var text = data.trim();
            var jsonMatch = text.match(/\{[\s\S]*\}/);
            resolve(JSON.parse(jsonMatch ? jsonMatch[0] : text));
          }
          catch (e) { reject(Object.assign(new Error('Brain API returned invalid JSON: ' + data.slice(0, 200)), { code: 'brain_api_failed' })); }
        }
      });
    });
    req.on('error', function(err) { reject(Object.assign(err, { code: err.code || 'brain_api_failed' })); });
    var timer = setTimeout(function() { req.destroy(); reject(Object.assign(new Error('Brain API timed out after ' + Math.round(timeoutMs / 1000) + 's'), { code: 'brain_api_timeout' })); }, timeoutMs);
    timer.unref();
    req.write(bodyStr);
    req.end();
  });
}

async function callBrain(prompt, options) {
  var resolved = resolveConfig(options);
  var spec = resolved.spec; var model = resolved.model; var apiKey = resolved.apiKey; var timeoutMs = resolved.timeoutMs;
  var url = typeof spec.endpoint === 'function' ? spec.endpoint(model, apiKey, resolved.config) : spec.endpoint;
  var body = spec.buildBody(prompt, model);
  var extraHeaders = typeof spec.headers === 'function' ? spec.headers(apiKey) : {};
  var data = await httpPost(url, body, extraHeaders, timeoutMs);
  return spec.extractText(data);
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
  var text = await callBrain(parts.join('\n'), options);
  var result = parseBrainJson(text);
  if (!result || result.approved === false) {
    var rc = Array.isArray(result && result.concerns) && result.concerns.length ? result.concerns.join('; ') : (result ? '' : text.slice(0, 300));
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
  var text = await callBrain(parts.join('\n'), options);
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
  var text = await callBrain(parts.join('\n'), options);
  var result = parseBrainJson(text);
  if (!result) {
    throw Object.assign(new Error('Brain result review returned no valid JSON: ' + text.slice(0, 300)), { code: 'brain_api_failed' });
  }
  return result;
}

module.exports = { callBrain, brainConsultChunk, brainReviewProposal, brainReviewResult, resolveConfig, PROVIDERS };