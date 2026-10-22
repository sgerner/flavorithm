# Flavorithm

Flavorithm is a kitchen companion for planning meals around the food you already have. Keep a pantry, browse or generate recipes, plan the week, and turn recipes into a shopping list. It runs as a self-hostable web app and can be used as a guest or with an account for household sync.

## Screenshots

The paired images below show the application at browser viewports of 1440 × 1000 (desktop) and 390 × 844 (phone). Screenshots use the sample kitchen or an isolated test account; they contain no account credentials. Import review uses a deterministic model response for repeatable UI testing. Click an image to view it at full size.

| Screen           | Desktop                                                                                                                                                             | Mobile                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discover         | <a href="docs/screenshots/desktop-discover.jpg"><img src="docs/screenshots/desktop-discover.jpg" width="640" alt="Discover recipes on desktop"></a>                 | <a href="docs/screenshots/mobile-discover.jpg"><img src="docs/screenshots/mobile-discover.jpg" width="260" alt="Discover recipes on mobile"></a>                 |
| Pantry           | <a href="docs/screenshots/desktop-pantry.jpg"><img src="docs/screenshots/desktop-pantry.jpg" width="640" alt="Pantry on desktop"></a>                               | <a href="docs/screenshots/mobile-pantry.jpg"><img src="docs/screenshots/mobile-pantry.jpg" width="260" alt="Pantry on mobile"></a>                               |
| Meal planner     | <a href="docs/screenshots/desktop-planner.jpg"><img src="docs/screenshots/desktop-planner.jpg" width="640" alt="Meal planner on desktop"></a>                       | <a href="docs/screenshots/mobile-planner.jpg"><img src="docs/screenshots/mobile-planner.jpg" width="260" alt="Meal planner on mobile"></a>                       |
| Shopping list    | <a href="docs/screenshots/desktop-shopping.jpg"><img src="docs/screenshots/desktop-shopping.jpg" width="640" alt="Shopping list on desktop"></a>                    | <a href="docs/screenshots/mobile-shopping.jpg"><img src="docs/screenshots/mobile-shopping.jpg" width="260" alt="Shopping list on mobile"></a>                    |
| Recipe details   | <a href="docs/screenshots/desktop-recipe.jpg"><img src="docs/screenshots/desktop-recipe.jpg" width="640" alt="Recipe details on desktop"></a>                       | <a href="docs/screenshots/mobile-recipe.jpg"><img src="docs/screenshots/mobile-recipe.jpg" width="260" alt="Recipe details on mobile"></a>                       |
| Nutrition        | <a href="docs/screenshots/desktop-nutrition.jpg"><img src="docs/screenshots/desktop-nutrition.jpg" width="640" alt="Nutrition details on desktop"></a>              | <a href="docs/screenshots/mobile-nutrition.jpg"><img src="docs/screenshots/mobile-nutrition.jpg" width="260" alt="Nutrition details on mobile"></a>              |
| Settings         | <a href="docs/screenshots/desktop-settings.jpg"><img src="docs/screenshots/desktop-settings.jpg" width="640" alt="Settings on desktop"></a>                         | <a href="docs/screenshots/mobile-settings.jpg"><img src="docs/screenshots/mobile-settings.jpg" width="260" alt="Settings on mobile"></a>                         |
| Taste onboarding | <a href="docs/screenshots/desktop-onboarding.jpg"><img src="docs/screenshots/desktop-onboarding.jpg" width="640" alt="Taste preference onboarding on desktop"></a>  | <a href="docs/screenshots/mobile-onboarding.jpg"><img src="docs/screenshots/mobile-onboarding.jpg" width="260" alt="Taste preference onboarding on mobile"></a>  |
| Recipe import    | <a href="docs/screenshots/desktop-import.jpg"><img src="docs/screenshots/desktop-import.jpg" width="640" alt="Recipe import on desktop"></a>                        | <a href="docs/screenshots/mobile-import.jpg"><img src="docs/screenshots/mobile-import.jpg" width="260" alt="Recipe import on mobile"></a>                        |
| Import review    | <a href="docs/screenshots/desktop-import-draft.jpg"><img src="docs/screenshots/desktop-import-draft.jpg" width="640" alt="Editable imported recipe on desktop"></a> | <a href="docs/screenshots/mobile-import-draft.jpg"><img src="docs/screenshots/mobile-import-draft.jpg" width="260" alt="Editable imported recipe on mobile"></a> |

## Features

| Area                           | What it does                                                                                                                                                                                                                     | Guest kitchen                                                                         | Signed-in kitchen                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discover and recipe collection | Browse the curated starter recipes; search, filter, save, and rate recipes.                                                                                                                                                      | Stored in this browser.                                                               | Starter recipes sync with the household; each person's ratings stay private.                                                                          |
| Pantry                         | Add, edit, and remove ingredients with quantities, units, categories, and optional expiry dates. Bulk text entry and browser dictation are available; an image-capable model can suggest items from a photo.                     | Stored in this browser.                                                               | Shared with the household. Photo suggestions require an account and an AI connection.                                                                 |
| Recipe generation              | Generate recipe ideas using pantry contents, taste preferences, and recipe ratings.                                                                                                                                              | Unavailable.                                                                          | Requires a connected model and an account. Review ingredients, allergens, and instructions.                                                           |
| Recipe import                  | Paste recipe text, a link, or rough ingredient notes; attach, paste, or drop a photo; or dictate text. The model fills missing quantities and steps, clarifies instructions, and produces an editable draft with estimate notes. | Input can be prepared before sign-in.                                                 | Draft generation requires an account and a connected model; photos require image support. Save explicitly to add the recipe to the shared collection. |
| Meal planner                   | Schedule breakfast, lunch, or dinner across a seven-day week and choose servings.                                                                                                                                                | Stored in this browser.                                                               | Shared with the household.                                                                                                                            |
| Shopping list                  | Add items manually or from recipes and planned meals, combine compatible quantities, subtract pantry amounts, mark purchases, move purchased items to the pantry, or export a text list.                                         | Stored in this browser.                                                               | Shared with the household.                                                                                                                            |
| Online recipe search           | Search for recipes with source links, then open them in the same import-and-review flow.                                                                                                                                         | Unavailable.                                                                          | Requires a server-side Brave Search key for search. Import requires an AI connection; Brave is only needed for search.                                |
| Household                      | Invite people to share a kitchen.                                                                                                                                                                                                | Unavailable.                                                                          | Members share pantry, recipes, meal plan, and shopping list. Invitations are one-use codes that expire after 48 hours; the app does not email them.   |
| Settings and taste preferences | Choose theme and color mode, set cooking time, complexity, cuisine, diet, and allergy preferences, and connect a model.                                                                                                          | Preferences stay in this browser.                                                     | Preferences belong to the account; recipe ratings and taste feedback are not shared with household members.                                           |
| Install and offline shell      | Install Flavorithm where the browser supports PWA installation.                                                                                                                                                                  | Previously loaded app shell and this device's saved kitchen may be available offline. | API sync and all server-backed features need a connection.                                                                                            |

A new guest kitchen starts with eight curated recipes, a sample pantry, and three planned meals. A newly registered account starts with the same recipe collection and an empty pantry, plan, and shopping list. Guest edits live in browser `localStorage`; accounts sync kitchen state through the server. Household changes synchronize through requests with version checks. This is not a live collaborative editor.

## Run locally

Requirements: Node.js 24 or newer and npm. Flavorithm uses Node's built-in `node:sqlite` module.

```sh
git clone https://github.com/sgerner/flavorithm.git
cd flavorithm
npm ci
cp .env.example .env
npm run dev
```

Vite prints the local development URL. You can begin as a guest, or create an account to try server sync and household features. AI, online recipe search, password recovery email, and hosted ChatGPT plan access need the optional connections described below.

For a disposable signed-in demo kitchen, run the seed command and start the app against its database:

```sh
npm run seed:dev
FLAVORITHM_DB_PATH=data/flavorithm.dev.sqlite npm run dev
```

The command prints a randomly generated demo password once. It refuses to seed the default application database or overwrite a database that contains data. See [development fixtures](docs/dev-fixtures.md).

To build and run the production Node server locally:

```sh
npm run build
npm start
```

`npm start` serves the SvelteKit Node adapter through `server.mjs`. The default listener is `0.0.0.0:3000`; `HOST` and `PORT` configure it. By default, SQLite is stored at `data/flavorithm.sqlite` relative to the working directory. Set `FLAVORITHM_DB_PATH` to use a different file or `:memory:` for disposable development use.

## Application structure

The UI is a SvelteKit single-page app: Discover, My pantry, Meal planner, Shopping list, and Recipe collection are views within `/`. Settings, onboarding, recipe details, account, and household flows open as dialogs. Server endpoints live under `/api`.

```text
src/
  app.css                         global styles and responsive layout
  hooks.server.ts                 session lookup and response security headers
  service-worker.ts               static asset cache and offline navigation shell
  lib/
    components/RecipeDetail.svelte recipe details, cooking steps, nutrition, ratings
    components/RecipeImport.svelte capture input and editable recipe drafts
    data.ts                        starter recipes, pantry, and initial guest kitchen
    domain.ts                      unit-aware shopping calculations and taste summary
    types.ts                       shared kitchen types
    server/
      ai.ts                        provider adapters, validation, search, recipe import
      chatgpt-inference.ts          ChatGPT model catalog and Responses API
      chatgpt-oauth.ts               consent, callbacks, token refresh and revocation
      db.ts                         SQLite accounts, household state, auth, invitations
      oauth-storage.ts               encrypted ChatGPT credential storage
  routes/
    +page.svelte                    app views and interactions
    api/                            authentication, kitchen, AI, export, and OAuth APIs
static/                             icons, PWA manifest, and recipe placeholder
scripts/                            demo seed and production smoke check
tests/                              domain, API, provider, and OAuth tests
docs/                               setup notes and development fixture guide
server.mjs                          production Node HTTP entry point
```

### HTTP routes

| Path                                | Methods       | Purpose                                                                                                            |
| ----------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `/`                                 | `GET`         | Single-page application and password-reset link handling.                                                          |
| `/api/auth`                         | `GET`, `POST` | Read session; register, log in or out, request/reset a password, or delete an account.                             |
| `/api/state`                        | `GET`, `PUT`  | Read or save a signed-in household kitchen. Writes use `ETag` preconditions to detect stale state.                 |
| `/api/household`                    | `GET`, `POST` | List household members; create an invite code, join, or leave.                                                     |
| `/api/export`                       | `GET`         | Download the signed-in account and kitchen data exposed by the export endpoint as JSON.                            |
| `/api/models`                       | `GET`         | Load a provider model catalog or the connected ChatGPT account's catalog.                                          |
| `/api/ai`                           | `POST`        | Generate recipes, recognize ingredients, estimate nutrition, search, or capture an import draft. Requires sign-in. |
| `/api/connections/chatgpt`          | `GET`, `POST` | Check connection availability and status, start consent, or disconnect an account.                                 |
| `/api/connections/chatgpt/callback` | `GET`         | Hosted ChatGPT OAuth callback. Local development uses a temporary loopback callback instead.                       |

## AI connections and external services

AI actions require a signed-in Flavorithm account. In **Settings → AI connection**, choose one of these distinct connection types:

- **OpenAI, Anthropic, or OpenRouter API key:** enter the provider's API key in the current tab. It remains in tab memory and is sent to Flavorithm's server for the requested operation; it is not stored in SQLite or browser `localStorage`. Requests use that provider's API billing. The model list for these connections comes from models.dev.
- **ChatGPT subscription:** authorize Flavorithm directly with ChatGPT. The app obtains an account model catalog and sends eligible requests to the public OpenAI Responses API using the user's granted plan access. This is separate from an OpenAI API key and its billing. The app never silently falls back to API-key billing when plan access is unavailable. No ChatGPT conversations or memories are imported.

Recipe generation, nutrition estimates, photo ingredient recognition, and recipe-import drafts support the selected model connection. Vision requests need a model that accepts images. Nutrition values are estimates per serving, including the values in the curated starter recipes. Voice dictation uses the browser's Speech Recognition API when available and with microphone permission; it is not model transcription and support varies by browser.

ChatGPT plan consent can be tested locally from a browser on the same computer running Flavorithm. A remotely hosted app needs an appropriately approved OpenAI client, an exact callback registration, and a stable encryption key. Test suites mock provider endpoints; they do not verify a real ChatGPT account or live provider entitlement. Follow [ChatGPT plan connection setup](docs/chatgpt-oauth.md) before enabling hosted OAuth.

Online recipe search is a separate Brave Search integration, configured with `BRAVE_SEARCH_API_KEY`. Search results link to their sources. Recipe capture accepts public HTTPS recipe pages, first reading embedded recipe data and otherwise using readable page text. The server rejects private/local addresses, credentials in URLs, and nonstandard ports; it pins public DNS results, revalidates up to three redirects, and caps pages at 1 MB. Access restrictions, JavaScript-only pages, or missing recipe content can prevent an import; paste the text or add a screenshot instead. The legacy `import` API action retains its original publisher allowlist.

### Import a recipe

Choose **Import** in Discover or Recipe collection. One box accepts complete recipes, rough notes, or a standalone HTTPS link. Add a JPG, PNG, or WebP photo (up to 5 MB), paste an image from the clipboard, or drop a photo or text into the box. **Use voice** appends browser dictation when supported. Text input is limited to 20,000 characters.

Choose **Create recipe draft**, then review quantities, servings, instructions, and the model’s estimate notes. Ingredients, steps, recipe details, and per-serving nutrition are editable. Dismiss notes you have resolved; remaining notes stay with the saved recipe. Nutrition remains an estimate and can be re-estimated from the saved recipe after ingredient or serving changes. **Save recipe** adds the draft to the household’s collection and makes it available for planning, shopping lists, and ratings.

Input and photos stay in page memory until cleared, saved, or the page reloads; they are not added to pantry or kitchen storage while drafting. Closing and reopening Import restores an unfinished draft. **Clear** removes source input and **Discard draft** starts over. In-page sign-in and model setup return to Import with the source intact. If a ChatGPT popup is blocked while an import exists, an explicit new-tab sign-in link keeps the draft in the original tab. Generation sends only the import source and selected connection details; it does not include pantry contents, preferences, or ratings. Photo contents are sent to the selected model provider and are not saved as the recipe’s cover image.

The `/api/ai` action `capture` returns `{ recipe, assumptions }` without saving it. Text, URL, and image responses use the same validated recipe schema and fixed provider adapters, including ChatGPT plan Responses requests. Provider failures leave the source available for correction and retry. Closing an in-flight import aborts the client request and forwards cancellation to page/provider work; a provider may still bill work already performed. Unit tests mock providers; UI testing uses an isolated database and intercepted local AI responses, and does not establish live model quality or account entitlement.

## Configuration

Copy `.env.example` to `.env`. No provider key is needed for the basic local app. Leave optional values empty until you configure that feature.

| Variable                          | Default or format                                         | Use                                                                                                                                                                                 |
| --------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FLAVORITHM_DB_PATH`              | `./data/flavorithm.sqlite`                                | SQLite database path. The parent directory is created automatically. Use a persistent writable path in production.                                                                  |
| `HOST`                            | `0.0.0.0`                                                 | Production Node server listen host.                                                                                                                                                 |
| `PORT`                            | `3000`                                                    | Production Node server listen port.                                                                                                                                                 |
| `ORIGIN`                          | `http://localhost:<PORT>` in `npm start`                  | Public HTTP(S) origin, without a path. Set the public HTTPS origin behind a production proxy; used to pin the request origin and build recovery links.                              |
| `BRAVE_SEARCH_API_KEY`            | unset                                                     | Enables online recipe search. This is a server-side key.                                                                                                                            |
| `RESEND_API_KEY`                  | unset                                                     | Enables password-reset email delivery through Resend.                                                                                                                               |
| `EMAIL_FROM`                      | placeholder in `.env.example`                             | Verified Resend sender used for password recovery. Replace the example value before enabling delivery.                                                                              |
| `OPENAI_OAUTH_CLIENT_ID`          | unset                                                     | Issued/approved client ID for a hosted ChatGPT integration. Local dynamic registration does not use this value.                                                                     |
| `OPENAI_OAUTH_REDIRECT_URI`       | unset                                                     | Exact hosted callback URI, ending in `/api/connections/chatgpt/callback`.                                                                                                           |
| `OPENAI_OAUTH_CLIENT_SECRET`      | unset                                                     | Optional secret for an approved confidential OAuth client.                                                                                                                          |
| `OPENAI_OAUTH_CLIENT_AUTH_METHOD` | `none` for public; `client_secret_basic` for confidential | Must match the method registered for the hosted OAuth client.                                                                                                                       |
| `FLAVORITHM_OAUTH_ENCRYPTION_KEY` | base64 encoding of exactly 32 random bytes                | Stable hosted key for encrypting OAuth tokens and pending authorizations. Back it up separately from SQLite. Local mode creates an owner-only `oauth.key` file beside the database. |
| `ADDRESS_HEADER`, `XFF_DEPTH`     | unset                                                     | Optional SvelteKit client-address settings. Configure only behind a trusted proxy that strips incoming forwarded-address headers.                                                   |

Provider API keys are entered in Settings and are not configured through environment variables. For hosted OAuth requirements and token handling details, see the [ChatGPT connection guide](docs/chatgpt-oauth.md).

## Storage, synchronization, and backups

SQLite stores account and household records, password hashes, hashed sessions and reset tokens, household invites, shared kitchen state, per-account preferences, and encrypted ChatGPT connection data. The schema is initialized when the server starts. SQLite uses write-ahead logging for a file-backed database.

Guest kitchen data is saved in this browser's `localStorage`. For signed-in users, the browser keeps a local copy for the interface and syncs kitchen state to the server. Household state is shared; preferences and recipe ratings are per account. If two household members save from an outdated copy, the app detects the version conflict and asks the user to load the latest kitchen. It does not merge simultaneous edits.

Back up the database with a SQLite-consistent backup while the server is running, for example:

```sh
mkdir -p backups
sqlite3 data/flavorithm.sqlite ".backup 'backups/flavorithm-backup.sqlite'"
```

Alternatively, stop the app gracefully and copy the database after the process exits. Do not copy only the main `.sqlite` file while the app is running: uncheckpointed changes may still be in its write-ahead log. Also back up the local `oauth.key`, or the hosted `FLAVORITHM_OAUTH_ENCRYPTION_KEY`, separately. Without the matching key, encrypted OAuth credentials in a restored database cannot be decrypted. Store backups and keys securely, and test a restore before relying on them.

The app includes a personal JSON export in Settings. It is not a replacement for a database backup: it does not contain server credentials or encrypted OAuth tokens.

## PWA and offline behavior

The web manifest and service worker make the app installable in browsers that support installation. The worker caches same-origin build assets and a credential-free app shell, and uses network-first navigation with the shell as an offline fallback. It does not cache `/api` responses or credentialed requests.

Previously loaded guest data remains in browser storage on that device. Offline access is limited to data already on that device and the cached shell. Sign-in, household synchronization, AI requests, online model discovery, password recovery, and web recipe search need a network connection. Recipe photographs may be hosted by Unsplash and may not load offline.

## Security and privacy notes

The app hashes passwords with scrypt and stores session-token hashes. Session cookies are `HttpOnly` and `SameSite=Lax`, and become `Secure` over HTTPS. Mutating endpoints check request origin; payloads are validated; authentication, AI, and household operations have rate limits; provider requests use fixed upstream endpoints; and model output is schema-validated. The app also sets browser security headers and avoids caching API responses.

ChatGPT access and refresh tokens are encrypted on the server with AES-256-GCM. Local installs keep the encryption key in an owner-only file beside the database; hosted installs need a stable `FLAVORITHM_OAUTH_ENCRYPTION_KEY`. API-key values stay in tab memory but are sent to the selected provider through the Flavorithm server for each requested operation. Pantry data, preferences, photos, and prompts included in an AI request are sent to that selected provider. Review the provider's current data policy before connecting it.

These controls are not a security audit. Email verification is not enforced. Password recovery is unavailable until Resend is configured with a verified sender. Household invites are codes to share privately, not emailed invitations. The operator of a public deployment is responsible for access control, backups, privacy disclosures, and data-retention policy.

## Deploy

Build and run the Node adapter on Node.js 24 or newer. Put it behind a reverse proxy that terminates HTTPS and set `ORIGIN` to the public HTTPS origin. `server.mjs` pins the application host and protocol to that origin. Configure `ADDRESS_HEADER` and `XFF_DEPTH` only when the request path passes through a trusted proxy that removes client-supplied forwarding headers.

Give the process a persistent writable volume for `FLAVORITHM_DB_PATH`; the default path is under `data/`. This app is designed for a single app instance with a local SQLite database. Rate limits are held in process memory and are not shared between instances. Horizontal scaling needs shared storage, a shared OAuth encryption key, and a distributed rate limiter; that deployment setup is not provided here.

## Commands and checks

| Command              | Description                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `npm run dev`        | Start the Vite development server.                                                                        |
| `npm run check`      | Sync SvelteKit types and run `svelte-check`.                                                              |
| `npm test`           | Run the Node test suite.                                                                                  |
| `npm run build`      | Build the SvelteKit Node adapter app.                                                                     |
| `npm start`          | Run the built app with `server.mjs`.                                                                      |
| `npm run test:smoke` | Start the built app with an isolated in-memory database and exercise production HTTP routes. Build first. |
| `npm run seed:dev`   | Create a disposable prefilled local demo account; see [development fixtures](docs/dev-fixtures.md).       |
| `npm run format`     | Format the repository with Prettier.                                                                      |

The automated tests cover application logic and use mocked provider/network responses. They do not make live AI, Brave Search, Resend, or ChatGPT requests. Browser behavior such as camera selection, speech recognition, installation prompts, and a real reverse-proxy deployment depends on the user's browser and hosting environment.

## Troubleshooting

| Symptom                                                  | Check                                                                                                                                                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node:sqlite` is unavailable                             | Use Node.js 24 or newer and confirm `node --version`.                                                                                                                                                           |
| Sign-in works, but sync returns an error                 | Check that `FLAVORITHM_DB_PATH` is writable and persistent. If the kitchen changed elsewhere, reload the latest shared state before editing again.                                                              |
| ChatGPT connection is unavailable locally                | Start the app on the same computer where you open it, use `localhost` or `127.0.0.1`, and complete consent in that browser. A phone connecting to another computer cannot complete the local loopback callback. |
| Hosted ChatGPT OAuth is unavailable                      | Check the approved client ID, exact callback URI, public `ORIGIN`, encryption key format, and registered client authentication method. See the [OAuth guide](docs/chatgpt-oauth.md).                            |
| Model catalog or AI operation fails                      | Check the selected connection, model support, account consent or API key, provider availability, network access, and provider quota. Image recognition requires a vision-capable model.                         |
| Online recipe search returns no results                  | Configure `BRAVE_SEARCH_API_KEY`; search also requires a signed-in account and internet access.                                                                                                                 |
| Password recovery reports it is not configured           | Set `RESEND_API_KEY`, `EMAIL_FROM` to a verified sender, and a valid public `ORIGIN`.                                                                                                                           |
| Pantry dictation does not start                          | Use a browser that exposes Speech Recognition, grant microphone access, and try manual entry if the API is unavailable.                                                                                         |
| Purchased list does not subtract an item from the pantry | Automatic subtraction requires a recognized compatible ingredient name and unit. Review and edit the generated list as needed.                                                                                  |

## Limitations

- AI-generated recipes, recognized pantry items, and nutrition values can be wrong. Nutrition values are estimates, not lab measurements or medical advice. Verify ingredients, allergens, quantities, cooking temperatures, and food safety yourself.
- Image recognition depends on the chosen vision-capable model and should be reviewed before adding items. Voice entry depends on browser support and permissions.
- Recipe search depends on Brave. Imports depend on supported publisher sites retaining accessible structured recipe data.
- Provider models, account eligibility, quotas, billing, and limits are managed by external services and can change. API-key billing and ChatGPT plan usage are separate.
- Local ChatGPT plan consent uses a loopback callback on the computer running the server. Hosted usage requires a registered integration and valid server-side OAuth configuration.
- The app is designed for one server instance and does not offer live multi-user editing, automatic conflict merging, built-in email invitation, or an out-of-the-box multi-host deployment.
