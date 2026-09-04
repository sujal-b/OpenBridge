'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execSync } = require('node:child_process');

const bridgeRoot = path.resolve(__dirname, '..');
const bridgeCli = path.join(bridgeRoot, 'bridge.js');
const bridgeConfig = require('../bridge-config');
const {
  MODULE_VERSION,
  resolveActiveBrainProvider,
  detectGeneration,
  detectGenerationSync,
  enforceVersionGate,
  getActiveBrainProvider,
  getActiveBrainProviderSync,
  emptyProviders
} = bridgeConfig;

describe('bridge-lifecycle-checks', () => {

  // ── Acceptance Trilogy ──────────────────────────────────────────────────
  describe('Acceptance Trilogy', () => {
    it('Acceptance 1: bridge open --project airtrack-legacy exits non-zero, stderr gen1 + migrate, zero writes', () => {
      const airtrackDir = path.join(bridgeRoot, 'fixtures', 'airtrack-legacy');
      const statBefore = fsSync.statSync(path.join(airtrackDir, '.bridge', 'brain.json'));

      const result = spawnSync(process.execPath, [bridgeCli, 'open', '--project', airtrackDir], {
        encoding: 'utf8',
        cwd: bridgeRoot
      });

      assert.notEqual(result.status, 0, 'open on legacy should exit non-zero');
      const errText = result.stderr + result.stdout;
      assert.ok(errText.includes('gen1'), 'stderr should mention gen1: ' + errText);
      assert.ok(errText.includes('bridge config migrate'), 'stderr should mention bridge config migrate: ' + errText);

      // Verify zero writes: file mtime untouched and no providers.json created
      const statAfter = fsSync.statSync(path.join(airtrackDir, '.bridge', 'brain.json'));
      assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, 'brain.json mtime must remain unchanged');
      assert.ok(!fsSync.existsSync(path.join(airtrackDir, '.bridge', 'providers.json')), 'providers.json must not be created');

      // Idempotence: second run also makes zero writes
      const result2 = spawnSync(process.execPath, [bridgeCli, 'open', '--project', airtrackDir], {
        encoding: 'utf8',
        cwd: bridgeRoot
      });
      assert.notEqual(result2.status, 0);
      const statAfter2 = fsSync.statSync(path.join(airtrackDir, '.bridge', 'brain.json'));
      assert.equal(statBefore.mtimeMs, statAfter2.mtimeMs, 'second run must also make zero writes');
    });

    it('Acceptance 2: bridge config migrate then open exits 0, active=zen, no 401', async () => {
      // Work on a copy of airtrack-legacy so we don't mutate the shared fixture
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airtrack-migrate-'));
      try {
        const fixtureDir = path.join(bridgeRoot, 'fixtures', 'airtrack-legacy');
        // Copy fixture files
        await fs.cp(fixtureDir, tempDir, { recursive: true });
        execSync('git init', { cwd: tempDir });
        execSync('git config user.name "Test"', { cwd: tempDir });
        execSync('git config user.email "test@example.com"', { cwd: tempDir });
        execSync('git add .', { cwd: tempDir });
        try { execSync('git commit -m "baseline"', { cwd: tempDir, stdio: 'pipe' }); } catch {}

        // 1. Run migrate
        const migrateResult = spawnSync(process.execPath, [bridgeCli, 'config', 'migrate', '--project', tempDir], {
          encoding: 'utf8',
          cwd: bridgeRoot
        });
        assert.equal(migrateResult.status, 0, 'migrate should exit 0: ' + migrateResult.stderr);
        assert.ok(migrateResult.stdout.includes('Backup created'), 'should report backup creation: ' + migrateResult.stdout);
        assert.ok(migrateResult.stdout.includes('migrated to gen3'), 'should report migration: ' + migrateResult.stdout);

        // Verify providers.json has active = zen
        const provRaw = await fs.readFile(path.join(tempDir, '.bridge', 'providers.json'), 'utf8');
        const provData = JSON.parse(provRaw);
        assert.equal(provData.brain.active, 'zen');
        assert.equal(provData.version, MODULE_VERSION);

        // Verify backup exists
        const bridgeFiles = await fs.readdir(path.join(tempDir, '.bridge'));
        const bakFile = bridgeFiles.find(f => f.startsWith('brain.json.bak.'));
        assert.ok(bakFile, 'brain.json backup file must exist');

        // 2. Run open
        const openResult = spawnSync(process.execPath, [bridgeCli, 'open', '--project', tempDir], {
          encoding: 'utf8',
          cwd: bridgeRoot
        });
        assert.equal(openResult.status, 0, 'open should now exit 0: ' + openResult.stderr);

        // Verify active provider is zen (no 401 HTTP attempt)
        const active = getActiveBrainProviderSync(tempDir);
        assert.equal(active.name, 'zen');
        assert.equal(active.builtin, true);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('Acceptance 3: intentional-custom fixture untouched, exits 0', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'intentional-custom-'));
      try {
        const customDir = path.join(bridgeRoot, 'fixtures', 'intentional-custom');
        await fs.cp(customDir, tempDir, { recursive: true });
        execSync('git init', { cwd: tempDir });
        execSync('git config user.name "Test"', { cwd: tempDir });
        execSync('git config user.email "test@example.com"', { cwd: tempDir });
        execSync('git add .', { cwd: tempDir });
        try { execSync('git commit -m "baseline"', { cwd: tempDir, stdio: 'pipe' }); } catch {}

        const provRawBefore = await fs.readFile(path.join(tempDir, '.bridge', 'providers.json'), 'utf8');

        const result = spawnSync(process.execPath, [bridgeCli, 'open', '--project', tempDir], {
          encoding: 'utf8',
          cwd: bridgeRoot
        });
        assert.equal(result.status, 0, 'open should exit 0: ' + result.stderr);

        const provRawAfter = await fs.readFile(path.join(tempDir, '.bridge', 'providers.json'), 'utf8');
        assert.equal(provRawBefore.trim(), provRawAfter.trim(), 'providers.json must remain completely untouched');

        const active = getActiveBrainProviderSync(tempDir);
        assert.equal(active.name, 'custom');
        assert.equal(active.config.baseURL, 'http://127.0.0.1:8080/v1');
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  // ── Resolver Precedence Matrix ──────────────────────────────────────────
  describe('Resolver Precedence Matrix', () => {
    let tempDir;
    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'precedence-test-'));
      await fs.mkdir(path.join(tempDir, '.bridge'), { recursive: true });
    });
    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('precedence 1: options.provider wins over providers.json, brain.json, env', async () => {
      await fs.writeFile(path.join(tempDir, '.bridge', 'providers.json'), JSON.stringify({
        version: 1, brain: { active: 'anthropic' }
      }));
      await fs.writeFile(path.join(tempDir, '.bridge', 'brain.json'), JSON.stringify({
        provider: 'ollama'
      }));
      process.env.MIND_LIMB_BRAIN_PROVIDER = 'groq';

      const result = getActiveBrainProviderSync(tempDir, { provider: 'openai' });
      assert.equal(result.name, 'openai');
      delete process.env.MIND_LIMB_BRAIN_PROVIDER;
    });

    it('precedence 2: providers.json:active wins over brain.json and env', async () => {
      await fs.writeFile(path.join(tempDir, '.bridge', 'providers.json'), JSON.stringify({
        version: 1, brain: { active: 'anthropic' }
      }));
      await fs.writeFile(path.join(tempDir, '.bridge', 'brain.json'), JSON.stringify({
        provider: 'ollama'
      }));
      process.env.MIND_LIMB_BRAIN_PROVIDER = 'groq';

      const result = getActiveBrainProviderSync(tempDir);
      assert.equal(result.name, 'anthropic');
      delete process.env.MIND_LIMB_BRAIN_PROVIDER;
    });

    it('precedence 3: legacy brain.json wins over env when providers.json has no active', async () => {
      await fs.writeFile(path.join(tempDir, '.bridge', 'providers.json'), JSON.stringify({
        version: 1, brain: { active: null }
      }));
      await fs.writeFile(path.join(tempDir, '.bridge', 'brain.json'), JSON.stringify({
        provider: 'custom', baseURL: 'http://example.com'
      }));
      process.env.MIND_LIMB_BRAIN_PROVIDER = 'groq';

      const result = getActiveBrainProviderSync(tempDir);
      assert.equal(result.name, 'custom');
      delete process.env.MIND_LIMB_BRAIN_PROVIDER;
    });

    it('precedence 4: env wins when neither providers.json nor brain.json has a provider', async () => {
      await fs.writeFile(path.join(tempDir, '.bridge', 'providers.json'), JSON.stringify({
        version: 1, brain: { active: null }
      }));
      process.env.MIND_LIMB_BRAIN_PROVIDER = 'zen';

      const result = getActiveBrainProviderSync(tempDir);
      assert.equal(result.name, 'zen');
      delete process.env.MIND_LIMB_BRAIN_PROVIDER;
    });

    it('precedence 5: returns null when nothing is configured', () => {
      const active = getActiveBrainProviderSync(tempDir);
      assert.equal(active, null);
    });
  });

  // ── detectGeneration and enforceVersionGate ──────────────────────────────
  describe('detectGeneration and enforceVersionGate', () => {
    let tempDir;
    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-detect-'));
      await fs.mkdir(path.join(tempDir, '.bridge'), { recursive: true });
    });
    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('detects uninitialized when neither providers.json nor brain.json exists', () => {
      const gen = detectGenerationSync(tempDir);
      assert.equal(gen.generation, 'uninitialized');
      assert.equal(gen.isLegacy, false);
    });

    it('detects gen1 when brain.json exists without providers.json', async () => {
      await fs.writeFile(path.join(tempDir, '.bridge', 'brain.json'), JSON.stringify({
        provider: 'custom',
        baseURL: 'https://router.nilovr.web.id/v1'
      }));
      const gen = detectGenerationSync(tempDir);
      assert.equal(gen.generation, 'gen1');
      assert.equal(gen.isLegacy, true);
      assert.equal(gen.isDeadDefault, true);
    });

    it('detects gen2 when providers.json exists without version', async () => {
      await fs.writeFile(path.join(tempDir, '.bridge', 'providers.json'), JSON.stringify({
        brain: { active: 'anthropic' }
      }));
      const gen = detectGenerationSync(tempDir);
      assert.equal(gen.generation, 'gen2');
      assert.equal(gen.isLegacy, true);
    });

    it('detects gen3 when providers.json has version: MODULE_VERSION', async () => {
      await fs.writeFile(path.join(tempDir, '.bridge', 'providers.json'), JSON.stringify({
        version: MODULE_VERSION,
        brain: { active: 'zen' }
      }));
      const gen = detectGenerationSync(tempDir);
      assert.equal(gen.generation, 'gen3');
      assert.equal(gen.isLegacy, false);
    });

    it('enforceVersionGate throws schema_version_unsupported when schema_version > MODULE_VERSION', async () => {
      await fs.writeFile(path.join(tempDir, '.bridge', 'state.json'), JSON.stringify({
        schema_version: MODULE_VERSION + 1,
        phase: 'idle'
      }));
      assert.throws(
        () => enforceVersionGate(tempDir),
        err => err.code === 'schema_version_unsupported'
      );
    });

    it('enforceVersionGate throws bridge_legacy_version on gen1 without consent', async () => {
      await fs.writeFile(path.join(tempDir, '.bridge', 'brain.json'), JSON.stringify({
        provider: 'custom',
        baseURL: 'https://router.nilovr.web.id/v1'
      }));
      assert.throws(
        () => enforceVersionGate(tempDir),
        err => err.code === 'bridge_legacy_version'
      );
    });

    it('enforceVersionGate returns auto_migrate when autoMigrate: true', async () => {
      await fs.writeFile(path.join(tempDir, '.bridge', 'brain.json'), JSON.stringify({
        provider: 'custom',
        baseURL: 'https://router.nilovr.web.id/v1'
      }));
      const res = enforceVersionGate(tempDir, { autoMigrate: true });
      assert.equal(res.action, 'auto_migrate');
    });

    it('enforceVersionGate warns on intentional custom without error', async () => {
      await fs.writeFile(path.join(tempDir, '.bridge', 'providers.json'), JSON.stringify({
        version: MODULE_VERSION,
        brain: {
          active: 'custom',
          custom: {
            custom: { baseURL: 'https://my-llm.corp/v1' }
          }
        }
      }));
      const res = enforceVersionGate(tempDir);
      assert.equal(res.action, 'pass');
    });
  });

  // ── Migrator Protections ────────────────────────────────────────────────
  describe('Migrator Protections', () => {
    let tempDir;
    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrator-prot-'));
      await fs.mkdir(path.join(tempDir, '.bridge'), { recursive: true });
      // initialize git
      execSync('git init', { cwd: tempDir });
      execSync('git config user.name "Test"', { cwd: tempDir });
      execSync('git config user.email "test@example.com"', { cwd: tempDir });
      await fs.writeFile(path.join(tempDir, 'file.txt'), 'hello');
      execSync('git add .', { cwd: tempDir });
      execSync('git commit -m "initial"', { cwd: tempDir });
    });
    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('--dry-run performs zero writes and does not change files', async () => {
      await fs.writeFile(path.join(tempDir, '.bridge', 'brain.json'), JSON.stringify({
        provider: 'custom',
        baseURL: 'https://router.nilovr.web.id/v1'
      }));
      execSync('git add . && git commit -m "add legacy brain"', { cwd: tempDir });

      const result = spawnSync(process.execPath, [bridgeCli, 'config', 'migrate', '--dry-run', '--project', tempDir], {
        encoding: 'utf8',
        cwd: bridgeRoot
      });
      assert.equal(result.status, 0);
      assert.ok(result.stdout.includes('DRY RUN'));
      assert.ok(!fsSync.existsSync(path.join(tempDir, '.bridge', 'providers.json')), 'providers.json should not exist');
    });

    it('corrupt providers.json fails with providers_corrupt and refuses to overwrite', async () => {
      await fs.writeFile(path.join(tempDir, '.bridge', 'providers.json'), '{ invalid json');
      execSync('git add . && git commit -m "corrupt"', { cwd: tempDir });

      const result = spawnSync(process.execPath, [bridgeCli, 'config', 'migrate', '--project', tempDir], {
        encoding: 'utf8',
        cwd: bridgeRoot
      });
      assert.notEqual(result.status, 0);
      assert.ok((result.stderr + result.stdout).includes('Corrupt providers.json'));
    });

    it('dirty working tree blocks migration unless --force', async () => {
      await fs.writeFile(path.join(tempDir, '.bridge', 'brain.json'), JSON.stringify({
        provider: 'custom',
        baseURL: 'https://router.nilovr.web.id/v1'
      }));
      // Leave uncommitted file
      await fs.writeFile(path.join(tempDir, 'dirty.txt'), 'dirty');

      const result = spawnSync(process.execPath, [bridgeCli, 'config', 'migrate', '--project', tempDir], {
        encoding: 'utf8',
        cwd: bridgeRoot
      });
      assert.notEqual(result.status, 0);
      assert.ok((result.stderr + result.stdout).includes('Working tree is dirty'));

      // With --force, succeeds
      const forceResult = spawnSync(process.execPath, [bridgeCli, 'config', 'migrate', '--force', '--project', tempDir], {
        encoding: 'utf8',
        cwd: bridgeRoot
      });
      assert.equal(forceResult.status, 0);
    });

    it('active session phase blocks migration unless --force', async () => {
      await fs.writeFile(path.join(tempDir, '.bridge', 'brain.json'), JSON.stringify({
        provider: 'custom',
        baseURL: 'https://router.nilovr.web.id/v1'
      }));
      await fs.writeFile(path.join(tempDir, '.bridge', 'state.json'), JSON.stringify({
        phase: 'hands_executing'
      }));
      execSync('git add . && git commit -m "active state"', { cwd: tempDir });

      const result = spawnSync(process.execPath, [bridgeCli, 'config', 'migrate', '--project', tempDir], {
        encoding: 'utf8',
        cwd: bridgeRoot
      });
      assert.notEqual(result.status, 0);
      assert.ok((result.stderr + result.stdout).includes('Session is active in phase hands_executing'));
    });
  });

  // ── BETWEEN Read-Only Guards ────────────────────────────────────────────
  describe('BETWEEN Read-Only Guards', () => {
    let tempDir;
    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'between-guards-'));
      await fs.mkdir(path.join(tempDir, '.bridge'), { recursive: true });
    });
    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('corrupting providers.json mid-task causes consult to block with named error', async () => {
      const runner = require('../bridge-runner');
      const { runProcess } = require('../bridge-adapter');
      const coordinatorPath = path.join(bridgeRoot, 'bridge-coordinator.js');
      // Set up state in hands_consulting
      await fs.writeFile(path.join(tempDir, '.bridge', 'state.json'), JSON.stringify({
        phase: 'hands_consulting',
        schema_version: 1,
        approach: { summary: 'test chunk', files: ['foo.js'] },
        hands_session_id: 'sess-1'
      }));
      // Corrupt providers.json
      await fs.writeFile(path.join(tempDir, '.bridge', 'providers.json'), 'BROKEN{JSON');

      const outcome = await runner.consult({
        cwd: tempDir,
        runProcess: async (command, args, opts) => {
          if (command === process.execPath && args && args[0] === coordinatorPath) {
            return runProcess(command, args, opts);
          }
          return { ok: true, stdout: '' };
        }
      });
      assert.ok(outcome.state);
      assert.equal(outcome.state.phase, 'blocked_user');
      assert.ok(outcome.error.includes('Corrupt providers.json'));
    });
  });

  // ── AFTER Passive Detector ──────────────────────────────────────────────
  describe('AFTER Passive Detector', () => {
    it('latency --json includes schema_version', () => {
      const result = spawnSync(process.execPath, [bridgeCli, 'latency', '--json'], {
        encoding: 'utf8',
        cwd: bridgeRoot
      });
      assert.equal(result.status, 0);
      const parsed = JSON.parse(result.stdout);
      assert.equal(typeof parsed.schema_version, 'number');
      assert.equal(parsed.schema_version, MODULE_VERSION);
    });

    it('doctor includes Lifecycle check', () => {
      const result = spawnSync(process.execPath, [bridgeCli, 'doctor'], {
        encoding: 'utf8',
        cwd: bridgeRoot
      });
      assert.equal(result.status, 0);
      assert.ok(result.stdout.includes('Lifecycle'), 'doctor output should contain Lifecycle check');
    });
  });
});
