'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createJevRunner, validatePlan} = require('../jev/runner');
const plan = {workflow: 'plan', goal: 'Open search', completion: 'Search results visible',
  steps: [{label: 'Search', when: 'Search field focused', actions: [{type: 'type_text', text: '{hello}'}]}]};
const screen = {width: 100, height: 100, data: 'AA==', mimeType: 'image/jpeg', frameID: 'f', receivedAt: 100};
const answer = (choice = 'ready', confidence = 0.99) => ({answers: {gate: {type: 'noul', noul: choice === 'ready' ? confidence : 0.1}}});
function setup(overrides = {}) {
  const inputs = [], judgments = [];
  const runner = createJevRunner({readScreen: async () => screen,
    readStatus: async () => ({connected: true, deviceID: 'a'}),
    execute: async input => {inputs.push(input); return {status: 'completed'};},
    ocr: async () => ({width: 100, height: 100, items: []}),
    evaluate: async request => {judgments.push(request); return answer();}, now: () => 101, ...overrides});
  return {...runner, inputs, judgments};
}
test('runner checks each precondition, escapes literals and verifies completion separately', async () => {
  const r = setup(); const result = await r.run(plan);
  assert.equal(result.structuredContent.status, 'done');
  assert.equal(r.inputs.length, 1);
  assert.equal(r.inputs[0].actions[0].text, '{{hello}}');
  assert.equal(r.judgments.length, 2);
  assert.equal(result.content[1].type, 'image');
});
test('false, uncertain and malformed checkpoints never execute', async () => {
  for (const response of [answer('blocked'), answer('ready', .2), answer('invented'), {}]) {
    const r = setup({evaluate: async () => response});
    assert.equal((await r.run(plan)).structuredContent.status, 'needs_reasoning');
    assert.equal(r.inputs.length, 0);
  }
});
test('a failed final verification does not claim success or replay input', async () => {
  let calls = 0;
  const r = setup({evaluate: async () => answer(++calls === 1 ? 'ready' : 'blocked')});
  assert.equal((await r.run(plan)).structuredContent.status, 'needs_reasoning');
  assert.equal(r.inputs.length, 1);
});
test('changed device and stale observations stop before input', async () => {
  let reads = 0;
  const r = setup({readStatus: async () => ({connected: true, deviceID: ++reads > 2 ? 'b' : 'a'})});
  assert.equal((await r.run(plan)).structuredContent.reason, 'device_changed');
  assert.equal(r.inputs.length, 0);
  const stale = setup({readScreen: async () => ({...screen, receivedAt: -6000})});
  assert.equal((await stale.run(plan)).structuredContent.reason, 'stale_observation');
  assert.equal(stale.inputs.length, 0);
});
test('cancel during inference prevents the pending action', async () => {
  const r = setup({evaluate: async () => {r.cancel(); return answer();}});
  assert.equal((await r.run(plan)).structuredContent.reason, 'cancelled');
  assert.equal(r.inputs.length, 0);
});
test('failed or timed-out input is not replayed', async () => {
  let calls = 0;
  const r = setup({execute: async () => {calls++; throw Error('input timeout');}});
  assert.equal((await r.run(plan)).structuredContent.reason, 'input timeout');
  assert.equal(calls, 1);
});
test('invalid plans fail before contacting the device', () => {
  for (const args of [{}, {...plan, steps: []}, {...plan, steps: [{...plan.steps[0], actions: [{type: 'click', x: 1, y: 2}]}]},
    {workflow: 'slack_open_conversation', query: 'Name\n{CMD+A}'}, {...plan, steps: [{...plan.steps[0], actions: [{type: 'press', keys: ['cmd', 'a']}]}]}])
    assert.throws(() => validatePlan(args));
});
test('Slack workflow never types a query without first checking the switcher', () => {
  const p = validatePlan({workflow: 'slack_open_conversation', query: 'Bogdan'}, true);
  assert.match(p.steps[1].when, /NOT the message composer/);
  assert.match(p.steps[2].when, /highlighted FIRST result/);
  assert.equal(p.steps[2].actions[0].keys.key, 'enter');
  assert.match(p.completion, /HEADER/);
});

test('native Slack path selects once, waits for header transition, and verifies without another model call', async () => {
  const person = {role: 'Cell', text: 'Alex Morgan, Away, Member', identifier: 'D123', bounds: {x: 80, y: 300, width: 250, height: 40}};
  const header = text => ({role: 'Button', text, bounds: {x: 440, y: 42, width: 600, height: 40}});
  let snapshots = 0, selections = 0, judgments = 0;
  const r = setup({activateApp: async id => assert.equal(id, 'com.tinyspeck.chatlyio'),
    readNativeUI: async () => ({app: ++snapshots === 1 ? 'Settings' : 'Slack', width: 1373, height: 954, receivedAt: 100,
      items: [person, header(snapshots < 4 ? 'Alex Morgan, Casey Taylor, 2 members, Group, 3 tabs' : 'Alex Morgan, Away, Member, 3 tabs')]}),
    selectSlackConversation: async (query, observed) => {selections++; assert.equal(query, 'Alex Morgan'); assert.equal(observed.items[0].identifier, 'D123');},
    evaluate: async request => {judgments++; assert.deepEqual(request.state.searchResults, [person.text]); return answer();}
  });
  const result = await r.run({workflow: 'slack_open_conversation', query: 'Alex Morgan'});
  assert.equal(result.structuredContent.status, 'done');
  assert.equal(result.structuredContent.stepsExecuted, 1);
  assert.equal(selections, 1);
  assert.equal(judgments, 1);
  assert.equal(r.inputs.length, 0, 'native route never emits Return or mouse input');
  assert.equal(result.structuredContent.trace.at(-1).verification, 'native_controls');
});

test('native blocking alerts and expired budgets cannot dispatch another action', async () => {
  const r = setup({activateApp: async () => {}, readNativeUI: async () => ({app: 'Slack', alertsPresent: true})});
  assert.equal((await r.run({workflow: 'slack_open_conversation', query: 'Alex Morgan'})).structuredContent.reason, 'blocking_alert');
  assert.equal(r.inputs.length, 0);
  let time = 101;
  const expired = setup({now: () => time, evaluate: async () => {time += 2000; return answer();}});
  assert.equal((await expired.run({...plan, maxMs: 1000})).structuredContent.reason, 'time_budget_exhausted');
  assert.equal(expired.inputs.length, 0);
});
