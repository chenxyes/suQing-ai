#!/usr/bin/env bash
# Deploy an immutable image into an existing Compose installation. No secrets printed.
set -Eeuo pipefail
if [[ $# != 2 ]]; then echo 'usage: release.sh EXISTING_COMPOSE_DIRECTORY IMAGE_DIGEST' >&2; exit 2; fi
project_dir=$1
candidate=$2
if [[ ! $candidate =~ ^ghcr\.io/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$ ]]; then
  echo 'Expected an immutable ghcr.io image digest' >&2; exit 2
fi
if [[ ! -d $project_dir || ! -f $project_dir/docker-compose.yml ]]; then
  echo 'Existing docker-compose.yml required; initial provisioning is manual' >&2; exit 2
fi
project_dir=$(cd "$project_dir" && pwd -P)
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
attempts=${RELEASE_HEALTH_ATTEMPTS:-60}
interval=${RELEASE_HEALTH_INTERVAL:-3}
if [[ ! $attempts =~ ^[0-9]+$ || ! $interval =~ ^[0-9]+$ ]] ||
   (( attempts < 1 || attempts > 120 || interval > 30 )); then
  echo 'Invalid health polling bounds' >&2; exit 2
fi
mkdir -p "$project_dir/.release"
lock="$project_dir/.release/lock"
if ! mkdir "$lock" 2>/dev/null; then echo 'Another release holds .release/lock; inspect it before retrying' >&2; exit 1; fi
printf '%s\n' "$$" > "$lock/pid"
rollback_image=''
mutated=0
export RELEASE_IMAGE=$candidate
compose=(docker compose --project-directory "$project_dir" -f "$project_dir/docker-compose.yml" -f "$script_dir/compose.release.yml")
healthy() {
  local id state i
  for ((i=0; i<attempts; i++)); do
    id=$("${compose[@]}" ps -q xiyu-ai) || return 1
    if [[ -n $id ]]; then
      state=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing-healthcheck{{end}}' "$id") || return 1
      [[ $state == healthy ]] && return 0
      [[ $state == unhealthy || $state == missing-healthcheck ]] && return 1
    fi
    sleep "$interval"
  done
  return 1
}
persist_image() {
  local ref=$1
  printf 'services:\n  xiyu-ai:\n    image: %s\n' "$ref" > "$project_dir/.release/compose.image.yml.tmp" &&
    mv "$project_dir/.release/compose.image.yml.tmp" "$project_dir/.release/compose.image.yml" &&
    printf '%s\n' "$ref" > "$project_dir/.release/current-image"
}
finish() {
  local rc=$?
  trap - EXIT INT TERM
  if (( rc != 0 && mutated == 1 )); then
    echo 'Release failed; restoring previous image' >&2
    export RELEASE_IMAGE=$rollback_image
    if "${compose[@]}" up -d --no-deps --no-build --pull never xiyu-ai && healthy; then
      persist_image "$rollback_image" || echo 'Failed to persist rollback metadata; inspect before restart' >&2
      echo 'Previous image restored and healthy' >&2
    else
      echo 'ROLLBACK FAILED: manual intervention required; persistent volumes retained' >&2
    fi
  fi
  rm -rf "$lock"
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker compose version >/dev/null
"${compose[@]}" config --quiet
existing=$("${compose[@]}" ps -q xiyu-ai)
if [[ -z $existing ]]; then echo 'No existing running xiyu-ai service; refusing an unprotected first deployment' >&2; exit 1; fi
actual_dir=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$existing")
project_name=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$existing")
if [[ $actual_dir != "$project_dir" || ! $project_name =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo 'Compose project identity mismatch' >&2; exit 1
fi
compose+=(--project-name "$project_name")
old_image=$(docker inspect --format '{{.Image}}' "$existing")
rollback_image="xiyu-release-rollback:$(date +%s)-$$"
docker image tag "$old_image" "$rollback_image"
# Pull before replacing any running service; registry login is an operator prerequisite.
docker pull "$candidate"
mutated=1
"${compose[@]}" up -d --no-deps --no-build --pull never xiyu-ai
if ! healthy; then echo 'Candidate did not become healthy' >&2; exit 1; fi
persist_image "$candidate"
printf '%s\n' "$rollback_image" > "$project_dir/.release/previous-image"
# Save the override as well so manual restarts can use the exact deployed image.

mutated=0
echo 'Release healthy; previous image retained locally for rollback'
