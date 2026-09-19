'use strict';
const crypto = require('node:crypto');
const {performance} = require('node:perf_hooks');
const {recognize} = require('./ocr');
const {validateOptions, normalizeItems, buildRequest, resolveDecision, createEvaluator} = require('./decide');

function createJevAdvisor({readScreen, ocr = recognize, evaluate = createEvaluator(),
  model = process.env.TYPESAFE_MODEL || 'jev-latest', now = Date.now} = {}) {
  let cached = null; // One exact image only; no screenshots or OCR written to disk.
  return async args => {
    const options = validateOptions(args);
    const started = performance.now();
    const screen = await readScreen();
    const captureMs = performance.now() - started;
    const {data, ...frame} = screen;
    const timings = {captureMs};
    let result;
    try {
      if (screen.mimeType !== 'image/jpeg' || typeof data !== 'string' || data.length > 2800000 ||
          !Number.isInteger(screen.width) || !Number.isInteger(screen.height) ||
          screen.width < 1 || screen.height < 1 || screen.width > 4096 || screen.height > 4096 ||
          typeof screen.frameID !== 'string' || !Number.isFinite(screen.receivedAt))
        throw Error('Invalid screenshot metadata');
      const image = Buffer.from(data, 'base64');
      const hash = crypto.createHash('sha256').update(image).digest('hex');
      const ocrStarted = performance.now();
      const cacheHit = cached?.hash === hash;
      const recognized = cacheHit ? cached.ocr : await ocr(image);
      const observation = normalizeItems(recognized, screen);
      cached = {hash, ocr: recognized};
      timings.ocrMs = performance.now() - ocrStarted;
      const request = buildRequest(options, screen, observation, model);
      const decisionStarted = performance.now();
      const response = await evaluate(request);
      timings.jevMs = performance.now() - decisionStarted;
      result = {...resolveDecision(response, request, options, observation),
        ocr: {itemCount: observation.items.length, truncated: observation.truncated, cacheHit}};
      // Never hand off a delayed response as a current action proposal.
      if (now() - screen.receivedAt > 15000) result = {status: 'needs_reasoning', reason: 'stale_frame'};
    } catch (error) {
      result = {status: 'needs_reasoning', reason: 'fast_path_unavailable', detail: error.message};
    }
    timings.totalMs = performance.now() - started;
    const metadata = {...result, frame, timings, executed: false,
      next: result.status === 'proposed' ?
        'Check this screenshot and the requirements; for a click add the observed pointer to proposal, then call issue_actions. If anything changes, obtain a new decision.' :
        'Use this screenshot with the existing agent; Jev has sent no input.'};
    return {content: [{type: 'text', text: JSON.stringify(metadata, null, 2)},
      {type: 'image', data, mimeType: screen.mimeType}], structuredContent: metadata};
  };
}

module.exports = {createJevAdvisor};
