# Development fixtures

The app's guest kitchen lives in browser storage and includes the curated starter recipes, a sample pantry, and a short meal plan. A newly created account starts with the same recipes and empty pantry, meal plan, and shopping list.

For manual account and sync testing, create a disposable SQLite database with a prefilled demo kitchen:

```sh
npm run seed:dev
FLAVORITHM_DB_PATH=data/flavorithm.dev.sqlite npm run dev
```

The seed command creates `data/flavorithm.dev.sqlite`, which is ignored by Git. It creates a local-only account at `developer@flavorithm.test` and prints a randomly generated password once. There is no shared or checked-in password. Keep the database path set when starting the app so it uses the seeded kitchen rather than the normal local database.

You can choose another empty `.sqlite` file with `npm run seed:dev -- --db /path/to/flavorithm-dev.sqlite`. The command refuses the app's default database path and refuses to write into any database that already contains data. Running it again against its existing demo database makes no changes. `npm run test:smoke` uses an in-memory database and does not need this fixture.
