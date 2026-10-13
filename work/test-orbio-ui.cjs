'use strict';
// Offline behavior tests execute the actual browser script against a minimal DOM
// and mocked EIP-1193 providers No browser wallet, network or real funds are used
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const sourcePath = fs.existsSync(path.join(__dirname, 'parallax/dist/orbio.js'))
  ? path.join(__dirname, 'parallax/dist/orbio.js') : path.join(__dirname, '../dist/orbio.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const ADDRESS = '0x' + '1'.repeat(40);
const OTHER = '0x' + '2'.repeat(40);

class Element {
  constructor() {
    this._html = ''; this.children = []; this.nodes = new Map(); this.attrs = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.isConnected = true; this.open = false;
  }
  set innerHTML(value) { this._html = value; this.nodes.clear(); }
  get innerHTML() { return this._html; }
  querySelector(selector) { if (!this.nodes.has(selector)) this.nodes.set(selector, new Element()); return this.nodes.get(selector); }
  querySelectorAll(selector) {
    if (selector !== '[data-evm-wallet]') return [];
    return [...this._html.matchAll(/data-evm-wallet="([^"]+)"/g)].map(match => {
      const node = this.querySelector('[data-evm-wallet="' + match[1] + '"]');
      node.dataset = { evmWallet: match[1] }; return node;
    });
  }
  append(element) { this.children.push(element); }
  addEventListener(name, handler) { this[name] = handler; }
  setAttribute(name, value) { this.attrs[name] = value; }
  removeAttribute(name) { delete this.attrs[name]; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() {}
  scrollIntoView() {}
  after() {}
  setCustomValidity(value) { this.validityMessage = value; }
  get elements() {
    if (!this._elements) this._elements = Object.fromEntries(['name', 'ticker', 'brief', 'inspiration', 'template', 'modelId'].map(name => { const input = new Element(); input.value = ''; return [name, input]; }));
    return this._elements;
  }
}

function harness(provider, { models = [], config = {apiVersion:2,creationMode:'prompt',revisions:true,releaseReview:true}, logoutGate=null, logoutError=false } = {}) {
  const body = new Element(), launch = new Element(), launchBody = new Element();
  const events = new Map(), storage = new Map(), requests=[];
  const window = {
    openLaunch() {}, ethereum: provider,
    addEventListener: (name, handler) => events.set(name, [...(events.get(name) || []), handler]),
    dispatchEvent: event => { for (const handler of events.get(event.type) || []) handler(event); },
  };
  const document = {
    body, querySelector: selector => selector === '#launch-dialog' ? launch : selector === '#launch-body' ? launchBody : null,
    querySelectorAll: () => [], createElement: () => new Element(),
  };
  const context = {
    window, document, escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    fetch: async url => {requests.push(url);if(url==='/api/orbio/auth/logout'){if(logoutGate)await logoutGate;if(logoutError)throw Error('Legacy logout failed');}return{ ok: true, json: async () => url.startsWith('/api/orbio/models') ? { data: models } : url === '/api/builds/config' ? config : { csrf: 'OFFLINE_TEST_TOKEN' } };},
    AbortSignal, TextEncoder, URL, crypto: webcrypto, setTimeout, clearTimeout,
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  };
  vm.runInNewContext(source, context, { filename: sourcePath });
  return { window, dialog: body.children[0], events, launch, launchBody, storage, requests };
}
function providerFixture(overrides = {}) {
  const calls = [], handlers = {};
  const provider = {
    isMetaMask: true,
    request: async ({ method }) => {
      calls.push(method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ADDRESS];
      if (method === 'eth_chainId') return '0x1237';
      throw new Error('Unexpected wallet request: ' + method);
    },
    on: (event, handler) => { handlers[event] = handler; },
    removeListener: (event, handler) => { if (handlers[event] === handler) delete handlers[event]; },
    ...overrides,
  };
  return { provider, calls, handlers };
}

test('desktop wallet picker does not claim any of five wallets is installed without a provider', () => {
  const h = harness(null); h.window.openEvmWallet();
  assert.equal(h.window.getEvmWallet(), null);
  assert.match(h.dialog.innerHTML, /No Ethereum extension was detected/);
  assert.equal((h.dialog.innerHTML.match(/Extension not detected/g) || []).length, 5);
});

test('selecting an absent wallet never falls back to a different injected wallet', async () => {
  const p = providerFixture(), h = harness(p.provider); h.window.openEvmWallet();
  await h.dialog.querySelector('[data-evm-wallet="phantom"]').onclick();
  assert.equal(p.calls.length, 0);
  assert.equal(h.window.getEvmWallet(), null);
  assert.match(h.dialog.innerHTML, /Phantom is not detected/);
});

test('desktop connection requests the selected wallet and independently rechecks account and chain', async () => {
  const p = providerFixture(), h = harness(p.provider); h.window.openEvmWallet();
  await h.dialog.querySelector('[data-evm-wallet="metamask"]').onclick();
  assert.deepEqual(p.calls, ['eth_requestAccounts', 'eth_accounts', 'eth_chainId']);
  assert.equal(h.window.getEvmWallet().address, ADDRESS);
  assert.equal(h.window.getEvmWallet().name, 'MetaMask');
  assert.equal(h.window.getEvmWallet().chainId, '0x1237');
  assert.match(h.dialog.innerHTML, /Robinhood Chain/);
});

test('legacy creator reads can await account invalidation and failed logout remains rejected',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve),p=providerFixture(),h=harness(p.provider,{logoutGate:gate});h.window.openEvmWallet();await h.dialog.querySelector('[data-evm-wallet="metamask"]').onclick();
  let settled=false;const wait=h.window.RopadWallet.whenInvalidated().then(()=>settled=true);await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);release();await wait;assert.equal(settled,true);
  const bad=harness(providerFixture().provider,{logoutError:true});bad.window.openEvmWallet();await bad.dialog.querySelector('[data-evm-wallet="metamask"]').onclick();await assert.rejects(bad.window.RopadWallet.whenInvalidated(),/Legacy logout failed/);await assert.rejects(bad.window.RopadWallet.authenticate(),/Legacy logout failed/);assert.equal(bad.requests.includes('/api/orbio/auth/session'),false);
});

test('account disconnect clears wallet state and detaches every previous provider listener', async () => {
  const p = providerFixture(), h = harness(p.provider); h.window.openEvmWallet();
  await h.dialog.querySelector('[data-evm-wallet="metamask"]').onclick();
  p.handlers.chainChanged('0x1');
  assert.equal(h.window.getEvmWallet().chainId, '0x1');
  p.handlers.accountsChanged([]);
  assert.equal(h.window.getEvmWallet(), null);
  assert.equal(Object.keys(p.handlers).length, 0);
});

test('an account that changes during the connection request is not committed', async () => {
  const h = harness({ isMetaMask: true, request: async ({ method }) => method === 'eth_requestAccounts' ? [ADDRESS] : method === 'eth_accounts' ? [OTHER] : '0x1237' });
  h.window.openEvmWallet();
  await h.dialog.querySelector('[data-evm-wallet="metamask"]').onclick();
  assert.equal(h.window.getEvmWallet(), null);
  assert.match(h.dialog.innerHTML, /account changed during connection/);
});

test('wallet rejection leaves the account disconnected and allows a deliberate retry', async () => {
  const h = harness({ isMetaMask: true, request: async () => { throw Object.assign(new Error('Rejected'), { code: 4001 }); } });
  h.window.openEvmWallet();
  await h.dialog.querySelector('[data-evm-wallet="metamask"]').onclick();
  assert.equal(h.window.getEvmWallet(), null);
  assert.match(h.dialog.innerHTML, /Connection cancelled/);
  assert.equal(h.dialog.querySelector('[data-evm-wallet="metamask"]').disabled, false);
});

test('EIP-6963 wallet branding uses exact known identifiers rather than substring matches', () => {
  const h = harness(null);
  h.window.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: { rdns: 'fake.io.metamask.evil', name: 'Unrelated wallet', uuid: 'fixture' }, provider: { request: async () => [] } } });
  h.window.openEvmWallet();
  assert.match(h.dialog.innerHTML, /Unrelated wallet/);
  assert.match(h.dialog.innerHTML, /data-evm-wallet="metamask"[^>]*>[\s\S]*?Extension not detected/);
});

test('Rabby takes precedence over its compatibility isMetaMask flag', async () => {
  const p = providerFixture({ isRabby: true }), h = harness(p.provider); h.window.openEvmWallet();
  await h.dialog.querySelector('[data-evm-wallet="rabby"]').onclick();
  assert.equal(h.window.getEvmWallet().name, 'Rabby Wallet');
  assert.equal(h.window.getEvmWallet().id, 'rabby');
});

test('Roblox launch shows only approved advanced text models and never initializes a camera picker', async () => {
  const h = harness(null, { models: [
    { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
    { id: 'openai/gpt-6-astra', name: 'GPT-6 Astra', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
    { id: 'google/gemini-2.5-flash', name: 'Gemini Flash', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
    { id: 'image/generator', name: 'Image generator', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
  ] });
  h.window.initLaunchCamera = () => { throw new Error('The Roblox launch must not initialize cameras'); };
  h.window.openRobloxLaunch({ name: 'Orbit', brief: 'Build a neon obby', template: 'obby' });
  await new Promise(resolve => setImmediate(resolve));
  const workspace = h.launchBody.querySelector('#orbio-workspace');
  assert.equal(h.launch.open, true);
  assert.match(workspace.innerHTML, /What should your agent build in Roblox/);
  assert.doesNotMatch(workspace.innerHTML, /Observation interval|Camera count|Game starter|name="template"/);
  const modelOptions = h.launchBody.querySelector('#orbio-model').innerHTML;
  assert.match(modelOptions, /anthropic\/claude-opus-5\.5/); assert.match(modelOptions, /openai\/gpt-6-astra/); assert.doesNotMatch(modelOptions, /image\/generator|google\/gemini-2\.5-flash/);
  assert.equal(h.launchBody.querySelector('#orbio-model').value, 'anthropic/claude-opus-5.5');
});

test('Roblox builder saves a game-specific handoff without fabricated camera or runtime connection', async () => {
  const h = harness(null, { models: [{ id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5', architecture: { input_modalities: ['text'], output_modalities: ['text'] } }] });
  h.window.openRobloxLaunch(); await new Promise(resolve => setImmediate(resolve));
  const workspace = h.launchBody.querySelector('#orbio-workspace');
  const form = workspace.querySelector('#orbio-handoff-form');
  for (const [name, value] of Object.entries({ name: 'Orbit', ticker: 'orbit', brief: 'Build a neon checkpoint obby', inspiration:'Short repeatable rounds with an original lunar theme', template: 'obby', modelId: 'anthropic/claude-opus-5.5' })) form.elements[name].value = value;
  form.onsubmit({ preventDefault() {} });
  const [draft] = JSON.parse(h.storage.get('parallax.orbio.handoffs.v1'));
  assert.equal(draft.kind, 'roblox'); assert.equal(draft.template, 'auto'); assert.equal(draft.ticker, 'ORBIT');
  assert.equal(draft.inspiration, 'Short repeatable rounds with an original lunar theme'); assert.equal(draft.cameraId, undefined); assert.equal(draft.intervalMinutes, undefined); assert.equal(draft.runtimeConnected, false);
  assert.match(workspace.innerHTML, /BUILDER BRIEF/); assert.match(workspace.innerHTML, /Studio worker|STUDIO WORKER/);
});


test('Roblox launch cannot use cheaper models when neither advanced model is available', async () => {
  const h = harness(null, { models: [{ id: 'google/gemini-2.5-flash', name: 'Gemini Flash', architecture: { input_modalities: ['text'], output_modalities: ['text'] } }] });
  h.window.openRobloxLaunch({ modelId: 'google/gemini-2.5-flash' });
  await new Promise(resolve => setImmediate(resolve));
  const select = h.launchBody.querySelector('#orbio-model');
  assert.equal(select.value, '');
  assert.equal(select.disabled, true);
  assert.equal(h.launchBody.querySelector('#orbio-save-handoff').disabled, true);
  assert.match(h.launchBody.querySelector('#orbio-model-note').textContent, /Neither Claude Opus 5.5 nor GPT-6 Astra/);
  assert.doesNotMatch(select.innerHTML, /gemini/);
});

test('Roblox launch selects available Astra when Opus is absent and excludes legacy seed models', async () => {
  const h = harness(null, { models: [{ id: 'openai/gpt-6-astra', name: 'GPT-6 Astra', architecture: { input_modalities: ['text'], output_modalities: ['text'] } }] });
  h.window.openRobloxLaunch({ modelId: 'google/gemini-2.5-flash' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.launchBody.querySelector('#orbio-model').value, 'openai/gpt-6-astra');
  assert.equal(h.launchBody.querySelector('#orbio-save-handoff').disabled, false);
});


test('Roblox launch requires a prompt-capable backend before presenting a launch form', async () => {
  const h=harness(null,{config:{apiVersion:1}});
  h.window.openRobloxLaunch();await new Promise(resolve=>setImmediate(resolve));
  assert.match(h.launchBody.innerHTML,/Restart the local Ropad server/);
  assert.doesNotMatch(h.launchBody.innerHTML,/orbio-handoff-form/);
});

// Creator flows execute the shipped modal controller with a bounded fake service
const shellSourcePath=path.join(path.dirname(sourcePath),'builder-shell.js');
const shellSource=fs.readFileSync(shellSourcePath,'utf8');
function builderHarness({canManage=true,config={apiVersion:2,creationMode:'prompt',revisions:true,releaseReview:true}}={}){
  const dialog=new Element(),host=new Element(),kicker=new Element(),toastElement=new Element(),requests=[];
  const build={id:'parent-build',gameName:'Orbital Garden',brief:'Build an orbital garden collection game',modelId:'anthropic/claude-opus-5.5',canManage,lineage:{projectId:'parent-build',version:1},status:'ready',playtestReport:{result:'smoke_passed'}};
  const location={hash:'#/build/parent-build'},window={addEventListener(){},ParallaxBuilders:{refresh(){}}};
  const document={querySelector:selector=>({'#info-dialog':dialog,'#info-body':host,'#info-kicker':kicker,'#toast':toastElement})[selector],querySelectorAll:()=>[]};
  const context={window,document,location,AbortSignal,setTimeout,clearTimeout,navigator:{},FormData:class{constructor(form){this.form=form;}*[Symbol.iterator](){for(const [name,input]of Object.entries(this.form.elements))yield[name,input.value||''];}},fetch:async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):undefined;requests.push({url,method:options.method||'GET',body});
    const payload=url==='/api/builds/config'?config:url==='/api/status'?{csrf:'OFFLINE_CSRF'}:url==='/api/builds/models'?{data:[{id:'anthropic/claude-opus-5.5',name:'Claude Opus 5.5'}]}:url.endsWith('/revisions')?{build:{id:'revision-build'}}:{build};
    return{ok:true,json:async()=>payload};
  }};
  vm.runInNewContext(shellSource,context,{filename:shellSourcePath});
  return{window,host,dialog,requests,location,build};
}

test('creator update submits a separate prompt revision without paid generation or queueing',async()=>{
  const h=builderHarness();await h.window.updateRobloxGame('parent-build');
  const form=h.host.querySelector('form');
  form.elements.brief.value='Keep the orbital garden and add an easier first collection route';form.elements.modelId.value='anthropic/claude-opus-5.5';form.elements.inspiration.value='Repeatable short rounds';
  await form.onsubmit({preventDefault(){}});
  const writes=h.requests.filter(request=>request.method==='POST');
  assert.equal(writes.length,1);assert.equal(writes[0].url,'/api/builds/parent-build/revisions');
  assert.equal(writes[0].body.brief,form.elements.brief.value);assert.equal(h.location.hash,'#/build/revision-build');
  assert.doesNotMatch(writes[0].url,/generate|enqueue|launch/);
});

test('creator update is unavailable to a non-owner before an editable form appears',async()=>{
  const h=builderHarness({canManage:false});await h.window.updateRobloxGame('parent-build');
  assert.match(h.host.innerHTML,/Only the project creator/);assert.doesNotMatch(h.host.innerHTML,/builder-update-form/);
  assert.equal(h.requests.some(request=>request.method==='POST'),false);
});

test('creator flow fails closed on an older localhost backend',async()=>{
  const h=builderHarness({config:{apiVersion:1}});await h.window.updateRobloxGame('parent-build');
  assert.match(h.host.innerHTML,/Restart the local Ropad server/);assert.doesNotMatch(h.host.innerHTML,/builder-update-form/);
});
