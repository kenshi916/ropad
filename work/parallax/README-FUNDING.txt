Ropad fee sharing and provider funding — 12 October 2026

Implemented, not yet executed with real funds

solana-fee-sharing.cjs constructs official Pump SDK 4.0.0 SOL creator-fee
configuration and distribution transactions. It simulates them, shows exact
treasury recipients, accepts only the original message with the original
wallet's valid signature, saves that signed intent before broadcasting, and
verifies its finalized receipt and resulting share accounts. Unknown sends
remain pending across restarts. Expiry requires finalized blockhash expiry,
fresh signature-history absence and an absent receipt. Distribution performs
current curve and canonical AMM pool fee sweeps before payout.

Configuration is explicit: platformMint, platformTreasury, computeTreasury,
splitBps:{platform,compute}. Both positive shares must sum to 10000. No real
mint, treasury address or split is assumed. Optional projects mappings or the
server's resolveProjectMint(projectId) supply an independently verified mint.
The sharing transaction permanently assigns ALL creator fees to those two
treasuries and revokes the sharing administrator, as required by Pump V2.
Creators must review that irreversible effect before signing. This does not
buy the platform token, promise distributions to token holders or establish
that every vault deposit originated in trading.

Integration
createSolanaFeeSharingService({stateDirectory,config,resolveProjectMint,now})
prepare({owner,projectId,mint,action:'configure'|'distribute'})
submit({owner,intentId,signedTransactionBase64})
status({owner,intentId}), list({owner,projectId}), inspect({projectId,mint})
Owner is the authenticated signing Solana wallet, derived by the server. Mint
and project come from the saved verified launch, not arbitrary browser input.
Distribute returns distributionInstructionIndex for the existing exact SOL
receipt accounting service. Confirmed distribution alone never creates USD.

Provider funding
OpenRouter has removed POST /api/v1/credits/coinbase: it now returns 410 Gone.
The replacement is the provider's web credit checkout. GET /api/v1/credits is
available with a MANAGEMENT key and returns authenticated aggregate purchased
credits and usage. The ordinary inference key is not sufficient.

createOpenRouterFundingService({stateDirectory,managementKey,accountId,
  getLedger:()=>projectCompute,now})
Create that service before the ledger; connect the ledger options:
  verifyProviderFunding: funding.verifyProviderFunding
  providerFundingGuard: funding.assertBacked
Refresh authenticated credits before starting funded work: await funding.refresh()
The guard rejects stale (>60 seconds), under-backed or wrong-provider credit.
Recovery: await funding.recover() replays reserved undelivered allocations.

funding.allocate({projectId,eventId,amountUsd,operator}) is an OPERATOR-ONLY
capability. It is not a customer payment API. A configured authenticated
operator decides which project receives already-purchased provider credit.
The allocation reserves global capacity durably before an idempotent ledger
grant. Concurrent requests cannot allocate the same dollars twice. Historical
grants, pending allocations and unknown compute charges remain liabilities.
Never expose this method through an unprivileged project-owner HTTP route.

accountId is a stable operator label for the OpenRouter account, not an API key
and not an inferred provider payment receipt. Store managementKey only on the
server. Switching accounts with existing allocations is rejected. Key rotation
within that same account is supported without changing allocation history.

Operational dependency
An operator must convert SOL income and purchase provider credits through an
available payment method, then reconcile and allocate the verified dollars.
The backend does not hold wallet private keys, trade SOL, bridge funds, initiate
provider checkout or claim it has done so. The provider's balance is shared,
not escrowed per project; outside usage may create a backing shortfall, which
blocks new funded work until replenished and reconciled. Standalone sponsored
development allowances remain local allowances under the existing budget.

Official references checked
https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/CREATOR_FEE_SHARING.md
https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/SWEEP_FEES.md
https://openrouter.ai/docs/cookbook/administration/crypto-api
https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits

Validation
Offline tests use random fixture wallets, real official SDK instructions and
mocked RPC/provider balances. They do not prove a live mainnet transaction or
funded provider integration. No real funds or paid inference calls were used.
