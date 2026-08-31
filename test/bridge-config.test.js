const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MODULE_VERSION,
  BUILTIN_BRAIN_PROVIDERS,
  loadProvidersJson,
  loadProvidersJsonSync,
  saveProvidersJson,
  listBrainProviders,
  getBrainProvider,
  addBrainProvider,
  removeBrainProvider,
  getActiveBrainProvider,
  getActiveBrainProviderSync,
  setActiveBrainProvider,
  listHandsProviders,
  getHandsProvider,
  addHandsProvider,
  removeHandsProvider,
  getActiveHandsModel,
  setActiveHandsModel,
  validateProviderConfig,
} = require('../bridge-config');

describe('bridge-config', () => {
  let cwd;

  before(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-test-'));
  });

  after(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  // ── loadProvidersJson ─────────────────────────────────────────────

  describe('loadProvidersJson', () => {
    it('returns empty structure when .bridge/providers.json does not exist', async () => {
      const data = await loadProvidersJson(cwd);
      assert.deepStrictEqual(data, { brain: { active: null, custom: {} }, hands: { active: null } });
    });

    it('reads existing providers.json correctly', async () => {
      const dir = path.join(cwd, '.bridge');
      await fs.mkdir(dir, { recursive: true });
      const payload = {
        brain: { active: 'groq', custom: { myprovider: { model: 'm-1' } } },
        hands: { active: { provider: 'p1', model: 'm1' } },
      };
      await fs.writeFile(path.join(dir, 'providers.json'), JSON.stringify(payload), 'utf8');

      const data = await loadProvidersJson(cwd);
      assert.deepStrictEqual(data, payload);
    });

    it('normalizes partial brain/hands structures', async () => {
      const dir = path.join(cwd, '.bridge');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'providers.json'), JSON.stringify({ brain: {} }), 'utf8');

      const data = await loadProvidersJson(cwd);
      assert.deepStrictEqual(data.brain, { custom: {} });
      assert.deepStrictEqual(data.hands, { active: null });
    });

    it('rejects corrupt JSON with providers_corrupt code', async () => {
      const dir = path.join(cwd, '.bridge');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'providers.json'), 'NOT JSON', 'utf8');

      await assert.rejects(() => loadProvidersJson(cwd), (err) => {
        assert.equal(err.code, 'providers_corrupt');
        return true;
      });
    });
  });

  // ── saveProvidersJson ─────────────────────────────────────────────

  describe('saveProvidersJson', () => {
    it('creates .bridge/ directory if missing and writes file', async () => {
      const dir = path.join(cwd, '.bridge');
      await fs.rm(dir, { recursive: true, force: true });

      const payload = { brain: { active: null, custom: {} }, hands: { active: null } };
      await saveProvidersJson(cwd, payload);

      const raw = await fs.readFile(path.join(dir, 'providers.json'), 'utf8');
      assert.deepStrictEqual(JSON.parse(raw), payload);
    });

    it('writes atomically via tmp + rename', async () => {
      const dir = path.join(cwd, '.bridge');
      const payload = { brain: { active: 'openai', custom: {} }, hands: { active: null } };
      await saveProvidersJson(cwd, payload);

      // No .tmp files should remain after atomic write
      const files = await fs.readdir(dir);
      const tmpFiles = files.filter((f) => f.includes('.tmp'));
      assert.equal(tmpFiles.length, 0);

      const data = await loadProvidersJson(cwd);
      assert.equal(data.brain.active, 'openai');
    });
  });

  // ── listBrainProviders ────────────────────────────────────────────

  describe('listBrainProviders', () => {
    it('returns all built-in providers when no custom providers exist', async () => {
      const list = await listBrainProviders(cwd);
      for (const name of BUILTIN_BRAIN_PROVIDERS) {
        assert.deepStrictEqual(list[name], { builtin: true });
      }
    });

    it('includes custom providers from providers.json', async () => {
      const dir = path.join(cwd, '.bridge');
      await fs.mkdir(dir, { recursive: true });
      const payload = {
        brain: { active: null, custom: { mycustom: { model: 'gpt-x' } } },
        hands: { active: null },
      };
      await fs.writeFile(path.join(dir, 'providers.json'), JSON.stringify(payload), 'utf8');

      const list = await listBrainProviders(cwd);
      assert.equal(list.mycustom.builtin, false);
      assert.equal(list.mycustom.model, 'gpt-x');
      assert.equal(list.gemini.builtin, true);
    });
  });

  // ── getBrainProvider ──────────────────────────────────────────────

  describe('getBrainProvider', () => {
    it('throws on missing or non-string name', () => {
      assert.throws(() => getBrainProvider(cwd, null), { code: 'providers_invalid_name' });
      assert.throws(() => getBrainProvider(cwd, ''), { code: 'providers_invalid_name' });
      assert.throws(() => getBrainProvider(cwd, 123), { code: 'providers_invalid_name' });
    });

    it('returns built-in provider info', async () => {
      const result = await getBrainProvider(cwd, 'gemini');
      assert.equal(result.name, 'gemini');
      assert.equal(result.builtin, true);
    });

    it('returns custom provider with config', async () => {
      const dir = path.join(cwd, '.bridge');
      await fs.mkdir(dir, { recursive: true });
      const payload = {
        brain: { active: null, custom: { deepseek: { model: 'ds-1', apiKey: 'sk-x' } } },
        hands: { active: null },
      };
      await fs.writeFile(path.join(dir, 'providers.json'), JSON.stringify(payload), 'utf8');

      const result = await getBrainProvider(cwd, 'deepseek');
      assert.equal(result.name, 'deepseek');
      assert.equal(result.builtin, false);
      assert.equal(result.config.model, 'ds-1');
    });

    it('throws on unknown provider', async () => {
      await assert.rejects(() => getBrainProvider(cwd, 'nonexistent'), (err) => {
        assert.equal(err.code, 'providers_not_found');
        return true;
      });
    });
  });

  // ── addBrainProvider ──────────────────────────────────────────────

  describe('addBrainProvider', () => {
    it('throws on missing or non-string name', () => {
      assert.throws(() => addBrainProvider(cwd, null, {}), { code: 'providers_invalid_name' });
      assert.throws(() => addBrainProvider(cwd, '', {}), { code: 'providers_invalid_name' });
    });

    it('throws when trying to override a built-in provider', () => {
      assert.throws(() => addBrainProvider(cwd, 'gemini', { model: 'x' }), { code: 'providers_builtin_protected' });
    });

    it('throws on invalid config (missing model)', () => {
      assert.throws(() => addBrainProvider(cwd, 'mycustom', {}), { code: 'providers_invalid_config' });
    });

    it('adds a custom provider and persists it', async () => {
      await addBrainProvider(cwd, 'mycustom', { model: 'test-model' });

      const result = await getBrainProvider(cwd, 'mycustom');
      assert.equal(result.name, 'mycustom');
      assert.equal(result.builtin, false);
      assert.equal(result.config.model, 'test-model');
    });
  });

  // ── removeBrainProvider ───────────────────────────────────────────

  describe('removeBrainProvider', () => {
    it('throws on missing or non-string name', () => {
      assert.throws(() => removeBrainProvider(cwd, null), { code: 'providers_invalid_name' });
    });

    it('throws when trying to remove a built-in provider', () => {
      assert.throws(() => removeBrainProvider(cwd, 'groq'), { code: 'providers_builtin_protected' });
    });

    it('throws when provider is not found', async () => {
      await assert.rejects(() => removeBrainProvider(cwd, 'nonexistent'), (err) => {
        assert.equal(err.code, 'providers_not_found');
        return true;
      });
    });

    it('removes a custom provider and clears active if it was active', async () => {
      await addBrainProvider(cwd, 'removeme', { model: 'r-model' });
      await setActiveBrainProvider(cwd, 'removeme');
      await removeBrainProvider(cwd, 'removeme');

      const data = await loadProvidersJson(cwd);
      assert.equal(data.brain.custom.removeme, undefined);
      assert.equal(data.brain.active, null);
    });
  });

  // ── getActiveBrainProvider ────────────────────────────────────────

  describe('getActiveBrainProvider', () => {
    it('returns the active provider from providers.json', async () => {
      const dir = path.join(cwd, '.bridge');
      await fs.mkdir(dir, { recursive: true });
      const payload = {
        brain: { active: 'anthropic', custom: {} },
        hands: { active: null },
      };
      await fs.writeFile(path.join(dir, 'providers.json'), JSON.stringify(payload), 'utf8');

      const result = await getActiveBrainProvider(cwd);
      assert.equal(result.name, 'anthropic');
      assert.equal(result.builtin, true);
      assert.equal(result.config, null);
    });

    it('returns custom active provider with config', async () => {
      const dir = path.join(cwd, '.bridge');
      await fs.mkdir(dir, { recursive: true });
      const payload = {
        brain: { active: 'custom1', custom: { custom1: { model: 'cm' } } },
        hands: { active: null },
      };
      await fs.writeFile(path.join(dir, 'providers.json'), JSON.stringify(payload), 'utf8');

      const result = await getActiveBrainProvider(cwd);
      assert.equal(result.name, 'custom1');
      assert.equal(result.builtin, false);
      assert.equal(result.config.model, 'cm');
    });

    it('falls back to legacy brain.json when no active provider', async () => {
      const legacyCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-legacy-'));
      try {
        const dir = path.join(legacyCwd, '.bridge');
        await fs.mkdir(dir, { recursive: true });
        // No providers.json, but brain.json exists
        await fs.writeFile(
          path.join(dir, 'brain.json'),
          JSON.stringify({ provider: 'openrouter', api_key: 'legacy-key' }),
          'utf8'
        );

        const result = await getActiveBrainProvider(legacyCwd);
        assert.equal(result.name, 'openrouter');
      } finally {
        await fs.rm(legacyCwd, { recursive: true, force: true });
      }
    });

    it('returns default gemini when nothing is configured', async () => {
      // Clean state: no providers.json, no brain.json
      const emptyCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-empty-'));
      try {
        const result = await getActiveBrainProvider(emptyCwd);
        assert.equal(result.name, 'gemini');
        assert.equal(result.builtin, true);
        assert.equal(result.config, null);
      } finally {
        await fs.rm(emptyCwd, { recursive: true, force: true });
      }
    });
  });

  // ── setActiveBrainProvider ────────────────────────────────────────

  describe('setActiveBrainProvider', () => {
    it('throws on missing or non-string name', () => {
      assert.throws(() => setActiveBrainProvider(cwd, null), { code: 'providers_invalid_name' });
      assert.throws(() => setActiveBrainProvider(cwd, ''), { code: 'providers_invalid_name' });
    });

    it('throws on unknown provider (not built-in and not custom)', async () => {
      const emptyCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-setempty-'));
      try {
        await assert.rejects(() => setActiveBrainProvider(emptyCwd, 'ghost'), (err) => {
          assert.equal(err.code, 'providers_not_found');
          return true;
        });
      } finally {
        await fs.rm(emptyCwd, { recursive: true, force: true });
      }
    });

    it('sets a built-in provider as active', async () => {
      const dir = path.join(cwd, '.bridge');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'providers.json'),
        JSON.stringify({ brain: { active: null, custom: {} }, hands: { active: null } }),
        'utf8'
      );

      await setActiveBrainProvider(cwd, 'groq');
      const data = await loadProvidersJson(cwd);
      assert.equal(data.brain.active, 'groq');
    });

    it('sets a custom provider as active', async () => {
      await addBrainProvider(cwd, 'myprovider', { model: 'mp-1' });
      await setActiveBrainProvider(cwd, 'myprovider');
      const data = await loadProvidersJson(cwd);
      assert.equal(data.brain.active, 'myprovider');
    });
  });

  // ── listHandsProviders ────────────────────────────────────────────

  describe('listHandsProviders', () => {
    it('returns empty when opencode.json does not exist', async () => {
      const emptyCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-handsempty-'));
      try {
        const providers = await listHandsProviders(emptyCwd);
        assert.deepStrictEqual(providers, {});
      } finally {
        await fs.rm(emptyCwd, { recursive: true, force: true });
      }
    });

    it('reads providers from opencode.json', async () => {
      const opencodePayload = {
        provider: {
          opencode: { apiKey: 'key-1', name: 'OpenCode' },
          anthropic: { apiKey: 'key-2' },
        },
      };
      await fs.writeFile(path.join(cwd, 'opencode.json'), JSON.stringify(opencodePayload), 'utf8');

      const providers = await listHandsProviders(cwd);
      assert.equal(providers.opencode.name, 'OpenCode');
      assert.equal(providers.anthropic.apiKey, 'key-2');
    });

    it('returns empty on corrupt opencode.json', async () => {
      await fs.writeFile(path.join(cwd, 'opencode.json'), 'NOT JSON', 'utf8');
      const providers = await listHandsProviders(cwd);
      assert.deepStrictEqual(providers, {});
    });
  });

  // ── getHandsProvider ──────────────────────────────────────────────

  describe('getHandsProvider', () => {
    it('throws on missing or non-string name', () => {
      assert.throws(() => getHandsProvider(cwd, null), { code: 'providers_invalid_name' });
    });

    it('returns the requested hands provider', async () => {
      const opencodePayload = { provider: { opencode: { apiKey: 'k', name: 'OpenCode' } } };
      await fs.writeFile(path.join(cwd, 'opencode.json'), JSON.stringify(opencodePayload), 'utf8');

      const result = await getHandsProvider(cwd, 'opencode');
      assert.equal(result.name, 'opencode');
      assert.equal(result.config.name, 'OpenCode');
    });

    it('throws on unknown hands provider', async () => {
      await assert.rejects(() => getHandsProvider(cwd, 'ghost'), (err) => {
        assert.equal(err.code, 'providers_not_found');
        return true;
      });
    });
  });

  // ── addHandsProvider ──────────────────────────────────────────────

  describe('addHandsProvider', () => {
    it('throws on missing or non-string name', () => {
      assert.throws(() => addHandsProvider(cwd, null, {}), { code: 'providers_invalid_name' });
    });

    it('throws when config is missing or not an object', async () => {
      assert.throws(() => addHandsProvider(cwd, 'p1', null), { code: 'providers_invalid_config' });
      assert.throws(() => addHandsProvider(cwd, 'p1', 'string'), { code: 'providers_invalid_config' });
    });

    it('creates opencode.json if missing and adds provider', async () => {
      const tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-addhands-'));
      try {
        await addHandsProvider(tempCwd, 'newprovider', { apiKey: 'k1' });

        const data = JSON.parse(await fs.readFile(path.join(tempCwd, 'opencode.json'), 'utf8'));
        assert.equal(data.provider.newprovider.apiKey, 'k1');
      } finally {
        await fs.rm(tempCwd, { recursive: true, force: true });
      }
    });

    it('adds provider to existing opencode.json', async () => {
      const opencodePayload = { provider: { existing: { apiKey: 'old' } } };
      await fs.writeFile(path.join(cwd, 'opencode.json'), JSON.stringify(opencodePayload), 'utf8');

      await addHandsProvider(cwd, 'added', { apiKey: 'new' });

      const data = JSON.parse(await fs.readFile(path.join(cwd, 'opencode.json'), 'utf8'));
      assert.equal(data.provider.existing.apiKey, 'old');
      assert.equal(data.provider.added.apiKey, 'new');
    });
  });

  // ── removeHandsProvider ───────────────────────────────────────────

  describe('removeHandsProvider', () => {
    it('throws on missing or non-string name', () => {
      assert.throws(() => removeHandsProvider(cwd, null), { code: 'providers_invalid_name' });
    });

    it('throws when provider is not found', async () => {
      await assert.rejects(() => removeHandsProvider(cwd, 'ghost'), (err) => {
        assert.equal(err.code, 'providers_not_found');
        return true;
      });
    });

    it('removes a provider from opencode.json', async () => {
      const opencodePayload = { provider: { keep: { apiKey: 'k1' }, remove: { apiKey: 'k2' } } };
      await fs.writeFile(path.join(cwd, 'opencode.json'), JSON.stringify(opencodePayload), 'utf8');

      await removeHandsProvider(cwd, 'remove');

      const data = JSON.parse(await fs.readFile(path.join(cwd, 'opencode.json'), 'utf8'));
      assert.deepStrictEqual(data.provider.keep, { apiKey: 'k1' });
      assert.equal(data.provider.remove, undefined);
    });
  });

  // ── setActiveHandsModel ───────────────────────────────────────────

  describe('setActiveHandsModel', () => {
    it('throws on missing provider name', () => {
      assert.throws(() => setActiveHandsModel(cwd, null, 'model'), { code: 'providers_invalid_name' });
      assert.throws(() => setActiveHandsModel(cwd, '', 'model'), { code: 'providers_invalid_name' });
    });

    it('throws on missing model name', () => {
      assert.throws(() => setActiveHandsModel(cwd, 'provider', null), { code: 'providers_invalid_name' });
      assert.throws(() => setActiveHandsModel(cwd, 'provider', ''), { code: 'providers_invalid_name' });
    });

    it('sets the active hands model in providers.json', async () => {
      const dir = path.join(cwd, '.bridge');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'providers.json'),
        JSON.stringify({ brain: { active: null, custom: {} }, hands: { active: null } }),
        'utf8'
      );

      await setActiveHandsModel(cwd, 'opencode', 'deepseek-v4-flash-free');

      const data = await loadProvidersJson(cwd);
      assert.deepStrictEqual(data.hands.active, { provider: 'opencode', model: 'deepseek-v4-flash-free' });
    });
  });

  // ── getActiveHandsModel ───────────────────────────────────────────

  describe('getActiveHandsModel', () => {
    it('returns null when no hands model is configured', async () => {
      const result = await getActiveHandsModel(cwd);
      // After setActiveHandsModel test above, it might be set, so load fresh state
      const dir = path.join(cwd, '.bridge');
      await fs.writeFile(
        path.join(dir, 'providers.json'),
        JSON.stringify({ brain: { active: null, custom: {} }, hands: { active: null } }),
        'utf8'
      );
      const result2 = await getActiveHandsModel(cwd);
      assert.equal(result2, null);
    });

    it('returns provider and model when configured', async () => {
      const dir = path.join(cwd, '.bridge');
      const payload = {
        brain: { active: null, custom: {} },
        hands: { active: { provider: 'opencode', model: 'deepseek-v4-flash-free' } },
      };
      await fs.writeFile(path.join(dir, 'providers.json'), JSON.stringify(payload), 'utf8');

      const result = await getActiveHandsModel(cwd);
      assert.deepStrictEqual(result, { provider: 'opencode', model: 'deepseek-v4-flash-free' });
    });
  });

  // ── validateProviderConfig ────────────────────────────────────────

  describe('validateProviderConfig', () => {
    it('rejects null name', () => {
      const result = validateProviderConfig(null, { model: 'm' });
      assert.equal(result.valid, false);
      assert.ok(result.errors.includes('name is required'));
    });

    it('rejects non-object config', () => {
      const result = validateProviderConfig('name', null);
      assert.equal(result.valid, false);
      assert.ok(result.errors.includes('config must be an object'));
    });

    it('rejects config missing both model and defaultModel', () => {
      const result = validateProviderConfig('name', { apiKey: 'k' });
      assert.equal(result.valid, false);
      assert.ok(result.errors.includes('model is required'));
    });

    it('accepts config with model field', () => {
      const result = validateProviderConfig('name', { model: 'gpt-4' });
      assert.equal(result.valid, true);
      assert.deepStrictEqual(result.errors, []);
    });

    it('accepts config with defaultModel field', () => {
      const result = validateProviderConfig('name', { defaultModel: 'claude-3' });
      assert.equal(result.valid, true);
    });
  });

  // ── loadProvidersJsonSync ─────────────────────────────────────────

  describe('loadProvidersJsonSync', () => {
    it('returns empty structure when file does not exist', async () => {
      const tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-sync-'));
      try {
        const data = loadProvidersJsonSync(tempCwd);
        assert.deepStrictEqual(data, { brain: { active: null, custom: {} }, hands: { active: null } });
      } finally {
        await fs.rm(tempCwd, { recursive: true, force: true });
      }
    });

    it('reads existing file synchronously', async () => {
      const dir = path.join(cwd, '.bridge');
      await fs.mkdir(dir, { recursive: true });
      const payload = { brain: { active: 'openai', custom: {} }, hands: { active: null } };
      await fs.writeFile(path.join(dir, 'providers.json'), JSON.stringify(payload), 'utf8');

      const data = loadProvidersJsonSync(cwd);
      assert.equal(data.brain.active, 'openai');
    });
  });

  // ── getActiveBrainProviderSync ────────────────────────────────────

  describe('getActiveBrainProviderSync', () => {
    it('returns null when no active provider is set', async () => {
      const tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-sync2-'));
      try {
        const result = getActiveBrainProviderSync(tempCwd);
        assert.equal(result, null);
      } finally {
        await fs.rm(tempCwd, { recursive: true, force: true });
      }
    });

    it('returns active built-in provider synchronously', async () => {
      const dir = path.join(cwd, '.bridge');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'providers.json'),
        JSON.stringify({ brain: { active: 'groq', custom: {} }, hands: { active: null } }),
        'utf8'
      );

      const result = getActiveBrainProviderSync(cwd);
      assert.equal(result.name, 'groq');
      assert.equal(result.builtin, true);
    });

    it('returns active custom provider with config', async () => {
      const dir = path.join(cwd, '.bridge');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'providers.json'),
        JSON.stringify({
          brain: { active: 'mine', custom: { mine: { model: 'm1' } } },
          hands: { active: null },
        }),
        'utf8'
      );

      const result = getActiveBrainProviderSync(cwd);
      assert.equal(result.name, 'mine');
      assert.equal(result.builtin, false);
      assert.equal(result.config.model, 'm1');
    });
  });

  // ── Legacy fallback integration ───────────────────────────────────

  describe('Legacy fallback', () => {
    it('getActiveBrainProvider reads brain.json when providers.json does not exist', async () => {
      const tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-legacy-'));
      try {
        const dir = path.join(tempCwd, '.bridge');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
          path.join(dir, 'brain.json'),
          JSON.stringify({ provider: 'ollama', api_key: 'local', model: 'llama3' }),
          'utf8'
        );

        const result = await getActiveBrainProvider(tempCwd);
        assert.equal(result.name, 'ollama');
        assert.equal(result.config.provider, 'ollama');
        assert.equal(result.config.model, 'llama3');
      } finally {
        await fs.rm(tempCwd, { recursive: true, force: true });
      }
    });

    it('getActiveBrainProvider prefers providers.json over brain.json', async () => {
      const tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-prefers-'));
      try {
        const dir = path.join(tempCwd, '.bridge');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
          path.join(dir, 'providers.json'),
          JSON.stringify({ brain: { active: 'openai', custom: {} }, hands: { active: null } }),
          'utf8'
        );
        await fs.writeFile(
          path.join(dir, 'brain.json'),
          JSON.stringify({ provider: 'ollama' }),
          'utf8'
        );

        const result = await getActiveBrainProvider(tempCwd);
        assert.equal(result.name, 'openai');
      } finally {
        await fs.rm(tempCwd, { recursive: true, force: true });
      }
    });
  });

  // ── Exports check ────────────────────────────────────────────────

  describe('exports', () => {
    it('exports MODULE_VERSION as number', () => {
      assert.equal(typeof MODULE_VERSION, 'number');
    });

    it('exports BUILTIN_BRAIN_PROVIDERS as frozen array', () => {
      assert.ok(Array.isArray(BUILTIN_BRAIN_PROVIDERS));
      assert.equal(Object.isFrozen(BUILTIN_BRAIN_PROVIDERS), true);
      assert.ok(BUILTIN_BRAIN_PROVIDERS.includes('gemini'));
    });
  });
});
