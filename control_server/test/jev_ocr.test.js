'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {recognize, closeOCR, binaryPath} = require('../jev/ocr');

test('Apple Vision reads a synthetic screenshot in top-left pixel coordinates', {
  skip: process.platform !== 'darwin' || !fs.existsSync(binaryPath()) ? 'Run jev:setup on macOS for the native OCR test' : false
}, async t => {
  t.after(closeOCR);
  const image = execFileSync('xcrun', ['swift', path.join(__dirname, 'fixtures/jev_ocr_fixture.swift')], {timeout: 30000, maxBuffer: 2 * 1024 * 1024});
  const result = await recognize(image);
  // NSImage may render at the host backing scale; both axes must remain consistent.
  const scale = result.width / 800;
  assert.equal(result.height, 600 * scale);
  const settings = result.items.find(item => item.text === 'Settings');
  const privacy = result.items.find(item => item.text === 'Privacy');
  assert.ok(settings && privacy, 'both labels recognized');
  assert.ok(settings.bounds.y < 150 * scale, 'upper label maps to upper screen');
  assert.ok(privacy.bounds.y > settings.bounds.y + 150 * scale, 'lower label maps below upper label');
  assert.ok(Math.abs(settings.bounds.x - 40 * scale) < 10 * scale);
  // Concurrent callers are serialized and receive their own complete response.
  const repeated = await Promise.all([recognize(image), recognize(image)]);
  assert.deepEqual(repeated, [result, result]);
  await assert.rejects(recognize(Buffer.from('invalid jpeg')));
  assert.deepEqual(await recognize(image), result, 'worker recovers after an invalid image');
});
