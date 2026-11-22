#!/bin/sh
set -eu

stack_dir="${FLAVORITHM_STACK_DIR:-/home/skynet/opt/stacks/flavorithm}"
model_dir="${FLAVORITHM_WHISPER_MODEL_DIR:-/home/skynet/opt/appdata/flavorithm-whisper}"
FLAVORITHM_WHISPER_MODEL_COMMIT="${FLAVORITHM_WHISPER_MODEL_COMMIT:-5359861c739e955e79d9a303bcbc70fb988958b1}"
FLAVORITHM_WHISPER_MODEL_SHA256="${FLAVORITHM_WHISPER_MODEL_SHA256:-60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe}"
model_url="https://huggingface.co/ggerganov/whisper.cpp/resolve/$FLAVORITHM_WHISPER_MODEL_COMMIT/ggml-base.bin?download=true"
model_file="$model_dir/ggml-base.bin"
model_tmp="$model_file.part"

verify_model_sha256() {
  printf '%s  %s\n' "$FLAVORITHM_WHISPER_MODEL_SHA256" "$1" | sha256sum -c - >/dev/null 2>&1
}

trap 'rm -f "$model_tmp"; exit 1' INT TERM HUP

mkdir -p "$model_dir"
if ! command -v sha256sum >/dev/null 2>&1; then
  rm -f "$model_tmp"
  printf '%s\n' 'sha256sum is required to verify the Whisper model.' >&2
  exit 1
fi

if [ -f "$model_file" ] && verify_model_sha256 "$model_file"; then
  rm -f "$model_tmp"
else
  rm -f "$model_file" "$model_tmp"
  if ! curl --fail --location --retry 5 --retry-delay 5 --retry-all-errors \
    --output "$model_tmp" \
    "$model_url"; then
    rm -f "$model_tmp"
    printf '%s\n' 'Failed to download the Whisper model.' >&2
    exit 1
  fi
  if ! [ -s "$model_tmp" ] || ! verify_model_sha256 "$model_tmp"; then
    rm -f "$model_tmp"
    printf '%s\n' 'Whisper model checksum verification failed.' >&2
    exit 1
  fi
  mv "$model_tmp" "$model_file"
fi
# The service runs as UID 10001 and only needs read access to this model.
chmod 0755 "$model_dir"
chmod 0644 "$model_file"

cd "$stack_dir"
docker compose -p flavorithm -f compose.yml -f deploy/skynet/compose.override.yml config --quiet
docker compose -p flavorithm -f compose.yml -f deploy/skynet/compose.override.yml pull flavorithm-whisper
docker compose -p flavorithm -f compose.yml -f deploy/skynet/compose.override.yml up -d --no-deps flavorithm-whisper flavorithm

attempt=0
while [ "$attempt" -lt 72 ]; do
  state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' flavorithm-whisper 2>/dev/null || true)"
  if [ "$state" = healthy ]; then
    printf '%s\n' 'Local Whisper is healthy and connected to Flavorithm.'
    exit 0
  fi
  if [ "$state" = unhealthy ]; then break; fi
  sleep 5
  attempt=$((attempt + 1))
done
docker logs --tail 60 flavorithm-whisper >&2 || true
printf '%s\n' 'Local Whisper did not become healthy.' >&2
exit 1
