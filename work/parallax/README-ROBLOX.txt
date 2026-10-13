ROPAD / CREATOR WORKSPACES AND RELEASE REVIEW

Token, game and creator pages
Explore cards open #/token/<build-id>: the game coin overview, observed market
cap/chart, buy/sell panel, agent activity and a link to the game page. Market
values appear only when supported verified observations exist; devnet coins
have no real market. Viewing these pages does not start AI work or a trade.

#/play/<build-id> presents saved game artwork or actual Studio captures, the
game description, model and version. Open in Roblox appears only for a valid
creator-supplied Roblox game URL saved through release review. The link is
labeled "Creator supplied · Availability not verified". The page opens Roblox;
actual gameplay runs in Roblox Player, with sign-in, device and experience
access determined by Roblox. It is not embedded Roblox gameplay. Without a
release link, the play action stays disabled and the page shows build progress.

#/workspace/<build-id> opens creator build controls and evidence; existing
#/build/<build-id> links remain supported. Eligible owners can record their
release review and game link after confirmed assembly and a passing smoke test.
Saving that review does not publish the game or verify public availability.
The token, play and workspace pages remain linked to the same build version.

Prompt-only design
New browser workspaces and coin launches accept a game prompt, optional reference
games, and an advanced planning model. Public starter generation is disabled.
Existing historical plans and downloads remain readable. Reference text is
creator-provided context; supplying a URL does not mean the AI visited it or
verified a game's popularity. Use references for broad mechanics, not copies of
another creator's code, branded characters, assets or map.

The AI returns a bounded scene and a structured design: core loop, objective,
progression, inspiration principles, limitations, unsupported features and future
acceptance tests. It chooses a supported gameplay foundation internally. Every
unsupported requested feature blocks readiness instead of becoming a claim that
the feature was built. Plans cannot contain arbitrary code, asset IDs or URLs.

Creator updates
The launching wallet or original signed local browser identity can create a
revision with a new prompt/model/references. Each revision is a fresh build with
its own plan, queue execution, captured frames and reviews. projectId,
parentBuildId and version preserve lineage. Existing plans are not overwritten.
Coin identity carries forward without another financial launch. Holding a coin
does not grant permission to manage source, builds or reviews.

The browser supports prompt updates, source copying and .rbxlx downloads. A code
editor with direct source saving and synchronization of manual Studio edits is
not implemented. A prompt revision rebuilds the scene from its prompt and earlier
design context; it does not import later changes from an exported project.

Ship readiness
Readiness distinguishes draft, planned, building, needs_fixes, needs_review and
creator_approved. Automated evidence includes supported requirements, Studio
assembly and the authenticated worker's runtime smoke result. Creator gameplay,
performance and content checks are owner attestations with notes. Missing checks
and unimplemented requested features remain blockers. Old plans without the new
design/acceptance data require a new revision for this release checklist.

readyForCreatorPublish means the checklist permits the creator to proceed in
Studio; it is not Roblox approval, verified publication or a guarantee of game
quality. A creator-supplied Roblox games URL is labeled unverified. Publishing,
account ownership, full gameplay QA and platform eligibility remain in Studio.

Delivery and editing
Download game .rbxlx contains the validated scene and bundled gameplay source.
Open it in Roblox Studio, edit the scene or ParallaxGameplay script, playtest and
publish from your own account. The Parallax internal folder/script names remain
for compatibility with existing workers and saved projects. The visible product
and Studio plugin are named Ropad. Do not manually edit a pooled worker project;
copy the downloaded project to a separate Studio place for your changes.

Two Studio views display real captures received from workers or owner screen
sharing. Captures are timestamped images, not a continuous video stream. An idle
worker or a retained completed frame is not a currently building game.

Security and storage
All browser mutations require owner access, same-origin checks and CSRF. Worker
credentials are separately scoped and are never included in public records or
exports. Public local records include briefs, designs, code and shared images;
do not place secrets in a prompt. Durable revisions/reviews use the same atomic
storage and corruption recovery as the existing build history.

Automatic visual improvement
New Start agent runs default to one bounded visual improvement pass. The creator
sets the same maximum USD cap for concept artwork, planning, thumbnails, visual
reviews and the optional revision. Existing saved approvals are not opted in.
If a new game has no plan, its optional concept is generated first. The advanced
planner receives the saved concept pixels, then creates the supported scene.
After the current worker assembles and smoke-checks the game, it captures overview,
spawn and finish views. The advanced vision model reviews those actual images,
the brief, validated geometry and original concept. Public feedback contains
specific issues and evidence hashes; it is not hidden model reasoning.

If improvements are needed, the agent creates one separate version automatically
and builds it on another fresh eligible Studio worker. The original scene and
coin lineage stay intact. The child uses the original concept without buying
duplicate artwork. A second visual review ends the run for creator review,
including any unresolved issues. This is not a recurring chat automation.

New visual scene features include bounded lighting and noncollidable decorative
blocks, spheres and cylinders with yaw rotation. Gameplay surfaces remain
axis-aligned so conservative reachability checks stay meaningful. External meshes,
textures, terrain authoring and arbitrary model-generated scripts are not included.
An image is an art-direction reference, not a promise of pixel-exact reproduction.

Visual work requires the current worker's visualReviewProtocol:1 capability.
Old unversioned manual bridges cannot apply enhanced scenes. Historical screens
without current-job evidence remain visible but cannot be used for paid reviews.
Uncertain provider charges stop the run; no automatic retry occurs. Insufficient
budget or unavailable fresh workers stop progress with an inspectable reason.
Visual review and smoke tests do not certify complete gameplay, performance,
originality, mobile controls or publication; creator review is still required.
