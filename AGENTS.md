# Development

- Requires Node.js 24 LTS (`>=24.19.0 <25.0.0`). `.nvmrc` pins major version `24` (`nvm use`) and `.npmrc` sets `engine-strict=true`.
- Run `npm ci` to install locked dependencies cleanly and initialize Husky hooks automatically (use `npm install` only when intentionally updating `package-lock.json`).
- Run `npm run format` to format the repository, or `npm run format:check` to check it without changes.
- The pre-commit hook runs `npx lint-staged` to format staged files with Prettier.
- Verify changes locally with `npm run format:check`, `npm run check`, `npm test`, `npm run build`, `npm run test:smoke`, and `npm run test:sso`.
