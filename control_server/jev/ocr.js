'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const {stateDirectory} = require('../config');

function binaryPath() {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'vision_ocr.swift'))).digest('hex').slice(0, 16);
  return path.join(stateDirectory, 'jev', `vision-ocr-${hash}`);
}

function recognize(image) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') return reject(Error('Local Jev OCR requires macOS; use get_screen with the existing agent on other hosts'));
    const binary = binaryPath();
    if (!fs.existsSync(binary)) return reject(Error('Run npm run jev:setup --workspace control_server to build local OCR'));
    const child = execFile(binary, [], {timeout: 10000, maxBuffer: 2 * 1024 * 1024}, (error, stdout) => {
      if (error) return reject(Error('Local OCR failed or timed out; use the existing agent'));
      try {resolve(JSON.parse(stdout));} catch {reject(Error('Local OCR returned invalid JSON'));}
    });
    child.stdin.on('error', () => {}); // execFile's callback reports an early child exit.
    child.stdin.end(image);
  });
}

module.exports = {recognize, binaryPath};
