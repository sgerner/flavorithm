# Hosted ChatGPT registration for Flavorithm

This is the optional registered SIWC alternative to the Codex device-code test path. It is a one-time administrator task for that integration. End users should only sign into Flavorithm through Authentik, select **Continue with ChatGPT**, approve plan access at OpenAI, and return to Flavorithm. There are no client-side downloads, terminal commands, local servers, or credential imports.

## Request approval

Use OpenAI's [Sign in with ChatGPT interest form](https://openai.com/form/sign-in-with-chatgpt-interest/) to request a hosted client **with ChatGPT plan usage**. The [client registration documentation](https://developers.openai.com/siwc/request-client-id) describes current availability. Identity-only sign-in approval is insufficient for recipe generation.

Deployment details:

| Field                        | Value                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| App                          | Flavorithm                                                                                                                     |
| Website / application origin | `https://eat.stevengerner.com`                                                                                                 |
| Source repository            | `https://github.com/sgerner/flavorithm`                                                                                        |
| Exact callback URL           | `https://eat.stevengerner.com/api/connections/chatgpt/callback`                                                                |
| Use case                     | A self-hosted household recipe, meal planning, and nutrition app. Each user explicitly connects their own ChatGPT plan.        |
| Authorization                | Authorization Code with PKCE S256, state, and OIDC nonce                                                                       |
| Identity scopes              | `openid profile email`                                                                                                         |
| Plan scopes requested        | `offline_access resource.invoke chatgpt.tokens.use.direct` (subject to the permissions OpenAI provisions)                      |
| Resource                     | `https://api.openai.com/v1`                                                                                                    |
| Token endpoint method        | `none` for an issued public client, or `client_secret_basic` for an issued confidential client                                 |
| Data handling                | Tokens stay encrypted on the server. Requests use `store: false` and streaming. The app does not access ChatGPT conversations. |

Ask OpenAI to confirm hosted plan permissions, the exact callback, supported scopes, and the registered token endpoint authentication method. Do not reuse the client ID belonging to Codex or another application.

## Configure the issued client

After approval, set the issued values in `/home/skynet/opt/stacks/flavorithm/.env` (mode `600`):

```dotenv
OPENAI_OAUTH_CLIENT_ID=<issued Flavorithm client ID>
OPENAI_OAUTH_REDIRECT_URI=https://eat.stevengerner.com/api/connections/chatgpt/callback
OPENAI_OAUTH_CLIENT_AUTH_METHOD=none
FLAVORITHM_OAUTH_ENCRYPTION_KEY=<privately generated stable 32-byte base64 key>
```

For a confidential client, use `client_secret_basic` and set the issued `OPENAI_OAUTH_CLIENT_SECRET` privately on the host. Keep the encryption key stable and backed up. Never put either secret in Git or application logs. Use the authentication method and scopes actually provisioned by OpenAI.

Recreate the app using the **production override** so Caddy networking and the existing database mount remain intact:

```sh
cd /home/skynet/opt/stacks/flavorithm
docker compose -p flavorithm -f compose.yml -f deploy/skynet/compose.override.yml up -d --no-deps flavorithm
```

Keep Authentik protection on the callback. The initiating Flavorithm session must still be valid when OAuth returns. Verify browser consent, the returned plan permission, and a completed recipe request with the user's account before declaring the integration live.

## Why Codex device login is not the hosted fallback

[Codex supports device-code login](https://learn.chatgpt.com/docs/auth#login-on-headless-devices) for remote CLI clients. Its [app-server auth contract](https://learn.chatgpt.com/docs/app-server#auth-endpoints) distinguishes that from hosted services. Flavorithm also implements the Codex device protocol as an experimental self-hosted test path; it uses Codex model access and its own inference transport. This registration guide applies to the separate app-specific SIWC route.
