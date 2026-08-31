'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { renameWithRetry } = require('./bridge-atomic');

var MODULE_VERSION = 1;
var PROVIDERS_DIR = '.bridge';
var PROVIDERS_FILE = 'providers.json';
var LEGACY_BRAIN_FILE = 'brain.json';
var OPENCODE_FILE = 'opencode.json';

var BUILTIN_BRAIN_PROVIDERS = Object.freeze(['gemini', 'openrouter', 'groq', 'ollama', 'openai', 'anthropic']);

var BRAIN_CONFIG_FIELDS = ['api_key', 'apiKey', 'model', 'baseURL', 'base_url', 'endpoint', 'timeout_ms'];

function emptyProviders() {
  return { brain: { active: null, custom: {} }, hands: { active: null } };
}

function loadProvidersJson(cwd) {
  var filePath = path.join(cwd || process.cwd(), PROVIDERS_DIR, PROVIDERS_FILE);
  return fs.readFile(filePath, 'utf8').then(function(raw) {
    try {
      var data = JSON.parse(raw.replace(/^\uFEFF/, '').trim());
      if (!data || typeof data !== 'object') return emptyProviders();
      if (!data.brain || typeof data.brain !== 'object') data.brain = { active: null, custom: {} };
      if (!data.brain.custom || typeof data.brain.custom !== 'object') data.brain.custom = {};
      if (!data.hands || typeof data.hands !== 'object') data.hands = { active: null };
      return data;
    } catch (e) {
      throw Object.assign(new Error('Corrupt providers.json: ' + e.message), { code: 'providers_corrupt' });
    }
  }).catch(function(err) {
    if (err.code === 'ENOENT') return emptyProviders();
    throw err;
  });
}

function saveProvidersJson(cwd, data) {
  var dirPath = path.join(cwd || process.cwd(), PROVIDERS_DIR);
  var filePath = path.join(dirPath, PROVIDERS_FILE);
  var tmpPath = filePath + '.tmp.' + Date.now() + '.' + Math.random().toString(36).slice(2, 8);
  var json = JSON.stringify(data, null, 2) + '\n';
  return fs.mkdir(dirPath, { recursive: true }).then(function() {
    return fs.writeFile(tmpPath, json, 'utf8');
  }).then(function() {
    return renameWithRetry(tmpPath, filePath);
  }).catch(function(err) {
    return fs.unlink(tmpPath).catch(function() {}).then(function() { throw err; });
  });
}

function listBrainProviders(cwd) {
  return loadProvidersJson(cwd).then(function(data) {
    var result = {};
    BUILTIN_BRAIN_PROVIDERS.forEach(function(name) {
      result[name] = { builtin: true };
    });
    var custom = data.brain && data.brain.custom || {};
    Object.keys(custom).forEach(function(name) {
      result[name] = Object.assign({ builtin: false }, custom[name]);
    });
    return result;
  });
}

function getBrainProvider(cwd, name) {
  if (!name || typeof name !== 'string') {
    throw Object.assign(new Error('Provider name is required'), { code: 'providers_invalid_name' });
  }
  return loadProvidersJson(cwd).then(function(data) {
    if (BUILTIN_BRAIN_PROVIDERS.includes(name)) {
      return { name: name, builtin: true, config: data.brain.custom[name] || null };
    }
    var custom = data.brain && data.brain.custom || {};
    if (!custom[name]) {
      throw Object.assign(new Error('Brain provider not found: ' + name), { code: 'providers_not_found' });
    }
    return { name: name, builtin: false, config: custom[name] };
  });
}

function addBrainProvider(cwd, name, config) {
  if (!name || typeof name !== 'string') {
    throw Object.assign(new Error('Provider name is required'), { code: 'providers_invalid_name' });
  }
  if (BUILTIN_BRAIN_PROVIDERS.includes(name)) {
    throw Object.assign(new Error('Cannot override built-in provider: ' + name), { code: 'providers_builtin_protected' });
  }
  var validation = validateProviderConfig(name, config);
  if (!validation.valid) {
    throw Object.assign(new Error('Invalid provider config: ' + validation.errors.join(', ')), { code: 'providers_invalid_config' });
  }
  return loadProvidersJson(cwd).then(function(data) {
    data.brain.custom[name] = config;
    return saveProvidersJson(cwd, data);
  });
}

function removeBrainProvider(cwd, name) {
  if (!name || typeof name !== 'string') {
    throw Object.assign(new Error('Provider name is required'), { code: 'providers_invalid_name' });
  }
  if (BUILTIN_BRAIN_PROVIDERS.includes(name)) {
    throw Object.assign(new Error('Cannot remove built-in provider: ' + name), { code: 'providers_builtin_protected' });
  }
  return loadProvidersJson(cwd).then(function(data) {
    if (!data.brain.custom[name]) {
      throw Object.assign(new Error('Brain provider not found: ' + name), { code: 'providers_not_found' });
    }
    delete data.brain.custom[name];
    if (data.brain.active === name) data.brain.active = null;
    return saveProvidersJson(cwd, data);
  });
}

function getActiveBrainProvider(cwd) {
  return loadProvidersJson(cwd).then(function(data) {
    var activeName = data.brain.active;
    if (activeName && data.brain.custom[activeName]) {
      return { name: activeName, builtin: BUILTIN_BRAIN_PROVIDERS.includes(activeName), config: data.brain.custom[activeName] };
    }
    if (activeName && BUILTIN_BRAIN_PROVIDERS.includes(activeName)) {
      return { name: activeName, builtin: true, config: null };
    }
    return loadLegacyBrainConfig(cwd).then(function(legacy) {
      if (legacy && legacy.provider) {
        return { name: legacy.provider, builtin: BUILTIN_BRAIN_PROVIDERS.includes(legacy.provider), config: legacy };
      }
      return { name: 'gemini', builtin: true, config: null };
    });
  });
}

function setActiveBrainProvider(cwd, name) {
  if (!name || typeof name !== 'string') {
    throw Object.assign(new Error('Provider name is required'), { code: 'providers_invalid_name' });
  }
  return loadProvidersJson(cwd).then(function(data) {
    var isBuiltin = BUILTIN_BRAIN_PROVIDERS.includes(name);
    var isCustom = data.brain.custom && data.brain.custom[name];
    if (!isBuiltin && !isCustom) {
      throw Object.assign(new Error('Provider not found: ' + name + '. Add it first or use a built-in.'), { code: 'providers_not_found' });
    }
    data.brain.active = name;
    return saveProvidersJson(cwd, data);
  });
}

function listHandsProviders(cwd) {
  var configPath = path.join(cwd || process.cwd(), OPENCODE_FILE);
  return fs.readFile(configPath, 'utf8').then(function(raw) {
    try {
      var config = JSON.parse(raw.replace(/^\uFEFF/, '').trim());
      return config.provider || {};
    } catch (e) {
      return {};
    }
  }).catch(function(err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  });
}

function getHandsProvider(cwd, name) {
  if (!name || typeof name !== 'string') {
    throw Object.assign(new Error('Provider name is required'), { code: 'providers_invalid_name' });
  }
  return listHandsProviders(cwd).then(function(providers) {
    if (!providers[name]) {
      throw Object.assign(new Error('Hands provider not found: ' + name), { code: 'providers_not_found' });
    }
    return { name: name, config: providers[name] };
  });
}

function addHandsProvider(cwd, name, config) {
  if (!name || typeof name !== 'string') {
    throw Object.assign(new Error('Provider name is required'), { code: 'providers_invalid_name' });
  }
  if (!config || typeof config !== 'object') {
    throw Object.assign(new Error('Provider config is required'), { code: 'providers_invalid_config' });
  }
  var configPath = path.join(cwd || process.cwd(), OPENCODE_FILE);
  var tmpPath = configPath + '.tmp.' + Date.now() + '.' + Math.random().toString(36).slice(2, 8);
  return fs.readFile(configPath, 'utf8').then(function(raw) {
    var data;
    try { data = JSON.parse(raw.replace(/^\uFEFF/, '').trim()); } catch (e) { data = {}; }
    if (!data.provider || typeof data.provider !== 'object') data.provider = {};
    data.provider[name] = config;
    return fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }).catch(function(err) {
    if (err.code === 'ENOENT') {
      var data = { provider: {} };
      data.provider[name] = config;
      return fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    }
    throw err;
  }).then(function() {
    return renameWithRetry(tmpPath, configPath);
  }).catch(function(err) {
    return fs.unlink(tmpPath).catch(function() {}).then(function() { throw err; });
  });
}

function removeHandsProvider(cwd, name) {
  if (!name || typeof name !== 'string') {
    throw Object.assign(new Error('Provider name is required'), { code: 'providers_invalid_name' });
  }
  var configPath = path.join(cwd || process.cwd(), OPENCODE_FILE);
  var tmpPath = configPath + '.tmp.' + Date.now() + '.' + Math.random().toString(36).slice(2, 8);
  return fs.readFile(configPath, 'utf8').then(function(raw) {
    var data;
    try { data = JSON.parse(raw.replace(/^\uFEFF/, '').trim()); } catch (e) { data = {}; }
    if (!data.provider || !data.provider[name]) {
      throw Object.assign(new Error('Hands provider not found: ' + name), { code: 'providers_not_found' });
    }
    delete data.provider[name];
    return fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }).then(function() {
    return renameWithRetry(tmpPath, configPath);
  }).catch(function(err) {
    return fs.unlink(tmpPath).catch(function() {}).then(function() { throw err; });
  });
}

function getActiveHandsModel(cwd) {
  return loadProvidersJson(cwd).then(function(data) {
    if (data.hands && data.hands.active && data.hands.active.provider && data.hands.active.model) {
      return { provider: data.hands.active.provider, model: data.hands.active.model };
    }
    return null;
  });
}

function setActiveHandsModel(cwd, providerName, modelName) {
  if (!providerName || typeof providerName !== 'string') {
    throw Object.assign(new Error('Provider name is required'), { code: 'providers_invalid_name' });
  }
  if (!modelName || typeof modelName !== 'string') {
    throw Object.assign(new Error('Model name is required'), { code: 'providers_invalid_name' });
  }
  return loadProvidersJson(cwd).then(function(data) {
    data.hands.active = { provider: providerName, model: modelName };
    return saveProvidersJson(cwd, data);
  });
}

function validateProviderConfig(name, config) {
  var errors = [];
  if (!name || typeof name !== 'string') errors.push('name is required');
  if (!config || typeof config !== 'object') {
    errors.push('config must be an object');
    return { valid: false, errors: errors };
  }
  if (!config.model && !config.defaultModel) errors.push('model is required');
  return { valid: errors.length === 0, errors: errors };
}

function loadLegacyBrainConfig(cwd) {
  var filePath = path.join(cwd || process.cwd(), PROVIDERS_DIR, LEGACY_BRAIN_FILE);
  return fs.readFile(filePath, 'utf8').then(function(raw) {
    try {
      return JSON.parse(raw.replace(/^\uFEFF/, '').trim());
    } catch (e) {
      return null;
    }
  }).catch(function(err) {
    if (err.code === 'ENOENT') return null;
    return null;
  });
}

function loadProvidersJsonSync(cwd) {
  var filePath = path.join(cwd || process.cwd(), PROVIDERS_DIR, PROVIDERS_FILE);
  try {
    var raw = require('node:fs').readFileSync(filePath, 'utf8');
    var data = JSON.parse(raw.replace(/^\uFEFF/, '').trim());
    if (!data || typeof data !== 'object') return emptyProviders();
    if (!data.brain || typeof data.brain !== 'object') data.brain = { active: null, custom: {} };
    if (!data.brain.custom || typeof data.brain.custom !== 'object') data.brain.custom = {};
    if (!data.hands || typeof data.hands !== 'object') data.hands = { active: null };
    return data;
  } catch (e) {
    return emptyProviders();
  }
}

function getActiveBrainProviderSync(cwd) {
  var data = loadProvidersJsonSync(cwd);
  var activeName = data.brain.active;
  if (activeName && data.brain.custom[activeName]) {
    return { name: activeName, builtin: BUILTIN_BRAIN_PROVIDERS.includes(activeName), config: data.brain.custom[activeName] };
  }
  if (activeName && BUILTIN_BRAIN_PROVIDERS.includes(activeName)) {
    return { name: activeName, builtin: true, config: null };
  }
  // Fallback to legacy brain.json
  try {
    var legacyPath = path.join(cwd || process.cwd(), PROVIDERS_DIR, LEGACY_BRAIN_FILE);
    var raw = require('node:fs').readFileSync(legacyPath, 'utf8');
    var legacy = JSON.parse(raw.replace(/^\uFEFF/, '').trim());
    if (legacy && legacy.provider) {
      return { name: legacy.provider, builtin: BUILTIN_BRAIN_PROVIDERS.includes(legacy.provider), config: legacy };
    }
  } catch (e) { /* no legacy config */ }
  return null;
}

module.exports = {
  MODULE_VERSION: MODULE_VERSION,
  BUILTIN_BRAIN_PROVIDERS: BUILTIN_BRAIN_PROVIDERS,
  loadProvidersJson: loadProvidersJson,
  loadProvidersJsonSync: loadProvidersJsonSync,
  saveProvidersJson: saveProvidersJson,
  listBrainProviders: listBrainProviders,
  getBrainProvider: getBrainProvider,
  addBrainProvider: addBrainProvider,
  removeBrainProvider: removeBrainProvider,
  getActiveBrainProvider: getActiveBrainProvider,
  getActiveBrainProviderSync: getActiveBrainProviderSync,
  setActiveBrainProvider: setActiveBrainProvider,
  listHandsProviders: listHandsProviders,
  getHandsProvider: getHandsProvider,
  addHandsProvider: addHandsProvider,
  removeHandsProvider: removeHandsProvider,
  getActiveHandsModel: getActiveHandsModel,
  setActiveHandsModel: setActiveHandsModel,
  validateProviderConfig: validateProviderConfig
};
