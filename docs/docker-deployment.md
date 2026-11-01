# Docker deployment

Flavorithm runs in a Node 24 container with a read-only application filesystem,
a non-root runtime user, and SQLite stored on persistent storage. The standard
Compose file binds port 3000 to loopback. The Skynet override attaches the app
to the host's existing `proxy` network and stores its database under
`/home/skynet/opt/appdata/flavorithm`.

## Run with Docker Compose

```sh
cp .env.example .env
```

Set `ORIGIN` to the public HTTPS origin and choose the sign-in mode before
starting the app. For a private local deployment, keep `FLAVORITHM_AUTH_MODE`
as `local`. Then build and start the service:

```sh
docker compose up -d --build
docker compose logs -f flavorithm
```

The container health check requests the PWA manifest through the app server.
Recipe and account data live in the Compose-managed `flavorithm-data` volume.
The Skynet override replaces that named volume with the bind mount
`/home/skynet/opt/appdata/flavorithm`; the backup and restore steps below work
with either storage setup.

## Back up and restore

Run these commands from the repository checkout. For Skynet, add
`-p flavorithm -f compose.yml -f deploy/skynet/compose.override.yml` to each
`docker compose` command so it selects the app's bind mount and deployment
project.

The online backup command uses Node 24's SQLite backup API against the running
database, so committed changes in the WAL are included. It writes a temporary
backup into `/app/data`, copies it out of the container, and removes the
temporary file. The local `oauth.key` is copied separately when present; if you
use hosted OAuth, preserve the matching `FLAVORITHM_OAUTH_ENCRYPTION_KEY` from
the private deployment configuration instead.

```sh
mkdir -p backups
container_id="$(docker compose ps -q flavorithm)"
test -n "$container_id"

docker compose exec -T flavorithm rm -f /app/data/flavorithm-backup.sqlite
docker compose exec -T flavorithm node --input-type=module -e '
import { DatabaseSync, backup } from "node:sqlite";
const db = new DatabaseSync("/app/data/flavorithm.sqlite", { readOnly: true });
await backup(db, "/app/data/flavorithm-backup.sqlite");
db.close();
'
docker cp "$container_id:/app/data/flavorithm-backup.sqlite" backups/flavorithm.sqlite
docker compose exec -T flavorithm rm -f /app/data/flavorithm-backup.sqlite
chmod 600 backups/flavorithm.sqlite

if docker compose exec -T flavorithm test -f /app/data/oauth.key; then
  docker cp "$container_id:/app/data/oauth.key" backups/oauth.key
  chmod 600 backups/oauth.key
fi
```

Backups contain private kitchen data and may contain OAuth credentials. Keep
the files and any hosted encryption key access restricted. Test restores before
relying on the backups.

To restore, stop the app gracefully first and keep its stopped Compose
container in place. The helper below uses that container's mounts and writes
as the image's runtime user (UID 1000), so the named volume and Skynet bind
mount retain the expected ownership. It also removes stale WAL and shared-memory
sidecars after replacing the database.

```sh
container_id="$(docker compose ps -aq flavorithm)"
test -n "$container_id"
docker compose stop --timeout 30 flavorithm
docker run --rm --volumes-from "$container_id" --user 1000:1000 --entrypoint sh flavorithm:local -c '
  cat > /app/data/flavorithm.sqlite
  chmod 600 /app/data/flavorithm.sqlite
  rm -f /app/data/flavorithm.sqlite-wal /app/data/flavorithm.sqlite-shm
' < backups/flavorithm.sqlite

# Only when the backup uses local OAuth encryption and includes oauth.key.
if [ -f backups/oauth.key ]; then
  docker run --rm --volumes-from "$container_id" --user 1000:1000 --entrypoint sh flavorithm:local -c '
    cat > /app/data/oauth.key
    chmod 600 /app/data/oauth.key
  ' < backups/oauth.key
fi

docker compose up -d flavorithm
```

For hosted OAuth, restore the matching `FLAVORITHM_OAUTH_ENCRYPTION_KEY` in
`.env` before starting the app. Do not copy a database by itself while the app
is running: SQLite may have committed data in its WAL that is not in the main
database file.

## Deploy on Skynet with Authentik

The host uses Caddy, Authentik's embedded proxy outpost, and the
`favonia/cloudflare-ddns` updater. These files integrate Flavorithm into those
existing services:

- [`deploy/skynet/authentik-blueprint.yml`](../deploy/skynet/authentik-blueprint.yml)
  creates a single-app forward-auth provider, an Authentik application, and
  assigns the app to the embedded outpost while retaining the host's current
  proxy providers.
- [`deploy/skynet/Caddyfile.snippet`](../deploy/skynet/Caddyfile.snippet)
  forwards sign-in checks to Authentik, copies the authenticated identity, and
  injects the proxy assertion only after Authentik accepts the request.
- [`deploy/skynet/compose.override.yml`](../deploy/skynet/compose.override.yml)
  removes the public host port, uses the persistent app-data bind mount, and
  starts the GitHub source updater.

Generate a random shared secret with `openssl rand -hex 32` and store the same
value in the app's `.env` and the Caddy-only environment file. Keep both files
mode `0600`; do not commit them. Configure these values in the app's `.env`:

```dotenv
ORIGIN=https://eat.stevengerner.com
FLAVORITHM_AUTH_MODE=proxy
FLAVORITHM_PROXY_SHARED_SECRET=<same-random-value-in-both-files>
FLAVORITHM_PROXY_LOGOUT_URL=https://eat.stevengerner.com/outpost.goauthentik.io/sign_out
```

The app uses `x-authentik-uid`, `x-authentik-email`, and `x-authentik-name`
from the authenticated forward-auth response. The shared secret prevents a
direct request to the app container from forging those identity headers. The
app has no host-published port and is reachable only on Docker's `proxy`
network.

Add `eat.stevengerner.com` to the existing Cloudflare DDNS `DOMAINS` list, then
start the updater so it creates or updates the DNS record. Copy the Authentik
blueprint into `/home/skynet/opt/appdata/authentik/blueprints/`, append the
Caddy snippet to the host's Caddyfile, and load the Caddy-only secret into the
Caddy container through a dedicated env file. Validate and reload Caddy before
opening the public URL. Authentik's forward-auth application redirects
signed-out visitors directly to the existing Authentik login.

On the host, clone the public repository into
`/home/skynet/opt/stacks/flavorithm`, create its ignored `.env` file, and make
the persistent data directory writable by the image's `node` user (UID 1000):

```sh
mkdir -p /home/skynet/opt/appdata/flavorithm
chown 1000:1000 /home/skynet/opt/appdata/flavorithm
```

After configuration is ready, build the app and launch the GitHub updater from
the repository root:

```sh
docker compose -p flavorithm -f compose.yml -f deploy/skynet/compose.override.yml build --pull flavorithm
docker compose -p flavorithm -f compose.yml -f deploy/skynet/compose.override.yml up -d flavorithm
mkdir -p /home/skynet/opt/appdata/flavorithm-updater
git rev-parse HEAD > /home/skynet/opt/appdata/flavorithm-updater/deployed-sha
docker compose -p flavorithm -f compose.yml -f deploy/skynet/compose.override.yml up -d flavorithm-updater
```

The updater checks the public `main` branch every 15 minutes, fast-forwards the
checkout, rebuilds the image, and records a commit only after the health check
passes. If an update fails its health check, it restores the previous image.
The updater needs the Docker socket to build and replace the app container, so
keep its compose file and host checkout writable only by trusted administrators.

## Acceptance checks

1. Confirm `https://eat.stevengerner.com` resolves and Caddy has a valid TLS
   certificate.
2. Open the site while signed out of Authentik. It should go directly to
   Authentik, with no Flavorithm login choice.
3. Sign in with a new Authentik user and confirm the account and starter
   recipes are created. Sign out, then confirm the next visit returns to
   Authentik.
4. From the host, request the app container directly without the proxy secret
   and confirm the response is unauthorized. Check Caddy's forward-auth route
   and the Authentik outpost logs if sign-in fails.
5. Stop the container, back up the SQLite file, restart it, and confirm the
   signed-in kitchen remains available.
