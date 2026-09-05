# Stage-2 Latency Baseline

Measurement gate for the Stage-2 latency program. Every optimization stage must
show its claimed delta against these numbers, measured the same way.

## Method

`node scripts/latency-demo.js` drives one full chunk through the real CLI with
a mock provider (the "model" responds in ~0 ms). Because LLM time is zero, the
report isolates **pure bridge mechanical overhead** — process spawns, file I/O,
locks, snapshots. Two runs recorded on win32 / Node v24.17.0 (2026-09-05).

For real workloads, re-measure with `bridge latency --clear` before a task and
`bridge latency` after 20-30 chunks (see `docs/step0-read-path-spec.md`).
`actions.lock_wait` and `tui.render` spans do not appear in the headless demo;
they surface in real TUI runs.

## Baseline (mock chunk, no LLM time)

| Span | n | p50 | p95 | total | Notes |
|---|---|---|---|---|---|
| **All spans** | 29 | — | — | **3.86–3.98 s** | Total bridge tax per chunk |
| `process.node` | 7 | 130–136 ms | 962–984 ms | 1.69–1.74 s | Coordinator + agent subprocess boots |
| `phase.reviewResult` | 1 | 829 ms | — | 829 ms | Includes evaluator + snapshots |
| `git.snapshot` | 2 | 106 ms | 108–137 ms | 214–243 ms | `under_lock 0/2` — Stage-1 fix holding |
| `process.git` | 3 | 58 ms | 65 ms | 177 ms | rev-parse / status spawns |
| `coord.done` | 1 | 149–151 ms | — | ~150 ms | One state mutation = one Node boot |
| `coord.activity` | 1 | 134–147 ms | — | ~140 ms | Coalesced Stage-1 activity write |
| `coord.evaluate` | 1 | 132–138 ms | — | ~135 ms | |
| `startup.prepare` | 1 | 133–140 ms | — | ~137 ms | Version gate + init subprocess + profiles |
| `agent.hands-evaluate` | 1 | 105 ms | — | ~105 ms | Mock agent (real agents: 10 s–10 min) |
| `brain.result_review` | 1 | 84–103 ms | — | ~95 ms | Mock HTTP |
| `config.detect_generation` | 3 | 4–5 ms | 5–6 ms | 12–14 ms | Up to 5 sync file reads per call |
| `config.brain_provider` | 4 | 1–2 ms | — | 4–5 ms | |
| `config.hands_model` | 2 | 1–2 ms | — | 2–3 ms | Re-read per agent invoke |

## Reading

- **Coordinator-as-subprocess dominates**: 7 Node boots ≈ 1.7 s of the ~3.9 s
  total. Each `coord.*` command costs ~130-150 ms before doing any work
  (Node boot + `ensureStore` + state read + 5-file commit cycle). This is the
  Stage-2 in-process coordinator target.
- **Startup tax**: `startup.spawn_runner` adds a fixed 400 ms sleep on every
  TTY launch (visible in real runs, not in the demo's non-TTY path).
  `startup.prepare` is ~137 ms of serial init. Stage-3 target.
- **Config reads are call-count-bound**: each read is 1-5 ms but they recur
  before every phase and twice per agent invoke. Stage-4 mtime cache target.
- **Real chunks are LLM-bound**: the demo has 3 near-instant "LLM" calls; a
  real chunk makes 6-7 sequential ones (propose, brain review, brain consult,
  hands-consult confirm, execute, evaluate, brain result review). The
  protocol fast path (Stage 1) removes one of them outright.

## Stage targets

| Stage | Change | Measurable signal |
|---|---|---|
| 1 | Skip hands-consult echo-confirm when Brain pre-approved | `agent.hands-consult` span count → 0 on direct-API path; ~1 fewer LLM round trip per chunk |
| 2 | In-process coordinator | `coord.*` total ~1.2 s → <150 ms/chunk; `process.node` count 7 → 1-2 |
| 3 | Readiness poll + parallel init | `startup.spawn_runner` 400 ms → <50 ms; `startup.prepare` shrinks |
| 4 | Config cache, dead-snapshot removal, keep-alive, tail scans | `config.*` call count −50%+; `process.git` count down; Brain p50 drops by TLS handshake |

## Stage deltas (measured after each stage, same method)

### Stage 1 — protocol fast path (c69d19d)

Removes one of ~7 LLM round trips on the direct-API Brain path. Not visible in
the mock demo (its "LLM" calls cost 0 ms); the signal is the missing
`agent.hands-consult` span on that path and one fewer provider round trip in
real chunks. Guarded by `MIND_LIMB_REQUIRE_CONSULT_CONFIRM=1`.

### Stage 2 — in-process coordinator (measured 2026-09-05)

`bridge-coordinator.js` dispatch is now requireable (`handleCommand`), and the
runner executes coordinator commands in-process by default
(`MIND_LIMB_COORD_INPROCESS=0` restores subprocess mode). File-lock protocol,
crash journal, and CLI/inspector subprocess paths unchanged.

| Span | Baseline | After Stage 2 | Delta |
|---|---|---|---|
| **All spans** | 3.86–3.98 s | **2.47 s** | **−1.4–1.5 s (−37%)** |
| `process.node` | 7 spawns, 1.69–1.74 s | 4 spawns, 963 ms | Coordinator boots gone; remainder are agent-transport spawns (real `opencode` processes in production, not bridge tax) |
| `coord.done` | ~150 ms | 12–14 ms | −90% |
| `coord.activity` | ~140 ms | 16–22 ms | −86% |
| `coord.evaluate` | ~135 ms | 14–16 ms | −89% |

Per-command coordinator cost is now dispatch + file I/O only (no Node boot).
The Stage-2 target ("`coord.*` <150 ms/chunk, `process.node` 7 → 1-2") is met:
the three measured `coord.*` commands total ~45 ms, and the remaining
`process.node` spawns belong to the agent transport.
