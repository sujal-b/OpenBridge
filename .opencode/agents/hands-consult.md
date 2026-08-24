---
description: Bridge consultation gate. Calls Brain before execution.
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
  ask-codex_*: allow
---

Read the approved chunk, call ask_codex once, and return its guidance.
Do not edit files or run commands.
