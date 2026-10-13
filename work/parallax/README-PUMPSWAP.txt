Ropad graduated token trading — 12 October 2026

The existing market, prepare, submit and status endpoints now route completed
Pump bonding curves to their canonical SOL-quoted PumpSwap pool. API callers
do not select arbitrary pools or recipient addresses. A migration gap returns
available:false and null price/market cap, rather than reusing the closed
curve's price. Returned venue is "PumpSwap" and pool is the verified address.

The adapter verifies the canonical pool address, creator PDA, index, quote and
base mints, program owners, vault ATAs and authority, fresh account slots, mint
decimals, balances, fee configuration and retained protocol/creator fee buckets.
Price uses actual quote-vault balance plus the pool's virtual quote adjustment.
Spendable sell liquidity excludes retained fee buckets. The official SDK 2.1.0
calculates both quotes and constructs buy_exact_quote_in_v2 / sell_v2. Slippage
is enforced by explicit minimum output; the caller signs the exact local
transaction after RPC simulation. User WSOL setup/close instructions and the
official fee recipient ATA are included, with account-rent disclosure. Existing
WSOL balance unwrapping is surfaced as unwrapExistingWsol:true.

The same durable signed-message recovery and finalized receipt checks apply
before and after graduation. Receipt slot and error must also agree with the
finalized signature status. Existing saved trade intents remain supported.

Scope: standard canonical SOL pools. Mayhem, cashback and holder-reward modes,
arbitrary pools, other quote assets, cross-chain swaps and price history are
not supported. Readiness is based on account evidence, not assumed migration.
No USD prices or volume are fabricated.

Dependencies
@pump-fun/pump-sdk remains exactly 4.0.0
@pump-fun/pump-swap-sdk is directly pinned to 2.1.0
Verified against the public npm registry's official pump-fun repository metadata
and current official Pump public docs. Installation used --ignore-scripts.

References
https://github.com/pump-fun/pump-public-docs
https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md
https://www.npmjs.com/package/@pump-fun/pump-swap-sdk/v/2.1.0

Verification
Offline tests construct actual official SDK transactions and use realistic
account layouts with mock RPC evidence. They cover both sides, migration gaps,
fee buckets, wrong owners/vaults, stale snapshots, unsupported modes, signed
message tampering, simulation failures, durable recovery and finalized receipts.
These tests do not establish that a real mainnet trade has been completed.
The first real transaction still requires the user's connected wallet, SOL,
explicit reviewed signature, a verified launched mint and live RPC simulation.
