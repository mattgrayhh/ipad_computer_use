'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validateOptions, normalizeItems, buildRequest, resolveDecision, createEvaluator} = require('../jev/decide');
const {createJevAdvisor} = require('../jev/advisor');
const {compileHighLevelActions} = require('../high_level_actions');
const {encodeActions} = require('ipad_input_device/actions');

const screen = {width: 800, height: 600, frameID: 'frame-1', receivedAt: 1000,
  capturedAt: 990, mimeType: 'image/jpeg', data: '/9j/2Q=='};
const ocr = {width: 800, height: 600, items: [{text: 'Settings', bounds: {x: 40, y: 60, width: 100, height: 30}}]};
const options = validateOptions({goal: 'Open Settings'});
const observation = normalizeItems(ocr, screen);
const request = buildRequest(options, screen, observation);
const choice = (value, confidence = 0.95) => ({type: 'choice', choice: value, confidence});
const reply = (kind = 'click_item', item = '0') => ({model: 'jev-test', answers: {kind: choice(kind), item: choice(item)}, usage: {input_tokens: 80, output_tokens: 4}});

test('Jev batches action, target and optional literal text without sending screenshot data', () => {
  const req = buildRequest(validateOptions({goal: 'Search', textCandidates: ['weather']}), screen, observation);
  assert.deepEqual(Object.keys(req.questions), ['kind', 'item', 'text']);
  assert.equal(req.model, 'jev-latest');
  assert.equal(JSON.stringify(req).includes(screen.data), false);
  assert.equal(req.questions.item.criteria.none, 'No visible text item is a suitable click target.');
  const empty = buildRequest(options, screen, {items: [], truncated: false});
  assert.equal(empty.questions.item, undefined);
  assert.equal(empty.questions.kind.criteria.click_item, undefined);
  assert.equal(empty.questions.kind.criteria.type_text, undefined);
});

test('a selected text target maps to screenshot pixels without inventing a pointer', () => {
  const result = resolveDecision(reply(), request, options, observation);
  assert.equal(result.status, 'proposed');
  assert.deepEqual(result.proposal.actions, [{type: 'click', x: 90, y: 75, button: 'left'}]);
  assert.equal(result.proposal.pointer, undefined);
  assert.ok(result.requirements.includes('observed_pointer'));
  assert.deepEqual(result.proposal.coordinateSpace, {width: 800, height: 600, units: 'screen_pixels'});
});

test('only confidence on the selected branch gates a proposal', () => {
  const lowTarget = reply();
  lowTarget.answers.item.confidence = 0.2;
  assert.equal(resolveDecision(lowTarget, request, options, observation).reason, 'low_confidence');
  lowTarget.answers.kind = choice('press_escape');
  assert.equal(resolveDecision(lowTarget, request, options, observation).status, 'proposed');
  delete lowTarget.answers.item;
  assert.equal(resolveDecision(lowTarget, request, options, observation).status, 'proposed');
});

test('no-match, uncertainty, and done have no executable proposal', () => {
  for (const response of [reply('click_item', 'none'), reply('needs_reasoning'), reply('done')]) {
    assert.equal(resolveDecision(response, request, options, observation).proposal, undefined);
  }
  const low = reply('done');
  low.answers.kind.confidence = 0.1;
  assert.equal(resolveDecision(low, request, options, observation).status, 'needs_reasoning');
});

test('malformed model choices and confidence cannot become device commands', () => {
  for (const response of [reply('invented'), reply('click_item', '999'), {},
    {answers: {kind: choice('press_enter', NaN)}}, {answers: {kind: choice('press_enter', 2)}},
    {answers: {kind: {choice: 'press_enter', confidence: 1}}}]) {
    assert.throws(() => resolveDecision(response, request, options, observation), /Invalid Jev answer/);
  }
});

test('literal braces cannot turn text candidates into HID shortcuts', () => {
  const opts = validateOptions({goal: 'Type the literal example', textCandidates: ['{CMD+A}']});
  const req = buildRequest(opts, screen, observation);
  const response = reply('type_text');
  response.answers.text = choice('0');
  const result = resolveDecision(response, req, opts, observation);
  assert.equal(result.proposal.actions[0].text, '{{CMD+A}}');
  const compiled = compileHighLevelActions(result.proposal);
  const hex = encodeActions(compiled);
  assert.equal(hex.includes('01087'), false);
  assert.ok(hex.startsWith('01007b')); // literal '{', no modifier
  response.answers.text = choice('none');
  assert.equal(resolveDecision(response, req, opts, observation).reason, 'no_text_candidate');
});

test('invalid input is rejected before any screen or network access', async () => {
  const advise = createJevAdvisor({readScreen: () => assert.fail('unexpected capture')});
  for (const args of [{}, {goal: ' '}, {goal: 'a', history: ['x'.repeat(1001)]},
    {goal: 'a', textCandidates: ['é']}, {goal: 'a', minConfidence: -1}, {goal: 'a', minConfidence: NaN}]) {
    await assert.rejects(advise(args));
  }
});

test('OCR rejects geometry mismatches and caps choices with an explicit no-match option', () => {
  assert.throws(() => normalizeItems({...ocr, width: 1600}, screen), /dimensions/);
  const many = normalizeItems({...ocr, items: Array.from({length: 300}, (_, i) => ({text: String(i), bounds: ocr.items[0].bounds}))}, screen);
  assert.equal(many.items.length, 254);
  assert.equal(many.truncated, true);
  assert.equal(Object.keys(buildRequest(options, screen, many).questions.item.criteria).length, 255);
  const invalid = normalizeItems({...ocr, items: [{text: 'Bad', bounds: {x: 999, y: 0, width: 1, height: 1}}]}, screen);
  assert.deepEqual(invalid.items, []);
});

test('HTTP client uses the documented API and does not expose credentials in state', async () => {
  const evaluate = createEvaluator({apiKey: 'test-key', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    assert.equal(init.redirect, 'error');
    assert.equal(init.body.includes('test-key'), false);
    assert.deepEqual(JSON.parse(init.body), request);
    assert.ok(init.signal instanceof AbortSignal);
    return {ok: true, json: async () => reply()};
  }});
  assert.equal((await evaluate(request)).answers.kind.choice, 'click_item');
});

test('missing key, HTTP errors, transport failures, and invalid JSON return promptly without retry', async () => {
  await assert.rejects(createEvaluator({apiKey: '', fetchImpl: () => assert.fail('unexpected request')})(request), /TYPESAFE_API_KEY/);
  for (const status of [401, 429, 529]) {
    let calls = 0;
    await assert.rejects(createEvaluator({apiKey: 'test', fetchImpl: async () => {
      calls++; return {ok: false, status};
    }})(request), new RegExp(String(status)));
    assert.equal(calls, 1);
  }
  await assert.rejects(createEvaluator({apiKey: 'test', fetchImpl: async () => {throw Error('private details');}})(request), /time budget/);
  await assert.rejects(createEvaluator({apiKey: 'test', fetchImpl: async () => ({ok: true, json: async () => {throw Error('private body');}})})(request), /invalid JSON/);
});

test('oversized screen state falls back before making a paid request', async () => {
  const evaluate = createEvaluator({apiKey: 'test', fetchImpl: () => assert.fail('unexpected request')});
  await assert.rejects(evaluate({...request, state: {screenText: 'x'.repeat(31000)}}), /request budget/);
});

test('advisor returns a fresh screenshot and reuses OCR only for byte-identical images', async () => {
  let captures = 0, reads = 0, decisions = 0;
  const advise = createJevAdvisor({
    readScreen: async () => ({...screen, frameID: String(++captures), data: captures < 3 ? screen.data : '/9j/AAAA/9k='}),
    ocr: async () => {reads++; return ocr;}, evaluate: async () => {decisions++; return reply();}, now: () => 1001
  });
  const first = await advise({goal: 'Open Settings'});
  assert.equal(first.structuredContent.executed, false);
  assert.equal(first.content[1].type, 'image');
  assert.equal(first.structuredContent.frame.data, undefined);
  const second = await advise({goal: 'Open Settings'});
  assert.equal(second.structuredContent.ocr.cacheHit, true);
  assert.equal(second.structuredContent.frame.frameID, '2');
  await advise({goal: 'Open Settings'});
  assert.equal(captures, 3);
  assert.equal(reads, 2);
  assert.equal(decisions, 3); // Never cache a judgment across goals/history/frames.
});

test('advisor hands the screenshot back on OCR/model failure or a stale response', async () => {
  for (const dependencies of [
    {ocr: async () => {throw Error('OCR unavailable');}},
    {evaluate: async () => {throw Error('Service unavailable');}},
    {evaluate: async () => ({})}, {now: () => 16001}
  ]) {
    const advise = createJevAdvisor({readScreen: async () => screen, ocr: async () => ocr,
      evaluate: async () => reply(), now: () => 1001, ...dependencies});
    const result = await advise({goal: 'Open Settings'});
    assert.equal(result.structuredContent.status, 'needs_reasoning');
    assert.equal(result.structuredContent.proposal, undefined);
    assert.equal(result.content[1].data, screen.data);
  }
});

test('capture failure never calls Jev', async () => {
  const advise = createJevAdvisor({readScreen: async () => {throw Error('iPad disconnected');},
    evaluate: () => assert.fail('unexpected request')});
  await assert.rejects(advise({goal: 'Open Settings'}), /disconnected/);
});
