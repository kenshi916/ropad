'use strict';

// This module deliberately has no configurable network or payment recipient.
// Devnet SOL is a test asset; the allowance is a subsidized application credit.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Connection, Keypair, PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID, MINT_SIZE, ACCOUNT_SIZE, AuthorityType,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction, createMintToCheckedInstruction, createSetAuthorityInstruction,
} = require('@solana/spl-token');

const RPC_URL = 'https://api.devnet.solana.com';
const GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const FUNDING_LAMPORTS = 10_000_000;
const SUPPLY = 1_000_000;
const DECIMALS = 6;
const RPC_TIMEOUT_MS = 12_000;

function fail(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function publicKey(value) {
  try {
    if (typeof value !== 'string' || value.length < 32 || value.length > 44) throw Error();
    const key = new PublicKey(value);
    if (key.toBase58() !== value || !PublicKey.isOnCurve(key.toBytes())) throw Error();
    return key;
  } catch { throw fail(400, 'A valid signing wallet address is required', 'INVALID_WALLET'); }
}

function fromBase64(value, maxBytes) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maxBytes / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw fail(400, 'Invalid base64 data', 'INVALID_ENCODING');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== value) throw fail(400, 'Invalid base64 data', 'INVALID_ENCODING');
  return bytes;
}

function verifyWalletSignature({ address, message, signatureBase64 } = {}) {
  try {
    const key = publicKey(address);
    if (typeof message !== 'string' || !message.length || Buffer.byteLength(message) > 4096) return false;
    const signature = fromBase64(signatureBase64, 64);
    if (signature.length !== 64) return false;
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.toBuffer()]);
    return crypto.verify(null, Buffer.from(message, 'utf8'), crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }), signature);
  } catch { return false; }
}

function base58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let result = '';
  while (n > 0n) { result = alphabet[Number(n % 58n)] + result; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = '1' + result; }
  return result;
}

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function atomicWrite(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  const bytes = JSON.stringify(value);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    return digest(bytes);
  } catch {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(temp); } catch {}
    throw fail(503, 'Unable to persist Devnet state; no new transaction was sent', 'STATE_WRITE_FAILED');
  }
}

function createDevnetService({ stateDirectory, connection } = {}) {
  if (!stateDirectory || typeof stateDirectory !== 'string') throw fail(500, 'A private state directory is required', 'STATE_REQUIRED');
  const directory = path.resolve(stateDirectory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stateFile = path.join(directory, 'devnet-intents.json');
  const treasuryFile = path.join(directory, 'devnet-test-treasury.json');
  let treasury;
  try {
    if (fs.existsSync(treasuryFile)) {
      const saved = JSON.parse(fs.readFileSync(treasuryFile, 'utf8'));
      if (saved.cluster !== 'devnet' || !Array.isArray(saved.secretKey) || saved.secretKey.length !== 64) throw Error();
      treasury = Keypair.fromSecretKey(Uint8Array.from(saved.secretKey));
    } else {
      if (fs.existsSync(stateFile)) throw Error('Treasury missing');
      treasury = Keypair.generate();
      atomicWrite(treasuryFile, { version: 1, cluster: 'devnet', secretKey: Array.from(treasury.secretKey) });
    }
  } catch (error) {
    if (error.code === 'STATE_WRITE_FAILED') throw error;
    throw fail(503, 'Devnet treasury state is missing or invalid', 'INVALID_STATE');
  }
  const depositAddress = treasury.publicKey.toBase58();
  let state = { version: 1, cluster: 'devnet', depositAddress, intents: {} };
  let diskDigest = null, storageFault = false;
  if (fs.existsSync(stateFile)) {
    try {
      const bytes = fs.readFileSync(stateFile);
      diskDigest = digest(bytes);
      state = JSON.parse(bytes.toString('utf8'));
      if (state.version !== 1 || state.cluster !== 'devnet' || state.depositAddress !== depositAddress ||
          !state.intents || typeof state.intents !== 'object' || Array.isArray(state.intents)) throw Error();
      const missions = new Set();
      for (const [id, intent] of Object.entries(state.intents)) {
        if (id !== intent.intentId || missions.has(intent.missionId) ||
            !['prepared', 'pending', 'confirmed', 'failed', 'expired'].includes(intent.status)) throw Error();
        publicKey(intent.owner);
        const mint = Keypair.fromSecretKey(Uint8Array.from(intent.mintSecretKey));
        if (mint.publicKey.toBase58() !== intent.mint) throw Error();
        const transaction = Transaction.from(fromBase64(intent.transactionBase64, 1232));
        if (transaction.serializeMessage().toString('base64') !== intent.messageBase64 || !transaction.verifySignatures(false)) throw Error();
        if (['pending', 'confirmed'].includes(intent.status) && (!intent.signature || !intent.signedTransactionBase64)) throw Error();
        missions.add(intent.missionId);
      }
    } catch { throw fail(503, 'Devnet transaction state is invalid; recovery is required', 'INVALID_STATE'); }
  }

  function assertStorage() {
    if (storageFault) throw fail(503, 'Devnet transaction storage is unavailable; recovery is required', 'STATE_WRITE_FAILED');
    try {
      const currentDigest = fs.existsSync(stateFile) ? digest(fs.readFileSync(stateFile)) : null;
      if (currentDigest !== diskDigest) throw Error('History changed');
    } catch {
      storageFault = true;
      throw fail(503, 'Devnet transaction history changed on disk; no new transaction was sent', 'STATE_WRITE_FAILED');
    }
  }

  if (connection?.rpcEndpoint && connection.rpcEndpoint !== RPC_URL) throw fail(503, 'Only the pinned Solana Devnet RPC is permitted', 'WRONG_CLUSTER');
  const rpc = connection || new Connection(RPC_URL, {
    commitment: 'confirmed', disableRetryOnRateLimit: true,
    fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) }),
  });
  let queue = Promise.resolve();
  const exclusive = (fn) => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  async function call(method, ...args) {
    let timeout;
    try {
      return await Promise.race([
        Promise.resolve().then(() => rpc[method](...args)),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(fail(503, 'Solana Devnet RPC timed out; retry to check the same transaction', 'RPC_TIMEOUT')), RPC_TIMEOUT_MS + 500); }),
      ]);
    } catch (error) {
      if (error.status) throw error;
      throw fail(503, 'Solana Devnet RPC is temporarily unavailable; retry to check the same transaction', 'RPC_UNAVAILABLE');
    } finally { clearTimeout(timeout); }
  }
  async function checkCluster() {
    if (await call('getGenesisHash') !== GENESIS_HASH) throw fail(503, 'RPC network verification failed; only Solana Devnet is allowed', 'WRONG_CLUSTER');
  }
  async function checkBalance(payer, requiredLamports) {
    const balance = await call('getBalance', payer, 'confirmed');
    if (!Number.isSafeInteger(balance) || balance < 0) throw fail(503, 'Unable to read the Devnet wallet balance', 'RPC_INVALID_RESPONSE');
    if (balance < requiredLamports) {
      throw Object.assign(fail(402, `This launch needs at least ${(requiredLamports / 1e9).toFixed(8)} Devnet SOL including rent and fees; add free test SOL from the Solana faucet and retry`, 'INSUFFICIENT_TEST_SOL'), { requiredLamports, balanceLamports: balance });
    }
  }
  function update(intent) {
    assertStorage();
    const next = { ...state, intents: { ...state.intents, [intent.intentId]: intent } };
    try { diskDigest = atomicWrite(stateFile, next); }
    catch (error) { storageFault = true; throw error; }
    state = next;
    return intent;
  }
  function config() {
    return { cluster: 'devnet', rpcUrl: RPC_URL, depositAddress, fundingLamports: FUNDING_LAMPORTS, allowanceUsd: 0.10, supply: SUPPLY, decimals: DECIMALS };
  }
  function output(intent) {
    return {
      ...config(), status: intent.status, owner: intent.owner, missionId: intent.missionId,
      intentId: intent.intentId, mint: intent.mint, tokenAccount: intent.tokenAccount,
      transactionBase64: intent.status === 'prepared' ? intent.transactionBase64 : undefined,
      blockhash: intent.blockhash, lastValidBlockHeight: intent.lastValidBlockHeight,
      expiresAt: intent.expiresAt, rentLamports: intent.rentLamports,
      estimatedNetworkFeeLamports: intent.estimatedNetworkFeeLamports,
      totalRequiredLamports: intent.totalRequiredLamports,
      signature: intent.signature || null, confirmedAt: intent.confirmedAt || null,
      explorerUrl: intent.signature ? `https://explorer.solana.com/tx/${intent.signature}?cluster=devnet` : null,
      mintExplorerUrl: `https://explorer.solana.com/address/${intent.mint}?cluster=devnet`,
    };
  }
  function owned(owner, intentId) {
    publicKey(owner);
    if (typeof intentId !== 'string' || !Object.hasOwn(state.intents, intentId)) throw fail(404, 'Launch intent not found', 'INTENT_NOT_FOUND');
    const intent = state.intents[intentId];
    if (intent.owner !== owner) throw fail(403, 'This launch belongs to another wallet', 'OWNER_MISMATCH');
    return intent;
  }
  function throwIfFailed(intent) {
    if (intent.status === 'failed') throw fail(409, 'The Devnet transaction failed on chain; prepare the launch again to retry safely', 'TRANSACTION_FAILED');
    if (intent.status === 'expired') throw fail(409, 'The Devnet transaction expired without confirmation; prepare the launch again', 'TRANSACTION_EXPIRED');
  }
  async function reconcile(intent) {
    if (intent.status !== 'pending') return intent;
    const response = await call('getSignatureStatuses', [intent.signature], { searchTransactionHistory: true });
    const result = response?.value?.[0];
    const confirmed = result && (result.confirmationStatus === 'confirmed' || result.confirmationStatus === 'finalized');
    if (confirmed && result.err) return update({ ...intent, status: 'failed', chainError: result.err, resolvedAt: new Date().toISOString() });
    if (confirmed && result.err === null) {
      return update({ ...intent, status: 'confirmed', confirmedAt: new Date().toISOString(), confirmationSlot: result.slot });
    }
    if (!result) {
      const height = await call('getBlockHeight', 'finalized');
      if (height > intent.lastValidBlockHeight) {
        // Never infer payment success from account existence. A missing signature plus
        // an existing mint stays pending for investigation, preventing duplicate credit.
        const account = await call('getAccountInfo', new PublicKey(intent.mint), 'finalized');
        if (!account) return update({ ...intent, status: 'expired', resolvedAt: new Date().toISOString() });
      }
    }
    return intent;
  }
  async function prepareLaunch({ owner, missionId } = {}) {
    return exclusive(async () => {
      assertStorage();
      const payer = publicKey(owner);
      if (typeof missionId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(missionId)) throw fail(400, 'A valid mission identifier is required', 'INVALID_MISSION');
      await checkCluster();
      let existing = Object.values(state.intents).find(item => item.missionId === missionId);
      if (existing && existing.owner !== owner) throw fail(403, 'This mission belongs to another wallet', 'OWNER_MISMATCH');
      if (existing?.status === 'pending') existing = await reconcile(existing);
      if (existing?.status === 'confirmed' || existing?.status === 'pending') return output(existing);
      if (existing?.status === 'prepared' && await call('getBlockHeight', 'confirmed') <= existing.lastValidBlockHeight) {
        await checkBalance(payer, existing.totalRequiredLamports);
        return output(existing);
      }
      const mint = existing ? Keypair.fromSecretKey(Uint8Array.from(existing.mintSecretKey)) : Keypair.generate();
      const [mintRent, accountRent, latest] = await Promise.all([
        call('getMinimumBalanceForRentExemption', MINT_SIZE, 'confirmed'),
        call('getMinimumBalanceForRentExemption', ACCOUNT_SIZE, 'confirmed'),
        call('getLatestBlockhash', 'confirmed'),
      ]);
      if (![mintRent, accountRent, latest?.lastValidBlockHeight].every(Number.isSafeInteger) || mintRent < 0 || accountRent < 0 || !latest.blockhash) throw fail(503, 'Invalid Devnet transaction parameters', 'RPC_INVALID_RESPONSE');
      const tokenAccount = getAssociatedTokenAddressSync(mint.publicKey, payer);
      const transaction = new Transaction({ feePayer: payer, recentBlockhash: latest.blockhash });
      transaction.add(
        SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint.publicKey, lamports: mintRent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
        createInitializeMint2Instruction(mint.publicKey, DECIMALS, payer, null),
        createAssociatedTokenAccountInstruction(payer, tokenAccount, payer, mint.publicKey),
        createMintToCheckedInstruction(mint.publicKey, tokenAccount, payer, BigInt(SUPPLY) * 10n ** BigInt(DECIMALS), DECIMALS),
        createSetAuthorityInstruction(mint.publicKey, payer, AuthorityType.MintTokens, null),
        SystemProgram.transfer({ fromPubkey: payer, toPubkey: treasury.publicKey, lamports: FUNDING_LAMPORTS }),
      );
      transaction.partialSign(mint);
      const fee = await call('getFeeForMessage', transaction.compileMessage(), 'confirmed');
      if (!Number.isSafeInteger(fee?.value) || fee.value < 0) throw fail(503, 'Unable to quote the Devnet transaction fee', 'RPC_INVALID_RESPONSE');
      await checkBalance(payer, FUNDING_LAMPORTS + mintRent + accountRent + fee.value);
      const intent = {
        intentId: existing?.intentId || crypto.randomUUID(), owner, missionId,
        mint: mint.publicKey.toBase58(), mintSecretKey: Array.from(mint.secretKey), tokenAccount: tokenAccount.toBase58(),
        status: 'prepared', transactionBase64: transaction.serialize({ requireAllSignatures: false }).toString('base64'),
        messageBase64: transaction.serializeMessage().toString('base64'),
        blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight,
        // UI estimate only; actual expiry is always checked against block height.
        expiresAt: new Date(Date.now() + 90_000).toISOString(),
        rentLamports: mintRent + accountRent, estimatedNetworkFeeLamports: fee.value,
        totalRequiredLamports: FUNDING_LAMPORTS + mintRent + accountRent + fee.value,
        createdAt: existing?.createdAt || new Date().toISOString(),
        attempts: [...(existing?.attempts || []), ...(existing?.signature ? [{ signature: existing.signature, status: existing.status }] : [])],
      };
      update(intent);
      return output(intent);
    });
  }
  async function submit({ owner, intentId, signedTransactionBase64, beforeBroadcast } = {}) {
    return exclusive(async () => {
      assertStorage();
      let intent = owned(owner, intentId);
      let transaction;
      try { transaction = Transaction.from(fromBase64(signedTransactionBase64, 1232)); }
      catch { throw fail(400, 'A valid signed Solana transaction is required', 'INVALID_TRANSACTION'); }
      const expected = Buffer.from(intent.messageBase64, 'base64');
      const received = transaction.serializeMessage();
      if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) throw fail(400, 'The signed transaction differs from the prepared launch', 'TRANSACTION_CHANGED');
      if (!transaction.verifySignatures(true)) throw fail(400, 'The wallet and mint signatures must both be valid', 'INVALID_SIGNATURE');
      const signature = base58(transaction.signature);
      if (intent.signature && intent.signature !== signature) throw fail(409, 'A different transaction signature is already recorded', 'SIGNATURE_MISMATCH');
      if (intent.status === 'confirmed') return output(intent);
      throwIfFailed(intent);
      await checkCluster();
      if (intent.status === 'pending') {
        intent = await reconcile(intent);
        throwIfFailed(intent);
        if (intent.status === 'confirmed') return output(intent);
      } else {
        if (await call('getBlockHeight', 'confirmed') > intent.lastValidBlockHeight) {
          update({ ...intent, status: 'expired' });
          throw fail(409, 'The signing window expired; prepare the launch again', 'TRANSACTION_EXPIRED');
        }
        // The transaction signature is known locally and durable before the first
        // broadcast, so a timeout/restart cannot turn a retry into a second launch.
        intent = update({ ...intent, status: 'pending', signature, signedTransactionBase64, submittedAt: new Date().toISOString() });
      }
      // A parent game index can also fail while RPC checks are in flight. Check
      // both durable records immediately before relay, including pending retries.
      if (beforeBroadcast) beforeBroadcast();
      assertStorage();
      try {
        const returned = await call('sendRawTransaction', transaction.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 });
        if (returned !== signature) throw fail(503, 'Devnet returned an unexpected signature; the launch remains pending', 'RPC_SIGNATURE_MISMATCH');
      } catch (error) {
        // An RPC failure is ambiguous: preserve the exact transaction and resolve
        // through signature status, never grant an allowance based on submission.
        intent = update({ ...intent, lastRpcError: error.code || 'RPC_UNAVAILABLE', lastBroadcastAt: new Date().toISOString() });
      }
      try { intent = await reconcile(intent); }
      catch (error) {
        if (error.code === 'STATE_WRITE_FAILED') throw error;
        return output(intent);
      }
      throwIfFailed(intent);
      return output(intent);
    });
  }
  async function status({ owner, intentId } = {}) {
    return exclusive(async () => {
      assertStorage();
      let intent = owned(owner, intentId);
      if (intent.status === 'pending') {
        await checkCluster();
        intent = await reconcile(intent);
      }
      throwIfFailed(intent);
      return output(intent);
    });
  }
  return { config, prepareLaunch, submit, status };
}

module.exports = { createDevnetService, verifyWalletSignature };
