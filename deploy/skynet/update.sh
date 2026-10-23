#!/bin/sh
set -eu

interval="${FLAVORITHM_UPDATE_INTERVAL_SECONDS:-900}"
timeout_seconds="${FLAVORITHM_UPDATE_COMMAND_TIMEOUT_SECONDS:-1800}"
branch="${FLAVORITHM_UPDATE_BRANCH:-main}"
repo_url="${FLAVORITHM_UPDATE_REPO_URL:-https://github.com/sgerner/flavorithm.git}"
compose_files="-p flavorithm -f /app/compose.yml -f /app/deploy/skynet/compose.override.yml"
state_file="/state/deployed-sha"

log() { printf '%s\n' "[flavorithm-updater] $*"; }

if ! command -v git >/dev/null 2>&1; then
	apk add --no-cache git >/dev/null
fi

wait_until_healthy() {
	attempts=0
	while [ "$attempts" -lt 36 ]; do
		state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' flavorithm 2>/dev/null || true)"
		if [ "$state" = healthy ]; then return 0; fi
		sleep 5
		attempts=$((attempts + 1))
	done
	log "Flavorithm did not become healthy after the update."
	return 1
}

while :; do
	remote_sha="$(timeout "$timeout_seconds" git ls-remote "$repo_url" "refs/heads/$branch" 2>/dev/null | awk 'NR == 1 { print $1 }')"
	local_sha="$(git -C /app -c safe.directory=/app rev-parse HEAD 2>/dev/null || true)"
	deployed_sha="$(cat "$state_file" 2>/dev/null || true)"

	if [ -z "$remote_sha" ]; then
		log "Could not resolve origin/$branch; retrying in ${interval}s."
	elif [ "$remote_sha" != "$deployed_sha" ]; then
		log "Deploying $remote_sha (last successful deploy: ${deployed_sha:-none})."
		if [ "$remote_sha" != "$local_sha" ] && ! timeout "$timeout_seconds" git -C /app -c safe.directory=/app pull --ff-only "$repo_url" "$branch"; then
			log "Git update failed; retrying in ${interval}s."
			sleep "$interval"
			continue
		fi

		build_sha="$(git -C /app -c safe.directory=/app rev-parse HEAD 2>/dev/null || true)"
		previous_image="$(docker inspect --format '{{.Image}}' flavorithm 2>/dev/null || true)"
		if [ -z "$build_sha" ]; then
			log "Could not resolve the checkout SHA; retrying in ${interval}s."
		elif timeout "$timeout_seconds" docker compose $compose_files build --pull flavorithm && \
			timeout "$timeout_seconds" docker compose $compose_files up -d --no-deps flavorithm && \
			wait_until_healthy; then
			printf '%s\n' "$build_sha" > "${state_file}.tmp"
			mv "${state_file}.tmp" "$state_file"
			log "Flavorithm updated successfully ($build_sha)."
		else
			log "Build or health check failed; the successful-deploy marker is unchanged."
			if [ -n "$previous_image" ]; then
				docker tag "$previous_image" flavorithm:local
				docker compose $compose_files up -d --no-deps flavorithm || true
			fi
		fi
	else
		log "No update detected ($remote_sha)."
	fi

	sleep "$interval"
done
