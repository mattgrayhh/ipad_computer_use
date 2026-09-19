'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createWDA, compactTree, selectorPredicate} = require('../jev/wda');
test('native UI selector quotes literal values and rejects unconstrained queries', () => {
  assert.throws(() => selectorPredicate({type: 'Button'}));
  assert.throws(() => selectorPredicate({label: 'x\ny'}));
  assert.equal(selectorPredicate({identifier: 'a" OR true', type: 'Cell'}), 'name == "a\\" OR true" AND type == "XCUIElementTypeCell" AND visible == 1 AND enabled == 1');
});
test('compact native observations retain roles, remove duplicate and offscreen items', () => {
  const item = {label: 'Search', rawIdentifier: 'search', type: 'Button', isEnabled: '1', rect: {x: 1, y: 2, width: 30, height: 20}};
  const ui = compactTree({label: 'App', type: 'Application', rect: {width: 100, height: 100},
    children: [item, item, {...item, rect: {...item.rect, x: 200}}]});
  assert.equal(ui.items.length, 1);
  assert.equal(ui.items[0].identifier, 'search');
  assert.equal(ui.items[0].role, 'Button');
});
test('ambiguous native controls never receive input; mutations are not retried', async () => {
  for (const count of [0, 2]) {
    const routes = [];
    const wda = createWDA({baseUrl: 'http://localhost:8100', fetchImpl: async (url, init) => {
      routes.push(url.pathname);
      const value = url.pathname === '/session' ? {sessionId: 's'} : url.pathname.endsWith('/elements') ? Array.from({length: count}, () => ({ELEMENT: 'e'})) : {};
      return {ok: true, json: async () => url.pathname === '/session' ? value : {value}};
    }});
    await assert.rejects(wda.action({action: 'click', selector: {label: 'Search'}}), /exactly one/);
    assert.ok(!routes.some(route => route.endsWith('/click')));
  }
});
test('native typing accepts Unicode and requires an editable control', async () => {
  for (const type of ['XCUIElementTypeTextView', 'XCUIElementTypeButton']) {
    let typed;
    const wda = createWDA({baseUrl: 'http://localhost:8100', fetchImpl: async (url, init) => {
      let value = {};
      if (url.pathname === '/session') return {ok: true, json: async () => ({sessionId: 's'})};
      if (url.pathname.endsWith('/elements')) value = [{ELEMENT: 'e'}];
      if (url.pathname.endsWith('/name')) value = type;
      if (url.pathname.endsWith('/value')) typed = JSON.parse(init.body).value;
      return {ok: true, json: async () => ({value})};
    }});
    const run = wda.action({action: 'type', selector: {label: 'Search'}, text: 'héllo'});
    if (type.endsWith('Button')) {await assert.rejects(run, /editable/); assert.equal(typed, undefined);}
    else {await run; assert.deepEqual(typed, ['héllo']);}
  }
});
