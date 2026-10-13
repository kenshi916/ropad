ROPAD / PROMPT-DRIVEN ROBLOX GAMES

Run locally
Use npm ci --ignore-scripts, then start.ps1 in the runtime package.
The source workspace uses work/start-parallax.ps1; that existing filename and
private directory are preserved for compatibility. Open http://127.0.0.1:61281.
The server is local-only. A separate connected Roblox Studio worker applies plans.

Create and update a game
1. Describe an original game, optionally adding reference titles or URLs and
   explaining which mechanics or progression you want to learn from.
2. Select Claude Opus 5.5 or GPT-6 Astra. There is no game-starter picker.
3. Generate and review the AI design, including its gameplay loop, progression,
   unsupported requested features, limitations and acceptance criteria.
4. Queue the plan for an available Studio worker. Watch actual recorded captures,
   object progress and the runtime smoke-test result.
5. Open Update game to create a new prompt-based revision. The original version,
   artifacts and coin linkage are retained; an update does not launch another coin.
6. Playtest the whole loop in Studio. Record creator gameplay, performance and
   content review with notes. A reported Roblox URL is not verified publication.

The browser Files tab supports source inspection and project download. Edit the
exported .rbxlx and its scripts in Studio. Browser prompt updates generate a full
new scene; they do not merge later manual Studio source edits.

Actual scope
The current engine supports platform courses, collection-and-upgrade loops and
on-foot racing. The AI selects a supported foundation internally from the prompt.
It does not execute arbitrary generated Luau or implement pets, NPC AI, trading,
vehicles, combat, persistent economies or automatic publishing. Unsupported
requested features must remain visible release blockers. A passing smoke check
is not a complete gameplay test or a guarantee of a successful game.

Compute and coins
The only AI planning models are anthropic/claude-opus-5.5 (default) and
openai/gpt-6-astra, subject to current catalog availability. No cheaper fallback.
Each plan reserves at most $0.75 against the existing $1 UTC-day local budget.
Credentials remain server-side and DPAPI encrypted on Windows. Configure a key
with configure-openrouter.ps1 or configure-orbio.ps1; never place it in a prompt.
The primary product uses Solana wallets (Phantom and Solflare). Agent and platform
coins are intended for Solana. The local launch path creates an explicitly labeled
Devnet test mint linked to a Roblox workspace. It is not a mainnet market and does
not create liquidity or a real market cap. The launch creator signs to edit the
agent; holding someone else's token does not grant control of their game.
Mainnet launch requires public durable token metadata and image hosting. Do not
send a localhost image URL to a mainnet token program. Historical Orbio/Robinhood
records retain their original chain and are not reclassified as Solana tokens.
The embedded mainnet trader supports verified standard SOL-paired Pump bonding
curves. It builds transactions locally with the official SDK, previews simulation
and fees, checks the exact wallet-signed message, and verifies finalized receipts.
Completed curves and unsupported modes link out to Pump. It does not implement
PumpSwap. This trader cannot turn a Devnet token into a mainnet market. No public
mainnet launch or mainnet-token linking flow is enabled in this local release.
Market cap is reported in SOL from curve reserves; no dollar price is invented.
Creators review and sign their own transactions. No real-fund transactions are
part of development tests. Launch fees do not automatically fund AI compute.
The coin workspace puts a market overview beside the buy/sell form, followed by
the real Studio view and creator controls. Market cap and token price are shown
in SOL from verified supported curve snapshots. The chart records observations
only while this browser session is open; it is not a historical candle feed.
No USD conversion, historical volume, holder count or price change is invented.
Prelaunch and Devnet coins retain a disabled trade form with a clear market state.
Creators can use separate planning/artwork/queue controls, or explicitly start
one bounded autonomous run. No agent starts merely because a page is opened or
a coin is launched.

Bounded autonomous builds
Start agent approves a $0.01-$1 run cap plus optional concept and thumbnail work.
The cap is a spending limit within the existing shared daily budget, not a funded
balance or a promise that the next model call fits. Existing saved plans and art
are reused. Only Opus 5.5 and GPT-6 Astra may plan. The runner persists planning,
artwork, assembly, runtime evidence, and the final creator-review stop.
Pause prevents the next step. A current provider call or claimed Studio job may
finish safely; a waiting queue entry is cancelled. Resume preserves the original
budget and choices. Restart never repeats an unresolved paid request. Unknown
charges retain their estimates; such runs require inspection and a new revision.
One plan repair is allowed only after a known-cost validation failure, before
any accepted plan or Studio mutation, and within the same remaining budget.
Failed Studio work is never replayed automatically.
Autonomous assembly requires a fresh idle dedicated worker advertising agent
protocol 1 and scene-v1. Old running workers cannot claim these jobs. A passing
runtime smoke check leads to creator review, never automatic publication or an
assertion that the entire game was played. Unsupported features block assembly.

Generated artwork
Generate a 16:9 game thumbnail for the directory and a separate concept image for
the desired visual direction. Both use the current OpenRouter FLUX.3 Image catalog
and verified fixed 1K image pricing, capped at a $0.15 estimate per image and the
shared local daily budget. Failed regeneration preserves the previous image.
Artwork is not a captured game screen. The Studio view only displays actual
captured frames with their timestamps. Opus/Astra remain the game planning models.

Verification
Run npm test. Tests use mocked inference and chain receipts, not real funds.
The local Studio connection has built two prior games with captured frames and
runtime smoke checks. Their historical Gemini model labels remain accurate.
New image, Solana and prompt capabilities require the updated server process.
/api/builds/config exposes apiVersion:2, workerPlanSchema:'scene-v1',
conceptGeneration:true, thumbnailGeneration:true, autonomousBuilds:true and
computeAccounting:true when
activated. The old server must be restarted to load the new backend modules.
Fixed gameplay now includes a visible timer and session best score. An already
running worker retains its previously loaded script until replaced by a fresh
worker on an empty dedicated Studio place. Preserve existing places first.
Each updated worker retires after one completed build. It never recycles or
deletes an existing scene; use a fresh empty unpublished place for the next build.
See README-WORKERS.txt for worker setup and README-ROBLOX.txt for release checks.
See README-ACCOUNTING.txt for exact project spending reservations, expiring
sponsored allowances and inactive read-only SOL fee receipt configuration.

Release status
This is a local development build, not a production launch. Public hosting,
mainnet mint metadata, platform treasury/fee configuration, funded per-agent
compute, activation of the bounded runner and full gameplay verification remain open.
The dependency audit reports transitive high-severity advisories that require
review before deployment. Installation scripts are disabled; development tests
use the pure JavaScript bigint fallback. This is not a security certification.
See RELEASE-READINESS.txt for the final audit evidence, activation steps and
remaining launch dependencies. Optional executable Luau fixture checks require
an official Luau CLI; set PARALLAX_LUAU_PATH and ROPAD_LUAU_BIN to its executable
before npm test so both worker and gameplay fixture checks run.
