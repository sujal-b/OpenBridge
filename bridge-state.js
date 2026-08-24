'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// Strict form classifies tool-name fields; loose form handles provider ids such as toolu_ask_codex.
const TOOL_NAME = /(?<![a-z0-9_])ask[_.-]?codex(?![a-z0-9_])/i;
const ID_MARKER = /(?:^|[^a-z0-9])ask[_.-]?codex/i;
const DATA_PFX = /^data\s*:/i;
const TOOL_KEYS = new Set(['name', 'tool', 'toolname', 'tool_name']);
const ENVELOPE_KEYS = new Set(['data', 'payload', 'result', 'event']);
const TEXT_KEYS = new Set(['text', 'summary', 'message', 'error', 'reason', 'output', 'content', 'input', 'console', 'stderr', 'stdout']);

function keyName(key) { return String(key).toLowerCase(); }

function isBrainConsultationEvent(event, rawLine) {
  const inspect = root => {
    const stack = [{ value: root, depth: 0, key: '', parent: null }];
    while (stack.length) {
      const current = stack.pop();
      const { value, depth, key, parent } = current;
      if (typeof value === 'string') {
        if (TOOL_KEYS.has(keyName(key)) && TOOL_NAME.test(value)) return true;
        if (keyName(key) === 'id' && parent && typeof parent === 'object' && !Array.isArray(parent)) {
          const toolKeys = Object.keys(parent).filter(k => TOOL_KEYS.has(keyName(k)));
          const toolTyped = /tool/i.test(String(parent.type || '')) || toolKeys.length > 0;
          const conflictingTool = toolKeys.some(k => !TOOL_NAME.test(String(parent[k])));
          if (toolTyped && !conflictingTool && ID_MARKER.test(value)) return true;
        }
        if (depth < 64 && ENVELOPE_KEYS.has(keyName(key)) && /^\s*[\[{]/.test(value)) {
          try { stack.push({ value: JSON.parse(value), depth: depth + 1, key, parent }); } catch {}
        }
        continue;
      }
      if (!value || typeof value !== 'object' || depth >= 64) continue;
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index--) stack.push({ value: value[index], depth: depth + 1, key: '', parent: value });
      } else {
        for (const [childKey, child] of Object.entries(value).reverse()) {
          if (TEXT_KEYS.has(keyName(childKey)) && typeof child === 'string') continue;
          stack.push({ value: child, depth: depth + 1, key: childKey, parent: value });
        }
      }
    }
    return false;
  };
  if (typeof event === 'string') {
    try { if (inspect(JSON.parse(event))) return true; } catch {}
  } else if (event !== null && event !== undefined && inspect(event)) return true;
  // Some adapters provide a shallow event plus the complete JSON on rawLine.
  if (event !== null && event !== undefined && event && typeof event === 'object') {
    const hasToolKey = Object.keys(event).some(key => TOOL_KEYS.has(keyName(key)));
    if (hasToolKey) return false;
  }
  if (typeof rawLine !== 'string') return false;
  for (const line of rawLine.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate) continue;
    const payload = DATA_PFX.test(candidate) ? candidate.replace(DATA_PFX, '').trim() : candidate;
    try {
      if (inspect(JSON.parse(payload))) return true;
    } catch {}
  }
  return false;
}

function hasAskCodexToken(value) {
  return typeof value === 'string' && TOOL_NAME.test(value);
}

function isLegacyConsultationRetry(state) {
  if (!state || state.phase !== 'blocked_user' || state.block_kind !== 'needs_revision'
    || state.resume_phase !== 'hands_consulting' || state.recovery_required === true
    || typeof state.blocked_reason !== 'string') return false;
  const reason = state.blocked_reason;
  return (hasAskCodexToken(reason) || /\b(?:mcp|tool)\b/i.test(reason))
    && /\b(?:fail(?:ed|ure)?|error|unavailable|tim(?:e|ed)\s*out|spawn(?:ing|ed)?|start(?:up)?)\b/i.test(reason)
    || (/\bhands-consult\b/i.test(reason) && /\b(?:fail(?:ed|ure)?|tim(?:e|ed)\s*out|timeout|exceeded)\b/i.test(reason));
}

function coerceEventSeq(raw) {
  const value = raw && raw.event_seq;
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

async function lastEvent(cwd) {
  let max = null;
  let session_id = null;
  try {
    const text = await fs.readFile(path.join(cwd, '.bridge', 'events.jsonl'), 'utf8');
    for (const line of text.trim().split(/\r?\n/).filter(Boolean)) {
      try { const event = JSON.parse(line); if (Number.isInteger(event.seq) && event.seq >= 0 && (!max || event.seq > max.seq)) max = event; } catch {}
    }
    session_id = max?.session_id || null;
  } catch {}
  return { seq: max?.seq ?? -1, session_id };
}

module.exports = { TOOL_NAME, ID_MARKER, isBrainConsultationEvent, hasAskCodexToken, isLegacyConsultationRetry, coerceEventSeq, lastEvent };
