'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { renameWithRetry } = require('./bridge-atomic');

var MODULE_VERSION = 1;
var PROVIDERS_DIR = '.bridge';
var PROVIDERS_FILE = 'providers.json';
var LEGACY_BRAIN_FILE = 'brain.json';
var OPENCODE_FILE = 'opencode.json';

var BUILTIN_BRAIN_PROVIDERS = Object.freeze(['gemini', 'openrouter', 'groq', 'ollama', 'openai', 'anthropic', 'zen']);

var BRAIN_CONFIG_FIELDS = ['api_key', 'apiKey', 'model', 'baseURL', 'base_url', 'endpoint', 'timeout_ms'];

function emptyProviders() {
  return { version: MODULE_VERSION, brain: { active: null, custom: {} }, hands: { active: null } };
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
  if (data && typeof data === 'object' && data.version === undefined) {
    data.version = MODULE_VERSION;
  }
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

function getActiveBrainProvider(cwd, options) {
  return Promise.resolve(resolveActiveBrainProvider(cwd, options));
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

function resolveActiveBrainProvider(cwd, options) {
  options = options || {};

  // 1. Explicit options (highest precedence)
  if (options.provider) {
    var optName = options.provider;
    var customConfig = null;
    if (options.config) {
      customConfig = options.config;
    } else {
      var provData = loadProvidersJsonSync(cwd);
      if (provData.brain && provData.brain.custom && provData.brain.custom[optName]) {
        customConfig = provData.brain.custom[optName];
      }
    }
    return {
      name: optName,
      builtin: BUILTIN_BRAIN_PROVIDERS.includes(optName),
      config: customConfig
    };
  }

  // 2. providers.json: brain.active
  var data = loadProvidersJsonSync(cwd);
  var activeName = data.brain && data.brain.active;
  if (activeName) {
    if (data.brain.custom && data.brain.custom[activeName]) {
      return {
        name: activeName,
        builtin: BUILTIN_BRAIN_PROVIDERS.includes(activeName),
        config: data.brain.custom[activeName]
      };
    }
    if (BUILTIN_BRAIN_PROVIDERS.includes(activeName)) {
      return { name: activeName, builtin: true, config: null };
    }
    return { name: activeName, builtin: false, config: null };
  }

  // 3. Legacy brain.json
  try {
    var legacyPath = path.join(cwd || process.cwd(), PROVIDERS_DIR, LEGACY_BRAIN_FILE);
    var raw = require('node:fs').readFileSync(legacyPath, 'utf8');
    var legacy = JSON.parse(raw.replace(/^\uFEFF/, '').trim());
    if (legacy && legacy.provider) {
      return {
        name: legacy.provider,
        builtin: BUILTIN_BRAIN_PROVIDERS.includes(legacy.provider),
        config: legacy
      };
    }
  } catch (e) { /* no legacy config */ }

  // 4. Environment variable: MIND_LIMB_BRAIN_PROVIDER
  var envProvider = process.env.MIND_LIMB_BRAIN_PROVIDER;
  if (envProvider) {
    return {
      name: envProvider,
      builtin: BUILTIN_BRAIN_PROVIDERS.includes(envProvider),
      config: null
    };
  }

  return null;
}

function getActiveBrainProviderSync(cwd, options) {
  return resolveActiveBrainProvider(cwd, options);
}

function detectGenerationSync(cwd) {
  var projectDir = cwd || process.cwd();
  var providersPath = path.join(projectDir, PROVIDERS_DIR, PROVIDERS_FILE);
  var brainPath = path.join(projectDir, PROVIDERS_DIR, LEGACY_BRAIN_FILE);
  var statePath = path.join(projectDir, PROVIDERS_DIR, 'state.json');

  var providersExists = false;
  var brainExists = false;
  var providersData = null;
  var brainData = null;
  var stateData = null;
  var providersCorrupt = false;

  try {
    var rawProviders = require('node:fs').readFileSync(providersPath, 'utf8');
    providersExists = true;
    try {
      providersData = JSON.parse(rawProviders.replace(/^\uFEFF/, '').trim());
    } catch (e) {
      providersCorrupt = true;
    }
  } catch (e) { /* ENOENT */ }

  try {
    var rawBrain = require('node:fs').readFileSync(brainPath, 'utf8');
    brainExists = true;
    try {
      brainData = JSON.parse(rawBrain.replace(/^\uFEFF/, '').trim());
    } catch (e) {}
  } catch (e) { /* ENOENT */ }

  try {
    var rawState = require('node:fs').readFileSync(statePath, 'utf8');
    try {
      stateData = JSON.parse(rawState.replace(/^\uFEFF/, '').trim());
    } catch (e) {}
  } catch (e) { /* ENOENT */ }

  var schemaVersion = stateData && typeof stateData.schema_version === 'number'
    ? stateData.schema_version
    : null;
  var codeTooOld = schemaVersion !== null && schemaVersion > MODULE_VERSION;

  // Classify dead default (router.nilovr.web.id or dead deepseek defaults in active/legacy config)
  var isDeadDefault = false;
  if (!providersExists && brainExists) {
    var legacyUrl = brainData && (brainData.baseURL || brainData.base_url || brainData.endpoint || '');
    if (/router\.nilovr\.web\.id/i.test(legacyUrl) || (brainData && brainData.provider === 'custom' && !legacyUrl)) {
      isDeadDefault = true;
    }
  } else if (providersExists && providersData) {
    if (providersData.brain && providersData.brain.active === 'custom') {
      var cEntry = providersData.brain.custom && providersData.brain.custom.custom;
      var cUrl = cEntry && (cEntry.baseURL || cEntry.base_url || cEntry.endpoint || '');
      if (/router\.nilovr\.web\.id/i.test(cUrl)) isDeadDefault = true;
    }
  }

  // Classify intentional custom
  var activeProvider = resolveActiveBrainProvider(projectDir);
  var activeName = activeProvider && activeProvider.name;
  var isIntentionalCustom = false;
  if (activeName && !BUILTIN_BRAIN_PROVIDERS.includes(activeName)) {
    var cfg = activeProvider.config;
    var customUrl = cfg && (cfg.baseURL || cfg.base_url || cfg.endpoint);
    if (customUrl && !/router\.nilovr\.web\.id/i.test(customUrl)) {
      isIntentionalCustom = true;
    }
  } else if (providersData && providersData.brain && providersData.brain.active === 'custom') {
    var customEntry = providersData.brain.custom && providersData.brain.custom.custom;
    var url = customEntry && (customEntry.baseURL || customEntry.base_url || customEntry.endpoint);
    if (url && !/router\.nilovr\.web\.id/i.test(url)) {
      isIntentionalCustom = true;
    }
  }

  var generation;
  if (!providersExists && brainExists) {
    generation = 'gen1';
  } else if (providersExists && (!providersData || providersData.version === undefined || providersData.version === null)) {
    generation = 'gen2';
  } else if (providersExists && providersData && typeof providersData.version === 'number') {
    generation = 'gen3';
  } else if (!providersExists && !brainExists) {
    generation = 'uninitialized';
  } else {
    generation = 'gen2';
  }

  return {
    generation: generation,
    version: providersData && providersData.version !== undefined ? providersData.version : null,
    schema_version: schemaVersion,
    codeTooOld: codeTooOld,
    isLegacy: generation === 'gen1' || generation === 'gen2',
    isDeadDefault: isDeadDefault,
    isIntentionalCustom: isIntentionalCustom,
    providersCorrupt: providersCorrupt,
    active: activeName || null
  };
}

function detectGeneration(cwd) {
  return Promise.resolve(detectGenerationSync(cwd));
}

function enforceVersionGate(cwd, options) {
  options = options || {};
  var gen = detectGenerationSync(cwd);

  if (gen.providersCorrupt) {
    throw Object.assign(new Error('Corrupt providers.json: invalid JSON'), { code: 'providers_corrupt' });
  }

  if (gen.codeTooOld) {
    var errOld = Object.assign(
      new Error('State schema version ' + gen.schema_version + ' is newer than supported version ' + MODULE_VERSION + '. Mind-Limb-Bridge code is too old; update required.'),
      { code: 'schema_version_unsupported', schema_version: gen.schema_version }
    );
    throw errOld;
  }

  if (gen.isLegacy) {
    var autoMigrate = options.autoMigrate || process.env.MIND_LIMB_BRIDGE_AUTO_MIGRATE === '1';
    if (autoMigrate) {
      return { action: 'auto_migrate', generation: gen.generation };
    }
    if (gen.isIntentionalCustom) {
      return { action: 'warn_custom', generation: gen.generation, message: 'Intentional custom provider in use (' + gen.active + ').' };
    }
    var errLegacy = Object.assign(
      new Error('Project is ' + gen.generation + ' legacy format. Run: bridge config migrate' + (cwd ? ' --project ' + cwd : '')),
      { code: 'bridge_legacy_version', generation: gen.generation }
    );
    throw errLegacy;
  }

  return { action: 'pass', generation: gen.generation };
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
  resolveActiveBrainProvider: resolveActiveBrainProvider,
  detectGeneration: detectGeneration,
  detectGenerationSync: detectGenerationSync,
  enforceVersionGate: enforceVersionGate,
  setActiveBrainProvider: setActiveBrainProvider,
  listHandsProviders: listHandsProviders,
  getHandsProvider: getHandsProvider,
  addHandsProvider: addHandsProvider,
  removeHandsProvider: removeHandsProvider,
  getActiveHandsModel: getActiveHandsModel,
  setActiveHandsModel: setActiveHandsModel,
  validateProviderConfig: validateProviderConfig
};
