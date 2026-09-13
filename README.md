# Mind-Limb Bridge

A small local Brain (MIND/Codex) <-> HANDS (OpenCode) workflow with autonomous
Brain handoffs, visibility, and one active agent at a time.

## Model routing

- HANDS, HANDS-PROPOSE, HANDS-CONSULT, and HANDS-EVALUATE use `opencode/muse-spark-1.2-contributor-free` (Zen, via `opencode run` subprocess).
- MIND (Brain) uses `opencode/muse-spark-1.3-contributor-free` (Zen, via `opencode run` subprocess with the `brain` agent profile) — never direct HTTPS.

## Public commands

```powershell
bridge install
bridge open .
bridge run "Add upload validation"
bridge watch
bridge inspect
bridge status
bridge unlock
bridge unlock-agent
```

For a new disposable or mock project, use one command:

```powershell
bridge new "D:\Projects\Bridge-Mock-E2E" --name "Sujal Barwad" --email "sujal.barwad27@gmail.com"
Set-Location "D:\Projects\Bridge-Mock-E2E"
bridge run "your task"
```

The `--name` and `--email` flags are optional when Git identity is already configured globally. For an existing project, keep using `bridge open`.

`bridge open .` also creates missing project-local OpenCode profiles under
`.opencode/agents/` and creates or updates the root `.gitignore` with
`.bridge/`, `.opencode/`, `node_modules/`, and `dist/` runtime entries. Existing
`.gitignore` content and profiles are preserved; entries are added idempotently.
It never changes global settings. The consultation profile allows only the Brain MCP
tool; the execution profile may edit only approved files, while evaluation denies edits, subagents,
skills, and external-directory access. `hands-evaluate` is the read-only role
for checking the completed chunk and its validation evidence. The global `ask-codex` MCP server must still be
installed once. Because the profiles are project files, run `bridge open .`
before creating the first baseline commit, or commit the newly-created
`.opencode/agents/` files once in an existing repository.

bridge run starts or continues the current task. HANDS proposes one small chunk
with named files and focused validation. The bridge requires a Git repository
with a baseline commit before the Brain <-> HANDS handoff. The autonomous sequence is:

    proposal -> Brain evaluates -> read-only Brain consultation -> one execution lease -> HANDS-EVALUATE/Brain review

The loop advances without an ordinary user approval prompt. `bridge approve` remains
a compatibility command for manually controlled sessions. Only the lease holder can
execute the approved files. A lease is claimed once;
if execution is interrupted, recovery invalidates it and the next run must
consult Brain again. A new chunk cannot start until Brain uses bridge done or
bridge revise.

If HANDS cannot make a safe, reviewable proposal because of a material dependency, it stops safely. Answer it with:
bridge revise "Use the minimal implementation with focused tests"

```powershell
# Only needed when a proposal is blocked or needs correction
bridge revise "Use a smaller change and add a unit test"
bridge done "Reviewed changes and tests pass"
```

For a project in another folder, add `--project <folder>` to any command.

## Live monitoring

`bridge watch` is the compact terminal dashboard. It repaints one frame, so it
does not print the same status repeatedly. The Flow line shows the autonomous
Brain <-> HANDS handoff and Evaluation shows the latest read-only review. During
`hands_consulting`, it shows
that HANDS is waiting for Brain guidance; during `hands_executing`, it shows
the claimed chunk and the live activity summary.

`bridge inspect` starts a local browser inspector and prints its URL. The
inspector provides a live Control Room with separate MIND/Codex and HANDS/OpenCode summaries, an expandable live timeline, grouped by task chunk, with
agent/action/risk/status cards, sanitized tool summaries, details on demand,
and controls synchronized with the terminal. It shows waiting/stale connection status and prevents duplicate controls while one command is running. The Bridge is the only control surface; the agent panels are views. It does not start work by itself.

Use `bridge policy` to view the project safety policy.

## Latency instrumentation

Every autonomous run records timing spans to `.bridge/latency.jsonl`: phase
wall time (propose, consult, execute, review), provider process cold-start
versus work time, Brain HTTP DNS/connect/TTFB/total with retry attempts,
coordinator subprocess calls per chunk, prompt/response sizes, and git
snapshots taken under the state lock.

```powershell
bridge latency              # P50/P95 per span, sorted by total time
bridge latency --json       # machine-readable summary
bridge latency --clear      # reset the collected data
```

Notes:

- Spans are buffered in memory and flushed on a timer; the instrumentation
  never takes the telemetry lock, so measuring a run does not change its
  timing.
- `phase.execute` includes `phase.reviewResult` when the run continues
  autonomously; nested phases are marked `nested:true` in the raw spans.
- `git.snapshot` reports `under_lock` — time spent in git while holding the
  coordinator state lock.
- The file rotates at 4 MB to `latency.jsonl.1`. Set `MIND_LIMB_LATENCY=0`
  to disable recording entirely.

## Provider fallback

Read-only HANDS proposals retry once by default after transient provider
failures, invalid structured output, or timeouts. A hard provider fault
(HTTP 5xx, `UnknownError`, server crash) drops the poisoned session and
retries with a **fresh session** — reusing a session that just server-faulted
reproduces the fault. Provider error payloads are humanized before they reach
the state record: you see `Provider server error: UnknownError — Unexpected
server error (ref err_...)` instead of a raw JSON blob, and the provider ref
stays for debugging. Code execution is not blindly replayed after a failure;
the bridge escalates it for user inspection first.

OpenCode JSON mode is an event stream. The bridge unwraps the final decision
from event text such as part.text, keeps parsing bounded per event, and
tolerates harmless markdown/progress wrappers without treating arbitrary
provider text as approval.

Optional PowerShell settings:

    $env:MIND_LIMB_AGENT_RETRY_ATTEMPTS = 2
    $env:MIND_LIMB_AGENT_RETRY_DELAY_MS = 250
    $env:MIND_LIMB_PROPOSAL_TIMEOUT_MS = 180000
    $env:MIND_LIMB_EXECUTION_TIMEOUT_MS = 600000
    $env:MIND_LIMB_AGENT_TIMEOUT_MS = 300000
    $env:MIND_LIMB_MAX_CHUNK_FILES = 3
    $env:MIND_LIMB_BRIDGE_TIMEOUT_MS = 630000

When Brain consultation succeeds through the direct API, the bridge skips the
redundant HANDS echo-confirm call and mints the execution lease directly (the
coordinator consultation gate still validates the record). Set
`MIND_LIMB_REQUIRE_CONSULT_CONFIRM = 1` to restore the extra HANDS-CONSULT
round trip.

Coordinator commands issued by the runner execute in-process (one Node process
total instead of one boot per state mutation). The file-lock protocol is
unchanged, so CLI, TUI, and inspector subprocess callers interleave safely. Set
`MIND_LIMB_COORD_INPROCESS = 0` to force the runner back to spawning
`bridge-coordinator.js` per command.

Startup is also leaner: `bridge open` prepares the project concurrently and
skips initialization when the store is already present, and`bridge run` auto-resumes a blocked session (dirty tree, provider failures,
revisions pending): `run` means "continue", always. The only refusals carry
their remedy: `bridge recover` after interrupted execution, or a decision
(`bridge revise` / `bridge done`) after a policy escalation or material
proposal blocker. `bridge run` returns the moment the runner's first state mark lands in `.bridge/state.json`
(process death or a 5 s cap cut the wait short — set
`MIND_LIMB_RUNNER_READY_MS` to widen the cap). Brain HTTP calls reuse one
keep-alive TLS connection per host, and repeated config reads are served from
an mtime-keyed cache, so per-chunk overhead stays flat as sessions grow.

Execution is not automatically retried because HANDS may have edited files
before a timeout. Inspect first, then run:

    bridge recover
    bridge resume

The bridge will create a fresh Brain consultation and a fresh execution lease.
It will not replay the old lease.

bridge resume is deliberately refused until bridge recover acknowledges
the inspection. This prevents duplicate edits.
## Interrupted execution

If a terminal closes while HANDS is executing, inspect the working tree first.
If no HANDS process is running, use:

```powershell
bridge recover
bridge resume
bridge run
```

Recovery refuses to change state while a live provider lock exists. Stale locks
are only removed when ownership is proven dead or the user explicitly requests
stale-lock cleanup.

## Working tree and Git ownership

The bridge never commits your own work. It manages only the tree churn its own
execution produced:

- **Before a chunk runs** (proposal preflight and the approval gate), the tree
  must be clean. The block lists the offending files (first 10), so stray
  `.env` files, editor droppings, or unrelated edits are self-diagnosing.
  The one-step remedy is `bridge resume --commit "checkpoint"` — it commits
  your changes and resumes in the same command (custom message optional;
  a user-staged index is never swept in). The proposal still stands and
  no re-proposal is needed. `bridge revise` is refused at this block because
  it cannot clean a tree.
- **Bridge-owned scaffold never blocks.** Files the bridge itself created
  (`opencode.json` via `bridge open`/`new`) are recorded with a content hash in
  `.bridge/scaffold.json` and auto-committed when still untracked and unchanged.
  If you edit a scaffold file, it becomes yours — it blocks like any other
  dirt and the `resume --commit` remedy applies. Runtime data directories
  (`.omo/`, `.opencode/`, `.claude/`, …) are exempt without a manifest.
- **Agent/tool runtime data is exempt.** Untracked files under known agent
  and tool runtime directories (`.omo/`, `.claude/`, `.cursor/`, `.codex/`,
  and others — the runtime hosting the HANDS session writes
  `.omo/run-continuation/*.json` mid-session) never count as dirt: not at the
  gate, not in the completion scope check, not in the auto-commit. Tracked
  changes inside those directories still block. For other generated paths,
  add them to `.gitignore` or to `approval.ignorePaths` in
  `.bridge/policy.json`; `bridge new`/`open` scaffold the known ones.
- **Revision cycles are hands-free.** When the Brain rejects a chunk result,
  the rejected attempt's own changes may stay in the tree: re-proposal,
  re-approval, and re-execution tolerate them as long as HEAD sits on the
  chunk baseline and every dirty file is inside the chunk's accumulated
  approved scope. Anything you add — or a commit you make mid-cycle — snaps
  the strict clean-tree rule back on.
- **Accepted chunks are auto-committed.** When the Brain accepts a chunk
  result (or you confirm with `bridge done`), exactly the chunk's accepted
  files are committed as `bridge(chunk): <task>`. Your own staging is never
  swept in (the commit is skipped instead), and files outside the chunk scope
  stay uncommitted for you to handle. With no Git identity configured, the
  commit falls back to a `mind-limb-bridge` identity.

You stay on the keyboard only for work that is genuinely yours.

## Safety and records

- `.bridge/state.json` is the authoritative state.
- `.bridge/state.json.corrupt-*` keeps a repaired corrupt snapshot for up to 7 days.
- `.bridge/events.jsonl` is the lifecycle overview log.
- `.bridge/actions.jsonl` records bounded provider/tool summaries with target path, op, and command; secrets are redacted.
- `.bridge/policy.json` stores safe defaults and project overrides.
- `.bridge/agent.lock` prevents parallel HANDS calls.
- The HANDS session ID is preserved across chunks.
- A dirty Git tree blocks the Brain <-> HANDS execution handoff as a `dirty_tree`
  block that `bridge resume` re-enters after cleanup; a revision cycle tolerates
  its own attempt's changes, and accepted chunks are auto-committed (see
  "Working tree and Git ownership"). Non-Git projects cannot enter execution.
- Changed files are checked against the approved file list, including untracked,
  deleted, renamed, and out-of-scope paths.
- Provider failures can be resumed; material proposal blockers require bridge revise.
- `hands-evaluate` is read-only and reports pass/fail evidence without changing files.
- A single-use execution lease prevents duplicate provider execution.
- State, plan, and event commits have a short crash-recovery journal.

## Validation

Run the dependency-free baseline checks:

```powershell
& .\evaluate.ps1
```

Run the focused Control Room checks first:

    & .\evaluate-control-room.ps1

Run the recovery checks:

    & .\evaluate-recovery.ps1

The `qa-*` Node suites cover detector, recovery, state, race, and CLI regressions.
`MIND_LIMB_AGENT_TIMEOUT_MS` supplies proposal, execution, and consultation defaults;
per-command `--timeout-ms` takes precedence, then this variable, then built-in defaults.

Run the isolated pre-production suite:

```powershell
& .\preprod-evaluate.ps1
```

The suite covers CLI behavior, coordinator transitions, atomic/recoverable
state commits, provider adapter timeouts, session reuse, no-parallel locking,
telemetry concurrency, live inspector HTTP/SSE behavior, bounded long logs,
sequential chunks, concurrent mutation attempts, stale locks, and Git checks.
