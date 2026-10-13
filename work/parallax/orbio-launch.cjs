'use strict';

// This service prepares wallet transactions and verifies chain receipts only
// It has no private keys, signing method, broadcasting method, or RPC override
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseAbi, encodeFunctionData, decodeFunctionData, decodeFunctionResult, decodeEventLog, isAddress, keccak256, zeroAddress } = require('viem');

const NETWORK = Object.freeze({ chainId: 4663, chainHex: '0x1237', name: 'Robinhood Chain', rpc: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robin.etherscan.io' });
const VAULT = '0x0e1651aec67b2a049a4fa6aeb6c1c305aabfc35b';
const IMPLEMENTATION = '0x862427215620dcbed7b60ab7b885ab33c622fb86';
const IMPLEMENTATION_HASH = '0x3aaef0af5bc806370d070e1229a714cfb31fc244a5f52f0562f97e5b0d7f542d';
const FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
const PAIR = '0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3';
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const TERMS_URL = 'https://api.orbio.so/api/protocol/agents/terms';
const QUOTE_TTL = 5 * 60_000;
const MAX_INTENTS = 5000;
const CREATOR_TAX_BPS = 0;
const ABI = parseAbi([
  'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }',
  'struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }',
  'function launch(TokenParams params, address agentWallet) payable returns (uint256 agentId, address token)',
  'event AgentLaunched(uint256 indexed agentId, address indexed token, address indexed owner, address receiver, address agentWallet, bytes32 beneficiary, uint16 feeBps, uint64 launchedAt)',
]);
const FACTORY_ABI = parseAbi([
  'struct LaunchConfig { uint256 supply; uint256 curveFeeBps; uint256 phantomQuote; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; bool enabled; }',
  'struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }',
  'function getLaunchConfig(uint256 id) view returns (LaunchConfig)',
  'function getLaunchedToken(address token) view returns (LaunchedToken)',
  'function launchFee() view returns (uint256)',
  'function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)',
  'function approvedPairTokens(address pairToken) view returns (bool)',
  'function canLaunch(address caller) view returns (bool)',
]);
const TOKEN_ABI = parseAbi([
  'function name() view returns (string)', 'function symbol() view returns (string)',
  'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)',
]);
const VAULT_READ_ABI = parseAbi([
  'function feeBps() view returns (uint16)', 'function paused() view returns (bool)',
  'function launchConfigId() view returns (uint256)', 'function nextAgentId() view returns (uint256)',
]);
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const hex = n => '0x' + BigInt(n).toString(16);
const missionKey = (owner, mission) => crypto.createHash('sha256').update(JSON.stringify([owner, mission])).digest('hex');
const hashPattern = /^0x[0-9a-f]{64}$/i;
function wallet(value) {
  if (typeof value !== 'string' || !isAddress(value, { strict: false }) || same(value, zeroAddress)) throw fail(400, 'A valid Ethereum wallet address is required', 'INVALID_WALLET');
  return value.toLowerCase();
}
function limitedText(value, name, max, required = true) {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw fail(400, `Invalid ${name}`, 'INVALID_MISSION');
  value = value.trim();
  if ((required && !value) || Buffer.byteLength(value) > max) throw fail(400, `${name} must fit within ${max} bytes`, 'INVALID_MISSION');
  return value;
}
function missionData(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'An agent mission is required', 'INVALID_MISSION');
  if (input.kind === 'roblox') {
    const result = {
      kind: 'roblox', name: limitedText(input.name, 'Token name', 32), ticker: limitedText(input.ticker, 'Ticker', 10),
      brief: limitedText(input.brief, 'Game brief', 2000), modelId: limitedText(input.modelId, 'Model', 200),
      template: limitedText(input.template??'auto', 'Game design mode', 20),
    };
    if (!/^[A-Z0-9]{1,10}$/.test(result.ticker) || !['auto', 'obby', 'tycoon', 'racing'].includes(result.template)) throw fail(400, 'Invalid ticker or game design mode', 'INVALID_MISSION');
    // Keep legacy signed reviews byte-for-byte reproducible. New launches use
    // prompt mode, where reference games are part of the reviewed mission.
    if (result.template === 'auto') result.inspiration = limitedText(input.inspiration??'', 'Reference games', 1200, false);
    return result;
  }
  if (input.kind !== undefined && input.kind !== 'camera') throw fail(400, 'Unsupported agent mission', 'INVALID_MISSION');
  // Keep the original camera shape and key order for durable pre-existing launch reviews.
  const result = {
    name: limitedText(input.name, 'Token name', 32), ticker: limitedText(input.ticker, 'Ticker', 10),
    brief: limitedText(input.brief, 'Mission brief', 2000), cameraId: limitedText(input.cameraId, 'Camera', 160),
    modelId: limitedText(input.modelId, 'Model', 200), intervalMinutes: Number(input.intervalMinutes),
  };
  if (!/^[A-Z0-9]{1,10}$/.test(result.ticker) || !Number.isInteger(result.intervalMinutes) || result.intervalMinutes < 1 || result.intervalMinutes > 1440) throw fail(400, 'Invalid ticker or observation interval', 'INVALID_MISSION');
  return result;
}
function description(mission) {
  const text = mission.kind === 'roblox'
    ? mission.template === 'auto'
      ? `Ropad Roblox game agent | prompt-driven | ${mission.modelId} | ${mission.brief}`
      : `Parallax Roblox game agent | ${mission.template} | ${mission.modelId} | ${mission.brief}`
    : `Parallax camera agent | ${mission.cameraId} | ${mission.modelId} | ${mission.brief}`;
  let result = '';
  for (const c of text) { if (Buffer.byteLength(result + c) > 256) break; result += c; }
  return result;
}
function writeState(file, state) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } catch {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw fail(503, 'Unable to save the launch review; do not sign a new transaction', 'STATE_WRITE_FAILED');
  }
}

function createOrbioLaunchService({ stateDirectory, fetcher = fetch, now = Date.now } = {}) {
  if (typeof stateDirectory !== 'string' || !stateDirectory) throw fail(500, 'A private state directory is required', 'STATE_REQUIRED');
  const directory = path.resolve(stateDirectory); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'orbio-launch-intents.json');
  let state = { version: 1, chainId: NETWORK.chainId, intents: {} };
  if (fs.existsSync(file)) {
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state.version !== 1 || state.chainId !== NETWORK.chainId || !state.intents || typeof state.intents !== 'object' || Array.isArray(state.intents)) throw Error();
      const hashes = new Set();
      for (const [id, intent] of Object.entries(state.intents)) {
        if (id !== intent.intentId || !['prepared', 'pending', 'confirmed', 'reverted'].includes(intent.status) || wallet(intent.owner) !== intent.owner || !same(intent.agentWallet, intent.owner) || intent.transaction?.chainId !== NETWORK.chainHex || !same(intent.transaction?.to, VAULT) || !same(intent.transaction?.from, intent.owner) || !/^0xa3a3ee69[0-9a-f]+$/i.test(intent.transaction?.data) || !Number.isFinite(intent.createdAt) || !Number.isFinite(intent.expiresAt)) throw Error();
        missionData(intent.mission);
        const decoded = decodeFunctionData({ abi: ABI, data: intent.transaction.data });
        const [params, agentWallet] = decoded.args;
        if (intent.missionKey !== missionKey(intent.owner, missionData(intent.mission)) || decoded.functionName !== 'launch' || !same(agentWallet, intent.owner) || params.name !== intent.mission.name || params.symbol !== intent.mission.ticker || params.description !== description(intent.mission) || !same(params.creatorFeeRecipient, zeroAddress) || params.creatorTaxBps !== CREATOR_TAX_BPS || params.buybackEnabled || !same(params.expectedEconomics, intent.quote?.economics) || BigInt(intent.transaction.value) !== BigInt(intent.quote?.launchFeeWei) || !same(intent.quote?.implementation, IMPLEMENTATION) || intent.quote?.implementationCodeHash !== IMPLEMENTATION_HASH) throw Error();
        if (intent.hash) { if (!hashPattern.test(intent.hash) || hashes.has(intent.hash.toLowerCase())) throw Error(); hashes.add(intent.hash.toLowerCase()); }
        if (intent.status === 'confirmed' && (!intent.hash || !isAddress(intent.token) || !intent.agentId || !intent.blockHash)) throw Error();
        if (intent.status === 'reverted' && (!intent.hash || !hashPattern.test(intent.blockHash) || intent.finalized !== true || !Number.isFinite(intent.revertedAt))) throw Error();
      }
    } catch { throw fail(503, 'Saved Orbio launch reviews are invalid; recovery is required', 'INVALID_STATE'); }
  }
  let queue = Promise.resolve();
  const exclusive = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  const persist = next => { writeState(file, next); state = next; };
  const saveIntent = intent => persist({ ...state, intents: { ...state.intents, [intent.intentId]: intent } });
  const publicIntent = intent => {
    const result = { ...structuredClone(intent), quoteExpired: now() > intent.expiresAt };
    const { args: [params] } = decodeFunctionData({ abi: ABI, data: intent.transaction.data });
    // Derive the review text from the exact signable calldata, including old saved reviews.
    result.quote.publicMetadata = { name: params.name, symbol: params.symbol, description: params.description };
    return result;
  };
  async function request(url, options = {}) {
    let response;
    try {
      response = await fetcher(url, { ...options, signal: AbortSignal.timeout(15_000), redirect: 'error' });
      if (!response.ok) throw Error();
      const text = await response.text();
      if (text.length > 1_000_000) throw Error();
      return JSON.parse(text);
    } catch { throw fail(503, 'Robinhood or Orbio verification is temporarily unavailable', 'RPC_UNAVAILABLE'); }
  }
  async function rpc(method, params) {
    const data = await request(NETWORK.rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (data.error) throw fail(422, method === 'eth_estimateGas' || method === 'eth_call' ? 'The launch simulation or contract check failed; review the wallet balance and launch availability' : 'Chain verification failed; retry the same transaction', 'RPC_REJECTED');
    if (!Object.hasOwn(data, 'result')) throw fail(503, 'Invalid chain verification response', 'RPC_INVALID_RESPONSE');
    return data.result;
  }
  async function read(address, abi, functionName, args = [], block = 'latest') {
    const data = encodeFunctionData({ abi, functionName, args });
    const result = await rpc('eth_call', [{ to: address, data }, block]);
    try { return decodeFunctionResult({ abi, functionName, data: result }); }
    catch { throw fail(503, 'Contract response does not match the verified interface', 'ABI_MISMATCH'); }
  }
  async function verifyDeployment() {
    const [chain, storage, code] = await Promise.all([
      rpc('eth_chainId', []), rpc('eth_getStorageAt', [VAULT, IMPLEMENTATION_SLOT, 'latest']), rpc('eth_getCode', [IMPLEMENTATION, 'latest']),
    ]);
    if (BigInt(chain) !== BigInt(NETWORK.chainId)) throw fail(503, 'The RPC is not Robinhood mainnet', 'WRONG_CHAIN');
    if (!hashPattern.test(storage) || !same('0x' + storage.slice(-40), IMPLEMENTATION) || !/^0x[0-9a-f]+$/i.test(code) || keccak256(code) !== IMPLEMENTATION_HASH) throw fail(503, 'The Orbio contract changed; a new integration review is required', 'IMPLEMENTATION_CHANGED');
  }
  async function prepare({ owner, mission, agentWallet } = {}) {
    return exclusive(async () => {
      owner = wallet(owner); agentWallet = wallet(agentWallet || owner);
      if (owner !== agentWallet) throw fail(400, 'This launch flow requires the connected wallet as the agent wallet', 'AGENT_WALLET_MISMATCH');
      mission = missionData(mission);
      const key = missionKey(owner, mission);
      const existing = Object.values(state.intents).find(x => x.missionKey === key && x.status !== 'reverted');
      if (existing?.status === 'confirmed' || existing?.status === 'pending') return publicIntent(existing);
      if (!existing && Object.keys(state.intents).length >= MAX_INTENTS) throw fail(429, 'Launch review capacity reached', 'INTENT_LIMIT');
      await verifyDeployment();
      if (existing && now() <= existing.expiresAt) return publicIntent(existing);
      const [terms, launchFee, economics, approved, canLaunch, balance, gasPrice, vaultFeeBps, paused, launchConfigId, launchConfig] = await Promise.all([
        request(TERMS_URL), read(FACTORY, FACTORY_ABI, 'launchFee'), read(FACTORY, FACTORY_ABI, 'previewLaunchEconomics', [0n, PAIR]),
        read(FACTORY, FACTORY_ABI, 'approvedPairTokens', [PAIR]), read(FACTORY, FACTORY_ABI, 'canLaunch', [VAULT]),
        rpc('eth_getBalance', [owner, 'latest']), rpc('eth_gasPrice', []),
        read(VAULT, VAULT_READ_ABI, 'feeBps'), read(VAULT, VAULT_READ_ABI, 'paused'), read(VAULT, VAULT_READ_ABI, 'launchConfigId'),
        read(FACTORY, FACTORY_ABI, 'getLaunchConfig', [0n]),
      ]);
      if (terms.live !== true || terms.chainId !== NETWORK.chainId || !same(terms.vault, VAULT) || !same(terms.pairToken, PAIR) || String(terms.launchConfigId) !== '0' || launchConfigId !== 0n || String(terms.launchFeeWei) !== launchFee.toString() || !same(terms.economics, economics) || terms.pairApproved !== true || terms.paused !== false || paused || !approved || !canLaunch || !Number.isInteger(terms.feeBps) || terms.feeBps !== Number(vaultFeeBps) || terms.feeBps < 0 || terms.feeBps > 10000 || ![terms.conversionBps, terms.creditBps, terms.gatewayBps].every(n => Number.isInteger(n) && n >= 0 && n <= 10000)) throw fail(503, 'Orbio terms and the current chain state do not agree', 'TERMS_MISMATCH');
      if (launchFee <= 0n || launchFee > 10n ** 16n) throw fail(503, 'Launch fee changed beyond the supported review range', 'FEE_CHANGED');
      if (BigInt(balance) < launchFee) throw fail(422, 'The connected wallet needs enough Robinhood ETH for the launch fee and network gas', 'INSUFFICIENT_BALANCE');
      if (!launchConfig.enabled || launchConfig.supply <= 0n || launchConfig.curveFeeBps > 1000n) throw fail(503, 'The supported Pons launch configuration is unavailable', 'CONFIG_CHANGED');
      if (existing && (!same(existing.quote.economics, economics) || existing.quote.launchFeeWei !== launchFee.toString() || existing.quote.protocolFeeBps !== terms.feeBps)) throw fail(409, 'The existing launch terms changed; recover any previously sent transaction before creating a different mission', 'QUOTE_CHANGED');
      const params = existing ? decodeFunctionData({ abi: ABI, data: existing.transaction.data }).args[0] : {
        name: mission.name, symbol: mission.ticker, logo: '', description: description(mission),
        socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
        creatorFeeRecipient: zeroAddress, creatorTaxBps: CREATOR_TAX_BPS, buybackEnabled: false,
        expectedEconomics: economics, salt: '0x' + crypto.randomBytes(32).toString('hex'),
      };
      const transaction = { from: owner, to: VAULT, data: encodeFunctionData({ abi: ABI, functionName: 'launch', args: [params, agentWallet] }), value: hex(launchFee), chainId: NETWORK.chainHex };
      const simulationCall = { from: owner, to: VAULT, data: transaction.data, value: transaction.value };
      let simulation;
      try { simulation = await rpc('eth_call', [simulationCall, 'latest']); }
      catch (error) {
        if (existing && error.code === 'RPC_REJECTED') throw fail(409, 'The saved launch can no longer be simulated; recover its wallet transaction hash before trying another launch', 'RECOVERY_REQUIRED');
        throw error;
      }
      let result;
      try { result = decodeFunctionResult({ abi: ABI, functionName: 'launch', data: simulation }); }
      catch { throw fail(503, 'Launch simulation returned an unexpected result', 'SIMULATION_INVALID'); }
      if (result[0] <= 0n || !isAddress(result[1]) || same(result[1], zeroAddress)) throw fail(503, 'Launch simulation returned an unexpected result', 'SIMULATION_INVALID');
      const estimate = BigInt(await rpc('eth_estimateGas', [simulationCall]));
      if (estimate <= 0n || estimate > 30_000_000n) throw fail(503, 'Unexpected launch gas estimate', 'GAS_INVALID');
      const gasLimit = (estimate * 120n + 99n) / 100n;
      const estimatedGasCost = gasLimit * BigInt(gasPrice);
      if (BigInt(balance) < launchFee + estimatedGasCost) throw fail(422, 'The connected wallet needs enough Robinhood ETH for the launch fee and network gas', 'INSUFFICIENT_BALANCE');
      transaction.gas = hex(gasLimit);
      const reviewedAt = now(), createdAt = existing?.createdAt ?? reviewedAt;
      const intent = {
        intentId: existing?.intentId ?? crypto.randomUUID(), missionKey: key, status: 'prepared', chainId: NETWORK.chainId, owner, agentWallet, mission,
        transaction, createdAt, reviewedAt, expiresAt: reviewedAt + QUOTE_TTL,
        quote: { network: NETWORK.name, realFunds: true, pairToken: PAIR, pairSymbol: 'ORBIO', launchFeeWei: launchFee.toString(), estimatedGasWei: estimatedGasCost.toString(), estimatedTotalWei: (launchFee + estimatedGasCost).toString(), creatorTaxBps: CREATOR_TAX_BPS, baseTradeFeeBps: Number(launchConfig.curveFeeBps), protocolFeeBps: terms.feeBps, conversionBps: terms.conversionBps, creditBps: terms.creditBps, gatewayBps: terms.gatewayBps, economics, simulation: 'passed', simulationIsNotALaunch: true, implementation: IMPLEMENTATION, implementationCodeHash: IMPLEMENTATION_HASH },
      };
      saveIntent(intent);
      return publicIntent(intent);
    });
  }
  async function confirm({ owner, intentId, hash } = {}) {
    return exclusive(async () => {
      owner = wallet(owner);
      if (typeof hash !== 'string' || !hashPattern.test(hash)) throw fail(400, 'A valid transaction hash is required', 'INVALID_HASH');
      hash = hash.toLowerCase();
      const intent = state.intents[intentId];
      if (!intent || intent.owner !== owner) throw fail(404, 'Launch review not found for this wallet', 'INTENT_NOT_FOUND');
      if (intent.hash && intent.hash !== hash) throw fail(409, 'This launch review is already bound to another transaction', 'HASH_MISMATCH');
      if (Object.values(state.intents).some(x => x.intentId !== intentId && x.hash === hash)) throw fail(409, 'This transaction belongs to another launch review', 'HASH_REUSED');
      if (intent.status === 'confirmed' || intent.status === 'reverted') return publicIntent(intent);
      await verifyDeployment();
      const [tx, receipt] = await Promise.all([rpc('eth_getTransactionByHash', [hash]), rpc('eth_getTransactionReceipt', [hash])]);
      if (!tx) return { ...publicIntent(intent), status: 'pending', message: 'Waiting for the transaction to appear on Robinhood Chain' };
      if (!same(tx.hash, hash) || !same(tx.from, intent.owner) || !same(tx.to, VAULT) || !same(tx.input, intent.transaction.data) || BigInt(tx.value) !== BigInt(intent.transaction.value) || BigInt(tx.chainId) !== BigInt(NETWORK.chainId)) throw fail(422, 'The transaction does not match this launch review', 'TRANSACTION_MISMATCH');
      if (!receipt) { const pending = { ...intent, status: 'pending', hash }; saveIntent(pending); return publicIntent(pending); }
      if (!same(receipt.transactionHash, hash) || !same(receipt.from, owner) || !same(receipt.to, VAULT) || !same(receipt.blockHash, tx.blockHash) || receipt.blockNumber !== tx.blockNumber) throw fail(503, 'Transaction receipt verification failed', 'RECEIPT_MISMATCH');
      const receiptStatus = BigInt(receipt.status);
      if (receiptStatus !== 0n && receiptStatus !== 1n) throw fail(503, 'Transaction receipt status is invalid', 'RECEIPT_MISMATCH');
      const [canonical, finalized] = await Promise.all([rpc('eth_getBlockByNumber', [receipt.blockNumber, false]), rpc('eth_getBlockByNumber', ['finalized', false])]);
      if (!canonical || !same(canonical.hash, receipt.blockHash)) throw fail(409, 'The launch block changed; retry chain verification', 'REORG');
      if (!finalized || BigInt(finalized.number) < BigInt(receipt.blockNumber)) {
        const pending = { ...intent, status: 'pending', hash, message: receiptStatus === 1n ? 'Transaction succeeded; waiting for finalized chain confirmation' : 'Transaction failed; waiting for finalized chain confirmation before a new launch' }; saveIntent(pending); return publicIntent(pending);
      }
      if (receiptStatus === 0n) {
        const reverted = { ...intent, status: 'reverted', hash, blockHash: receipt.blockHash, blockNumber: BigInt(receipt.blockNumber).toString(), finalized: true, revertedAt: now(), explorerUrl: `${NETWORK.explorer}/tx/${hash}`, message: 'The launch transaction reverted; no agent was registered and a new launch review can be prepared' };
        saveIntent(reverted);
        return publicIntent(reverted);
      }
      const events = [];
      for (const log of receipt.logs || []) {
        if (!same(log.address, VAULT) || log.removed) continue;
        try { const decoded = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics, strict: true }); if (decoded.eventName === 'AgentLaunched') events.push(decoded.args); } catch {}
      }
      if (events.length !== 1) throw fail(422, 'The verified launch event is missing or ambiguous', 'EVENT_INVALID');
      const event = events[0];
      if (!same(event.owner, owner) || !same(event.agentWallet, intent.agentWallet) || !same(event.beneficiary, '0x' + owner.slice(2).padStart(64, '0')) || event.agentId <= 0n || !isAddress(event.token) || same(event.token, zeroAddress) || !isAddress(event.receiver) || same(event.receiver, zeroAddress) || Number(event.feeBps) !== intent.quote.protocolFeeBps || event.launchedAt !== BigInt(canonical.timestamp)) throw fail(422, 'The launch event does not match this wallet and mission', 'EVENT_MISMATCH');
      const token = event.token.toLowerCase();
      const [code, name, symbol, decimals, supply, launchRecord] = await Promise.all([
        rpc('eth_getCode', [token, receipt.blockNumber]), read(token, TOKEN_ABI, 'name', [], receipt.blockNumber),
        read(token, TOKEN_ABI, 'symbol', [], receipt.blockNumber), read(token, TOKEN_ABI, 'decimals', [], receipt.blockNumber), read(token, TOKEN_ABI, 'totalSupply', [], receipt.blockNumber),
        read(FACTORY, FACTORY_ABI, 'getLaunchedToken', [token], receipt.blockNumber),
      ]);
      if (!code || code === '0x' || name !== intent.mission.name || symbol !== intent.mission.ticker || Number(decimals) !== 18 || supply <= 0n) throw fail(422, 'The deployed token does not match the launch review', 'TOKEN_MISMATCH');
      if (!launchRecord.exists || !same(launchRecord.token, token) || !same(launchRecord.deployer, VAULT) || !same(launchRecord.creatorFeeRecipient, event.receiver) || !same(launchRecord.pairToken, PAIR) || Number(launchRecord.creatorTaxBps) !== intent.quote.creatorTaxBps || launchRecord.buybackEnabled) throw fail(422, 'Pons did not register the expected Orbio pair and fee recipient', 'FACTORY_RECORD_MISMATCH');
      const confirmed = { ...intent, status: 'confirmed', hash, agentId: event.agentId.toString(), token, receiver: event.receiver.toLowerCase(), beneficiary: event.beneficiary, blockHash: receipt.blockHash, blockNumber: BigInt(receipt.blockNumber).toString(), finalized: true, confirmedAt: now(), launchedAt: Number(event.launchedAt) * 1000, quoteExpiredAtMining: Number(BigInt(canonical.timestamp)) * 1000 > intent.expiresAt, tokenSupplyWei: supply.toString(), tokenDecimals: Number(decimals), explorerUrl: `${NETWORK.explorer}/tx/${hash}`, tokenUrl: `${NETWORK.explorer}/token/${token}` };
      delete confirmed.message;
      saveIntent(confirmed);
      return publicIntent(confirmed);
    });
  }
  function list(owner) { owner = wallet(owner); return Object.values(state.intents).filter(x => x.owner === owner).sort((a, b) => b.createdAt - a.createdAt).map(publicIntent); }
  return { prepare, confirm, list };
}

module.exports = { createOrbioLaunchService, ABI, FACTORY_ABI, TOKEN_ABI, VAULT_READ_ABI, NETWORK, VAULT, IMPLEMENTATION, IMPLEMENTATION_HASH, IMPLEMENTATION_SLOT, FACTORY, PAIR, TERMS_URL };
