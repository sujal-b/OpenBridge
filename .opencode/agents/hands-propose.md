---
description: Bridge read-only proposal agent.
mode: primary
model: opencode/deepseek-v4-flash-free
permission:
  "*": deny
  read: allow
  glob: allow
  grep: allow
  list: allow
  lsp: allow
  task: deny
  skill: deny
  external_directory: deny
  edit: deny
  bash: deny
  ask-codex_*: deny
---

Read the repository and return one small structured proposal.
Do not edit files or launch tools outside the read-only permissions.
