#!/bin/sh
set -eu

if [ -z "${FLAVORITHM_UPDATER_RUNTIME_SCRIPT:-}" ]; then
	umask_prev="$(umask)"
	umask 077
	runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/flavorithm-updater.XXXXXX")"
	umask "$umask_prev"
	chmod 0700 "$runtime_dir"
	FLAVORITHM_UPDATER_RUNTIME_SCRIPT="$runtime_dir/update.sh"
	export FLAVORITHM_UPDATER_RUNTIME_SCRIPT
fi
runtime_script="$FLAVORITHM_UPDATER_RUNTIME_SCRIPT"
if [ "$0" != "$runtime_script" ]; then
	runtime_dir="$(dirname "$runtime_script")"
	mkdir -p "$runtime_dir"
	if [ -L "$runtime_dir" ]; then
		printf '%s\n' "[flavorithm-updater] Refusing symlinked runtime directory: $runtime_dir" >&2
		exit 1
	fi
	chmod 0700 "$runtime_dir"
	umask_prev="$(umask)"
	umask 077
	tmp_runtime="$(mktemp "$runtime_dir/update.sh.XXXXXX")"
	umask "$umask_prev"
	cp "$0" "$tmp_runtime"
	chmod 0700 "$tmp_runtime"
	mv -f "$tmp_runtime" "$runtime_script"
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
ci_workflow_path="${FLAVORITHM_CI_WORKFLOW_PATH:-.github/workflows/ci.yml}"
app_dir="${FLAVORITHM_UPDATE_APP_DIR:-/app}"
source_script="${FLAVORITHM_UPDATER_SOURCE_SCRIPT:-$app_dir/deploy/skynet/update.sh}"
state_dir="${FLAVORITHM_UPDATE_STATE_DIR:-/state}"
deployed_state_file="$state_dir/deployed-state"
legacy_sha_file="$state_dir/deployed-sha"
legacy_image_file="$state_dir/deployed-image"
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
	umask_prev="$(umask)"
	umask 077
	tmp_state="$(mktemp "$state_dir/.state.XXXXXX")"
	umask "$umask_prev"
	printf '%s\n' "$2" > "$tmp_state"
	mv -f "$tmp_state" "$1"
}

read_state_file() {
	[ -f "$1" ] || return 0
	tr -d '[:space:]' < "$1" 2>/dev/null || true
}

write_deployed_state() {
	mkdir -p "$state_dir"
	umask_prev="$(umask)"
	umask 077
	tmp_state="$(mktemp "$state_dir/.state.XXXXXX")"
	umask "$umask_prev"
	printf '%s\n%s\n' "$1" "${2:-}" > "$tmp_state"
	mv -f "$tmp_state" "$deployed_state_file"
	rm -f "$legacy_sha_file" "$legacy_image_file"
}

load_deployed_state() {
	deployed_sha=""
	deployed_image=""
	if [ -f "$deployed_state_file" ]; then
		line1=""
		line2=""
		{
			IFS= read -r line1 || true
			IFS= read -r line2 || true
		} < "$deployed_state_file"
		deployed_sha="$(printf '%s' "$line1" | tr -d '[:space:]')"
		deployed_image="$(printf '%s' "$line2" | tr -d '[:space:]')"
	else
		deployed_sha="$(read_state_file "$legacy_sha_file")"
		deployed_image="$(read_state_file "$legacy_image_file")"
	fi
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
	if [ -n "$deployed_image" ]; then
		if [ ! -f "$deployed_state_file" ] && [ ! -f "$rollback_pending_file" ] && is_valid_sha "$deployed_sha"; then
			write_deployed_state "$deployed_sha" "$deployed_image"
		fi
		docker tag "$deployed_image" flavorithm:rollback 2>/dev/null || true
		return 0
	fi

	if [ -f "$rollback_pending_file" ] || ! is_valid_sha "$deployed_sha"; then
		return 0
	fi

	current_local_sha="$(git -C "$app_dir" -c safe.directory="$app_dir" rev-parse HEAD 2>/dev/null || true)"
	if [ "$current_local_sha" != "$deployed_sha" ]; then
		return 0
	fi

	if [ "$(inspect_container_health)" = healthy ]; then
		current_image="$(inspect_container_image)"
		if [ -n "$current_image" ]; then
			write_deployed_state "$deployed_sha" "$current_image"
			deployed_image="$current_image"
			docker tag "$deployed_image" flavorithm:rollback 2>/dev/null || true
		fi
	fi
}

github_api_get() {
	api_url="$1"
	api_timeout=60
	if [ "$timeout_seconds" -lt "$api_timeout" ] 2>/dev/null; then
		api_timeout="$timeout_seconds"
	fi

	if [ -n "${FLAVORITHM_GITHUB_TOKEN:-}" ]; then
		clean_token="$(printf '%s' "$FLAVORITHM_GITHUB_TOKEN" | tr -d '\r\n"\\')"
		printf 'header = "Authorization: Bearer %s"\n' "$clean_token" |
			curl --fail --silent --show-error --location \
				--connect-timeout 15 \
				--max-time "$api_timeout" \
				--config - \
				-H 'Accept: application/vnd.github+json' \
				-H 'X-GitHub-Api-Version: 2022-11-28' \
				-H 'User-Agent: flavorithm-updater' \
				"$api_url"
	else
		curl --fail --silent --show-error --location \
			--connect-timeout 15 \
			--max-time "$api_timeout" \
			-H 'Accept: application/vnd.github+json' \
			-H 'X-GitHub-Api-Version: 2022-11-28' \
			-H 'User-Agent: flavorithm-updater' \
			"$api_url"
	fi
}

verify_ci_check_run() {
	target_sha="$1"
	check_url="${github_api_url%/}/repos/${repo_owner}/${repo_name}/commits/${target_sha}/check-runs?check_name=verify&filter=latest"
	response="$(github_api_get "$check_url")" || return 1

	run_ids="$(
		printf '%s\n' "$response" | jq -er --arg sha "$target_sha" '
			if (.check_runs | type) != "array" then
				error("invalid check_runs")
			else
				[
					.check_runs[]
					| select(
						.name == "verify" and
						(.app.slug? == "github-actions") and
						(((.head_sha? // $sha) | tostring | ascii_downcase) == ($sha | ascii_downcase))
					)
				] as $runs
				| if ($runs | length) == 0 or (all($runs[]; .status == "completed" and .conclusion == "success") | not) then
					error("verify not green")
				else
					[
						$runs[]
						| ((.details_url? // .html_url? // "") | tostring)
						| capture("/actions/runs/(?<id>[0-9]+)(?:/|$)")
						| .id
					]
					| unique
					| if length == 0 then error("missing workflow run id") else .[] end
				end
			end
		' 2>/dev/null
	)" || return 1

	matched_ci_workflow=0
	for run_id in $run_ids; do
		case "$run_id" in
			'' | *[!0-9]*) return 1 ;;
		esac
		run_url="${github_api_url%/}/repos/${repo_owner}/${repo_name}/actions/runs/${run_id}"
		run_response="$(github_api_get "$run_url")" || return 1
		if printf '%s\n' "$run_response" | jq -e --arg sha "$target_sha" --arg wf "$ci_workflow_path" '
			(.path? == $wf) and
			(((.head_sha? // "") | tostring | ascii_downcase) == ($sha | ascii_downcase)) and
			(.status == "completed") and
			(.conclusion == "success")
		' >/dev/null 2>&1; then
			matched_ci_workflow=1
		fi
	done

	[ "$matched_ci_workflow" -eq 1 ]
}

rollback_to_deployed() {
	failed_candidate="$1"
	load_deployed_state
	if ! is_valid_sha "$deployed_sha"; then
		log "No rollback target: no valid deployed SHA recorded; clearing pending rollback marker."
		if is_valid_sha "$failed_candidate"; then
			write_state_file "$failed_sha_file" "$failed_candidate"
		fi
		rm -f "$rollback_pending_file"
		return 0
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

	if is_valid_sha "$failed_candidate" && [ "$failed_candidate" != "$deployed_sha" ]; then
		write_state_file "$failed_sha_file" "$failed_candidate"
		log "Rollback to $deployed_sha succeeded; skipping broken commit $failed_candidate."
	else
		existing_failed="$(read_state_file "$failed_sha_file")"
		if [ "$existing_failed" = "$deployed_sha" ]; then
			rm -f "$failed_sha_file"
		fi
		log "Rollback to $deployed_sha succeeded."
	fi
	rm -f "$rollback_pending_file"
	return 0
}

poll_once() {
	load_deployed_state
	if [ -f "$rollback_pending_file" ] && ! is_valid_sha "$deployed_sha"; then
		log "No rollback target: deployed SHA is missing or invalid; clearing pending rollback marker."
		rm -f "$rollback_pending_file"
	fi

	ensure_rollback_image

	if [ -f "$rollback_pending_file" ]; then
		pending_failed_sha="$(read_state_file "$rollback_pending_file")"
		log "Retrying pending rollback to $deployed_sha."
		if ! rollback_to_deployed "$pending_failed_sha"; then
			log "Recovery retry failed; retrying in ${interval}s."
		fi
		return 0
	fi

	failed_sha="$(read_state_file "$failed_sha_file")"

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
		write_deployed_state "$build_sha" "$healthy_image"
		rm -f "$rollback_pending_file" "$failed_sha_file"
		if [ -n "$healthy_image" ]; then
			docker tag "$healthy_image" flavorithm:rollback 2>/dev/null || true
		fi
		log "Flavorithm updated successfully ($build_sha)."

		if [ -f "$source_script" ] && ! cmp -s "$source_script" "$runtime_script"; then
			runtime_dir="$(dirname "$runtime_script")"
			if [ -L "$runtime_dir" ]; then
				log "Refusing symlinked runtime directory: $runtime_dir"
				exit 1
			fi
			chmod 0700 "$runtime_dir"
			umask_prev="$(umask)"
			umask 077
			tmp_runtime="$(mktemp "$runtime_dir/update.sh.XXXXXX")"
			umask "$umask_prev"
			cp "$source_script" "$tmp_runtime"
			chmod 0700 "$tmp_runtime"
			mv -f "$tmp_runtime" "$runtime_script"
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
