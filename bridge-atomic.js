'use strict';

const fs = require('node:fs/promises');

const RETRYABLE_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const MAX_RENAME_RETRIES = 7;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function renameWithRetry(source, destination, options = {}) {
  const rename = options.rename || fs.rename;
  const wait = options.wait || delay;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rename(source, destination);
    } catch (error) {
      if (!RETRYABLE_RENAME_ERRORS.has(error && error.code) || attempt >= MAX_RENAME_RETRIES) throw error;
      await wait(Math.min(100, 5 * (2 ** attempt)));
    }
  }
}

module.exports = {
  renameWithRetry
};
