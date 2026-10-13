#!/bin/sh
# Container entrypoint (started by tini): logs the CPU and memory share the container got,
# prepares /config and /photos, then runs the app (CMD) as PUID:PGID.
#
# As root (the default):
#   - creates the folders the app uses;
#   - /config (app data, small): chown -R, but only when something in it isn't PUID:PGID yet
#     (first start, or PUID/PGID changed);
#   - /photos (the share, can hold years of files): chowns only /photos and its top-level
#     folders, never recursively;
#   - applies UMASK and drops to PUID:PGID with setpriv, without supplementary groups.
# Started with --user: runs the command as that user unchanged.
set -eu

PUID=${PUID:-99}
PGID=${PGID:-100}
UMASK=${UMASK:-022}
CONFIG_DIR=${CONFIG_DIR:-/config}
PHOTOS_DIR=${PHOTOS_DIR:-/photos}

log() {
	echo "[entrypoint] $*"
}

# Prints a file's first line, or "unknown" when it can't be read.
read_first() {
	head -n 1 "$1" 2>/dev/null || echo unknown
}

# docker --cpu-shares sets cpu.weight (cgroup v2, default 100) or cpu.shares (v1, default 1024).
# Without it, video work takes about half the CPU from Plex whatever its nice value.
log_cgroup() {
	cg=/sys/fs/cgroup
	if [ -r "$cg/cpu.weight" ]; then
		share=$(read_first "$cg/cpu.weight")
		default=100
		log "cgroup v2: cpu.weight=$share cpu.max=$(read_first "$cg/cpu.max") memory.max=$(read_first "$cg/memory.max")"
	elif [ -r "$cg/cpu/cpu.shares" ]; then
		share=$(read_first "$cg/cpu/cpu.shares")
		default=1024
		log "cgroup v1: cpu.shares=$share cpu.cfs_quota_us=$(read_first "$cg/cpu/cpu.cfs_quota_us") memory.limit_in_bytes=$(read_first "$cg/memory/memory.limit_in_bytes")"
	else
		log 'cgroup CPU settings are not visible in this container'
		return 0
	fi
	if [ "$share" -ge "$default" ] 2>/dev/null; then
		log 'Hint: no --cpu-shares is set, so getting videos ready competes for the CPU as hard as Plex and'
		log '      other containers. Add "--cpu-shares=128 --memory=4g" to Extra Parameters (the Unraid template does).'
	fi
}

# Runs a preparation step; a failure (e.g. an NFS share that refuses chown) is logged, not fatal:
# the app then reports exactly which folder it can't write.
try() {
	"$@" || log "Warning: '$*' failed; Family Photos may not be able to write there."
}

# True when $1 is not owned by PUID:PGID.
wrong_owner() {
	[ "$(stat -c %u:%g "$1")" != "$PUID:$PGID" ]
}

case $PUID$PGID in
'' | *[!0-9]*)
	log "PUID ($PUID) and PGID ($PGID) must be numbers, e.g. PUID=99 and PGID=100 on Unraid."
	exit 1
	;;
esac
case $UMASK in
[0-7][0-7][0-7] | [0-7][0-7][0-7][0-7]) ;;
*)
	log "UMASK ($UMASK) must be three or four octal digits, e.g. 022."
	exit 1
	;;
esac
umask "$UMASK"

log_cgroup

if [ "$(id -u)" != 0 ]; then
	exec "$@"
fi

for dir in "$CONFIG_DIR/cache" "$CONFIG_DIR/tmp" "$CONFIG_DIR/outbox" \
	"$PHOTOS_DIR/library" "$PHOTOS_DIR/originals" "$PHOTOS_DIR/.incoming" "$PHOTOS_DIR/.work" "$PHOTOS_DIR/.backups"; do
	try mkdir -p "$dir"
done

if [ -n "$(find "$CONFIG_DIR" \( ! -user "$PUID" -o ! -group "$PGID" \) -print -quit 2>/dev/null)" ]; then
	log "Giving $CONFIG_DIR to $PUID:$PGID"
	try chown -R "$PUID:$PGID" "$CONFIG_DIR"
fi

for dir in "$PHOTOS_DIR" "$PHOTOS_DIR/library" "$PHOTOS_DIR/originals" "$PHOTOS_DIR/.incoming" "$PHOTOS_DIR/.work" "$PHOTOS_DIR/.backups"; do
	if [ -d "$dir" ] && wrong_owner "$dir"; then
		log "Giving $dir (not its contents) to $PUID:$PGID"
		try chown "$PUID:$PGID" "$dir"
	fi
done

log "Starting as $PUID:$PGID with umask $UMASK"
exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups -- "$@"
