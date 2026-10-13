# Media tests

`npm run test:media` runs `tests/media/**/*.test.ts` (vitest project `media`, 10-minute timeouts,
one file at a time). They use the real `heif-dec`/`heif-convert`, `ffmpeg`, `ffprobe` and
`exiftool` binaries; tests that need ffmpeg 7.1-only features skip with a message locally — CI
in the `node:24-trixie-slim` container is the source of truth. Fixtures live in `tests/fixtures/`.
