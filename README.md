# Ropad

Ropad connects prompt-driven Roblox game builders with Solana game coins. Creators describe a game, choose its AI model, generate artwork, and follow the build through Studio captures, code revisions, and release review.

The repository contains the application source, browser interface, Studio worker integration, tests, and deployment configuration. Credentials, saved games, financial records, and runtime captures are excluded from Git.

## Run locally

Prerequisites:

- Node.js 24 and npm
- Windows with Roblox Studio for the provided Studio worker setup
- A configured inference provider with available credits for paid AI generation
- Phantom or Solflare in the browser for Solana wallet actions

From the repository root:

```powershell
npm --prefix work/parallax ci --ignore-scripts
.\work\start-parallax.ps1
```

Open [http://localhost:61281](http://localhost:61281). The Windows launcher uses `work/private` for local state and can load optional provider credentials protected with Windows DPAPI. Encrypted credentials belong to the Windows user who created them; they are not portable between machines or accounts.

The Node application can also run separately from Studio, including on a non-Windows host:

```sh
cd work/parallax
PARALLAX_STATE_DIR="$HOME/.local/share/ropad" npm start
```

Without an explicit `PARALLAX_STATE_DIR`, direct startup uses `work/parallax/private`. Use one persistent state directory per server. Cloning and installing this repository does not migrate existing data or restart an existing Ropad instance.

## How it works

| Component | Responsibility |
| --- | --- |
| [`work/parallax/server.cjs`](work/parallax/server.cjs) | Persistent Node service, authentication, project records, AI requests, and transaction verification |
| [`work/parallax/dist`](work/parallax/dist) | Game directory, launch flow, token pages, creator workspace, and release controls |
| [`work/parallax/studio-worker.cjs`](work/parallax/studio-worker.cjs) | Connects authorized, isolated Roblox Studio sessions to queued builds |
| [`work/parallax/deploy`](work/parallax/deploy) | Single-server deployment examples, persistent storage, HTTPS proxy, and readiness checks |
| [`work/test-*.cjs`](work) | Application, worker, wallet, publishing, and UI tests |

AI runs have explicit spending limits. Planning, artwork, scene assembly, screenshot review, and improvements retain recorded status rather than simulated progress. Studio workers need real Studio sessions and process one assigned project at a time. A browser preview or successful smoke test does not establish that a complete game is ready for public release.

Creators can prompt new versions, inspect and edit generated source, and download Roblox `.rbxlx` projects. Manual Studio edits must be saved or exported separately; the generated download is not an automatic backup of later Studio changes.

## Roblox accounts and publication

Roblox account connection uses OAuth with the identity-only `openid` and `profile` scopes. It remains unavailable until an operator registers a Roblox OAuth application and supplies the server-side configuration. It does not log into Studio or grant publishing permission.

Games should belong to each creator's Roblox account or group. Publication is a separate step:

- Download the project, open and test it in the creator's Studio, then publish to their own experience
- Or configure a creator-scoped Open Cloud permission for an existing universe and place, review the version, and upload it

A confirmed upload does not make an experience publicly playable automatically. Roblox visibility, account eligibility, and the creator's release review remain separate requirements.

See [Roblox account setup](work/parallax/README-ROBLOX-ACCOUNT.txt) and the [publishing configuration in the deployment guide](work/parallax/deploy/README.txt).

## Solana coins and AI funding

Mainnet launching is disabled by default. Test launches use Solana devnet; test tokens have no monetary value or live trading market.

Mainnet operation requires configured infrastructure, publicly accessible token metadata, a valid simulated quote, creator wallet approval, and a verified launch receipt. Coin creation does not automatically start an AI build or publish a Roblox game. The creator explicitly starts the bounded builder run after launch.

Optional fee sharing needs configured recipients, percentages, and its own verified onchain setup. Creator fees, Roblox game income, and AI provider credit are separate records. Sending SOL to a compute treasury does not by itself fund an inference-provider balance.

See [compute accounting](work/parallax/README-ACCOUNTING.txt) and the [deployment guide](work/parallax/deploy/README.txt) for configuration and funding prerequisites.

## Tests

```powershell
npm --prefix work/parallax test
```

The automated suite checks application behavior and integration boundaries. Passing tests does not verify live provider credit, an available Studio worker, Roblox publishing access, a public deployment, or a real mainnet transaction.

## Deployment status

This is an actively developed application, not a claim of production readiness. A usable public service still needs funded provider access, isolated Studio capacity, registered OAuth configuration, creator-authorized publishing destinations, and a persistent HTTPS backend.

The deployment package uses one Node process with persistent storage. Static website hosting alone cannot run its build queues, OAuth callback, accounting, or transaction verification. Review [deployment instructions](work/parallax/deploy/README.txt) before enabling paid workflows or mainnet.

Keep provider keys, OAuth secrets, worker credentials, private state, and backups outside Git. Supply deployment secrets through the host's secret management or the documented local configuration helpers.
