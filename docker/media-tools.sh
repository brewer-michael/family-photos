#!/bin/sh
# The media tools of the production image, kept in one place so the Dockerfile and CI's
# media-parity job (.github/workflows/ci.yml) install exactly the same Debian packages.
#
#   media-tools.sh install [extra-package ...]   apt-get install the media packages (+ extras)
#   media-tools.sh check                         exit 1 unless the tools have what the lanes need
#
# `check` fails the image build early. The app repeats a fuller check at every start
# (src/lib/server/selfcheck.ts: decoders, disk space), logs it and shows it on the admin page.
# HEIF_DEC_BIN overrides the HEIF decoder, as it does for the app.
set -eu

# ffmpeg/ffprobe: videos and odd photo formats. exiftool: dates and places.
# heif-dec/heif-info + decoder plugins: iPhone (HEVC) and AVIF photos.
PACKAGES='ffmpeg libimage-exiftool-perl libheif-examples libheif-plugin-libde265 libheif-plugin-dav1d libheif-plugin-ffmpegdec'

fail() {
	echo "media-tools: $*" >&2
	exit 1
}

install_packages() {
	export DEBIAN_FRONTEND=noninteractive
	apt-get update
	# shellcheck disable=SC2086 # word splitting of the package list is intended
	apt-get install -y --no-install-recommends $PACKAGES "$@"
	rm -rf /var/lib/apt/lists/*
}

check_tools() {
	heif_dec=${HEIF_DEC_BIN:-heif-dec}

	filters=$(ffmpeg -hide_banner -filters) || fail 'ffmpeg does not run'
	for f in zscale tonemap sidedata; do
		printf '%s\n' "$filters" | grep -Eq "^ [A-Z.|]{3} $f " || fail "ffmpeg has no $f filter"
	done
	ffmpeg -hide_banner -h filter=sidedata | grep -q AMBIENT_VIEWING_ENVIRONMENT ||
		fail 'ffmpeg sidedata filter cannot remove AMBIENT_VIEWING_ENVIRONMENT (needs ffmpeg 7.1)'

	encoders=$(ffmpeg -hide_banner -encoders)
	for e in libx264 aac; do
		printf '%s\n' "$encoders" | grep -Eq "^ [A-Z.]{6} $e " || fail "ffmpeg has no $e encoder"
	done
	ffprobe -hide_banner -version >/dev/null || fail 'ffprobe does not run'

	decoders=$("$heif_dec" --list-decoders) || fail "$heif_dec --list-decoders failed"
	for d in libde265 ffmpeg dav1d; do
		printf '%s\n' "$decoders" | grep -q "^- $d " || fail "$heif_dec has no $d decoder plugin"
	done
	heif-info --version >/dev/null || fail 'heif-info does not run'

	exiftool_ver=$(exiftool -ver) || fail 'exiftool does not run'

	echo "media-tools: OK: $(ffmpeg -hide_banner -version | head -n 1); $heif_dec $("$heif_dec" --version | head -n 1); exiftool $exiftool_ver"
}

case ${1:-} in
install)
	shift
	install_packages "$@"
	;;
check)
	check_tools
	;;
*)
	fail "usage: $0 install [extra-package ...] | check"
	;;
esac
