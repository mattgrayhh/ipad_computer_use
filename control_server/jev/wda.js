'use strict';

function compactTree(root) {
  const items = [], seen = new Set();
  let alertsPresent = false;
  const width = root.rect?.width, height = root.rect?.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw Error('Invalid native screen geometry');
  function walk(node, depth = 0) {
    if (depth > 40 || items.length >= 200) return;
    if (node.type === 'Alert') alertsPresent = true;
    const b = node.rect;
    const text = [node.label, node.value].filter(value => typeof value === 'string' && value.trim()).join(' | ').slice(0, 400);
    if (b && b.width > 0 && b.height > 0 && b.x < width && b.y < height && b.x + b.width > 0 && b.y + b.height > 0 &&
        node.isVisible !== '0' && text && node.type !== 'Application' && node.type !== 'Window' && node.type !== 'Other') {
      const item = {text, label: node.label || undefined, value: node.value ?? undefined,
        role: node.type, identifier: node.rawIdentifier || undefined,
        enabled: node.isEnabled !== '0', bounds: b};
      const key = JSON.stringify(item);
      if (!seen.has(key)) {seen.add(key); items.push(item);}
    }
    for (const child of node.children || []) walk(child, depth + 1);
  }
  walk(root);
  return {app: root.label, width, height, items, alertsPresent, truncated: items.length >= 200, receivedAt: Date.now()};
}

function selectorPredicate(selector) {
  if (!selector || typeof selector !== 'object') throw Error('A selector is required');
  const quote = value => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const parts = [];
  for (const [field, property] of [['identifier', 'name'], ['label', 'label'], ['type', 'type']]) {
    if (selector[field] !== undefined) {
      if (typeof selector[field] !== 'string' || !selector[field] || selector[field].length > 512 || /[\x00-\x1f]/.test(selector[field])) throw Error('Invalid UI selector');
      const value = field === 'type' && !selector[field].startsWith('XCUIElementType') ? 'XCUIElementType' + selector[field] : selector[field];
      parts.push(`${property} == ${quote(value)}`);
    }
  }
  if (!selector.identifier && !selector.label) throw Error('Selector must specify an exact identifier or label');
  return parts.join(' AND ') + ' AND visible == 1 AND enabled == 1';
}

function createWDA({baseUrl = process.env.WDA_URL, fetchImpl = fetch} = {}) {
  if (!baseUrl) return null;
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Invalid WDA_URL');
  let sessionId, connecting;
  async function request(route, body, session = true) {
    const response = await fetchImpl(new URL((session ? `/session/${sessionId}` : '') + route, url), {
      method: body === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000), redirect: 'error'
    });
    const result = await response.json();
    if (result.value?.error === 'invalid session id') sessionId = undefined;
    if (!response.ok || result.value?.error) throw Error(`WebDriverAgent request failed (${result.value?.error || response.status})`);
    return result;
  }
  async function connect() {
    if (sessionId) return;
    if (!connecting) connecting = (async () => {
      const result = await request('/session', {capabilities: {alwaysMatch: {shouldWaitForQuiescence: false}}}, false);
      sessionId = result.sessionId || result.value?.sessionId;
      if (!sessionId) throw Error('WebDriverAgent did not create a session');
      try {await request('/appium/settings', {settings: {waitForIdleTimeout: 0, animationCoolOffTimeout: 0, snapshotMaxDepth: 30}});}
      catch (error) {sessionId = undefined; throw error;}
    })().finally(() => {connecting = null;});
    return connecting;
  }
  async function readUI() {
    await connect();
    const receivedAt = Date.now();
    const {value} = await request('/source?format=json&excluded_attributes=visible,accessible');
    return {...compactTree(value), receivedAt};
  }
  async function activateApp(bundleId) {
    if (typeof bundleId !== 'string' || !/^[a-zA-Z0-9.-]{1,200}$/.test(bundleId)) throw Error('Invalid app bundle ID');
    await connect();
    await request('/wda/apps/activate', {bundleId});
    return {status: 'completed'};
  }
  async function action(args) {
    if (args.action === 'activate') return activateApp(args.bundleId);
    if (!['click', 'type'].includes(args.action)) throw Error('UI action must be activate, click or type');
    const predicate = selectorPredicate(args.selector);
    if (args.action === 'type' && (typeof args.text !== 'string' || args.text.length > 2000)) throw Error('UI text must be at most 2,000 characters');
    await connect();
    const {value} = await request('/elements', {using: 'predicate string', value: predicate});
    if (!Array.isArray(value) || value.length !== 1) throw Error(`UI selector matched ${value?.length ?? 0} elements; require exactly one`);
    const id = value[0]['element-6066-11e4-a52e-4f735466cecf'] || value[0].ELEMENT;
    if (typeof id !== 'string') throw Error('Invalid UI element response');
    if (args.action === 'type' && !['TextField', 'TextView', 'SearchField', 'SecureTextField'].includes(args.selector.type)) {
      const {value: type} = await request(`/element/${encodeURIComponent(id)}/name`);
      if (!['TextField', 'SecureTextField', 'TextView', 'SearchField', 'XCUIElementTypeTextField', 'XCUIElementTypeSecureTextField', 'XCUIElementTypeTextView', 'XCUIElementTypeSearchField'].includes(type))
        throw Error('UI typing requires an editable field');
    }
    await request(`/element/${encodeURIComponent(id)}/${args.action === 'click' ? 'click' : 'value'}`,
      args.action === 'click' ? {} : {value: [args.text]});
    return {status: 'completed', backend: 'accessibility'};
  }
  async function selectSlackConversation(query, observed) {
    const ui = observed && Date.now() - observed.receivedAt < 5000 ? observed : await readUI();
    if (ui.app !== 'Slack') throw Error('Slack is no longer foreground');
    const switcherOpen = ui.items.some(item => item.text === 'Cancel');
    const matches = ui.items.filter(item => item.role === 'Cell' && item.text.startsWith(query + ',') &&
      (switcherOpen ? /^U[A-Z0-9]+$/.test(item.identifier || '') && item.text.endsWith(', ' + query) :
        /^D[A-Z0-9]+$/.test(item.identifier || '') && /, Member$/.test(item.text)));
    if (matches.length !== 1) throw Error('No unique Slack person result; inspect get_ui');
    return action({action: 'click', selector: {identifier: matches[0].identifier, type: 'Cell'}});
  }
  return {readUI, activateApp, action, selectSlackConversation};
}
module.exports = {createWDA, compactTree, selectorPredicate};
