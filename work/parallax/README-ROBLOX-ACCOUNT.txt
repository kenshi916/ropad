Ropad Roblox account linking

Account linking identifies the Roblox account that a creator authorizes. It does
not log into Roblox Studio, create a Studio session, or authorize publishing an
experience. Ropad's account-link flow is a confidential authorization-code flow
with PKCE and requests only the identity scopes openid and profile.

Register the app in the Roblox Creator Dashboard under OAuth 2.0 Apps. Use an
ID-verified account eligible to register an app.
Select Creation & Productivity Tools for this game-creation product. Enable only
openid and profile. Keep the client secret on the backend. The client ID is public.

Local setup

1. Register this exact redirect URL in the Roblox OAuth app:
   http://localhost:61281/roblox/oauth/callback
2. Run work/configure-roblox-oauth.ps1 in PowerShell under the same Windows account
   that starts Ropad. Enter the client ID, redirect URL and secret in its hidden
   secret prompt. Never paste the secret into chat, a URL or browser storage.
3. The helper saves public values in work/private/roblox-oauth-config.json and
   protects the secret with Windows DPAPI in work/private/roblox-oauth-secret.dpapi.
   The secret can be decrypted only in the corresponding Windows user context.
   Other credentials, saved games and build history are not changed.
4. Restart through the current approved Ropad restart procedure after active work
   is finished. The setup helper does not start or stop any process.
5. Open Ropad at http://localhost:61281 and initiate Connect Roblox there. Use the
   same host throughout authorization so the browser retains the session cookie.
   localhost and 127.0.0.1 are different browser origins; Ropad never silently
   substitutes one for the registered callback. The helper also permits a literal
   127.0.0.1 callback for a separately registered configuration, but Roblox's
   documented local-debug example is localhost.

Blank client-ID or callback input keeps its saved value. Blank secret input keeps
the existing encrypted secret only when the client ID is unchanged. Validation
failure preserves the previous files. A new client ID requires its matching new
secret. Missing optional OAuth settings leave account linking unconfigured.

The startup script prefers explicitly supplied environment values:
ROBLOX_OAUTH_CLIENT_ID
ROBLOX_OAUTH_CLIENT_SECRET
ROBLOX_OAUTH_REDIRECT_URI
It loads only missing values from the optional files, passes the secret to the
server process, and clears it from the launcher environment when the child exits.
Never commit private settings, DPAPI files or server environment secrets.

Hosted setup and public access

Use https://ropad.fun/roblox/oauth/callback only after the persistent backend is
actually deployed at ropad.fun with HTTPS and this route. Owning the domain or
hosting a static frontend alone does not provide an OAuth callback server. Supply
the hosted environment variables through the host's secret management. Windows
DPAPI files are not portable credentials for a Linux host or another account.

Register the hosted callback exactly, without query, fragment or URL credentials.
Use an HTTPS entry link and published Privacy Terms and Terms of Service URLs.
Roblox's private app mode permits up to 10 unique users. General public access
requires Roblox review; provide the required category/scope justification and a
short video showing the complete sign-in and return flow. Pending review is not
public approval. Recheck Roblox's current eligibility and review requirements.

How creators receive and publish games

Creators can download the generated .rbxlx project, including its code, open it in
Roblox Studio under their own Roblox account, inspect and edit it, then use Publish
to Roblox As to publish to an experience they own or a group they can manage.
They choose the destination and visibility in Studio. A local export or successful
Studio test does not mean the game has been published or made publicly playable.

Ropad's separate Open Cloud place-publishing path needs an existing universe/place
and a suitably scoped Open Cloud API key with permission for that destination.
openid/profile account linking does not grant those publishing permissions. Do
not request creators' passwords, Roblox session cookies or Studio login tokens.

Official references (checked 2026-10-13)
https://create.roblox.com/docs/cloud/auth/oauth2-registration
https://create.roblox.com/docs/cloud/auth/oauth2-develop
https://create.roblox.com/docs/cloud/guides/usage-place-publishing
