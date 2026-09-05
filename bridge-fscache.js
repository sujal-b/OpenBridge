'use strict';

// bridge-fscache.js — mtime+size keyed text cache for hot config files.
//
// Config reads recur before every phase boundary and twice per agent invoke;
// a stat (one syscall) replaces read+parse on hits. A rewrite that lands
// within the filesystem's mtime resolution with an identical size would be
// served stale, so writers that can produce that (temp+rename keeps mtime
// fresh, so in practice only in-place writes) should call invalidate() after
// saving. Cache is per-process; external writers change mtime and self-heal.

const fs = require('node:fs/promises');
const fsSync = require('node:fs');

const cache = new Map(); // absolute path -> { key, raw }

function keyOf(stat) {
  return stat.size + ':' + stat.mtimeMs;
}

function readTextCachedSync(filePath) {
  // statSync throws ENOENT like readFileSync did; callers keep their fallbacks.
  const stat = fsSync.statSync(filePath);
  const key = keyOf(stat);
  const hit = cache.get(filePath);
  if (hit && hit.key === key) return hit.raw;
  const raw = fsSync.readFileSync(filePath, 'utf8');
  cache.set(filePath, { key, raw });
  return raw;
}

async function readTextCached(filePath) {
  const stat = await fs.stat(filePath);
  const key = keyOf(stat);
  const hit = cache.get(filePath);
  if (hit && hit.key === key) return hit.raw;
  const raw = await fs.readFile(filePath, 'utf8');
  cache.set(filePath, { key, raw });
  return raw;
}

function invalidate(filePath) {
  if (filePath) cache.delete(filePath);
  else cache.clear();
}

module.exports = { readTextCached, readTextCachedSync, invalidate };
