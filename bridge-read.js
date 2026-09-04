'use strict';

// bridge-read.js — shared JSONL tail reader for TUI + inspector.
//
// Unifies accidental duplication between bridge.js readJsonLines and
// bridge-inspector.js readSource + parseJsonLines. Cap applied BEFORE parse
// so TUI repaints stay at ~280 parses, not ~4000. No server deps.

const fs = require('node:fs/promises');
const path = require('node:path');

async function readJsonlTail(file, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 512 * 1024;
  const rawLimit = Number.isFinite(options.limit) ? options.limit : Infinity;
  const limit = rawLimit <= 0 ? 0 : rawLimit;
  const source = options.source || path.basename(String(file));
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(Number(stat.size - start));
    if (buffer.length) await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    const truncated = start > 0;
    if (truncated) {
      const firstBreak = text.indexOf('\n');
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : '';
    }
    const complete = text.endsWith('\n') || text.endsWith('\r');
    const lines = text.split(/\r?\n/);
    const last = complete ? lines.length : lines.length - 1;
    // Backwards walk: collect up to `limit` non-blank lines so neither
    // allocation nor parsing grows with the window.
    const windowed = [];
    if (limit !== 0) {
      for (let index = last - 1; index >= 0 && windowed.length < limit; index -= 1) {
        if (!lines[index].trim()) continue;
        windowed.push({ line: lines[index], lineNumber: index + 1 });
      }
      windowed.reverse();
    }
    const values = [];
    const warnings = [];
    for (const { line, lineNumber } of windowed) {
      try {
        values.push(JSON.parse(line));
      } catch {
        warnings.push({ source, type: 'malformed', line: lineNumber, message: 'Malformed JSON ignored.' });
      }
    }
    return {
      values,
      warnings,
      available: true,
      error: null,
      truncated,
      complete,
      parseCount: windowed.length
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { values: [], warnings: [], available: false, error: 'File not found.', truncated: false, complete: true, parseCount: 0 };
    }
    return { values: [], warnings: [], available: false, error: error.message, truncated: false, complete: true, parseCount: 0 };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function readJsonlPair(cwd, { events = {}, actions = {} } = {}) {
  const dir = path.join(cwd, '.bridge');
  const [eventsResult, actionsResult] = await Promise.all([
    readJsonlTail(path.join(dir, 'events.jsonl'), { source: 'events.jsonl', ...events }),
    readJsonlTail(path.join(dir, 'actions.jsonl'), { source: 'actions.jsonl', ...actions })
  ]);
  return { events: eventsResult, actions: actionsResult };
}

module.exports = { readJsonlTail, readJsonlPair };
