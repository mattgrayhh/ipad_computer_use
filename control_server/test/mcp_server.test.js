const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {createMcpServer} = require('../mcp_server');

test('MCP initialize and tools/list expose the iPad tools without auth', async t => {
  const {call} = await setup(t);
  const initialized = await call({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-11-25'}});
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  assert.deepEqual(initialized.result.capabilities, {tools: {listChanged: false}});
  await call({jsonrpc: '2.0', method: 'notifications/initialized'});
  const list = await call({jsonrpc: '2.0', id: 2, method: 'tools/list'});
  assert.deepEqual(list.result.tools.map(tool => tool.name), ['get_ui', 'ui_action', 'jev_run', 'jev_cancel', 'status', 'get_screen', 'jev_decide', 'issue_actions']);
  const issue = list.result.tools.find(tool => tool.name === 'issue_actions');
  assert.match(issue.description, /press\.keys must be an object/);
  const press = issue.inputSchema.properties.actions.items.oneOf.find(action => action.properties.type.const === 'press');
  assert.deepEqual(press.required, ['type', 'keys']);
  assert.deepEqual(press.properties.keys.required, ['key']);
  assert.equal(press.properties.keys.type, 'object');
  assert.equal(press.properties.keys.additionalProperties, false);
  assert.deepEqual(press.properties.keys.properties.modifiers.items.enum, ['ctrl', 'shift', 'alt', 'cmd']);
  assert.equal(issue.inputSchema.properties.actions.items.oneOf.some(action => action.properties.type.const === 'drag_to'), false);
});

test('MCP tools call through to the loopback control API', async t => {
  const seen = [];
  const control = await fakeControl(t, async (request, body) => {
    seen.push({url: request.url, method: request.method, auth: request.headers.authorization, body});
    if (request.url === '/status') return {statusCode: 200, body: {connected: true, pointerCalibrated: true}};
    if (request.url === '/screen') return {statusCode: 200, body: {
      frameID: 'frame-1', capturedAt: 1, receivedAt: 2, width: 10, height: 10,
      orientation: 'up', mimeType: 'image/jpeg', data: '/9j/2Q=='
    }};
    if (request.url === '/computer-use/actions') return {statusCode: 200, body: {id: 'run-1', status: 'completed'}};
    return {statusCode: 404, body: {error: 'nope'}};
  });
  const {call} = await setup(t, {controlBaseUrl: control.base});
  const status = await call({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'status', arguments: {}}});
  assert.equal(status.result.structuredContent.connected, true);
  const screen = await call({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'get_screen', arguments: {}}});
  assert.equal(screen.result.content[1].type, 'image');
  assert.equal(screen.result.content[1].mimeType, 'image/jpeg');
  assert.equal(screen.result.structuredContent.frameID, 'frame-1');
  assert.equal(screen.result.structuredContent.data, undefined);
  const actions = {actions: [{type: 'type_text', text: 'hello'}]};
  const run = await call({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'issue_actions', arguments: actions}});
  assert.equal(run.result.structuredContent.status, 'completed');
  assert.deepEqual(seen.map(item => item.url), ['/status', '/screen', '/computer-use/actions']);
  assert.ok(seen.every(item => item.auth === undefined));
  assert.deepEqual(seen[2].body, actions);
});

test('MCP execution errors are returned as tool errors', async t => {
  const control = await fakeControl(t, async () => ({statusCode: 428, body: {code: 'calibration_required', error: 'Calibrate first'}}));
  const {call} = await setup(t, {controlBaseUrl: control.base});
  const result = await call({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'issue_actions', arguments: {actions: [{type: 'click', x: 1, y: 1}]}}});
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /Calibrate first/);
  assert.equal(result.result.structuredContent.status, 428);
});

test('jev_decide reads the screen and returns a proposal without issuing any input', async t => {
  const seen = [];
  const control = await fakeControl(t, async request => {
    seen.push({url: request.url, method: request.method});
    assert.equal(request.url, '/screen');
    return {statusCode: 200, body: {width: 800, height: 600, frameID: 'jev-frame',
      receivedAt: Date.now(), capturedAt: Date.now(), mimeType: 'image/jpeg', data: '/9j/2Q=='}};
  });
  const {call} = await setup(t, {controlBaseUrl: control.base, jevOptions: {
    ocr: async () => ({width: 800, height: 600, items: [{text: 'Settings', bounds: {x: 40, y: 60, width: 100, height: 30}}]}),
    evaluate: async () => ({answers: {
      kind: {type: 'choice', choice: 'click_item', confidence: 0.95},
      item: {type: 'choice', choice: '0', confidence: 0.95}
    }})
  }});
  const result = await call({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'jev_decide', arguments: {goal: 'Open Settings'}
  }});
  assert.equal(result.result.structuredContent.status, 'proposed');
  assert.equal(result.result.structuredContent.executed, false);
  assert.equal(result.result.content[1].type, 'image');
  assert.equal(result.result.structuredContent.proposal.pointer, undefined);
  assert.deepEqual(seen, [{url: '/screen', method: 'GET'}]);
});

test('MCP endpoint rejects browser origins', async t => {
  const {base} = await setup(t);
  const response = await fetch(base + '/mcp', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: 'https://example.com'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'ping'})
  });
  assert.equal(response.status, 403);
});

async function setup(t, options = {}) {
  const mcp = createMcpServer({controlBaseUrl: 'http://127.0.0.1:1', ...options});
  await new Promise(resolve => mcp.server.listen(0, '127.0.0.1', resolve));
  t.after(() => mcp.close());
  const base = `http://127.0.0.1:${mcp.server.address().port}`;
  async function call(message) {
    const response = await fetch(base + '/mcp', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'},
      body: JSON.stringify(message)
    });
    if (message.id === undefined) {
      assert.equal(response.status, 202);
      return null;
    }
    assert.equal(response.status, 200);
    return response.json();
  }
  return {base, call};
}

async function fakeControl(t, handler) {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? JSON.parse(text) : undefined;
    const result = await handler(request, body);
    response.writeHead(result.statusCode, {'Content-Type': 'application/json'});
    response.end(JSON.stringify(result.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return {base: `http://127.0.0.1:${server.address().port}`};
}

test('local workflow excludes competing input while status and cancellation remain available', async t => {
  let entered, release, inputs = 0;
  const reached = new Promise(resolve => {entered = resolve;});
  const blocked = new Promise(resolve => {release = resolve;});
  const control = await fakeControl(t, async request => {
    if (request.url === '/status') return {statusCode: 200, body: {connected: true, deviceID: 'test-ipad'}};
    if (request.url === '/screen') return {statusCode: 200, body: {width: 100, height: 100, frameID: 'f',
      receivedAt: Date.now(), mimeType: 'image/jpeg', data: 'AA=='}};
    inputs++; return {statusCode: 200, body: {status: 'completed'}};
  });
  const {call} = await setup(t, {controlBaseUrl: control.base, wda: null, jevOptions: {
    ocr: async () => ({width: 100, height: 100, items: []}),
    evaluate: async () => {entered(); await blocked; return {answers: {gate: {type: 'noul', noul: .99}}};}
  }});
  const tool = (name, args = {}) => call({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}});
  const running = tool('jev_run', {workflow: 'plan', goal: 'Search', completion: 'Done', steps: [
    {label: 'Type', when: 'Search focused', actions: [{type: 'type_text', text: 'example'}]}
  ]});
  await reached;
  assert.equal((await tool('issue_actions', {actions: [{type: 'press', keys: {key: 'enter'}}]})).result.isError, true);
  assert.equal((await tool('status')).result.structuredContent.connected, true);
  assert.equal((await tool('jev_cancel')).result.structuredContent.cancellationRequested, true);
  release();
  assert.equal((await running).result.structuredContent.reason, 'cancelled');
  assert.equal(inputs, 0);
});
