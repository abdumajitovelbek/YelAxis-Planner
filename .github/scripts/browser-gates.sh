#!/usr/bin/env bash
set -euo pipefail

# Keep the managed browsers and their OS libraries reproducible. Only this disposable job's
# Docker daemon, checkout and synthetic artifacts are available inside the verification image.
artifact_dir="${RUNNER_TEMP:?}/browser-artifacts"
gate="${1:-full}"
case "$gate" in full|firefox|backend|connectivity) ;; *) exit 2 ;; esac
mkdir -p "$artifact_dir"
docker run --rm --ipc=host --network=host -e CI=true \
  -v "$PWD:$PWD" -w "$PWD" \
  -v "$artifact_dir:/tmp" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$(command -v docker):/usr/bin/docker:ro" \
  -v "$(command -v node):/usr/local/bin/node:ro" \
  mcr.microsoft.com/playwright:v1.62.0-noble@sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07 \
  bash -lc '
    set -euo pipefail
    git config --global --add safe.directory "$PWD"
    npm install -g pnpm@11.9.0 >/dev/null
    pnpm install --frozen-lockfile
    if [ "$1" = firefox ]; then
      pnpm --filter web run test:firefox
      exit 0
    fi
    if [ "$1" = connectivity ]; then
      pnpm --filter web run test:connectivity
      exit 0
    fi
    finish() {
      result=$?
      trap - EXIT
      if ! pnpm run supabase:stop; then exit 1; fi
      exit "$result"
    }
    trap finish EXIT
    pnpm run supabase:start
    pnpm run supabase:reset
    node .github/scripts/check-backend-query.mjs
    if [ "$1" = backend ]; then
      pnpm run test:backend
    else
      pnpm run web:verify
      pnpm run release:verify
    fi
  ' browser-gates "$gate"
