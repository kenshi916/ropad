'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Keypair, Transaction, SystemInstruction, SystemProgram } = require('./parallax/node_modules/@solana/web3.js');
const token = require('./parallax/node_modules/@solana/spl-token');
const bs58 = require('./parallax/node_modules/bs58');
const { createDevnetService, verifyWalletSignature } = require('./parallax/devnet.cjs');

const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
class FakeRpc {
  constructor() {
    this.rpcEndpoint = 'https://api.devnet.solana.com';
    this.genesis = GENESIS;
    this.height = 100;
    this.blockhash = Keypair.generate().publicKey.toBase58();
    this.statuses = new Map();
    this.sent = [];
    this.autoConfirm = true;
    this.account = null;
    this.balance = 1_000_000_000;
  }
  async getGenesisHash() { return this.genesis; }
  async getMinimumBalanceForRentExemption(size) { return size === token.MINT_SIZE ? 1_461_600 : 2_039_280; }
  async getLatestBlockhash() { return { blockhash: this.blockhash, lastValidBlockHeight: this.height + 150 }; }
  async getFeeForMessage() { return { value: 10_000 }; }
  async getBalance() { return this.balance; }
  async getBlockHeight() { return this.height; }
  async getAccountInfo() { return this.account; }
  async getSignatureStatuses(signatures, options) {
    assert.equal(options.searchTransactionHistory, true);
    if (this.statusError) throw Error('RPC unavailable');
    return { value: signatures.map(signature => this.statuses.get(signature) || null) };
  }
  async sendRawTransaction(bytes, options) {
    assert.deepEqual(options, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 });
    const transaction = Transaction.from(bytes);
    const signature = bs58.encode(transaction.signature);
    this.beforeSend?.(signature, bytes);
    this.sent.push({ bytes, signature });
    if (this.autoConfirm) this.statuses.set(signature, { slot: 101, err: null, confirmationStatus: 'confirmed', confirmations: 1 });
    if (this.sendError) throw Error('Response lost after broadcast');
    return signature;
  }
}
function setup(t, rpc = new FakeRpc()) {
  const directory = fs.mkdtempSync(path.join(__dirname, 'devnet-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ownerKey = Keypair.generate();
  const owner = ownerKey.publicKey.toBase58();
  const service = createDevnetService({ stateDirectory: directory, connection: rpc });
  return { rpc, directory, ownerKey, owner, service };
}
function sign(intent, key) {
  const tx = Transaction.from(Buffer.from(intent.transactionBase64, 'base64'));
  tx.partialSign(key);
  return tx.serialize().toString('base64');
}
function signedMessage(key, message) {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(key.secretKey).subarray(0, 32)]),
    format: 'der', type: 'pkcs8',
  });
  return crypto.sign(null, Buffer.from(message), privateKey).toString('base64');
}

test('wallet authentication verifies Ed25519 bytes and rejects altered messages, address and malformed input', () => {
  const key = Keypair.generate(), other = Keypair.generate();
  const message = 'Parallax Devnet\nnonce=unique-test-nonce';
  const input = { address: key.publicKey.toBase58(), message, signatureBase64: signedMessage(key, message) };
  assert.equal(verifyWalletSignature(input), true);
  assert.equal(verifyWalletSignature({ ...input, message: message + 'x' }), false);
  assert.equal(verifyWalletSignature({ ...input, address: other.publicKey.toBase58() }), false);
  assert.equal(verifyWalletSignature({ ...input, signatureBase64: 'invalid' }), false);
  assert.equal(verifyWalletSignature({ ...input, signatureBase64: input.signatureBase64 + '\n' }), false);
  assert.equal(verifyWalletSignature({ ...input, message: 'a'.repeat(4097) }), false);
});

test('launch uses exact atomic SPL mint, owner ATA, fixed supply, revoked mint authority and test deposit', async t => {
  const { service, owner, ownerKey, rpc, directory } = setup(t);
  const config = service.config();
  assert.equal(config.cluster, 'devnet');
  assert.equal(config.fundingLamports, 10_000_000);
  assert.equal(config.allowanceUsd, 0.10);
  const intent = await service.prepareLaunch({ owner, missionId: 'mission_1' });
  const tx = Transaction.from(Buffer.from(intent.transactionBase64, 'base64'));
  assert.equal(tx.instructions.length, 6);
  assert.equal(tx.feePayer.toBase58(), owner);
  assert.equal(tx.verifySignatures(false), true);
  assert.equal(tx.verifySignatures(true), false);
  const account = SystemInstruction.decodeCreateAccount(tx.instructions[0]);
  assert.equal(account.fromPubkey.toBase58(), owner);
  assert.equal(account.newAccountPubkey.toBase58(), intent.mint);
  assert.equal(account.programId.toBase58(), token.TOKEN_PROGRAM_ID.toBase58());
  const initialized = token.decodeInitializeMint2Instruction(tx.instructions[1]);
  assert.equal(initialized.data.decimals, 6);
  assert.equal(initialized.data.mintAuthority.toBase58(), owner);
  assert.equal(initialized.data.freezeAuthority, null);
  assert.equal(tx.instructions[2].programId.toBase58(), token.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  assert.equal(tx.instructions[2].keys[1].pubkey.toBase58(), intent.tokenAccount);
  assert.equal(tx.instructions[2].keys[2].pubkey.toBase58(), owner);
  const minted = token.decodeMintToCheckedInstruction(tx.instructions[3]);
  assert.equal(minted.data.amount, 1_000_000_000_000n);
  assert.equal(minted.data.decimals, 6);
  const revoked = token.decodeSetAuthorityInstruction(tx.instructions[4]);
  assert.equal(revoked.data.authorityType, token.AuthorityType.MintTokens);
  assert.equal(revoked.data.newAuthority, null);
  const transfer = SystemInstruction.decodeTransfer(tx.instructions[5]);
  assert.equal(transfer.toPubkey.toBase58(), config.depositAddress);
  assert.equal(transfer.lamports, 10_000_000n);
  assert.equal(intent.totalRequiredLamports, 13_510_880);
  assert.equal(JSON.stringify(intent).includes('Secret'), false);
  rpc.beforeSend = signature => {
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'devnet-intents.json'))).intents[intent.intentId];
    assert.equal(saved.status, 'pending');
    assert.equal(saved.signature, signature);
    assert.ok(saved.signedTransactionBase64);
  };
  const result = await service.submit({ owner, intentId: intent.intentId, signedTransactionBase64: sign(intent, ownerKey) });
  assert.equal(result.status, 'confirmed');
  assert.match(result.explorerUrl, /\?cluster=devnet$/);
  assert.equal(result.transactionBase64, undefined);
});

test('prepared launch is idempotent and concurrent preparation creates exactly one intent', async t => {
  const { service, owner, directory } = setup(t);
  const [a, b] = await Promise.all([service.prepareLaunch({ owner, missionId: 'same' }), service.prepareLaunch({ owner, missionId: 'same' })]);
  assert.equal(a.intentId, b.intentId);
  assert.equal(a.mint, b.mint);
  assert.equal(a.transactionBase64, b.transactionBase64);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(directory, 'devnet-intents.json'))).intents).length, 1);
});

test('wallet with insufficient test SOL gets actionable guidance before signing', async t => {
  const { service, owner, rpc, directory } = setup(t);
  rpc.balance = 0;
  await assert.rejects(service.prepareLaunch({ owner, missionId: 'no-funds' }), error => {
    assert.equal(error.status, 402);
    assert.equal(error.code, 'INSUFFICIENT_TEST_SOL');
    assert.equal(error.requiredLamports, 13_510_880);
    assert.match(error.message, /free test SOL.*faucet/);
    return true;
  });
  assert.equal(fs.existsSync(path.join(directory, 'devnet-intents.json')), false);
  assert.equal(rpc.sent.length, 0);
  rpc.balance = 1_000_000_000;
  assert.equal((await service.prepareLaunch({ owner, missionId: 'no-funds' })).status, 'prepared');
});

test('a changed transaction or missing owner signature cannot be broadcast', async t => {
  const { service, owner, ownerKey, rpc } = setup(t);
  const intent = await service.prepareLaunch({ owner, missionId: 'mutated' });
  const tx = Transaction.from(Buffer.from(intent.transactionBase64, 'base64'));
  tx.instructions.push(SystemProgram.transfer({ fromPubkey: ownerKey.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  tx.partialSign(ownerKey);
  await assert.rejects(service.submit({ owner, intentId: intent.intentId, signedTransactionBase64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') }), { code: 'TRANSACTION_CHANGED' });
  await assert.rejects(service.submit({ owner, intentId: intent.intentId, signedTransactionBase64: intent.transactionBase64 }), { code: 'INVALID_SIGNATURE' });
  assert.equal(rpc.sent.length, 0);
});

test('another wallet cannot submit, inspect or prepare an existing mission', async t => {
  const { service, owner, ownerKey, rpc } = setup(t);
  const intent = await service.prepareLaunch({ owner, missionId: 'owned' });
  const other = Keypair.generate().publicKey.toBase58();
  await assert.rejects(service.prepareLaunch({ owner: other, missionId: 'owned' }), { status: 403 });
  await assert.rejects(service.status({ owner: other, intentId: intent.intentId }), { status: 403 });
  await assert.rejects(service.submit({ owner: other, intentId: intent.intentId, signedTransactionBase64: sign(intent, ownerKey) }), { status: 403 });
  assert.equal(rpc.sent.length, 0);
});

test('signed transaction cannot be replayed against a different mission', async t => {
  const { service, owner, ownerKey, rpc } = setup(t);
  const first = await service.prepareLaunch({ owner, missionId: 'first' });
  const second = await service.prepareLaunch({ owner, missionId: 'second' });
  await assert.rejects(service.submit({ owner, intentId: second.intentId, signedTransactionBase64: sign(first, ownerKey) }), { code: 'TRANSACTION_CHANGED' });
  assert.equal(rpc.sent.length, 0);
});

test('confirmed submit retries never broadcast or produce another mint', async t => {
  const { service, owner, ownerKey, rpc } = setup(t);
  const intent = await service.prepareLaunch({ owner, missionId: 'repeated' });
  const args = { owner, intentId: intent.intentId, signedTransactionBase64: sign(intent, ownerKey) };
  const first = await service.submit(args), second = await service.submit(args);
  assert.equal(first.signature, second.signature);
  assert.equal(rpc.sent.length, 1);
  assert.equal((await service.prepareLaunch({ owner, missionId: 'repeated' })).mint, first.mint);
});

test('ambiguous broadcast outcome recovers confirmation by persisted signature after restart', async t => {
  const { service, owner, ownerKey, rpc, directory } = setup(t);
  const intent = await service.prepareLaunch({ owner, missionId: 'restart' });
  rpc.autoConfirm = false; rpc.sendError = true;
  const pending = await service.submit({ owner, intentId: intent.intentId, signedTransactionBase64: sign(intent, ownerKey) });
  assert.equal(pending.status, 'pending');
  const restarted = createDevnetService({ stateDirectory: directory, connection: rpc });
  assert.equal((await restarted.prepareLaunch({ owner, missionId: 'restart' })).intentId, intent.intentId);
  rpc.statuses.set(pending.signature, { slot: 200, err: null, confirmationStatus: 'finalized', confirmations: null });
  assert.equal((await restarted.status({ owner, intentId: intent.intentId })).status, 'confirmed');
  assert.equal(rpc.sent.length, 1);
  assert.equal(restarted.config().depositAddress, service.config().depositAddress);
});

test('unknown confirmation API result remains pending rather than granting allowance', async t => {
  const { service, owner, ownerKey, rpc } = setup(t);
  const intent = await service.prepareLaunch({ owner, missionId: 'unavailable' });
  rpc.statusError = true;
  const result = await service.submit({ owner, intentId: intent.intentId, signedTransactionBase64: sign(intent, ownerKey) });
  assert.equal(result.status, 'pending');
});

test('processed status is not enough for confirmation', async t => {
  const { service, owner, ownerKey, rpc } = setup(t);
  const intent = await service.prepareLaunch({ owner, missionId: 'processed' });
  rpc.autoConfirm = false;
  const result = await service.submit({ owner, intentId: intent.intentId, signedTransactionBase64: sign(intent, ownerKey) });
  rpc.statuses.set(result.signature, { slot: 200, err: null, confirmationStatus: 'processed', confirmations: 0 });
  assert.equal((await service.status({ owner, intentId: intent.intentId })).status, 'pending');
  rpc.statuses.set(result.signature, { slot: 200, err: { InstructionError: [0, 'GenericError'] }, confirmationStatus: 'processed', confirmations: 0 });
  assert.equal((await service.status({ owner, intentId: intent.intentId })).status, 'pending');
  rpc.statuses.set(result.signature, { slot: 200, err: null, confirmations: null });
  assert.equal((await service.status({ owner, intentId: intent.intentId })).status, 'pending');
});

test('chain errors are not confirmed and safe retry keeps the same mint', async t => {
  const { service, owner, ownerKey, rpc } = setup(t);
  const intent = await service.prepareLaunch({ owner, missionId: 'chain-error' });
  rpc.autoConfirm = false;
  const result = await service.submit({ owner, intentId: intent.intentId, signedTransactionBase64: sign(intent, ownerKey) });
  rpc.statuses.set(result.signature, { slot: 200, err: { InstructionError: [5, 'InsufficientFunds'] }, confirmationStatus: 'confirmed', confirmations: 1 });
  await assert.rejects(service.status({ owner, intentId: intent.intentId }), { status: 409, code: 'TRANSACTION_FAILED' });
  rpc.blockhash = Keypair.generate().publicKey.toBase58();
  const retry = await service.prepareLaunch({ owner, missionId: 'chain-error' });
  assert.equal(retry.mint, intent.mint);
  assert.equal(retry.intentId, intent.intentId);
  assert.notEqual(retry.transactionBase64, intent.transactionBase64);
});

test('expired unsigned preparation refreshes the same mint with a new blockhash', async t => {
  const { service, owner, ownerKey, rpc } = setup(t);
  const intent = await service.prepareLaunch({ owner, missionId: 'expired' });
  rpc.height = intent.lastValidBlockHeight + 1;
  await assert.rejects(service.submit({ owner, intentId: intent.intentId, signedTransactionBase64: sign(intent, ownerKey) }), { code: 'TRANSACTION_EXPIRED' });
  assert.equal(rpc.sent.length, 0);
  rpc.blockhash = Keypair.generate().publicKey.toBase58();
  const retry = await service.prepareLaunch({ owner, missionId: 'expired' });
  assert.equal(retry.mint, intent.mint);
  assert.equal(retry.status, 'prepared');
});

test('pending expiry requires finalized block height and absence of the mint', async t => {
  const { service, owner, ownerKey, rpc } = setup(t);
  const intent = await service.prepareLaunch({ owner, missionId: 'pending-expired' });
  rpc.autoConfirm = false;
  await service.submit({ owner, intentId: intent.intentId, signedTransactionBase64: sign(intent, ownerKey) });
  rpc.height = intent.lastValidBlockHeight + 1;
  rpc.account = { owner: token.TOKEN_PROGRAM_ID };
  assert.equal((await service.status({ owner, intentId: intent.intentId })).status, 'pending');
  rpc.account = null;
  await assert.rejects(service.status({ owner, intentId: intent.intentId }), { code: 'TRANSACTION_EXPIRED' });
});

test('wrong RPC URL or genesis is blocked before signing or broadcasting', async t => {
  const { service, owner, ownerKey, rpc, directory } = setup(t);
  const intent = await service.prepareLaunch({ owner, missionId: 'network' });
  rpc.genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  await assert.rejects(service.prepareLaunch({ owner, missionId: 'badnet' }), { code: 'WRONG_CLUSTER' });
  await assert.rejects(service.submit({ owner, intentId: intent.intentId, signedTransactionBase64: sign(intent, ownerKey) }), { code: 'WRONG_CLUSTER' });
  assert.equal(rpc.sent.length, 0);
  assert.throws(() => createDevnetService({ stateDirectory: directory, connection: { rpcEndpoint: 'https://api.mainnet-beta.solana.com' } }), { code: 'WRONG_CLUSTER' });
});

test('corrupt persisted state fails closed', async t => {
  const { service, owner, rpc, directory } = setup(t);
  await service.prepareLaunch({ owner, missionId: 'corrupt' });
  fs.writeFileSync(path.join(directory, 'devnet-intents.json'), '{broken');
  assert.throws(() => createDevnetService({ stateDirectory: directory, connection: rpc }), { code: 'INVALID_STATE' });
});

test('persistence failure prevents first broadcast', async t => {
  const { service, owner, ownerKey, rpc, directory } = setup(t);
  const intent = await service.prepareLaunch({ owner, missionId: 'unwritable' });
  const file = path.join(directory, 'devnet-intents.json');
  fs.unlinkSync(file); fs.mkdirSync(file);
  await assert.rejects(service.submit({ owner, intentId: intent.intentId, signedTransactionBase64: sign(intent, ownerKey) }), { code: 'STATE_WRITE_FAILED' });
  assert.equal(rpc.sent.length, 0);
});

test('history changes after preview stop relay and preserve the original recoverable intent', async t => {
  for (const change of ['corrupt', 'valid-change', 'remove']) await t.test(change, async t => {
    const { service, owner, ownerKey, rpc, directory } = setup(t);
    const intent = await service.prepareLaunch({ owner, missionId: 'guard-' + change });
    const file = path.join(directory, 'devnet-intents.json'), original = fs.readFileSync(file);
    const altered = change === 'corrupt' ? Buffer.from('{damaged') : Buffer.from(JSON.stringify({ ...JSON.parse(original), externalRevision: 1 }));
    if (change === 'remove') fs.unlinkSync(file); else fs.writeFileSync(file, altered);
    await assert.rejects(service.submit({ owner, intentId: intent.intentId, signedTransactionBase64: sign(intent, ownerKey) }), { code: 'STATE_WRITE_FAILED' });
    assert.equal(rpc.sent.length, 0);
    if (change === 'remove') assert.equal(fs.existsSync(file), false); else assert.deepEqual(fs.readFileSync(file), altered);
    fs.writeFileSync(file, original);
    const restored = createDevnetService({ stateDirectory: directory, connection: rpc });
    const same = await restored.prepareLaunch({ owner, missionId: 'guard-' + change });
    assert.equal(same.intentId, intent.intentId);assert.equal(same.mint, intent.mint);
    assert.equal((await restored.submit({ owner, intentId: intent.intentId, signedTransactionBase64: sign(intent, ownerKey) })).status, 'confirmed');
    assert.equal(rpc.sent.length, 1);
  });
});

test('a pending retry rechecks disk immediately before relaying the same signature', async t => {
  const { service, owner, ownerKey, rpc, directory } = setup(t);rpc.autoConfirm = false;
  const intent = await service.prepareLaunch({ owner, missionId: 'pending-guard' }), signedTransactionBase64 = sign(intent, ownerKey);
  await service.submit({ owner, intentId: intent.intentId, signedTransactionBase64 });
  const file = path.join(directory, 'devnet-intents.json');
  rpc.getSignatureStatuses = async () => { fs.writeFileSync(file, '{damaged during RPC');return { value: [null] }; };
  await assert.rejects(service.submit({ owner, intentId: intent.intentId, signedTransactionBase64 }), { code: 'STATE_WRITE_FAILED' });
  assert.equal(rpc.sent.length, 1);assert.equal(fs.readFileSync(file, 'utf8'), '{damaged during RPC');
});
