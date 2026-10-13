'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { encodeFunctionResult, decodeFunctionData, encodeEventTopics, encodeAbiParameters, parseAbiParameters } = require('./parallax/node_modules/viem');
const { createOrbioLaunchService, ABI, FACTORY_ABI, TOKEN_ABI, VAULT_READ_ABI, NETWORK, VAULT, IMPLEMENTATION, FACTORY, PAIR, TERMS_URL } = require('./parallax/orbio-launch.cjs');
const fixture = require('./orbio-launch-fixture.json');
const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';
const RECEIVER = '0x4444444444444444444444444444444444444444';
const HASH = '0x' + '55'.repeat(32), BLOCK = '0x' + '66'.repeat(32), ECONOMICS = '0x' + '77'.repeat(32);
const MISSION = { name: 'Parallax Test', ticker: 'PQA', brief: 'Observe road conditions', cameraId: 'fremont', modelId: 'google/gemma-3-4b-it', intervalMinutes: 5 };
class FakeChain {
  constructor() { this.calls = []; this.time = 1_791_300_000_000; this.chain = '0x1237'; this.storage = '0x' + IMPLEMENTATION.slice(2).padStart(64, '0'); this.code = fixture.code; this.balance = '0x1000000000000000000'; this.finalized = '0x65'; this.tokenName = MISSION.name; this.terms = { live: true, chainId: 4663, vault: VAULT, pairToken: PAIR, launchConfigId: '0', launchFeeWei: '500000000000000', economics: ECONOMICS, pairApproved: true, paused: false, feeBps: 1000, conversionBps: 4000, creditBps: 3000, gatewayBps: 1000 }; }
  fetcher = async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url === TERMS_URL) return new Response(JSON.stringify(this.terms));
    assert.equal(url, NETWORK.rpc); const { method, params } = JSON.parse(options.body); this.calls.push(method);
    assert.ok(!method.startsWith('eth_send'), 'The service must never broadcast a transaction');
    let result;
    if (method === 'eth_chainId') result = this.chain;
    else if (method === 'eth_getStorageAt') result = this.storage;
    else if (method === 'eth_getCode') result = params[0].toLowerCase() === IMPLEMENTATION ? this.code : this.tokenCode ?? '0x6000';
    else if (method === 'eth_getBalance') result = this.balance;
    else if (method === 'eth_gasPrice') result = '0x3b9aca00';
    else if (method === 'eth_estimateGas') result = '0x3d0900';
    else if (method === 'eth_getTransactionByHash') result = this.tx ?? null;
    else if (method === 'eth_getTransactionReceipt') result = this.receipt ?? null;
    else if (method === 'eth_getBlockByNumber') result = params[0] === 'finalized' ? { number: this.finalized } : { hash: this.canonicalHash ?? BLOCK, number: '0x64', timestamp: '0x' + Math.floor(this.time / 1000).toString(16) };
    else if (method === 'eth_call') {
      const abi = params[0].to.toLowerCase() === FACTORY ? FACTORY_ABI : params[0].to.toLowerCase() === VAULT ? [...ABI, ...VAULT_READ_ABI] : TOKEN_ABI;
      const { functionName } = decodeFunctionData({ abi, data: params[0].data });
      if (this.revertSimulation && functionName === 'launch') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }));
      const values = { launchFee: 500000000000000n, previewLaunchEconomics: this.economics || ECONOMICS, approvedPairTokens: true, canLaunch: true, launch: [5n, TOKEN], name: this.tokenName, symbol: 'PQA', decimals: 18, totalSupply: 10n ** 27n, feeBps: 1000, paused: false, launchConfigId: 0n, nextAgentId: 5n,
        getLaunchConfig: { supply: 10n ** 27n, curveFeeBps: 100n, phantomQuote: 1n, graduationThreshold: 2n, poolFee: 0, tickSpacing: 200, enabled: true },
        getLaunchedToken: { token: TOKEN, curve: OTHER, deployer: VAULT, creatorFeeRecipient: RECEIVER, pairToken: this.recordPair || PAIR, graduationThreshold: 2n, poolFee: 0, tickSpacing: 200, creatorTaxBps: 0, buybackEnabled: false, phase: 0, sweptQuote: 0n, sweptTokens: 0n, sweptAt: 0n, exists: true },
      };
      result = encodeFunctionResult({ abi, functionName, result: values[functionName] });
    } else throw Error(`Unmocked RPC ${method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  };
  mined(intent, overrides = {}) {
    this.tx = { hash: HASH, from: OWNER, to: VAULT, input: intent.transaction.data, value: intent.transaction.value, chainId: '0x1237', blockHash: BLOCK, blockNumber: '0x64' };
    this.event = { agentId: 5n, token: TOKEN, owner: OWNER, receiver: RECEIVER, agentWallet: OWNER, beneficiary: '0x' + OWNER.slice(2).padStart(64, '0'), feeBps: 1000, launchedAt: BigInt(Math.floor(this.time / 1000)), ...overrides };
    const e = this.event;
    this.receipt = { transactionHash: HASH, from: OWNER, to: VAULT, blockHash: BLOCK, blockNumber: '0x64', status: '0x1', logs: [{ address: VAULT, topics: encodeEventTopics({ abi: ABI, eventName: 'AgentLaunched', args: { agentId: e.agentId, token: e.token, owner: e.owner } }), data: encodeAbiParameters(parseAbiParameters('address,address,bytes32,uint16,uint64'), [e.receiver, e.agentWallet, e.beneficiary, e.feeBps, e.launchedAt]) }] };
  }
}
function setup(t) {
  const directory = fs.mkdtempSync(path.join(__dirname, 'orbio-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const chain = new FakeChain();
  const service = createOrbioLaunchService({ stateDirectory: directory, fetcher: chain.fetcher, now: () => chain.time });
  const prepare = () => service.prepare({ owner: OWNER, agentWallet: OWNER, mission: MISSION });
  const confirm = intent => service.confirm({ owner: OWNER, intentId: intent.intentId, hash: HASH });
  return { directory, chain, service, prepare, confirm };
}

test('prepares the independently verified two-argument ABI, pinned payable transaction and durable quote without broadcasting', async t => {
  const { service, prepare, directory, chain } = setup(t); const intent = await prepare();
  assert.equal(intent.transaction.data.slice(0, 10), '0xa3a3ee69');
  const decoded = decodeFunctionData({ abi: ABI, data: intent.transaction.data });
  assert.equal(decoded.args.length, 2); assert.equal(decoded.args[1].toLowerCase(), OWNER);
  assert.equal(decoded.args[0].name, MISSION.name); assert.equal(decoded.args[0].creatorTaxBps, 0);
  assert.equal(intent.transaction.to, VAULT); assert.equal(BigInt(intent.transaction.value), 500000000000000n);
  assert.equal(intent.transaction.chainId, '0x1237'); assert.equal(intent.quote.realFunds, true);
  assert.equal(intent.quote.simulationIsNotALaunch, true); assert.equal(intent.expiresAt - intent.createdAt, 300000);
  assert.equal(service.list(OTHER).length, 0); assert.equal(service.list(OWNER).length, 1);
  const restarted = createOrbioLaunchService({ stateDirectory: directory, fetcher: chain.fetcher, now: () => chain.time });
  assert.equal(restarted.list(OWNER)[0].transaction.data, intent.transaction.data);
});
test('duplicate prepare requests reuse one durable intent and only different missions get new salts', async t => {
  const x = setup(t), first = await x.prepare(), second = await x.prepare();
  assert.equal(first.intentId, second.intentId); assert.equal(first.transaction.data, second.transaction.data);
  const other = await x.service.prepare({ owner: OWNER, mission: { ...MISSION, brief: 'A different mission' } });
  assert.notEqual(first.transaction.data, other.transaction.data);
});
test('rejects malformed mission and agent-wallet redirection before RPC', async t => {
  const { service, chain } = setup(t);
  await assert.rejects(service.prepare({ owner: OWNER, agentWallet: OTHER, mission: MISSION }), { code: 'AGENT_WALLET_MISMATCH' });
  await assert.rejects(service.prepare({ owner: OWNER, mission: { ...MISSION, ticker: 'bad ticker' } }), { code: 'INVALID_MISSION' });
  assert.equal(chain.calls.length, 0);
});
test('refuses testnet or changed implementation instead of substituting a contract', async t => {
  const x = setup(t); x.chain.chain = '0xb626'; await assert.rejects(x.prepare(), { code: 'WRONG_CHAIN' });
  x.chain.chain = '0x1237'; x.chain.storage = '0x' + OTHER.slice(2).padStart(64, '0'); await assert.rejects(x.prepare(), { code: 'IMPLEMENTATION_CHANGED' });
  x.chain.storage = '0x' + IMPLEMENTATION.slice(2).padStart(64, '0'); x.chain.code = '0x6000'; await assert.rejects(x.prepare(), { code: 'IMPLEMENTATION_CHANGED' });
});
test('blocks contradictory API terms and failed simulation', async t => {
  const x = setup(t); x.chain.terms.launchFeeWei = '1'; await assert.rejects(x.prepare(), { code: 'TERMS_MISMATCH' });
  x.chain.terms.launchFeeWei = '500000000000000'; x.chain.revertSimulation = true; await assert.rejects(x.prepare(), { code: 'RPC_REJECTED' });
  assert.equal(x.service.list(OWNER).length, 0);
});
test('checks fee plus gas balance before exposing a signable review', async t => { const x = setup(t); x.chain.balance = '0x1'; await assert.rejects(x.prepare(), { code: 'INSUFFICIENT_BALANCE' }); });
test('confirms only a finalized matching transaction, event and deployed token', async t => {
  const x = setup(t), intent = await x.prepare(); x.chain.mined(intent); const confirmed = await x.confirm(intent);
  assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.token, TOKEN); assert.equal(confirmed.agentId, '5'); assert.equal(confirmed.finalized, true);
  const count = x.chain.calls.length; assert.equal((await x.confirm(intent)).status, 'confirmed'); assert.equal(x.chain.calls.length, count);
});
test('waits for transaction visibility, receipt and chain finality', async t => {
  const x = setup(t), intent = await x.prepare(); assert.equal((await x.confirm(intent)).status, 'pending');
  assert.equal(x.service.list(OWNER)[0].status, 'prepared');
  x.chain.mined(intent); const receipt = x.chain.receipt; x.chain.receipt = null; assert.equal((await x.confirm(intent)).status, 'pending');
  x.chain.receipt = receipt; x.chain.finalized = '0x63'; assert.equal((await x.confirm(intent)).status, 'pending');
  assert.equal((await x.prepare()).status, 'pending');
  x.chain.finalized = '0x65'; assert.equal((await x.confirm(intent)).status, 'confirmed');
});
test('rejects mismatched wallet, target, data, value or chain in submitted transaction', async t => {
  const x = setup(t), intent = await x.prepare();
  for (const [field, value] of [['from', OTHER], ['to', OTHER], ['input', '0xdeadbeef'], ['value', '0x1'], ['chainId', '0x1']]) { x.chain.mined(intent); x.chain.tx[field] = value; await assert.rejects(x.confirm(intent), { code: 'TRANSACTION_MISMATCH' }); }
  assert.equal(x.service.list(OWNER)[0].status, 'prepared');
});
test('rejects missing events and noncanonical blocks', async t => {
  const x = setup(t), intent = await x.prepare();
  x.chain.mined(intent); x.chain.receipt.logs = []; await assert.rejects(x.confirm(intent), { code: 'EVENT_INVALID' });
  x.chain.mined(intent); x.chain.receipt.logs.push(x.chain.receipt.logs[0]); await assert.rejects(x.confirm(intent), { code: 'EVENT_INVALID' });
  x.chain.mined(intent); x.chain.canonicalHash = HASH; await assert.rejects(x.confirm(intent), { code: 'REORG' });
});
test('a canonical finalized revert is terminal, durable and allows a fresh review without losing history', async t => {
  const x = setup(t), intent = await x.prepare(); x.chain.mined(intent); x.chain.receipt.status = '0x0';
  const reverted = await x.confirm(intent);
  assert.equal(reverted.status, 'reverted'); assert.equal(reverted.finalized, true); assert.equal(reverted.token, undefined); assert.equal(reverted.hash, HASH);
  const calls = x.chain.calls.length; assert.equal((await x.confirm(intent)).status, 'reverted'); assert.equal(x.chain.calls.length, calls);
  const next = await x.prepare(); assert.equal(next.status, 'prepared'); assert.notEqual(next.intentId, intent.intentId); assert.notEqual(next.transaction.data, intent.transaction.data);
  assert.equal(x.service.list(OWNER).length, 2);
  const restarted = createOrbioLaunchService({ stateDirectory: x.directory, fetcher: x.chain.fetcher, now: () => x.chain.time });
  assert.equal(restarted.list(OWNER).find(i => i.intentId === intent.intentId).status, 'reverted');
  assert.equal((await restarted.prepare({ owner: OWNER, mission: MISSION })).intentId, next.intentId);
});
test('a failed receipt waits for finality and blocks a replacement until then', async t => {
  const x = setup(t), intent = await x.prepare(); x.chain.mined(intent); x.chain.receipt.status = '0x0'; x.chain.finalized = '0x63';
  const pending = await x.confirm(intent); assert.equal(pending.status, 'pending'); assert.match(pending.message, /failed/);
  assert.equal((await x.prepare()).intentId, intent.intentId); assert.equal(x.service.list(OWNER).length, 1);
  x.chain.finalized = '0x65'; assert.equal((await x.confirm(intent)).status, 'reverted');
});
test('a failed receipt on a noncanonical block cannot unlock a duplicate launch', async t => {
  const x = setup(t), intent = await x.prepare(); x.chain.mined(intent); x.chain.receipt.status = '0x0'; x.chain.canonicalHash = HASH;
  await assert.rejects(x.confirm(intent), { code: 'REORG' }); assert.equal((await x.prepare()).intentId, intent.intentId);
  x.chain.canonicalHash = BLOCK; x.chain.tx.from = OTHER;
  await assert.rejects(x.confirm(intent), { code: 'TRANSACTION_MISMATCH' }); assert.equal(x.service.list(OWNER)[0].status, 'prepared');
});
test('rejects redirected ownership, agent wallet, beneficiary and fee mismatch in event', async t => {
  const x = setup(t), intent = await x.prepare();
  for (const override of [{ owner: OTHER }, { agentWallet: OTHER }, { beneficiary: HASH }, { feeBps: 999 }]) { x.chain.mined(intent, override); await assert.rejects(x.confirm(intent), { code: 'EVENT_MISMATCH' }); }
});
test('requires real matching token code and metadata', async t => {
  const x = setup(t), intent = await x.prepare(); x.chain.mined(intent); x.chain.tokenCode = '0x'; await assert.rejects(x.confirm(intent), { code: 'TOKEN_MISMATCH' });
  x.chain.tokenCode = '0x6000'; x.chain.tokenName = 'Wrong'; await assert.rejects(x.confirm(intent), { code: 'TOKEN_MISMATCH' });
});
test('requires the Pons factory record to preserve ORBIO pairing and vault fee routing', async t => {
  const x = setup(t), intent = await x.prepare(); x.chain.mined(intent); x.chain.recordPair = OTHER;
  await assert.rejects(x.confirm(intent), { code: 'FACTORY_RECORD_MISMATCH' });
});
test('isolates wallet reviews and binds one transaction hash per intent', async t => {
  const x = setup(t), intent = await x.prepare();
  await assert.rejects(x.service.confirm({ owner: OTHER, intentId: intent.intentId, hash: HASH }), { code: 'INTENT_NOT_FOUND' });
  x.chain.mined(intent); await x.confirm(intent);
  await assert.rejects(x.service.confirm({ owner: OWNER, intentId: intent.intentId, hash: BLOCK }), { code: 'HASH_MISMATCH' });
  assert.equal((await x.prepare()).status, 'confirmed');
  const second = await x.service.prepare({ owner: OWNER, mission: { ...MISSION, brief: 'A different mission' } }); await assert.rejects(x.confirm(second), { code: 'HASH_REUSED' });
});
test('quote expiration is visible but does not orphan an already mined exact transaction', async t => {
  const x = setup(t), intent = await x.prepare(); x.chain.time += 600000;
  assert.equal(x.service.list(OWNER)[0].quoteExpired, true); x.chain.mined(intent); const result = await x.confirm(intent);
  assert.equal(result.status, 'confirmed'); assert.equal(result.quoteExpiredAtMining, true);
});
test('expired quote refresh keeps the same salt, payload and identity', async t => {
  const x = setup(t), first = await x.prepare(); x.chain.time += 600000; const refreshed = await x.prepare();
  assert.equal(first.intentId, refreshed.intentId); assert.equal(first.transaction.data, refreshed.transaction.data);
  assert.equal(first.createdAt, refreshed.createdAt); assert.ok(refreshed.expiresAt > first.expiresAt);
});
test('an expired review that can no longer be simulated requires transaction recovery', async t => {
  const x = setup(t); await x.prepare(); x.chain.time += 600000; x.chain.revertSimulation = true;
  await assert.rejects(x.prepare(), { code: 'RECOVERY_REQUIRED' }); assert.equal(x.service.list(OWNER).length, 1);
});
test('changed economics never silently replace a possibly submitted transaction', async t => {
  const x = setup(t), first = await x.prepare(); x.chain.time += 600000; x.chain.economics = HASH; x.chain.terms.economics = HASH;
  await assert.rejects(x.prepare(), { code: 'QUOTE_CHANGED' }); assert.equal(x.service.list(OWNER)[0].transaction.data, first.transaction.data);
});
test('corrupt persisted reviews fail closed', async t => {
  const x = setup(t); fs.writeFileSync(path.join(x.directory, 'orbio-launch-intents.json'), '{');
  assert.throws(() => createOrbioLaunchService({ stateDirectory: x.directory, fetcher: x.chain.fetcher }), { code: 'INVALID_STATE' });
});
test('altered persisted launch calldata fails closed', async t => {
  const x = setup(t); await x.prepare(); const file = path.join(x.directory, 'orbio-launch-intents.json');
  const state = JSON.parse(fs.readFileSync(file)); const intent = Object.values(state.intents)[0];
  intent.mission.name = 'Changed after review'; fs.writeFileSync(file, JSON.stringify(state));
  assert.throws(() => createOrbioLaunchService({ stateDirectory: x.directory, fetcher: x.chain.fetcher }), { code: 'INVALID_STATE' });
});
test('a state write failure never returns a signable review', async t => {
  const x = setup(t); fs.mkdirSync(path.join(x.directory, 'orbio-launch-intents.json'));
  await assert.rejects(x.prepare(), { code: 'STATE_WRITE_FAILED' }); assert.equal(x.service.list(OWNER).length, 0);
});

test('Roblox launch persists a camera-free game mission and publishes the exact game description', async t => {
  const x = setup(t);
  const mission = { kind: 'roblox', name: MISSION.name, ticker: MISSION.ticker, brief: 'Build a neon checkpoint obby', template: 'obby', modelId: 'coding/text-model' };
  const intent = await x.service.prepare({ owner: OWNER, mission });
  assert.deepEqual(intent.mission, mission);
  assert.equal(intent.mission.cameraId, undefined); assert.equal(intent.mission.intervalMinutes, undefined);
  const decoded = decodeFunctionData({ abi: ABI, data: intent.transaction.data });
  assert.equal(decoded.args[0].description, 'Parallax Roblox game agent | obby | coding/text-model | Build a neon checkpoint obby');
  assert.equal(intent.quote.publicMetadata.description, decoded.args[0].description);
  const restarted = createOrbioLaunchService({ stateDirectory: x.directory, fetcher: x.chain.fetcher, now: () => x.chain.time });
  assert.equal((await restarted.prepare({ owner: OWNER, mission })).intentId, intent.intentId);
  x.chain.mined(intent);
  const result = await restarted.confirm({ owner: OWNER, intentId: intent.intentId, hash: HASH });
  assert.equal(result.status, 'confirmed'); assert.equal(result.mission.kind, 'roblox'); assert.equal(result.token, TOKEN);
  assert.equal(result.runtimeConnected, undefined);
});

test('Roblox launch rejects unsupported starters, missing models and unknown mission types before RPC', async t => {
  const x = setup(t);
  const mission = { kind: 'roblox', name: MISSION.name, ticker: MISSION.ticker, brief: 'Build a neon checkpoint obby', template: 'obby', modelId: 'coding/text-model' };
  for (const invalid of [{ ...mission, template: 'arbitrary-script' }, { ...mission, modelId: '' }, { ...MISSION, kind: 'unknown' }]) {
    await assert.rejects(x.service.prepare({ owner: OWNER, mission: invalid }), { code: 'INVALID_MISSION' });
  }
  assert.equal(x.chain.calls.length, 0);
});

test('changing a Roblox starter makes a separate review while old camera reviews remain reusable', async t => {
  const x = setup(t), camera = await x.prepare();
  const mission = { kind: 'roblox', name: MISSION.name, ticker: MISSION.ticker, brief: MISSION.brief, template: 'obby', modelId: MISSION.modelId };
  const obby = await x.service.prepare({ owner: OWNER, mission });
  const racing = await x.service.prepare({ owner: OWNER, mission: { ...mission, template: 'racing' } });
  assert.notEqual(obby.intentId, racing.intentId); assert.notEqual(obby.intentId, camera.intentId);
  assert.equal((await x.prepare()).intentId, camera.intentId);
});

test('prompt-driven Ropad launches preserve reference games and remain resumable after restart', async t => {
  const x = setup(t);
  const mission = { kind: 'roblox', name: MISSION.name, ticker: MISSION.ticker, brief: 'Design an original island collection game with an attainable finish', modelId: 'anthropic/claude-opus-5.5', inspiration: 'Use short collection loops and visible upgrades as inspiration' };
  const intent = await x.service.prepare({ owner: OWNER, mission });
  assert.equal(intent.mission.template, 'auto');
  assert.equal(intent.mission.inspiration, mission.inspiration);
  const decoded = decodeFunctionData({ abi: ABI, data: intent.transaction.data });
  assert.match(decoded.args[0].description, /^Ropad Roblox game agent \| prompt-driven \| anthropic\/claude-opus-5.5/);
  const restarted = createOrbioLaunchService({ stateDirectory: x.directory, fetcher: x.chain.fetcher, now: () => x.chain.time });
  assert.equal((await restarted.prepare({ owner: OWNER, mission })).intentId, intent.intentId);
  const changed = await restarted.prepare({ owner: OWNER, mission: { ...mission, inspiration: 'Prioritize a timed obstacle loop instead' } });
  assert.notEqual(changed.intentId, intent.intentId);
  x.chain.mined(intent);
  const result = await restarted.confirm({ owner: OWNER, intentId: intent.intentId, hash: HASH });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.mission.inspiration, mission.inspiration);
});

test('prompt references are bounded and rejected before transaction preparation', async t => {
  const x = setup(t);
  const mission = { kind: 'roblox', name: MISSION.name, ticker: MISSION.ticker, brief: 'Design an original game from this prompt', modelId: 'openai/gpt-6-astra' };
  for (const inspiration of ['x'.repeat(1201), { url: 'https://example.test' }, 'bad\u0000reference']) {
    await assert.rejects(x.service.prepare({ owner: OWNER, mission: { ...mission, inspiration } }), { code: 'INVALID_MISSION' });
  }
  assert.equal(x.chain.calls.length, 0);
});
