Ropad persistent runtime deployment package

Prepared files only. Nothing has been deployed, purchased, restarted or changed
in DNS. Docker is not available on the preparation host, so the image and Caddy
configuration still require a container build and validation on the chosen host.

Topology
Internet HTTPS -> Caddy -> ONE Node process on internal port 61281.
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
1. Copy the runtime source and deploy directory; do not copy credentials into
   the image or distribute the existing private folder with frontend files.
2. In deploy, copy .env.example to .env. Restrict its permissions. Fill secrets
   there or inject equivalent environment values through your host's secret
   manager. Keep ROPAD_SOLANA_MAINNET_ENABLED=0 initially. An ordinary OpenRouter
   inference key does not replace the management key used to verify credit.
3. Use one canonical hostname for ROPAD_DOMAIN and ROPAD_PUBLIC_ORIGIN. The
   provided worker currently accepts only ropad.fun / www.ropad.fun over HTTPS.
   If choosing a different hostname, update and test that allowlist first.
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
   The Docker health check separately GETs /api/health using an allowed Host.

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
- fee-accounting-config.json: fill the example's real platform mint, distinct
  platform/compute treasury addresses and positive shares totaling 10000 bps.
  The example deliberately fails validation until completed. Do not install an
  empty example as if it were configured. Verified new game mints are derived
  from persisted launch receipts by the server; static project mappings remain
  optional. Each coin still needs a creator-reviewed fee-sharing signature.
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
  This is operator-provisioned per-creator support, not self-service Roblox OAuth
  or automatic account creation. Account linking/OAuth consent and secure token
  lifecycle still require implementation before unattended public onboarding.
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
With funded compute the operator can adjust ROPAD_BUILD_OUTPUT_TOKENS (1000 to
32000, default 6000), ROPAD_BUILD_PLAN_CAP_USD (0.01 to 25, default 0.75), and
ROPAD_AGENT_MAX_BUDGET_USD (0.01 to 25, default 1). Raising these ceilings does
not authorize a run or charge; each creator run still needs its explicit budget
and project credit. A larger ceiling alone does not guarantee a good game.
Set mainnet enablement to 1 only when the operator chooses to permit wallet-
reviewed mainnet creation. That setting alone does not submit a transaction or
establish fees. Verify one end-to-end wallet-signed launch, trade, fee sharing,
funded build, creator review and published playable Roblox URL before declaring
the service launch-ready. No wallet private key belongs on this server.

Frontend, cookies and proxy behavior
This runtime expects frontend and /api to share the same canonical origin.
Caddy preserves that Host and the browser's original Origin; the backend checks
both before mutations. Cookies are Secure/HttpOnly/SameSite=Strict on HTTPS.
A Sites frontend on another hostname cannot directly call this backend with
the current authentication rules. Use supported same-origin routing or finish
and test an explicit cross-origin session integration before claiming it works.
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
