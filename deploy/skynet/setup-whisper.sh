#!/bin/sh
set -eu

stack_dir=/home/skynet/opt/stacks/flavorithm
model_dir=/home/skynet/opt/appdata/flavorithm-whisper
model_file="$model_dir/ggml-base.bin"
model_tmp="$model_file.part"

mkdir -p "$model_dir"
if [ ! -s "$model_file" ]; then
  rm -f "$model_tmp"
  curl --fail --location --retry 5 --retry-delay 5 --retry-all-errors \
    --output "$model_tmp" \
    'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin?download=true'
  test -s "$model_tmp"
  mv "$model_tmp" "$model_file"
fi
chown 10001:10001 "$model_dir" "$model_file"
chmod 0750 "$model_dir"
chmod 0640 "$model_file"

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
