# Launch acceptance

Run `npm run readiness` on the production host after setting `.env`. Use
`npm run readiness -- --strict` when every optional integration is required.
The command prints setup status without exposing keys. Configuration checks do
not prove that an external provider will accept a request.

## Host and recovery

- Serve the built app behind HTTPS, set its exact public `ORIGIN`, and use a
  persistent SQLite volume. Keep one application instance unless storage and
  rate limits have been redesigned for multiple instances.
- Make a SQLite-consistent backup and back up the OAuth encryption key
  separately. Restore into an isolated instance and verify sign-in and kitchen
  contents before relying on the backup.
- Configure Resend with a verified sender (`RESEND_API_KEY`, `EMAIL_FROM`). Send
  a verification link to an account you control, consume it, then confirm a
  second use is rejected. Repeat for password recovery; verify the old password
  and old sessions no longer work after reset. Do not commit delivery credentials.

## Connected features

- Configure `BRAVE_SEARCH_API_KEY`, search for a recipe, import a public link,
  review its quantities and assumptions, save it, edit it, and delete it.
- Connect an API model using a temporary test key in Settings. Generate a recipe,
  recognize a food photo, and estimate nutrition. Verify provider errors are
  visible and that disconnecting/closing the tab clears in-memory API keys.
- For local ChatGPT consent, use a browser on the same computer as the server.
  For a hosted deployment, obtain the provider-approved client configuration
  described in [the OAuth guide](chatgpt-oauth.md). Connect, consent, fetch the
  account catalog, make a small request, refresh/reconnect, and disconnect.
  Invalid eligibility and expired consent must fail visibly without changing to
  API-key billing. This acceptance step needs a real eligible account; mocked
  automated tests cannot establish provider eligibility or quota.

## Real devices and shared kitchens

- Install on an Android browser and iOS Safari over HTTPS. Check small-screen
  dialogs, camera/photo selection, keyboard focus, voice support, light/dark
  themes, and reduced-motion behavior. Voice may require text fallback.
- Open a household on two devices. Test owner invites, revocation and removal,
  simultaneous disjoint edits, and a competing edit requiring a user choice.
- Load the app, go offline, change the pantry and meal plan, close/reopen it,
  then reconnect. Confirm pending changes survive and synchronize. Try another
  account and household; pending data must never upload to that different kitchen.
- Build a weekly list twice, change plan servings, mark purchases and refresh
  again. Manual entries and actual purchases should survive without repeated
  generated quantities. Mark a meal cooked once, check pantry units and leftovers,
  then verify completing it again cannot deduct stock twice.

## Operational responsibilities

Publish the deployment's privacy, retention, and support information. Confirm
monitoring, disk space, backup retention, and email delivery failures have an owner.
Nutrition and recognized ingredients remain estimates for the user to review.
