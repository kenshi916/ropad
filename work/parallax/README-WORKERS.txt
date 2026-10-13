ROPAD / LOCAL STUDIO WORKER POOL

The browser and queue run on the local server. A separate Node worker connects
to Roblox Studio's MCP server on this Windows or Mac host. Up to two explicitly
selected Studio sessions process independent projects; actual online workers,
active jobs and queue length are shown at http://127.0.0.1:61281/#/studio.

Start workers on Windows
1. Start the local server and open new empty unpublished places in Studio.
2. Enable Studio as an MCP server in Studio Assistant > Manage MCP Servers.
3. Run .\start-studio-workers.ps1 -List to find Studio IDs.
4. Run .\start-studio-workers.ps1 -StudioIds 'FIRST-ID','SECOND-ID'.
5. Leave Studio and the worker process running while it waits for a build.
   Each selected Studio handles one build, then its worker retires and preserves
   the scene. Use Ctrl+C to stop waiting workers. -Once checks the queue once.

In the source workspace the launcher is work/start-studio-workers.ps1; the
outputs/Start-StudioWorkers.ps1 helper forwards to it. A private/studio-workers.json
file can hold the selected studioIds. These IDs belong to running Studio sessions.
The worker credential is read from private/studio-pool.key, never exposed publicly.

Build behavior
Create a game from a prompt and optional references, generate its advanced AI
plan, review the design and queue it. A coin launch by itself does not run an AI
request or purchase compute. The model picks an internal supported foundation;
there is no public starter-generation path. Only Claude Opus 5.5 and GPT-6 Astra
may plan new games. The local $1 daily limit and $0.75 per-plan reservation remain.

Workers apply validated geometry and bundled gameplay to an empty Edit place.
Scenes support bounded lighting and noncollidable decorative blocks, spheres and
cylinders with yaw rotation. Gameplay surfaces remain axis-aligned and validated
for a connected route. The template SpawnLocation is preserved but disabled after
preflight so players use the generated game's start.
Workers capture actual images after batches, run a runtime initialization/player
smoke check, inspect new console errors and stop Play. They then save overview,
spawn and finish views with source timestamps, job IDs and content hashes. This
is not a full physics playthrough. Creator acceptance tests, performance/content
review and publishing are separate. Unsupported features block release readiness.

Existing scenes are never recycled or deleted by a later job. IDs and object
counts cannot prove that a creator has not edited a scene. Save the completed
place, open a fresh empty unpublished place, and start a new worker for the next
build. Failed or uncertain work also stops for inspection. Never mix manual
changes into a place while a job is running. Two simultaneous views do not imply
two simultaneously active Studio workers.

Autonomous runs
Start agent can move through optional concept art, planning, thumbnails, Studio
assembly, smoke checks and visual review within one creator-approved spending
cap. A saved concept image guides the planner's art direction. The advanced model
reviews actual saved Studio views and records a concise critique with evidence.
If needed, the runner creates at most one separate improvement version and then
reviews that version's actual Studio output. The same run and project budgets
cover both versions; a child does not reset the cap. At most one original build
and one visual revision are assembled per run. Every scene still needs its own
fresh empty unpublished Studio place and worker. The runner waits when none is
available and does not charge for repeated worker checks.
Visual review stops for creator review even when the model finds no remaining
visual changes. It never certifies gameplay quality or automatically publishes.
Unknown provider costs and uncertain requests stop paid work without replay.

Updated workers advertise agentProtocol:1, planSchema:scene-v1,
dedicatedStudio:true, oneBuildPerStudio:true and visualReviewProtocol:1 over the
authenticated pool API. Every pool claim needs the core dedicated capabilities;
visual runs and enhanced scene plans additionally require visualReviewProtocol:1.
Presence must be fresh and idle before queuing. Older core-only workers cannot
claim visual jobs, and the unversioned manual bridge cannot apply enhanced plans.
Historical primary screenshots remain viewable but are not promoted into trusted
visual-review evidence. Existing runs do not gain new paid visual steps on update.
Safely stop an idle old worker after preserving its place, open a fresh empty
dedicated place, and use the updated worker launcher. Do not restart a worker
against an existing nonempty pooled place or treat the capability flag as proof
of full gameplay quality. The worker still validates the actual place before
applying any generated objects.

Creator revisions are new independent queue jobs with preserved parent history
and coin linkage. Revision generation does not merge manual Studio edits. It does
not deploy another token or automatically publish a Roblox game.

Durability and credentials
Build state uses atomic writes and a validated backup. Queue claims have scoped
lease tokens with renewable expiry; failures are not silently replayed. Recovery
closes uncertain work rather than repeating Studio mutations. Do not distribute
private/, provider credentials, worker keys or session cookies.

configure-openrouter.ps1 and configure-orbio.ps1 accept credentials through a
hidden local prompt. Windows stores them encrypted for the current user. Existing
source launcher names and private paths retain Parallax for compatibility; the
product is Ropad. The visual update is active when /api/builds/config additionally
reports visualReviewVersion:1, visualSceneVersion:1, maxVisualRevisions:1 and
visualCaptureViews:[overview,spawn,finish]. Core capabilities must still include
apiVersion:2, workerPlanSchema:scene-v1, oneBuildPerStudio:true and
manualQueueRequiresAgentWorker:true. Restart-Ropad.ps1 verifies all these markers.

Current verification
The core backend is active on localhost. Activation of the visual update and
fresh compatible workers remains necessary. No live visual build/review/rebuild
cycle has been verified with the provider and Studio. The current 481 passing
tests use provider fixtures and actual Luau execution; those results do not
replace a real Studio run or creator playtesting.

This is a local fleet, not a deployed 24/7 service. Keep worker hosts and Studio
sessions running. Remote deployment needs authenticated transport, isolation,
process supervision and billing beyond this loopback-only runtime.

Official references checked October 9, 2026
https://create.roblox.com/docs/studio/mcp
https://create.roblox.com/docs/projects/collaboration
https://create.roblox.com/docs/get-started/strategies
https://www.roblox.com/charts/top-playing-now
