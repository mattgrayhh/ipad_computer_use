'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {stateDirectory} = require('../config');

function binaryPath() {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'vision_ocr.swift'))).digest('hex').slice(0, 16);
  return path.join(stateDirectory, 'jev', `vision-ocr-${hash}`);
}

function createOCRWorker({timeoutMs = 10000, idleMs = 60000} = {}) {
  let child, active, buffer = '', idleTimer, timer;
  let tail = Promise.resolve();
  let queued = 0;
  function close() {
    clearTimeout(timer);
    clearTimeout(idleTimer);
    const previous = child;
    child = null;
    buffer = '';
    previous?.kill();
    if (active) {active.reject(Error('Local OCR stopped or timed out')); active = null;}
  }
  function start() {
    if (child) return;
    if (process.platform !== 'darwin') throw Error('Local Jev OCR requires macOS');
    if (!fs.existsSync(binaryPath())) throw Error('Run npm run jev:setup --workspace control_server to build local OCR');
    const current = child = spawn(binaryPath(), ['--serve'], {stdio: ['pipe', 'pipe', 'ignore']});
    current.on('error', () => {if (child === current) close();});
    current.on('exit', () => {if (child === current) close();});
    current.stdin.on('error', () => {if (child === current) close();});
    current.stdout.setEncoding('utf8');
    current.stdout.on('data', chunk => {
      if (child !== current) return;
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) return close();
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        if (!active || end !== buffer.length - 1) throw Error('Unexpected OCR response');
        const result = JSON.parse(buffer.slice(0, end));
        buffer = '';
        clearTimeout(timer);
        const pending = active;
        active = null;
        idleTimer = setTimeout(close, idleMs);
        pending.resolve(result);
      } catch {close();}
    });
  }
  function recognize(image) {
    if (!Buffer.isBuffer(image) || !image.length || image.length > 2 * 1024 * 1024)
      return Promise.reject(Error('Invalid OCR image'));
    if (queued >= 16) return Promise.reject(Error('OCR worker is busy'));
    queued++;
    const result = tail.then(() => new Promise((resolve, reject) => {
      try {start();} catch (error) {reject(error); return;}
      clearTimeout(idleTimer);
      active = {resolve, reject};
      timer = setTimeout(close, timeoutMs);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(image.length);
      child.stdin.write(Buffer.concat([header, image]));
    }));
    tail = result.catch(() => {}).finally(() => {queued--;});
    return result;
  }
  return {recognize, close};
}

const worker = createOCRWorker();
module.exports = {recognize: worker.recognize, closeOCR: worker.close, createOCRWorker, binaryPath};
