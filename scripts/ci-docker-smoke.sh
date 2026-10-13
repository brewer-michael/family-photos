#!/bin/sh
# Smoke test for a built image (.github/workflows/docker.yml): starts it the way the Unraid template
# does (required settings, empty /config and /photos, PUID 99 / PGID 100, cpu-shares and memory
# limits, TZ) and checks that it
#   - becomes healthy (the image's HEALTHCHECK) and answers /healthz and the sign-in page,
#   - writes its data as 99:100 and gives /photos' top-level folders to 99:100,
#   - can start both media worker lanes as 99:100 (scripts/smoke-worker.mjs),
#   - has a working time zone and passes the app's media-tools self-check.
#
#   scripts/ci-docker-smoke.sh <image>
set -eu

image=${1:?usage: $0 <image>}
repo=$(cd "$(dirname "$0")/.." && pwd)
name=fp-smoke-$$
tmp=$(mktemp -d)
mkdir "$tmp/config" "$tmp/photos"

fail() {
	echo "SMOKE TEST FAILED: $*" >&2
	exit 1
}

cleanup() {
	status=$?
	if [ "$status" != 0 ]; then
		echo '--- container logs ---'
		docker logs "$name" 2>&1 || true
	fi
	docker rm -f "$name" >/dev/null 2>&1 || true
	# The files belong to 99:100 now; remove them from inside a container instead of needing sudo.
	docker run --rm --entrypoint rm -v "$tmp:/smoke" "$image" -rf /smoke/config /smoke/photos >/dev/null 2>&1 || true
	rmdir "$tmp" 2>/dev/null || true
	exit "$status"
}
trap cleanup EXIT

# Waits up to $1 seconds for the command in the remaining arguments to succeed.
wait_for() {
	limit=$1
	shift
	i=0
	until "$@" >/dev/null 2>&1; do
		i=$((i + 1))
		[ "$i" -lt "$limit" ] || return 1
		sleep 1
	done
}

healthy() {
	[ "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy ]
}

docker run -d --name "$name" \
	--cpu-shares=128 --memory=4g \
	-p 127.0.0.1::3000 \
	-e PUBLIC_URL=http://localhost:3000 \
	-e FAMILY_PASSWORD='smoke test family' \
	-e ADMIN_PASSWORD='smoke-test-admin' \
	-e PUID=99 -e PGID=100 -e UMASK=022 \
	-e TZ=America/Chicago \
	-v "$tmp/config:/config" \
	-v "$tmp/photos:/photos" \
	-v "$repo/scripts/smoke-worker.mjs:/app/scripts/smoke-worker.mjs:ro" \
	"$image" >/dev/null

url="http://$(docker port "$name" 3000/tcp | head -n 1)"
echo "Started $name at $url"

wait_for 120 curl -fsS "$url/healthz" || fail '/healthz did not answer within 2 minutes'
echo 'ok: /healthz answers'

wait_for 120 healthy || fail "the container's HEALTHCHECK did not report healthy within 2 minutes"
echo 'ok: HEALTHCHECK reports healthy'

curl -fsS "$url/login" | grep -q 'name="code"' || fail '/login does not show the family code form'
echo 'ok: /login is served'

for f in config/app.sqlite photos photos/library photos/originals photos/.incoming photos/.work photos/.backups; do
	owner=$(stat -c %u:%g "$tmp/$f") || fail "$f is missing"
	[ "$owner" = 99:100 ] || fail "$f is owned by $owner, not 99:100"
done
echo 'ok: data is owned by 99:100'

for lane in photo video; do
	docker exec -u 99:100 -w /app "$name" node scripts/smoke-worker.mjs "$lane" || fail "the $lane worker lane did not start"
done
echo 'ok: both worker lanes start as 99:100'

case $(docker exec "$name" date +%Z) in
CDT | CST) echo 'ok: TZ is applied' ;;
*) fail 'TZ=America/Chicago is ignored (tzdata missing?)' ;;
esac

wait_for 60 sh -c "docker logs '$name' 2>&1 | grep -q '\[selfcheck\]'" || fail 'the media self-check did not run'
docker logs "$name" 2>&1 | grep -q '\[selfcheck\] media tools OK' || fail 'the media self-check found problems'
echo 'ok: media self-check passed'

if docker logs "$name" 2>&1 | grep -q 'lane exited'; then
	fail 'a worker lane crashed'
fi
echo 'Smoke test passed.'
