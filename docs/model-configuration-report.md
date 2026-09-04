# Mind / Hands Model Configuration — Analysis & Recommendations

**Scope:** how the MIND (Brain) and HANDS (OpenCode) models are configured, resolved,
and actually used at runtime in the Mind-Limb Bridge.
**Analyzed at:** commit `da519d3` (clean working tree), Windows, Node 22.
**Sources:** `bridge-brain.js`, `bridge-config.js`, `bridge-runner.js`, `bridge-adapter.js`,
`bridge.js`, `bridge-state.js`, `opencode.json`, `.opencode/agents/*.md`, `.bridge/brain.json`,
`~/.config/opencode/opencode.jsonc`.

---

## 1. Executive summary

The bridge does **not** have one model configuration system. It has **two unrelated ones**
that are configured in different places, resolved by different code, and documented
inconsistently:

| | MIND (Brain) | HANDS |
|---|---|---|
| Transport | Direct HTTPS from Node (`https.request`) | `opencode run --agent <role>` subprocess |
| Config store | `.bridge/brain.json` (legacy) or `.bridge/providers.json` | `opencode.json` provider block **+** `.opencode/agents/*.md` frontmatter |
| Model source | `config.model` → env → provider default | `model:` key in the agent profile frontmatter |
| Overridable at runtime | No (no CLI flag reaches it) | Only via `opencode --model`, which the bridge never passes |
| Actual model in this repo | `bd/deepseek-v4-pro-0813` @ `router.nilovr.web.id/v1` | `local-router/bd/Deepseek-V4-Flash-0731` @ `localhost:20128/v1` |

**Three P0 findings:**

1. **`bridge config hands use <provider> <model>` is a no-op.** It writes
   `.bridge/providers.json`, but `bridge-runner.js` never reads it and never passes
   `--model`. Users can "switch" the HANDS model all day and nothing changes.
2. **HANDS points at a local router that is not running.** All four agent profiles use
   `local-router/bd/Deepseek-V4-Flash-0731`; `local-router` resolves to
   `http://localhost:20128/v1`, which was not listening at analysis time.
3. **The README and `.env.example` describe a different system than the code ships.**
   README claims HANDS uses `opencode/deepseek-v4-flash-free` and MIND uses
   `gpt-5.6-terra` with "high reasoning". Neither string appears in the active config,
   and no reasoning-effort knob exists anywhere in `bridge-brain.js`.

---

## 2. How model resolution actually works

### 2.1 MIND (Brain) — `bridge-brain.js`

Brain is a hand-rolled HTTP client, not an agent. Seven providers are hardcoded in the
`PROVIDERS` table, each with `endpoint`, `buildBody`, `extractText`, `headers`, `defaultModel`:

`gemini`, `openrouter`, `groq`, `ollama`, `openai`, `custom`, `anthropic`.

`resolveConfig(options)` picks values in this order (highest wins):

| Field | Precedence chain |
|---|---|
| `provider` | `options.provider` → `config.provider` → `providers.json brain.active` → `MIND_LIMB_BRAIN_PROVIDER` → `'custom'` if any baseURL key present → **throw** |
| `model` | `options.model` → `config.model` → `MIND_LIMB_BRAIN_MODEL` → `spec.defaultModel` |
| `apiKey` | `options.apiKey` → `config.api_key`/`apiKey` → `MIND_LIMB_BRAIN_API_KEY` → `BRAIN_API_KEY` → `GEMINI_API_KEY` |
| `timeoutMs` | `options.timeoutMs` → `config.timeout_ms`/`timeoutMs` → **`60000` (hardcoded)** |

`config` = `getActiveBrainProviderSync(cwd)?.config` **||** the legacy `.bridge/brain.json`
blob **||** `{}`.

Transport behaviour: `httpPostWithRetry` — 3 attempts, retries on
`brain_api_timeout`, HTTP 429, and HTTP ≥ 500, exponential backoff capped at 30 s,
honouring `Retry-After`. No retry on 4xx other than 429, no circuit breaker, no
per-provider timeout budget (60 s default applies to every call including the
longest review).

Requests are always `temperature: 0.1` with `max_tokens: 1024` (2048 for `custom`).
There is **no** reasoning-effort, top-p, or max-token knob.

### 2.2 HANDS — `bridge-runner.js` → `bridge-adapter.js`

`buildOpencodeArgs()` emits:

```
opencode run --agent <role> --format json [--model <id>] [--session <id>] --dir <cwd> <prompt>
```

`--model` is emitted **only if `options.model` is truthy**. In the entire runtime, the
only place `options.model` is ever set is the proposal fallback in
`invokeAgentWithRetry` (see §4, P1-4). For everything else, OpenCode resolves the model
from the agent profile frontmatter in `.opencode/agents/*.md`:

| Profile | `model:` | Key permissions |
|---|---|---|
| `hands.md` | `local-router/bd/Deepseek-V4-Flash-0731` | `edit: allow`, `bash: allow`; `task`/`skill`/`webfetch`/`websearch`: deny |
| `hands-propose.md` | `local-router/bd/Deepseek-V4-Flash-0731` | read-only; `edit`/`bash`: deny |
| `hands-consult.md` | `local-router/bd/Deepseek-V4-Flash-0731` | read-only; template grants `ask-codex_*: allow` (on-disk copy does **not**) |
| `hands-evaluate.md` | `local-router/bd/Deepseek-V4-Flash-0731` | read-only + `bash: allow` |

`local-router` is defined in the project `opencode.json`:

```json
"local-router": {
  "npm": "@ai-sdk/openai-compatible",
  "options": { "baseURL": "http://localhost:20128/v1", "apiKey": "{env:OPENCODE_API_KEY}" },
  "models": { "bd/Deepseek-V4-Flash-0731": {...}, "oc/x-preview-f-free": {...}, "bd/Kimi-k2.7-code": {...} }
}
```

Note the layering trap: the **global** `~/.config/opencode/opencode.jsonc` sets
`"model": "nvidia-nim/deepseek-ai/deepseek-v4-pro-0813"` and
`"small_model": "nvidia-nim/deepseek-ai/deepseek-v4-flash-0731"`, and its `provider`
block contains `nvidia-nim`, `nilovr`, `tokenrouter` — **not** `local-router`. The global
defaults are irrelevant during a bridge run because agent frontmatter wins; they only
matter if a profile is missing its `model:` key.

### 2.3 Where configuration is stored

```
.bridge/providers.json   { brain: { active, custom{} }, hands: { active: {provider, model} } }   ← DOES NOT EXIST here
.bridge/brain.json       { provider, baseURL, api_key, model, timeout_ms }                       ← legacy, but authoritative today
opencode.json            { provider: { <name>: { npm, options, models } } }                        ← tracked in git
.opencode/agents/*.md    frontmatter `model:`                                                     ← tracked in git
.env                     documented by .env.example, never loaded by any code
```

`.bridge/brain.json` currently holds a live API key in cleartext (redacted here). It is
git-ignored (`.gitignore:1`), so it is not in history, but it is world-readable on disk.

---

## 3. The live pipeline: which model runs when

| # | Phase | Mechanism | Model invoked |
|---|---|---|---|
| 1 | `proposal` | `opencode run --agent hands-propose` | `local-router/bd/Deepseek-V4-Flash-0731` |
| 2 | `proposal review` (MIND) | `brainReviewProposal()` → **direct HTTP** | `bd/deepseek-v4-pro-0813` |
| 3 | `consultation` (MIND) | `brainConsultChunk()` → **direct HTTP** | `bd/deepseek-v4-pro-0813` |
| 4 | `consultation gate` | `opencode run --agent hands-consult` | `local-router/bd/Deepseek-V4-Flash-0731` |
| 5 | `execution` | `opencode run --agent hands` | `local-router/bd/Deepseek-V4-Flash-0731` |
| 6 | `evaluation` | `opencode run --agent hands-evaluate` | `local-router/bd/Deepseek-V4-Flash-0731` |
| 7 | `result review` (MIND) | `brainReviewResult()` → **direct HTTP** | `bd/deepseek-v4-pro-0813` |

MIND is reached **five model calls per chunk** (proposal review, consultation, plus
retries), each a separate cold HTTPS request with no session reuse.

The `ask_codex` MCP path is **fallback-only**. In `autoAdvance` (line 979) and
`reviewResult` (line 895) the bridge only falls through to the `hands-consult` agent +
`ask_codex` when the direct Brain call throws `brain_config_error` (missing API key /
unknown provider) or when `options.runProcess` is injected (tests only).

---

## 4. Findings

### P0-1 — `bridge config hands use` writes configuration nothing consumes

`bridge.js:1212` calls `setActiveHandsModel()`, which persists
`hands.active = { provider, model }` into `.bridge/providers.json`.
`getActiveHandsModel()` is then referenced **only** in `bridge.js` (lines 1061, 1169)
for display. `bridge-runner.js` never imports it and never sets `options.model`.

Consequence: the advertised way to change the HANDS model has zero runtime effect. The
real switch is editing `model:` in four `.opencode/agents/*.md` files by hand.

### P0-2 — HANDS depends on a local router that is not running

All four profiles resolve to `local-router` → `http://localhost:20128/v1`. `netstat`
showed nothing bound to 20128 during analysis. Every HANDS phase fails until the router
is started or the profiles are repointed. `ensureOpencodeConfig()` hardcodes this baseURL
with no validation and no env override, so `bridge open .` silently produces a broken
config on any machine without the router.

`OPENCODE_API_KEY` is also untested; if unset, the router is called with an empty bearer.

### P0-3 — Documentation and `.env.example` describe a system that does not exist

| Claim | Reality |
|---|---|
| README: HANDS uses `opencode/deepseek-v4-flash-free` | `local-router/bd/Deepseek-V4-Flash-0731` |
| README: MIND uses `gpt-5.6-terra` with high reasoning | `bd/deepseek-v4-pro-0813`; **no reasoning-effort parameter exists in the codebase** |
| `.env.example`: Brain default is `gemini-2.0-flash` | `ensureBrainConfig()` seeds `provider: 'custom'`, `model: 'bd/deepseek-v4-pro-0813'` |
| `.env.example`: `MIND_LIMB_BRAIN_PROVIDER` / `_MODEL` / `_TIMEOUT_MS` | All three are **unreachable** (see P1-5) |

### P1-4 — Proposal fallback model is stale and nearly unreachable

`invokeAgentWithRetry` uses `opencode/big-pickle` when: agent is `hands-propose`
**and** attempt > 1 **and** `lastError.code === 'invalid_provider_result'`.
`opencode/big-pickle` is defined in neither the project `opencode.json` nor the global
`opencode.jsonc`; it relies on the built-in OpenCode Zen provider still exposing that
alias. The most common failure — `provider_timeout` — never triggers the fallback at all.

### P1-5 — Three documented Brain env vars are dead code

Because `config.model`, `config.provider`, and `config.timeout_ms` are **always** present
(`ensureBrainConfig()` writes them on `bridge open .`), they always win:

```js
var provider  = options.provider || config.provider     || providerConfig?.name || env.…   // config wins
var model     = options.model    || config.model        || env.MIND_LIMB_BRAIN_MODEL || …  // config wins
var timeoutMs = options.timeoutMs || config.timeout_ms  || 60000;                          // env never consulted
```

`MIND_LIMB_BRAIN_PROVIDER`, `MIND_LIMB_BRAIN_MODEL`, and `MIND_LIMB_BRAIN_TIMEOUT_MS`
can therefore never take effect once a project has been opened. `bridge.js` consumes
`MIND_LIMB_BRAIN_API_KEY` only when seeding the default file, not at runtime.

### P1-6 — The `ask_codex` fallback is structurally broken

When the direct Brain call is unconfigured, the bridge falls back to requiring an
observable `ask_codex` MCP event (`bridge-state.js:isBrainConsultationEvent`), throwing
`brain_review_missing` otherwise. But:

- No `ask-codex` MCP server is defined in `~/.config/opencode/opencode.jsonc` (only the
  plugins `oh-my-openagent` and `opencode-antigravity-auth`).
- The on-disk `.opencode/agents/hands-consult.md` has **no** `ask-codex_*: allow` entry,
  and its `"*": deny` default means the tool is denied.
- `ensureLocalAgentProfiles()` only rewrites a profile if it contains
  `opencode/deepseek-v4-flash-free` or `oc/x-preview-f-free`. The on-disk profiles
  contain neither, so **drifted profiles are never repaired**.

So the fallback path cannot succeed, and it triggers precisely when a user has no Brain
key — the worst moment to fail.

### P1-7 — `addHandsProvider` / `removeHandsProvider` can destroy `opencode.json`

Both functions `JSON.parse` the file inside a `try/catch`; on failure they fall back to
`data = {}`. If the file is `opencode.jsonc`, has comments, or is momentarily
unparseable, the next `add` rewrites it as `{ "provider": { … } }`, silently discarding
`$schema`, `model`, `small_model`, `plugin`, and every other provider.

### P1-8 — Secrets in cleartext; no `{env:…}` indirection for Brain

`opencode.json` already uses the good pattern (`"apiKey": "{env:OPENCODE_API_KEY}"`).
`bridge-brain.js` has no equivalent — the key must be a literal in `.bridge/brain.json`.
The global `opencode.jsonc` also stores three provider keys (NVIDIA NIM, NiloVR,
TokenRouter) in cleartext.

### P2-9 — No per-role model selection

All four roles share one model id. `hands` (edits, bash, long context) has materially
different requirements from `hands-propose` / `hands-evaluate` (read-only, short
JSON output). Today you cannot promote the executor to a stronger model without also
upgrading the read-only roles.

### P2-10 — Sync and async Brain resolution disagree

`getActiveBrainProvider()` (async) falls back to `{ name: 'gemini' }`.
`getActiveBrainProviderSync()` returns `null`. So `bridge config show` reports
`gemini` in a fresh project while `resolveConfig()` throws `brain_config_error`.

### P2-11 — `custom` is a provider in `PROVIDERS` but not in `BUILTIN_BRAIN_PROVIDERS`

`BUILTIN_BRAIN_PROVIDERS` has 6 entries; `PROVIDERS` has 7. Therefore
`bridge config brain use custom` throws `providers_not_found` even though every project
is seeded with `provider: 'custom'` in `brain.json` and works fine.

### P2-12 — No validation when setting the active HANDS model

`bridge config hands use <p> <m>` accepts any strings without checking that `<p>` exists
in `opencode.json` or that `<m>` is in its `models` map. Harmless while P0-1 makes it a
no-op; a real footgun the moment it is wired up.

### P2-13 — Brain response parsing is regex-loose

`httpPost` extracts JSON with `text.match(/\{[\s\S]*\}/)` — greedy from the first `{` to
the last `}` anywhere in the body, including inside string values. `parseBrainJson`
then falls back to `parseStructuredResult`. A brace-balanced scanner already exists
(`bridge-adapter.balancedJsonFragments`) and should be reused.

### P2-14 — `.env` is documented but never loaded

No dotenv dependency; `package.json` has no dependencies at all. Users who fill in
`.env` get silently ignored configuration.

---

## 5. Recommendations

### Immediate (fix the broken behaviour)

**R1 — Make `bridge config hands use` real.** Preferred: have `bridge-runner.js` read the
active model once per phase and pass it through.

```js
// bridge-runner.js — resolve once, near the top of each phase function
const activeHands = await getActiveHandsModel(options.cwd || root);   // { provider, model } | null
const modelId = activeHands ? `${activeHands.provider}/${activeHands.model}` : undefined;
// …then pass `model: modelId` into every invokeAgent / invokeAgentWithRetry call
```

Because `--model` overrides frontmatter, this immediately makes the CLI authoritative
and lets you drop the per-file `model:` duplication. Alternative (less invasive): have
`config hands use` rewrite the `model:` frontmatter in all four profiles — but then the
profiles stay duplicated and out of git-friendly sync.

**R2 — Add a model preflight.** Before the first HANDS call, verify reachability and
fail with an actionable message:

```
HANDS model local-router/bd/Deepseek-V4-Flash-0731 is unreachable.
  baseURL http://localhost:20128/v1 refused the connection.
  Start the router, or run: bridge config hands use <provider> <model>
```

Also assert `OPENCODE_API_KEY` is non-empty when a provider uses `{env:…}`.

**R3 — Reconcile the docs with the code.** Update README's "Model routing" section and
`.env.example` to the real defaults, and delete the "high reasoning" claim or implement
it (see R6).

**R4 — Retire or repair `opencode/big-pickle`.** Make the fallback configurable and
reachable:

```js
const fallbackModel = options.proposalFallbackModel || process.env.MIND_LIMB_PROPOSAL_FALLBACK_MODEL || null;
const useFallbackModel = Boolean(fallbackModel) && attempt > 1
  && ['invalid_provider_result', 'provider_timeout'].includes(lastError?.code);
```

Default it to `null` — silently switching to a hardcoded, unverified third-party model
mid-run is worse than reporting the failure.

### Short term (remove the traps)

**R5 — Fix the Brain precedence chain.** Make explicit overrides beat stored config:

```js
var model    = options.model || process.env.MIND_LIMB_BRAIN_MODEL || config.model || spec.defaultModel;
var provider = options.provider || process.env.MIND_LIMB_BRAIN_PROVIDER || config.provider || …;
var timeoutMs = options.timeoutMs || Number(process.env.MIND_LIMB_BRAIN_TIMEOUT_MS) || config.timeout_ms || 60000;
```

**R6 — Add real generation parameters.** Expose `temperature`, `max_tokens`, and an
optional `reasoning_effort` / provider-specific passthrough per provider, defaulting to
today's values. This is what makes "MIND reasons harder than HANDS" actually true
instead of just a README sentence.

**R7 — Decide the fate of `ask_codex`.** Either (a) delete the MCP fallback and let
`brain_config_error` block with a clear "run `bridge config brain add`" message, or
(b) restore it properly: register the MCP server, add `ask-codex_*: allow` to
`hands-consult.md`, and make `ensureLocalAgentProfiles` use a version marker
(`# bridge-profile-version: 2`) rather than matching an old model string.

**R8 — Make profile generation idempotent and safe.** Write a `bridge-profile-version`
marker into the frontmatter comment or a `.opencode/agents/.bridge-version` file;
rewrite profiles whenever the marker is older than the bundled version. Read the user's
current model out of the existing profile first and preserve it.

**R9 — Never clobber `opencode.json`.** If `JSON.parse` fails, abort with
`providers_corrupt` instead of resetting to `{}`. Preserve `$schema` and unknown
top-level keys (already the case on the happy path). Add `{env:VAR}` resolution to
`bridge-brain.js` so Brain keys never need to sit in a file.

### Structural (the real fix)

**R10 — One source of truth.** Introduce a single `.bridge/models.json` (or extend
`providers.json`) that declares role → model:

```json
{
  "version": 1,
  "brain": { "provider": "custom", "model": "bd/deepseek-v4-pro-0813",
             "baseURL": "{env:MIND_LIMB_BRAIN_BASE_URL}", "api_key": "{env:MIND_LIMB_BRAIN_API_KEY}",
             "timeout_ms": 60000, "temperature": 0.1, "max_tokens": 2048 },
  "hands": {
    "default":  "local-router/bd/Deepseek-V4-Flash-0731",
    "roles": {
      "hands-propose":  "local-router/bd/Deepseek-V4-Flash-0731",
      "hands":          "local-router/bd/Deepseek-V4-Pro-0731",
      "hands-evaluate": "local-router/bd/Deepseek-V4-Flash-0731"
    },
    "fallbacks": { "hands-propose": null }
  }
}
```

`bridge-runner.js` reads this once and passes `--model` per role; `.opencode/agents/*.md`
keeps only permissions and system prompt (no `model:` at all, or a clearly-labelled
`model: {bridge-managed}`). `bridge config hands use` becomes a real switch with
validation against the provider's `models` map, and `bridge config show` reports the
effective model actually used per phase.

### Test coverage to add

- `config hands use X Y` → the next `invokeAgent` argv contains `--model X/Y` (this is
  the regression test that P0-1 needs).
- `resolveConfig` honours each env var when `brain.json` has a conflicting value.
- Preflight fails cleanly when the provider baseURL refuses connections.
- `addHandsProvider` preserves `$schema`, `plugin`, `model`, and unrelated providers;
  and refuses to write when the file is unparseable.
- `ensureLocalAgentProfiles` rewrites a drifted profile and preserves a customised
  `model:`.

---

## 6. Quick verification checklist

```powershell
bridge config show                      # does the Hands model match the profiles?
node -e "console.log(JSON.parse(require('fs').readFileSync('.bridge/brain.json','utf8')).model)"
Get-Content .opencode\agents\*.md | Select-String '^model:'
(Test-NetConnection localhost -Port 20128).TcpTestSucceeded   # is the router up?
```

Effective configuration at analysis time:

- **MIND:** `custom` → `bd/deepseek-v4-pro-0813` @ `https://router.nilovr.web.id/v1/chat/completions`,
  60 s timeout, temperature 0.1, max_tokens 2048, key from `.bridge/brain.json`.
- **HANDS:** `local-router/bd/Deepseek-V4-Flash-0731` @ `http://localhost:20128/v1`
  — **router down at analysis time**.
- **`.bridge/providers.json`:** absent (legacy `brain.json` is authoritative).
- **Fallback:** `opencode/big-pickle`, propose-only, unreachable in practice.
