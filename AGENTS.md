# Development

- Run `npm install` to install dependencies and initialize Husky hooks automatically.
- Run `npm run format` to format the repository, or `npm run format:check` to check it without changes.
- Run `npm run check` to typecheck Svelte components, TypeScript modules, `src/service-worker.ts`, `server.mjs`, and `scripts/*.mjs` under Node 24 types.
- Run `npm test` for unit and integration suites, and `npm run build` followed by `npm run test:smoke` and `npm run test:sso` (or set `FLAVORITHM_SMOKE_URL` against a running container) for production smoke checks.
- The pre-commit hook runs `npx lint-staged` to format staged files with Prettier.
