# ChatGPT subscription connections

## Codex device-code connection

Flavorithm implements the Codex OAuth device-code protocol for the requested self-hosted trial. It is separate from the newer app-specific Sign in with ChatGPT (SIWC) integration. Device credentials call the Codex subscription service; they are never sent to the public API as though they were SIWC credentials or API keys.

1. Sign into Flavorithm normally (including Authentik on Skynet).
2. Open **Settings → AI connection → ChatGPT subscription → Continue with ChatGPT**.
3. Select **Open ChatGPT**, sign into OpenAI, and enter the displayed one-time code. Device-code login may need to be enabled in ChatGPT security settings or by the workspace administrator.
4. Return to Flavorithm. It finishes the connection automatically. Select an available model, optionally set a supported reasoning level, and generate a recipe.

Users do not install Node.js, run a local server, download a connector, import a token file, or enter an API key. The app server requests the code, polls at the provider's interval, and exchanges the approved code. It supports multiple separate accounts/workspaces per Flavorithm user. Reconnecting a saved account must verify that account's original identity.

The code expires after 15 minutes and **Cancel** invalidates the app's attempt. Pending attempts are encrypted in SQLite and bound to the initiating user, live app session, and origin. They survive server/container restarts when the database and its owner-only `oauth.key` are persisted together. Keep the initiating Flavorithm tab open: its poller retries brief network/server outages until the code expires. Reloading the browser still requires starting again.

Database leases coordinate polling across workers and recover after an interrupted poll. Credentials and the completed result are saved in one transaction, so a lost success response can be retried without another provider exchange. If the process stops during the final one-time token exchange before credentials are committed, a fresh login is required; Flavorithm reports the interrupted exchange after the lease expires rather than replaying the provider code. Tokens stay encrypted on the server. Back up the database and key together.

## Implementation and testing status

The implementation follows [Codex's device authorization source](https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs) and the [Hermes Codex provider](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/auth_constants.py):

- Fixed public Codex client ID; `deviceauth/usercode` and `deviceauth/token` on the OpenAI account service.
- The provider returns the exchange PKCE verifier/challenge. Flavorithm checks their consistency, then exchanges the code at `https://auth.openai.com/oauth/token` with OpenAI's device callback.
- OpenAI ID-token signature, issuer, audience, expiration, and account/workspace identity are verified before saving.
- Saved Codex credentials use authenticated per-user encryption and the existing SQLite refresh lease. Refresh token rotation is serialized, and transient failures preserve the saved credentials.
- The model list and Responses stream use only fixed `https://chatgpt.com/backend-api/codex` destinations, with the selected Codex account header. The model catalog compatibility version is pinned to Codex `0.164.0`; it is not an installed CLI dependency.
- Reasoning options come from the Codex account catalog and are validated against it. Requests use `store: false` and streaming; partial/failed streams do not save recipes. API billing is never an automatic fallback.

Automated tests use signed mock identities and provider responses. A successfully returned real device code verifies initiation only. The user must still approve OpenAI login and complete a model request to verify their account's live model access.

This compatibility path is an experimental self-hosted integration, not a claim that Flavorithm has approved hosted-partner status. OpenAI documents restrictions on hosted-service use of [Codex app-server authentication](https://learn.chatgpt.com/docs/app-server#auth-endpoints). The registered SIWC route below remains available independently.

## Registered hosted integration

OpenAI documents dynamic registration for open-source/local clients. Paid or remotely hosted apps need an appropriately approved client registration; do not use the dynamic local flow with a fabricated HTTPS redirect.

Configure the actual issued values in the server environment:

```dotenv
ORIGIN=https://flavorithm.example
OPENAI_OAUTH_CLIENT_ID=oaiapp_your_registered_client
OPENAI_OAUTH_REDIRECT_URI=https://flavorithm.example/api/connections/chatgpt/callback
FLAVORITHM_OAUTH_ENCRYPTION_KEY=your_base64_encoded_32_byte_key
```

For a public client, omit the client secret and use `OPENAI_OAUTH_CLIENT_AUTH_METHOD=none` (or omit the method). For a confidential client, also supply its secret and its **registered** authentication method:

```dotenv
OPENAI_OAUTH_CLIENT_SECRET=your_secret
OPENAI_OAUTH_CLIENT_AUTH_METHOD=client_secret_basic
```

Flavorithm implements the documented `client_secret_basic` confidential-client method; the secret is sent only in the Authorization header. A secret defaults to `client_secret_basic`; a client without a secret defaults to `none`. Identity-only client approval is insufficient: the token response must explicitly grant `chatgpt.tokens.use.direct` before inference is enabled.

Generate the encryption key privately using a cryptographically secure generator. It must decode from standard base64 to exactly 32 bytes. Keep it stable across restarts and back it up separately from the database. Missing or invalid encryption/client/callback configuration leaves hosted connection unavailable instead of storing tokens in plaintext.

Pending hosted authorizations are encrypted in SQLite, expire after ten minutes, and are consumed atomically once. They survive server restarts and can complete through another process sharing the same database and encryption key. Local authorizations use temporary listeners in the initiating process; restarting that process cancels those attempts. Deploy SQLite with persistent storage on a single host.

## Connection selection

Without a registered hosted client, device-code sign-in is the default for HTTPS and same-computer loopback installations. Set `FLAVORITHM_CHATGPT_AUTH_FLOW=device` to explicitly choose this path even when hosted SIWC settings exist. A complete registered hosted client selects SIWC by default. For same-computer SIWC development only, `FLAVORITHM_CHATGPT_AUTH_FLOW=local` enables the built-in temporary loopback listener; Flavorithm starts it automatically.

Existing SIWC and previously imported connections retain their own inference and refresh routes. The legacy import API can finish previously issued encrypted bundles, but the UI no longer asks users to download or run a connector.

## Storage and disconnect

Access and refresh credentials are encrypted with AES-256-GCM and bound to the app user, account, and credential mode. Tokens are absent from browser storage, kitchen exports, errors, and logs. Disconnect removes local credentials and attempts remote revocation; when revocation cannot be confirmed, review app access in ChatGPT. Account deletion cascades to stored credentials.

Recipe generation, nutrition, photo recognition, and recipe import use the selected connection. Voice dictation remains browser-based; internet search uses the separately configured Brave key. A connection does not expose ChatGPT conversations or memories. Model availability and subscription limits come from OpenAI.

### Optional host-wide Codex connection

Set `FLAVORITHM_HOST_ADMIN_USER_ID` to the exact ID of an existing, trusted
Flavorithm user and restart the server. There is no implicit host admin; household
ownership does not grant this capability. Sign in as that user, connect ChatGPT
using the existing device-code flow, choose a model, and select **Use selected
connection for this host** in AI connection settings. If your deployment uses
another OAuth flow, set `FLAVORITHM_CHATGPT_AUTH_FLOW=device` for device login.

While enabled, all authenticated AI generation uses that connection and model,
including accounts in other households. Search retains its existing behavior.
Users see a generic host connection without the admin's email or credentials.
Only the configured admin sees host controls; the server also checks authorization.
Credentials remain encrypted in the existing OAuth store, with the existing refresh
coordination. The host shares the subscription's allowance and limits.

The admin can disable sharing in settings. Disconnecting the backing account,
removing the admin configuration, or changing its user ID also disables sharing.
Existing personal connections are retained. Household recipes and preferences
remain scoped as before. This setting does not establish subscription eligibility
or increase the subscription's usage allowance.
