Ropad persistent runtime deployment package

Prepared files only. Nothing has been deployed, purchased, restarted or changed
in DNS. Docker is not available on the preparation host, so the image and Caddy
configuration still require a container build and validation on the chosen host.

Topology
https://ropad.fun -> Caddy -> ONE Node process on internal port 61281.
The same Node process serves the maintained frontend in work/parallax/dist and
all /api routes, token metadata, OAuth callbacks and worker screenshots. This
package replaces the static interface preview at the canonical domain; it does
not connect that preview directly to a separate api.ropad.fun browser origin.
Keep the current public site working until the new host passes staging checks.
Changing DNS and retiring its previous custom-domain binding are later cutover
actions, not effects of copying these deployment files.
The app image runs as the unprivileged node user (UID/GID 1000), with a read-only
root filesystem. The named ropad_private volume contains saved games, build and
transaction history, compute accounting, worker credentials and operator config.
Caddy's separate persistent volumes retain TLS account/certificate state.

Do not use multiple Node replicas, PM2 cluster mode, serverless handlers, or two
hosts writing the same volume. The current ledgers detect stale file writes;
they are not a distributed database. A fixed container name prevents accidental
Compose scaling. Studio workers run separately on Windows/Mac hosts with actual
Roblox Studio sessions and authorized Roblox accounts. They are not included in
this Linux image and no live game is simulated by the container health check.

First deployment on the selected Linux Docker host
1. Use the maintained Git checkout, then work in work/parallax/deploy. The Docker
   build context is work/parallax, including its current dist, not work/ropad-sites.
   Copy the runtime source and deploy directory; do not copy credentials into
   the image or distribute the existing private folder with frontend files.
   Dockerfile.dockerignore allowlists shipped source and excludes private files,
   node_modules and all runtime-playtest captures. Pooled worker screenshots are
   stored in the private volume and served by /api/builds/:id/screen instead.
2. In deploy, copy .env.example to .env. Restrict its permissions. Fill secrets
   there or inject equivalent environment values through your host's secret
   manager. Keep ROPAD_SOLANA_MAINNET_ENABLED=0 initially. An ordinary OpenRouter
   inference key does not replace the management key used to verify credit.
3. Use one canonical hostname for ROPAD_DOMAIN and ROPAD_PUBLIC_ORIGIN. The
   provided worker currently accepts only ropad.fun / www.ropad.fun over HTTPS.
   If choosing a different hostname, update and test that allowlist first.
   The supplied configuration uses ropad.fun. Set an HTTPS redirect for www at
   the proxy/hosting layer if desired; it is not a second authenticated origin.
4. Arrange the host, domain DNS and inbound TCP 80/443 (UDP 443 is optional for
   HTTP/3). This package has not done any of those actions. Caddy obtains TLS
   when the configured public hostname actually reaches this host.
5. Validate locally on the deployment host, without printing rendered secrets:
     docker compose --env-file .env config --quiet
     docker compose --env-file .env build --pull app
     docker compose --env-file .env run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
6. After deployment authorization, start the single app and proxy:
     docker compose --env-file .env up -d
   The named volume is initialized from the image's node-owned state directory.
   A custom bind mount must instead be pre-owned by UID/GID 1000. Do not broaden
   it to the entire workspace or mount user profile credentials into the app.
7. Check runtime configuration without exposing keys or saved project records:
     docker compose exec app node deploy/check-readiness.cjs
   Exit 0: launch configuration is present; 1: runtime configuration incomplete;
   2: runtime configured but launch prerequisites missing. This script makes no
   provider, blockchain or Studio requests and does not verify live readiness.
   It validates the actual private fee configuration, required frontend files,
   locally referenced entrypoint assets, and absence of the old preview blocker.
   The output contains booleans and check names, never secret values or records.
   The Docker health check separately GETs /api/health using an allowed Host.
8. Before routing public traffic, verify HTTPS, browser wallet authentication,
   creator authorization, CSRF rejection and a connected isolated Studio worker.
   Keep mainnet disabled through these checks. A successful health response is
   not evidence that provider credit, game publication or trading is available.

Read-only local preflight
With Node dependencies installed and the intended non-secret settings plus
server secrets supplied privately in the environment, run:
  node work/parallax/deploy/check-readiness.cjs
Set PARALLAX_STATE_DIR explicitly to the state directory being inspected. The
script defaults to work/parallax/private, which may differ from the local app's
work/private. It never creates a missing state directory or modifies its files.
An exit of 1 or 2 lists concrete missing configuration rather than enabling it.

Existing data and backup
Preserve the entire current private state, not only game files. The live state
path may be work/private rather than work/parallax/private; inspect the existing
launcher/config before migration. Windows DPAPI-encrypted provider credentials
cannot be decrypted by Linux; supply server environment secrets separately.
Only copy state from a stopped/quiescent original server, and never leave the
original process serving against the same ledger after cutover. Make a complete
encrypted backup before import and keep the original intact. Restore to the
named volume with UID/GID 1000 ownership and restrictive permissions.
Back up private and Caddy volumes consistently while the app is stopped, or use
a filesystem snapshot with a tested recovery procedure. Never run Compose down
with --volumes. Container replacement preserves named volumes; deleting them
would erase saved games, transaction recovery state and credentials.

Operator files inside the private volume
- fee-accounting-config.json: fill reviewed platform/compute treasury addresses
  and positive shares totaling 10000 bps. platformMint is optional/null; a Ropad
  platform-token mint is not needed to route each game's Pump creator fees.
  The example deliberately fails validation until completed. Do not install an
  empty example as if it were configured. Verified new game mints are derived
  from persisted launch receipts by the server; static project mappings remain
  optional. Each coin still needs a creator-reviewed fee-sharing signature.
  The suggested compute-first preset is
  fee-accounting-config.compute-first.example.json: 60% compute, 30% creator,
  10% platform. These shares divide collected creator-fee revenue, not trading
  volume, token supply, all Pump fees or Roblox game revenue. For $100 equivalent
  of collected creator fees, those buckets receive $60 / $30 / $10 equivalent.
  SOL amounts stay SOL until an operator handles provider funding separately.
  The creator recipient is resolved from the verified project owner; it is not
  an operator-entered shared creator wallet. Treasury addresses may be the same.
  With one platform/compute wallet, Pump receives a 70% recipient and the creator
  a 30% recipient. The 60% AI / 10% platform distinction is internal accounting
  within that shared wallet, not a separate on-chain AI reserve. If the verified
  creator is also that wallet, all three roles merge into one 100% recipient.
  Verified receipts expose unique on-chain transfers separately from internal
  role allocations; integer dust uses proportional largest remainder rounding.
  All example treasury addresses are empty, so
  the preset fails validation until reviewed and completed. No example is loaded
  automatically, and no existing project split is changed by adding this file.
  The platform bucket is a treasury allocation, not automatic holder payouts or
  token buybacks. Initial AI credit must be funded before relying on future fees.
- roblox-publishing-config.json: use credentialMode "creator_scoped". Each creator
  owns their game in their own Roblox account or group. Do not publish all games
  under the Ropad operator's personal account. projects maps the saved project ID
  to {owner: creatorWallet, universeId: authorizedUniverseId,
      placeId: authorizedPlaceId, credentialEnv: "ROPAD_ROBLOX_CREATOR_ALICE_KEY"}.
  The owner is the verified Ropad creator identity; the Roblox account/group must
  separately authorize that exact destination. A wallet is not Roblox ownership.
  Create the initial private experience in the creator's own Studio/account or
  group, then grant universe-places Write only for that creator's target. Keep
  the key in the referenced server environment variable, never in the JSON grant
  or browser. Names must match ROPAD_ROBLOX_CREATOR_<UPPERCASE_ID>_KEY. Inject each
  added variable into the actual app container via the host secret manager or an
  explicit Compose environment entry; a host .env entry alone is not forwarded.
  Missing creator keys never fall back to the operator's key. Cross-creator key
  reuse and assigning one place to multiple projects are rejected. Projects by
  the same creator may share a key only if its Roblox scopes authorize them.
  Legacy configs without this mode or any credentialEnv keep the former global
  ROBLOX_OPEN_CLOUD_API_KEY behavior for existing single-operator installations.
  Publishing grants are operator-provisioned per creator. Identity-only Roblox
  OAuth is implemented separately; register the Ropad app, supply its client ID,
  client secret and exact https://ropad.fun/roblox/oauth/callback redirect URI.
  It links the authenticated Roblox profile to the verified creator wallet and
  does not grant Studio control or place-publishing permission. OAuth registration
  and any required Roblox review remain external prerequisites. See
  ../README-ROBLOX-ACCOUNT.txt. The scoped publishing credentials described above
  remain necessary; account linking does not replace them or create accounts.
  Uploading a version does not prove public access; verify audience settings and
  play the released game separately. Roblox game earnings belong to the creator
  account/group. A Ropad wallet or coin does not itself transfer that ownership
  or establish revenue-sharing rights.
- studio-pool.key is generated privately by the backend when the pool is first
  used. Securely provision its value to authorized worker hosts without logging
  it. Do not embed it in JavaScript, a public frontend, Git or this README.

External Studio workers
On the Windows Studio host, install the matching runtime dependencies, open an
empty unpublished dedicated place, enable the Studio MCP server, and use:
  node studio-worker.cjs --list
Set PARALLAX_BASE_URL=https://ropad.fun (or https://www.ropad.fun matching the
canonical origin) and PARALLAX_WORKER_KEY through a private environment/launcher,
then run node studio-worker.cjs --studio-id <selected-session-id>.
The worker makes outbound HTTPS requests; do not expose Studio MCP publicly.
Use a separate logged-in OS/Studio workspace for isolated tenants. Default
workers retire after one build. Same-project revision reuse is explicit and
must retain ownership checks; unrelated creator projects are never recycled.
Generated custom Luau validation is not a security sandbox. Public creator
workloads need isolated worker OS accounts or VMs, restricted Roblox accounts
and credentials, network boundaries, quotas and supervised lifecycle cleanup.
Do not run untrusted creator scripts inside a personal administrator Studio
session that can access unrelated projects or production publishing credentials.

Funding and mainnet
Public-origin mode disables development sponsorship. Purchase OpenRouter credit
through its current web checkout, verify its management-key balance, then let a
configured operator allocate credit to a creator project. This package does not
convert SOL or pay the provider. See ../README-FUNDING.txt for that boundary.
ROPAD_DAILY_COMPUTE_BUDGET_USD sets the shared UTC-day compute spending cap for
the whole runtime (0 to 1000, default $1). Zero pauses paid compute. It is separate
from each project's funded balance and each run's budget; all limits must pass.
Multiple funded projects still share that default $1/day ceiling. Increase it
only deliberately alongside verified provider funding. Updating an environment
example does not raise the live server's cap or authorize an inference request.
With funded compute the operator can adjust ROPAD_BUILD_OUTPUT_TOKENS (1000 to
32000, default 6000), ROPAD_BUILD_PLAN_CAP_USD (0.01 to 25, default 0.75), and
ROPAD_AGENT_MAX_BUDGET_USD (0.01 to 25, default 1). Raising these ceilings does
not authorize a run or charge; each creator run still needs its explicit budget
and project credit. A larger ceiling alone does not guarantee a good game.
Set mainnet enablement to 1 only when the operator chooses to permit wallet-
reviewed mainnet creation. That setting alone does not submit a transaction or
establish fees. Atomic mint creation with the reviewed three-way fee shares
requires an address lookup table to fit the Solana transaction packet limit.
Set ROPAD_PUMP_LOOKUP_TABLE_ADDRESS to an operator-provisioned frozen mainnet
table containing the required static accounts. Creating/extending/freezing that
table is a separate funded on-chain operation; this package does not perform it.
Preflight checks only validated address presence. Verify the table's network,
frozen state and exact contents live before attempting the wallet-reviewed atomic
launch. Missing or unsuitable tables must block launch; do not launch a mint
first and promise to attach its fee split later. No successful mainnet launch is
implied by configuration or fixture tests.
Verify one end-to-end wallet-signed atomic launch, trade, fee sharing,
funded build, creator review and published playable Roblox URL before declaring
the service launch-ready. No wallet private key belongs on this server.

Frontend, cookies and proxy behavior
This runtime expects frontend and /api to share the same canonical origin.
Caddy preserves that Host and the browser's original Origin; the backend checks
both before mutations. Cookies are Secure/HttpOnly/SameSite=Strict on HTTPS.
A Sites frontend on another hostname cannot directly call this backend with
the current authentication rules. This package deploys the entire maintained
app at ropad.fun and requires no cross-origin browser authentication. Retaining
Sites would require a separately implemented and verified same-origin proxy,
including API routes, OAuth callback, metadata and authenticated cookie handling.
Removing hosting-status.js alone does not create this connection. Do not upload
the older work/ropad-sites/dist in place of the maintained runtime frontend.
Do not bypass the check by forging Origin at the proxy or enabling wildcard CORS.
The Caddy sample supports SSE flushing and WebSocket upgrades. Its long response
timeouts allow model requests; backend request limits still apply. Studio views
remain worker captures, not a newly implemented WebRTC stream.

Updates and shutdown
The container forwards SIGTERM to Node using an init process. The server's
existing shutdown handler stops accepting new HTTP requests and drains active
ones. Compose allows five minutes before forced termination. Uncertain paid
work and signed transactions must retain their recovery records, not be retried
as new work. Drain Studio queues and save active places before scheduled updates.
Use one replacement container only. Major image tags receive upstream fixes on
rebuild; after a verified build, pin an approved image digest for repeatability.
No automatic deployment, DNS change, package purchase or wallet signing occurs.

Official references used
https://docs.docker.com/build/concepts/context/#dockerignore-files
https://github.com/nodejs/docker-node/blob/main/README.md
https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
