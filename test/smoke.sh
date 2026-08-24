#!/usr/bin/env bash
#
# Build-and-run smoke for the container image: the image must build, serve its
# bundled defaults standalone, run as a non-root user, and reach HEALTHY
# through the /health/mapping canary.
#
#   ./test/smoke.sh                      build the image and smoke it
#   BUILD_FLAGS=--network=host ./test/smoke.sh
#                                        extra flags for docker build (hosts
#                                        whose bridge network lacks egress)
#   PREBUILT=<container> ./test/smoke.sh
#                                        smoke an already-running container
#                                        publishing port 3333 (skips build/run)
set -euo pipefail

PORT="${PORT:-3333}"
IMAGE="mapper-http:smoke"
CONTAINER="${PREBUILT:-mapper-http-smoke}"

fail() {
  echo "smoke: FAIL — $1" >&2
  docker logs "$CONTAINER" >&2 || true
  exit 1
}

cleanup() {
  if [ -z "${PREBUILT:-}" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ -z "${PREBUILT:-}" ]; then
  echo "smoke: building $IMAGE"
  # shellcheck disable=SC2086
  docker build ${BUILD_FLAGS:-} -q -t "$IMAGE" "$(dirname "$0")/.." >/dev/null
  docker run -d --name "$CONTAINER" -p "$PORT:3333" "$IMAGE" >/dev/null
fi

echo "smoke: waiting for the server"
for _ in $(seq 1 30); do
  curl -sf "http://localhost:$PORT/health" >/dev/null && break
  sleep 1
done
curl -sf "http://localhost:$PORT/health" >/dev/null || fail "/health did not come up"

echo "smoke: /health/mapping"
curl -sf "http://localhost:$PORT/health/mapping" | grep -q '"status":"ok"' || fail "/health/mapping not ok"

echo "smoke: /map serves the bundled defaults"
result="$(curl -sf -X POST "http://localhost:$PORT/map" \
  -H 'content-type: application/json' \
  -d '{"mapping":"greet","input":{"message":"smoke"}}')"
echo "$result" | grep -q '"text":"smoke"' || fail "/map did not serve the bundled greet mapping: $result"

echo "smoke: container runs as a non-root user"
user="$(docker exec "$CONTAINER" whoami)"
[ "$user" = deno ] || fail "container runs as '$user', expected 'deno'"

echo "smoke: waiting for the container HEALTHCHECK"
for _ in $(seq 1 40); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo unknown)"
  [ "$status" = healthy ] && break
  [ "$status" = unhealthy ] && fail "container HEALTHCHECK reports unhealthy"
  sleep 3
done
[ "$status" = healthy ] || fail "container did not reach healthy in time"

echo "smoke: PASS"
