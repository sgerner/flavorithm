#!/bin/sh
set -eu

runtime_script="${FLAVORITHM_UPDATER_RUNTIME_SCRIPT:-/tmp/flavorithm-update.sh}"
if [ "$0" != "$runtime_script" ]; then
	mkdir -p "$(dirname "$runtime_script")"
	cp "$0" "${runtime_script}.tmp"
	chmod 0700 "${runtime_script}.tmp"
	mv -f "${runtime_script}.tmp" "$runtime_script"
	exec /bin/sh "$runtime_script" "$@"
fi

if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
	apk add --no-cache git curl jq >/dev/null
fi

interval="${FLAVORITHM_UPDATE_INTERVAL_SECONDS:-900}"
timeout_seconds="${FLAVORITHM_UPDATE_COMMAND_TIMEOUT_SECONDS:-1800}"
branch="${FLAVORITHM_UPDATE_BRANCH:-main}"
repo_url="${FLAVORITHM_UPDATE_REPO_URL:-https://github.com/sgerner/flavorithm.git}"
github_api_url="${FLAVORITHM_GITHUB_API_URL:-https://api.github.com}"
app_dir="${FLAVORITHM_UPDATE_APP_DIR:-/app}"
source_script="${FLAVORITHM_UPDATER_SOURCE_SCRIPT:-$app_dir/deploy/skynet/update.sh}"
state_dir="${FLAVORITHM_UPDATE_STATE_DIR:-/state}"
state_file="$state_dir/deployed-sha"
deployed_image_file="$state_dir/deployed-image"
failed_sha_file="$state_dir/failed-sha"
rollback_pending_file="$state_dir/rollback-pending"
health_max_attempts="${FLAVORITHM_HEALTH_MAX_ATTEMPTS:-36}"
health_interval="${FLAVORITHM_HEALTH_INTERVAL_SECONDS:-5}"
max_polls="${FLAVORITHM_UPDATE_MAX_POLLS:-0}"

log() { printf '%s\n' "[flavorithm-updater] $*"; }

is_valid_sha() {
	[ "${#1}" -eq 40 ] && case "$1" in
		*[!0123456789abcdefABCDEF]*) return 1 ;;
		*) return 0 ;;
	esac
}

parse_github_repo() {
	repo_owner=""
	repo_name=""
	trimmed_url="${1%/}"
	case "$trimmed_url" in
		https://github.com/*)
			repo_path="${trimmed_url#https://github.com/}"
			;;
		ssh://git@github.com/*)
			repo_path="${trimmed_url#ssh://git@github.com/}"
			;;
		git@github.com:*)
			repo_path="${trimmed_url#git@github.com:}"
			;;
		*)
			return 1
			;;
	esac

	repo_path="${repo_path%.git}"
	case "$repo_path" in
		*/*/*) return 1 ;;
		*/*)
			repo_owner="${repo_path%%/*}"
			repo_name="${repo_path#*/}"
			;;
		*) return 1 ;;
	esac

	if [ -z "$repo_owner" ] || [ -z "$repo_name" ]; then
		return 1
	fi
	if [ "$repo_owner" = "." ] || [ "$repo_owner" = ".." ] || [ "$repo_name" = "." ] || [ "$repo_name" = ".." ]; then
		return 1
	fi
	case "$repo_owner" in
		-* | *[!A-Za-z0-9._-]*) return 1 ;;
	esac
	case "$repo_name" in
		-* | *[!A-Za-z0-9._-]*) return 1 ;;
	esac
	return 0
}

if [ -n "${FLAVORITHM_GITHUB_TOKEN:-}" ] && [ -z "${FLAVORITHM_GIT_AUTH_CONFIGURED:-}" ]; then
	case "$repo_url" in
		https://github.com/*)
			git_auth_b64="$(printf 'x-access-token:%s' "$FLAVORITHM_GITHUB_TOKEN" | base64 | tr -d '\r\n')"
			git_cfg_idx="${GIT_CONFIG_COUNT:-0}"
			case "$git_cfg_idx" in
				'' | *[!0-9]*) git_cfg_idx=0 ;;
			esac
			export "GIT_CONFIG_KEY_${git_cfg_idx}=http.https://github.com/.extraheader"
			export "GIT_CONFIG_VALUE_${git_cfg_idx}=AUTHORIZATION: basic ${git_auth_b64}"
			export "GIT_CONFIG_COUNT=$((git_cfg_idx + 1))"
			export FLAVORITHM_GIT_AUTH_CONFIGURED=1
			;;
	esac
fi

write_state_file() {
	mkdir -p "$state_dir"
	printf '%s\n' "$2" > "${1}.tmp"
	mv -f "${1}.tmp" "$1"
}

read_state_file() {
	[ -f "$1" ] || return 0
	tr -d '[:space:]' < "$1" 2>/dev/null || true
}

run_compose() {
	timeout "$timeout_seconds" docker compose -p flavorithm \
		-f "$app_dir/compose.yml" \
		-f "$app_dir/deploy/skynet/compose.override.yml" \
		"$@"
}

inspect_container_health() {
	docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' flavorithm 2>/dev/null || true
}

inspect_container_image() {
	docker inspect --format '{{.Image}}' flavorithm 2>/dev/null || true
}

wait_until_healthy() {
	attempts=0
	while [ "$attempts" -lt "$health_max_attempts" ]; do
		state="$(inspect_container_health)"
		if [ "$state" = healthy ]; then return 0; fi
		sleep "$health_interval"
		attempts=$((attempts + 1))
	done
	log "Flavorithm did not become healthy after the update."
	return 1
}

ensure_rollback_image() {
	deployed_image="$(read_state_file "$deployed_image_file")"
	if [ -n "$deployed_image" ]; then
		docker tag "$deployed_image" flavorithm:rollback 2>/dev/null || true
		return 0
	fi

	if [ -f "$rollback_pending_file" ]; then
		return 0
	fi

	current_local_sha="$(git -C "$app_dir" -c safe.directory="$app_dir" rev-parse HEAD 2>/dev/null || true)"
	if [ -n "$deployed_sha" ] && [ "$current_local_sha" != "$deployed_sha" ]; then
		return 0
	fi

	if [ "$(inspect_container_health)" = healthy ]; then
		current_image="$(inspect_container_image)"
		if [ -n "$current_image" ]; then
			write_state_file "$deployed_image_file" "$current_image"
			deployed_image="$current_image"
			docker tag "$deployed_image" flavorithm:rollback 2>/dev/null || true
		fi
	fi
}

verify_ci_check_run() {
	check_url="${github_api_url%/}/repos/${repo_owner}/${repo_name}/commits/${1}/check-runs?check_name=verify&filter=latest"
	api_timeout=60
	if [ "$timeout_seconds" -lt "$api_timeout" ] 2>/dev/null; then
		api_timeout="$timeout_seconds"
	fi

	if [ -n "${FLAVORITHM_GITHUB_TOKEN:-}" ]; then
		clean_token="$(printf '%s' "$FLAVORITHM_GITHUB_TOKEN" | tr -d '\r\n"\\')"
		response="$(
			printf 'header = "Authorization: Bearer %s"\n' "$clean_token" |
				curl --fail --silent --show-error --location \
					--connect-timeout 15 \
					--max-time "$api_timeout" \
					--config - \
					-H 'Accept: application/vnd.github+json' \
					-H 'X-GitHub-Api-Version: 2022-11-28' \
					-H 'User-Agent: flavorithm-updater' \
					"$check_url"
		)" || return 1
	else
		response="$(
			curl --fail --silent --show-error --location \
				--connect-timeout 15 \
				--max-time "$api_timeout" \
				-H 'Accept: application/vnd.github+json' \
				-H 'X-GitHub-Api-Version: 2022-11-28' \
				-H 'User-Agent: flavorithm-updater' \
				"$check_url"
		)" || return 1
	fi

	printf '%s\n' "$response" | jq -e --arg sha "$1" '
		(.check_runs | type == "array") and
		(
			[
				.check_runs[]
				| select(
					.name == "verify" and
					(.app.slug? == "github-actions") and
					(((.head_sha? // $sha) | tostring | ascii_downcase) == ($sha | ascii_downcase))
				)
			]
			| length > 0 and all(.[]; .status == "completed" and .conclusion == "success")
		)
	' >/dev/null 2>&1
}

rollback_to_deployed() {
	failed_candidate="$1"
	if ! is_valid_sha "$deployed_sha"; then
		log "Cannot roll back: no valid deployed SHA recorded in $state_file."
		return 1
	fi

	log "Rolling back /app and container to $deployed_sha."
	if ! timeout "$timeout_seconds" git -C "$app_dir" -c safe.directory="$app_dir" reset --hard "$deployed_sha"; then
		log "Git reset to $deployed_sha failed during rollback."
		return 1
	fi

	if ! run_compose config --quiet; then
		log "Compose config validation failed after resetting /app to $deployed_sha."
		return 1
	fi

	deployed_image="$(read_state_file "$deployed_image_file")"
	if [ -n "$deployed_image" ]; then
		docker tag "$deployed_image" flavorithm:rollback 2>/dev/null || true
	fi
	if ! docker tag flavorithm:rollback flavorithm:local; then
		log "Failed to retag flavorithm:rollback to flavorithm:local."
		return 1
	fi

	if ! run_compose up -d --no-deps flavorithm; then
		log "Failed to recreate flavorithm during rollback."
		return 1
	fi

	if ! wait_until_healthy; then
		log "Rollback container did not pass health check."
		return 1
	fi

	if is_valid_sha "$failed_candidate"; then
		write_state_file "$failed_sha_file" "$failed_candidate"
		log "Rollback to $deployed_sha succeeded; skipping broken commit $failed_candidate."
	else
		log "Rollback to $deployed_sha succeeded."
	fi
	rm -f "$rollback_pending_file"
	return 0
}

poll_once() {
	deployed_sha="$(read_state_file "$state_file")"
	failed_sha="$(read_state_file "$failed_sha_file")"
	ensure_rollback_image

	if [ -f "$rollback_pending_file" ]; then
		pending_failed_sha="$(read_state_file "$rollback_pending_file")"
		log "Retrying pending rollback to ${deployed_sha:-none}."
		if ! rollback_to_deployed "$pending_failed_sha"; then
			log "Recovery retry failed; retrying in ${interval}s."
		fi
		return 0
	fi

	if ! parse_github_repo "$repo_url"; then
		log "Invalid GitHub repository URL ($repo_url); retrying in ${interval}s."
		return 0
	fi

	remote_sha="$(timeout "$timeout_seconds" git ls-remote "$repo_url" "refs/heads/$branch" 2>/dev/null | awk 'NR == 1 { print $1 }')"
	if ! is_valid_sha "$remote_sha"; then
		log "Could not resolve a valid 40-character SHA for origin/$branch; retrying in ${interval}s."
		return 0
	fi

	if [ "$remote_sha" = "$deployed_sha" ]; then
		log "No update detected ($remote_sha)."
		return 0
	fi

	if [ -n "$failed_sha" ] && [ "$remote_sha" = "$failed_sha" ]; then
		log "Skipping previously failed commit $remote_sha."
		return 0
	fi

	if ! verify_ci_check_run "$remote_sha"; then
		log "Skipping $remote_sha: GitHub Actions verify check-run has not completed with success."
		return 0
	fi

	log "Deploying verified commit $remote_sha (last successful deploy: ${deployed_sha:-none})."
	if ! timeout "$timeout_seconds" git -C "$app_dir" -c safe.directory="$app_dir" fetch --no-tags "$repo_url" "$remote_sha"; then
		log "Git fetch failed for $remote_sha; retrying in ${interval}s."
		return 0
	fi

	write_state_file "$rollback_pending_file" "recover"
	if ! timeout "$timeout_seconds" git -C "$app_dir" -c safe.directory="$app_dir" checkout --force "$remote_sha"; then
		log "Git checkout failed for $remote_sha; restoring ${deployed_sha:-none}."
		if ! rollback_to_deployed ""; then
			log "Rollback failed after checkout error; retrying recovery in ${interval}s."
		fi
		return 0
	fi

	build_sha="$(git -C "$app_dir" -c safe.directory="$app_dir" rev-parse HEAD 2>/dev/null || true)"
	if [ "$build_sha" != "$remote_sha" ]; then
		log "Checkout SHA mismatch (expected $remote_sha, got ${build_sha:-none}); rolling back."
		write_state_file "$rollback_pending_file" "$remote_sha"
		if ! rollback_to_deployed "$remote_sha"; then
			log "Rollback failed; retrying recovery in ${interval}s."
		fi
		return 0
	fi

	if run_compose config --quiet && \
		run_compose build --pull flavorithm && \
		run_compose up -d --no-deps flavorithm && \
		wait_until_healthy; then
		healthy_image="$(inspect_container_image)"
		if [ -n "$healthy_image" ]; then
			write_state_file "$deployed_image_file" "$healthy_image"
			docker tag "$healthy_image" flavorithm:rollback
		fi
		write_state_file "$state_file" "$build_sha"
		rm -f "$failed_sha_file" "$rollback_pending_file"
		log "Flavorithm updated successfully ($build_sha)."

		if [ -f "$source_script" ] && ! cmp -s "$source_script" "$runtime_script"; then
			cp "$source_script" "${runtime_script}.tmp"
			chmod 0700 "${runtime_script}.tmp"
			mv -f "${runtime_script}.tmp" "$runtime_script"
			log "Updater script changed; re-executing $runtime_script."
			exec /bin/sh "$runtime_script" "$@"
		fi
	else
		log "Compose validation, build, or health check failed for $remote_sha; rolling back."
		write_state_file "$rollback_pending_file" "$remote_sha"
		if ! rollback_to_deployed "$remote_sha"; then
			log "Rollback failed; retrying recovery in ${interval}s."
		fi
	fi
}

completed_polls=0
while :; do
	poll_once
	completed_polls=$((completed_polls + 1))
	if [ "$max_polls" -gt 0 ] && [ "$completed_polls" -ge "$max_polls" ]; then
		exit 0
	fi
	sleep "$interval"
done
