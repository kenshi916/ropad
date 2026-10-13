Ropad fee receipt interface — 9 October 2026

Status
This is an inactive-by-default, read-only accounting foundation. It has been
tested with offline receipts encoded by the official Pump SDK 4.0.0. No real
mainnet distribution receipt has been exercised against this implementation.
It does not configure fee routing, collect or claim fees, create transactions,
sign, broadcast, change recipients, buy tokens, or fund an AI provider.

Official interfaces reviewed
Pump creator fee sharing and SOL versus token distributions:
https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/CREATOR_FEE_SHARING.md
Pump fee sweeps and fees held on curves and pools:
https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/SWEEP_FEES.md
Current instruction accounts and DistributeCreatorFeesEvent layout:
https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json
Official SDK release:
https://www.npmjs.com/package/@pump-fun/pump-sdk/v/4.0.0
Anchor CPI event decoding:
https://www.anchor-lang.com/docs/features/events
Anchor event-instruction discriminator:
https://github.com/coral-xyz/anchor/blob/master/lang/src/event.rs
Solana finalized transaction lookup:
https://solana.com/docs/rpc/http/gettransaction

Integration contract
createSolanaFeeAccountingService({stateDirectory, config:null, connection?, now?})
The trusted operator injects config; there is no browser configuration endpoint.
Required fields are platformMint, platformTreasury, computeTreasury, and
splitBps:{platform,compute}. Treasuries must differ. Both shares must be positive
integer basis points and total 10000. No recipient address, mint, or percentage
is supplied by default. Optional projects is an array of {projectId,sourceMint}.
Every reconciled project requires an explicit mapping. The platform mint does
not implicitly assign platform-wide receipts to a project's account.

config() returns status inactive/configured, the explicit public configuration,
readOnly:true, onChainConfigurationVerified:false, and providerCreditsUsd:0.
Configured means verification parameters were provided, not that Pump routing
has been established or independently checked on chain.

reconcile({owner,projectId,mint,signature,instructionIndex}) returns
{receipt,duplicate,fees}. The HTTP integration must authenticate the owner,
apply its normal mutation/CSRF checks, and derive projectId and mint from the
persisted verified Solana mainnet game token. It must not accept identity, mint,
recipient, share, or credit values from the request body. The request supplies
only the transaction signature and the exact zero-based top-level instruction.

summary({projectId,owner?}) returns status, asset:'SOL', receivedLamports,
receivedSol, platformLamports, platformSol, computeLamports, computeSol,
providerCreditsUsd:0, receiptCount, receipts, and reason. Amounts are strings:
lamports are exact integers; SOL is exact decimal formatting at nine places.
Totals are public. Detailed receipts are included only when the injected owner
matches the owner who reconciled them. The server supplies that owner identity.

What a receipt proves
The RPC must identify Solana mainnet by its genesis hash. A matching successful
transaction must be finalized and match the finalized signature-status slot.
The selected instruction must be a direct Pump distribute_creator_fees or
SOL-paired distribute_creator_fees_v2. Its accounts must match the official SDK,
canonical mint, bonding-curve, sharing-config, creator-vault and event-authority
PDAs, and the configured recipients. The CPI event must belong to that exact
top-level instruction with the expected Pump program and event authority.

The supported shape has exactly two depth-two System Program SOL transfers
from the creator vault and one canonical Pump distribution event. The event's
two shareholders and basis points must match the operator config. Actual
transfers must sum exactly to the event's distributed lamports and match the
proportional shares within one-lamport integer rounding. The ledger uses those
observed transfer amounts, never a floating-point estimate.

A distribution is a creator-vault payout. It does not independently establish
that every lamport originally came from trading, since a vault can also receive
external deposits. Display these as verified Pump creator-vault distributions,
not as independently audited trading revenue.

Limits and unsupported receipts
More than two shareholders, non-SOL quotes, holder-reward payouts, nested CPI
distributions, different event layouts, missing inner-instruction evidence,
unscoped log events, generic SOL transfers, balance-delta-only evidence and
other receipt shapes are rejected. A valid on-chain payout outside this narrow
shape needs a separately reviewed verifier; it is never silently accepted.
Address table keys must be available for version-zero messages. Legacy and v0
message fixtures are covered, but no live receipt has been validated.

Accounting and spending boundary
Signature plus instruction index is globally unique in the durable ledger.
Repeated reconciliation is idempotent, including concurrent requests. A receipt
cannot be replayed for a different project or owner. Changed or damaged ledger
files stop reconciliation and preserve the existing bytes.

Amounts are lifetime gross distributions received by the configured accounts.
They are not current wallet balances, withdrawable balances, project ownership
of pooled funds, dollar valuations, or spendable OpenRouter balances. No SOL/USD
conversion occurs. Provider credits remain zero. Converting SOL, funding a
provider, and issuing project spending allowances require a separate verified
provider-funding reconciliation and explicit operating policy.

Validation
11 focused offline tests pass. Coverage includes inactive configuration, exact
SDK v1/v2 and legacy/v0 receipts, integer rounding, large lamport values,
concurrent/idempotent reconciliation, cross-project and owner replay, finalized
cluster and receipt checks, mismatched events/transfers, and preserved corruption.
No signing or broadcasting of real transactions was performed.
