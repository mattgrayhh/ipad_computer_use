#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {binaryPath} = require('./ocr');

if (process.platform !== 'darwin') {
  console.error('Jev local OCR requires macOS with Xcode Command Line Tools.');
  process.exitCode = 1;
} else {
  const binary = binaryPath();
  fs.mkdirSync(path.dirname(binary), {recursive: true, mode: 0o700});
  const temporary = binary + `.${process.pid}.tmp`;
  const result = spawnSync('xcrun', ['swiftc', '-O', path.join(__dirname, 'vision_ocr.swift'), '-o', temporary], {stdio: 'inherit'});
  if (result.error || result.status !== 0) {
    fs.rmSync(temporary, {force: true});
    console.error('Could not build OCR. Install Xcode Command Line Tools (xcode-select --install).');
    process.exitCode = 1;
  } else {
    fs.renameSync(temporary, binary);
    console.log('Warming up Apple Vision with synthetic text (first run can take a minute)...');
    const warmup = spawnSync(binary, ['--warmup'], {timeout: 120000, stdio: ['ignore', 'ignore', 'pipe']});
    if (warmup.error || warmup.status !== 0) {
      console.error('OCR compiled but warm-up failed. Run jev:setup again before using jev_decide.');
      process.exitCode = 1;
    } else console.log('Jev local OCR ready. Set TYPESAFE_API_KEY before starting the MCP server.');
  }
}
