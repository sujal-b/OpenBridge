# Mind-Limb Bridge

A small local Brain (MIND/Codex) -> HANDS (OpenCode) workflow with approval,
visibility, and one active agent at a time.

## Model routing

- HANDS and HANDS-PROPOSE use OpenCode Zen's current rolling alias: `opencode/deepseek-v4-flash-free`.
- MIND and HANDS-to-MIND `ask_codex` guidance use `gpt-5.6-terra` with high reasoning.

## Public commands

```powershell
bridge install
bridge open .
bridge run "Add upload validation"
bridge watch
bridge inspect
```

`bridge open .` also creates missing project-local OpenCode profiles under
`.opencode/agents/`. It never overwrites existing profiles or changes global
settings. The consultation profile allows only the Brain MCP tool; the
execution profile explicitly denies `ask_codex`, subagents, skills, and
external-directory access. The global `ask-codex` MCP server must still be
installed once. Because the profiles are project files, run `bridge open .`
before creating the first baseline commit, or commit the newly-created
`.opencode/agents/` files once in an existing repository.

bridge run starts or continues the current task. HANDS must propose one small
chunk with named files and focused validation. The bridge requires a Git
repository with a baseline commit before approval. The sequence is:

    proposal -> Brain approval -> read-only Brain consultation -> one execution lease -> Brain review

Only the lease holder can execute the approved files. A lease is claimed once;
if execution is interrupted, recovery invalidates it and the next run must
consult Brain again. A new chunk cannot start until Brain uses bridge done or
bridge revise.

If HANDS has a material question, it stops safely. Answer it with:
bridge revise "Use the minimal implementation with focused tests"

```powershell
bridge approve
bridge revise "Use a smaller change and add a unit test"
bridge done "Reviewed changes and tests pass"
```

For a project in another folder, add `--project <folder>` to any command.

## Live monitoring

`bridge watch` is the compact terminal dashboard. It repaints one frame, so it
does not print the same status repeatedly. During `hands_consulting`, it shows
that HANDS is waiting for Brain guidance; during `hands_executing`, it shows
the claimed chunk and the live activity summary.

`bridge inspect` starts a local browser inspector and prints its URL. The
inspector provides a live Control Room with separate MIND/Codex and HANDS/OpenCode summaries, an expandable live timeline, grouped by task chunk, with
agent/action/risk/status cards, sanitized tool summaries, details on demand,
and controls synchronized with the terminal. It shows waiting/stale connection status and prevents duplicate controls while one command is running. The Bridge is the only control surface; the agent panels are views. It does not start work by itself.

Use `bridge policy` to view the project safety policy.

## Provider fallback

Read-only HANDS proposals retry once by default after transient provider
failures, invalid structured output, or timeouts. Retries reuse a discovered
provider session. Code execution is not blindly replayed after a failure;
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
    $env:MIND_LIMB_MAX_CHUNK_FILES = 3
    $env:MIND_LIMB_BRIDGE_TIMEOUT_MS = 630000

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

## Safety and records

- `.bridge/state.json` is the authoritative state.
- `.bridge/events.jsonl` is the lifecycle overview log.
- `.bridge/actions.jsonl` records bounded provider/tool summaries; secrets are redacted.
- `.bridge/policy.json` stores safe defaults and project overrides.
- `.bridge/agent.lock` prevents parallel HANDS calls.
- The HANDS session ID is preserved across chunks.
- A dirty Git tree blocks approval; non-Git projects cannot enter execution.
- Changed files are checked against the approved file list, including untracked,
  deleted, renamed, and out-of-scope paths.
- Provider failures and blocked questions wait for the user.
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

Run the isolated pre-production suite:

```powershell
& .\preprod-evaluate.ps1
```

The suite covers CLI behavior, coordinator transitions, atomic/recoverable
state commits, provider adapter timeouts, session reuse, no-parallel locking,
telemetry concurrency, live inspector HTTP/SSE behavior, bounded long logs,
sequential chunks, concurrent mutation attempts, stale locks, and Git checks.