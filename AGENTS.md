# Development

## Environment and dependencies

- Requires Node.js 24 LTS (`>=24.19.0 <25.0.0`, matching `package.json` and CI). `.nvmrc` pins major version `24` (`nvm use`) and `.npmrc` sets `engine-strict=true`.
- Run `npm ci` for clean, reproducible installs matching CI, or `npm install` when adding or updating dependencies.
- Outside `NODE_ENV=production`, the `prepare` script initializes Husky hooks automatically.
- `.husky/pre-commit` runs `npx lint-staged` to format staged files with Prettier only; it intentionally skips static and test checks to keep commits fast, so run the verification commands below before pushing.
- Run `npm run format` to format the repository with Prettier, or `npm run format:check` to check formatting without modifying files.

## CI and security verification

Run checks in this order so build artifacts exist and stay current before smoke tests execute:

1. `npm run format:check` — check Prettier formatting without changing files.
2. `npm run check` — sync SvelteKit types and run `svelte-check`.
3. `npm test` — run unit and integration tests.
4. `npm run build` — build the production SvelteKit Node adapter (`build/handler.js`).
5. `npm run test:smoke` — start `server.mjs` against an in-memory database and smoke-test production HTTP routes (requires `npm run build` first because `server.mjs` imports `./build/handler.js`).
6. `npm run test:sso` — start `server.mjs` and smoke-test SSO and trusted-proxy authentication (requires `npm run build` first).
7. `docker build --tag flavorithm:ci .` — verify the production container image build (requires a running Docker daemon).
8. `npm audit --omit=dev --audit-level=high` — audit production dependencies for high or critical vulnerabilities as run in the Security workflow (requires network access to reach the npm registry; CI runs this after `npm ci --ignore-scripts`).

### Notes and edge cases

- Rebuild after edits: editing source files after `npm run build` leaves stale output in `build/`, so re-run `npm run build` before re-running `npm run test:smoke` or `npm run test:sso`.
- Docker availability: environments without a running Docker daemon cannot run `docker build --tag flavorithm:ci .`.
- Network availability: offline environments cannot reach the npm registry during `npm audit --omit=dev --audit-level=high`.
