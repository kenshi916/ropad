Ropad fee sharing and provider funding — 15 October 2026

Implemented, not yet executed with real funds

solana-fee-sharing.cjs constructs official Pump SDK 4.0.0 SOL creator-fee
configuration and distribution transactions. It simulates them, shows exact
treasury recipients, accepts only the original message with the original
wallet's valid signature, saves that signed intent before broadcasting, and
verifies its finalized receipt and resulting share accounts. Unknown sends
remain pending across restarts. Expiry requires finalized blockhash expiry,
fresh signature-history absence and an absent receipt. Distribution performs
current curve and canonical AMM pool fee sweeps before payout.

Configuration is explicit: platformTreasury, computeTreasury, and positive
splitBps totaling 10000. The approved Ropad allocation is compute:6000,
creator:3000, platform:1000. These percentages divide creator-fee revenue,
not trading volume, all Pump fees, Roblox revenue or token supply. The creator
address comes from the verified launching wallet. platformMint is optional
metadata; the platform token does not need to exist for creator-fee routing.
No real wallet is included in the source examples. Optional projects mappings
or the server's verified launch resolver supply the project token mint.

When compute and platform use the same wallet, Pump gets unique recipients:
70% to that shared treasury and 30% to the creator. The 60% compute / 10%
platform distinction is internal accounting, not separately enforceable
on-chain balances. If the creator also uses that treasury, all matching shares
are combined into one recipient. Receipt verification counts each actual
transfer once and assigns integer lamports proportionally to its roles, using
the recorded largest-remainder rule for dust. Internal allocations do not
prove the current wallet balance or that money was spent on a specific game.

The sharing transaction permanently assigns ALL creator fees to the reviewed
recipients and revokes the sharing administrator, as required by Pump V2.
Creators must review that irreversible effect before signing. It does not buy
the platform token, promise token-holder payouts or prove every vault deposit
originated in trading. Fee distributions are separate wallet-reviewed
transactions; assigning a split does not schedule or pay for those claims.

New server mainnet launches require coin creation and fee configuration in
one atomic transaction. An operator-provisioned frozen mainnet lookup table
with the exact static addresses exported by pump-launch-lookup.cjs is required
to fit Solana's packet limit. The service verifies its owner, frozen state,
contents and finalized context before constructing or relaying a launch.
Finalized receipt, metadata, mint, curve and permanent share verification are
required before creating the game workspace. Existing historical launches
retain their recovery path and do not inherit a false fee-routing claim.
No funded lookup table setup or mainnet launch has been executed by these tests.

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
The server's global daily compute cap defaults to $1 and is configurable only
by the operator through ROPAD_DAILY_COMPUTE_BUDGET_USD (0 to 1000 USD). Public
deployments grant no development sponsorship. Raising this cap does not buy
credit, allocate a project balance or authorize an inference call. Creators
need an initial funded build budget even if their new coin has no trading fees.

Official references checked
https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/CREATOR_FEE_SHARING.md
https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/SWEEP_FEES.md
https://openrouter.ai/docs/cookbook/administration/crypto-api
https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits

Validation
Offline tests use random fixture wallets, real official SDK instructions and
mocked RPC/provider balances. They do not prove a live mainnet transaction or
funded provider integration. No real funds or paid inference calls were used.
