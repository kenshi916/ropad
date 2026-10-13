ROPAD COMPUTE AND FEE ACCOUNTING

Status
This is a local accounting foundation, not an active fee-to-compute payment
system. No token purchase, treasury transfer, fee claim, fee-recipient change,
provider credit purchase, or automatic SOL conversion is performed here.
New local launches remain Solana Devnet test tokens. They have no fee revenue
or trading market. Public mainnet launch/metadata hosting remains unfinished.

Project compute
Every planning, concept and thumbnail request reserves project allowance before
the provider request, including both creator controls and autonomous runs.
All versions of a game share their original lineage.projectId ledger. Autonomous
actions use a persisted operation ID; a used ID cannot submit another paid call.
The project allowance, shared server daily budget, and optional agent run cap
must all permit a request. Known provider cost settles the reservation and
releases unused allowance. An ambiguous failure or crash keeps the estimated
cost as unknown, never a zero-cost success. Restart does not resubmit that work.
Actual overages are recorded even when larger than the original estimate.

Amounts use exact integer nano-USD strings (one billionth of a dollar). Provider
decimal inputs are rounded upward at that precision. The original shared server
and run caps remain independent limits. Ledger data is atomically written with
flush and stale-writer checks; unreadable/changed history stops paid work.
The shared daily ledger records the same operation IDs. A failed settlement
write stops work; startup restores known cost increases from the project ledger
while preserving other daily costs. Missing legacy operation mappings require
operator reconciliation instead of guessed refunds or double counting. The
status endpoint exposes computeRecoveryRequired for this case. Reconcile against
provider and saved operation evidence; never fix this by clearing spend/history.
An exact settlement journal is written before committing a provider result to
the project, run and daily ledgers. Pending journal entries survive UTC rollover.
Startup replays only matching operation/project/build/estimate identities and
never calls the provider again. A mismatched journal or failed recovery stops
paid work while retaining its saved evidence. This also repairs a known actual
cost when the project write failed but another ledger retained the result.

Development sponsorship
The default sponsor allowance is at most $1 per project per UTC day, within the
existing $1 server-wide daily limit. A grant is issued only when reserving a
request successfully. Viewing the page grants nothing. Unused sponsored allowance
expires at UTC midnight. It does not accumulate. A late refund to an earlier
day stays expired. This allowance is an internal permission to use the operator's
provider account, not a wallet balance, token revenue, or proof of available
OpenRouter credit. The provider can still decline an unfunded account.

Provider funding
The internal addProviderCredit method keeps evidence pending/nonspendable unless
an operator-supplied authenticated verifier confirms the exact project, unique
receipt reference and exact amount. No verifier or public grant endpoint is
enabled by default. A Solana fee receipt never invokes this method.
An OpenRouter account-level total balance alone does not prove funding for a
particular project. A production system still needs an authenticated funding
workflow, allocation of purchased provider credit, reconciliation and operations.
Unknown inference costs can be settled internally only against trustworthy
provider evidence; there is no browser endpoint accepting user-provided costs.

Read-only SOL receipt verification
Configuration is absent by default. A trusted operator may provide
fee-accounting-config.json inside the private state directory, after separately
establishing the actual on-chain fee-sharing setup. Required structure:
  platformMint: an actual Solana platform token mint
  platformTreasury: an actual intended SOL recipient address
  computeTreasury: a distinct actual intended SOL recipient address
  splitBps: { platform: chosen positive integer, compute: chosen positive integer }
  projects: [ { projectId: original saved game UUID, sourceMint: its verified mint } ]
Shares must total 10000. No addresses or economic split are supplied in the
package. Configuring this file only enables receipt verification; it does not
change or confirm any on-chain fee recipients.

The creator-authenticated POST /api/builds/:id/fees/reconcile accepts signature
and instructionIndex only. It derives project identity and the verified Solana
mainnet mint from the saved game, never user-supplied amounts or mints. A trusted
project-to-source mapping must also exist. The verifier requires mainnet genesis,
finalized matching signature/status/transaction, successful execution, canonical
Pump accounts, a supported direct SOL distribution instruction, its scoped Pump
event, and exact transfers to both configured recipients. Lamports use integer
arithmetic. Signature plus instruction index is unique across all projects.

Supported scope is deliberately narrow: direct Pump creator-fee distributions
using the SDK 4.0.0 layout, two shareholders, SOL, two corresponding transfers
and the canonical event. Ordinary transfers, balance changes alone, nested or
unsupported instruction/event layouts and other fee mechanisms are rejected.
Tests use offline fixtures; an actual funded receipt has not been exercised.
Receipt totals are lifetime historical distributions, not treasury balances.
Platform allocation means a recorded SOL allocation. It does not buy, burn,
stake, distribute or create demand for the platform token.

Inspection and activation
GET /api/builds/:id/compute exposes a public summary. Only the creator gets
detailed compute entries and their receipt history. The page's Compute accounting
disclosure keeps sponsored USD, known costs, reservations, unknown estimates and
SOL receipt totals separate. Merely opening it does not start a job or payment.
The active backend must expose computeAccounting:true in /api/builds/config.
Back up and preserve all private state when upgrading. Never copy private state
or credentials into a distributable package. Existing paid plans are not
retroactively assigned new charges or regenerated by this ledger.

Official interfaces checked October 9, 2026
https://openrouter.ai/docs/api/api-reference/credits/get-credits
  Account credit totals require a management key; not project funding evidence
https://openrouter.ai/docs/api/api-reference/generations/get-generation
  Generation metadata can provide cost evidence for an exact recorded request
https://openrouter.ai/support
  Inference costs deduct from provider credit; buying credit is a separate step
See README-FEES.txt for Pump references and scope.
