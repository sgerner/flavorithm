# ChatGPT plan connections

Flavorithm supports the current **Sign in with ChatGPT** plan-usage flow. Users authorize their own connection; credentials are not copied from Codex or another application. Flavorithm authenticates as itself and sends eligible requests to the public OpenAI Responses API.

## Connect on this computer

1. Start Flavorithm with `npm run dev`, or `npm run build` followed by `npm start`.
2. Open the app from `localhost` or `127.0.0.1` on the same computer as its server. Sign into your Flavorithm account.
3. In **Settings & themes → Your kitchen intelligence**, choose **ChatGPT subscription**, then **Continue with ChatGPT**.
4. Complete OpenAI's account selection and permission screen yourself. No API key is required for this connection.
5. Return to Flavorithm and choose a model from the connected account's catalog. A successful completed inference request is the entitlement check; appearing in the catalog alone does not prove access.

On first connection, the app generates a stable host ID and requests dynamic registration as Flavorithm. OpenAI returns an issued client ID for that user/workspace registration. Later reconnections reuse that issued ID and host ID with fresh state, PKCE, and nonce values.

The local callback is a temporary HTTP listener bound only to `127.0.0.1` on an available port, at `/auth/callback`. This is why a phone accessing a server on a different computer cannot complete the local flow. Use a registered hosted integration for a remotely hosted deployment.

If plan usage is declined, the account remains signed in with **Sign-in only** status. **Enable plan usage** starts a new, explicit consent flow. Multiple registrations remain separate even if they have the same email address. Disconnecting clears local tokens and attempts remote revocation. If remote revocation cannot be confirmed, the app says so and links to ChatGPT's usage/access settings.

## Hosted deployment

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

## Credentials and inference

OAuth state is one-use and bound to the initiating live Flavorithm session. The callback verifies the ID token's signature against OpenAI's JWKS, its issuer, issued-client audience, expiration, subject, and original nonce. Returning accounts must match their saved registration and verified subject. An email match never merges accounts automatically.

Access, refresh, and retained ID tokens are encrypted with AES-256-GCM in SQLite and bound to the local user/account/mode through authenticated additional data. Local installations create an owner-only `oauth.key` alongside the database; hosted installations use the configured encryption key. Tokens never enter browser storage, kitchen exports, source control, or logs. Account deletion cascades to stored model credentials. Disconnect in ChatGPT Settings to independently revoke app access.

Refreshes are serialized and use the provider's earliest-refresh time; replacement access/refresh tokens are stored together. Confirmed terminal refresh failures require reconnection. Temporary network failures preserve credentials. Disconnect coordinates with an in-flight refresh so it revokes the latest rotated token, and removes local tokens even when coordination or remote revocation cannot be confirmed.

The account's model catalog comes from authenticated `GET https://api.openai.com/v1/models`. Inference uses `POST https://api.openai.com/v1/responses` with `stream: true`, `store: false`, array input, and instructions. Text and image inputs are supported when the selected model supports them. The app consumes SSE events and accepts results only after `response.completed`; interrupted, incomplete, and failed results do not save partial recipes.

Recipe generation, nutrition estimation, ingredient-photo recognition, and recipe-import normalization all support this connection. Voice transcription remains browser-based, and internet recipe search remains the separately configured Brave integration. Plan use does not grant access to ChatGPT conversations or memories. Usage and app limits are managed in [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage). The app does **not** silently switch to API-key billing when a plan limit is reached.

Claude remains available through its API-key connection. Anthropic's published Agent SDK requirements call for prior approval before offering subscription login in a third-party product; no Claude subscription integration is claimed here.

## Verification and provider documentation

Run `npm run check`, `npm test`, `npm run build`, and `npm run test:smoke`. OAuth tests use signed mock ID tokens and mocked provider endpoints; they never authenticate a real ChatGPT account. A real user must still complete consent and a successful live inference before declaring their particular account verified.

- [ChatGPT plan usage overview](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts, refresh, and revocation](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and Responses inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Hosted client registration](https://developers.openai.com/siwc/request-client-id)
- [Anthropic Agent SDK requirements](https://code.claude.com/docs/en/agent-sdk/overview)
