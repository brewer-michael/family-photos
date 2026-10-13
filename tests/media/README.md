# Media tests

`npm run test:media` runs `tests/media/**/*.test.ts` (vitest project `media`, 10-minute timeouts,
one file at a time). They use the real `heif-dec`/`heif-convert`, `ffmpeg`, `ffprobe` and
`exiftool` binaries; tests that need ffmpeg 7.1-only features skip with a message locally — CI
in the `node:24-trixie-slim` container is the source of truth. Fixtures live in `tests/fixtures/`.

## Photo fixtures

- `tests/fixtures/heif/`: real HEIF/AVIF files from other projects, with their sources and
  licences in `LICENSES.md`.
- `tests/fixtures/photo/`: small generated files (a few KB each), committed so CI needs no
  encoders. Their colours and metadata come from `tests/helpers/photo-fixtures.ts`, which the
  tests also use for their expectations. Regenerate them from the repository root with

  ```
  node tests/fixtures/photo/generate.ts
  ```

  (Node ≥ 22.18 runs the TypeScript directly). It needs `exiftool`, `heif-enc` with the x265 and
  aom encoders (`libheif-plugin-x265`, `libheif-plugin-aomenc`) and an ffmpeg with libjxl,
  libopenjpeg and libaom-av1. It rewrites every fixture; with the same tool versions the output
  is byte-identical, so commit only the files you meant to change.
- **The Display P3 ICC profile is built in code** (`displayP3Icc()` in
  `src/worker/photo/icc.ts`: Display P3 primaries, D65 adapted to D50, the sRGB curve), so it is
  ours to ship rather than a copy of an OS or libvips profile. The lane embeds it in HEIFs that say
  P3 only in their nclx box, and the generator tags `p3.jpg` (and so `p3.heic`) with the same bytes.

Some photo tests depend on the installed libheif: an AVIF image sequence (`sequence.avif`)
converts to its primary still with `heif-dec` (libheif ≥ 1.18) but fails as unsupported with
`heif-convert` (1.17), which refuses that file type; both outcomes are tested. The
`--disable-limits` paths use small wrapper scripts (`photo-tools.test.ts`) instead of a huge file.

## Photo performance

`photo.test.ts` → "performance" encodes a 12 MP and a 48 MP HEIC at `-q 85` (about the size of a
real phone photo: 3.1 MB and 12.5 MB) and converts each in a fresh Node process started like the
photo lane (`--max-old-space-size=512`; `tests/helpers/photo-perf-runner.ts`, bundled with the
worker's Vite config). Peak memory is the process's `VmHWM`, so earlier tests can't inflate it;
it covers Node and sharp but not the decoder, which is measured on its own run. The numbers are
printed (`--silent=false` shows them), not asserted; only the time has a generous ceiling. Without
`heif-enc` and its x265 encoder the two tests skip.

Measured in the 4-core development container (libheif 1.17.6 `heif-convert -d ffmpeg`, sharp
0.35.5 / libvips 8.18.7):

| Photo | Whole conversion | Photo lane peak RSS (idle) | HEIF decoder alone |
|---|---|---|---|
| 12 MP, 3.1 MB | 2.6 s | 173 MB (87 MB) | 1.1 s, 115 MB |
| 48 MP, 12.5 MB | 8.1 s | 391 MB (87 MB) | 4.0 s, 412 MB |

The decoder runs while the lane waits, so a 48 MP photo needs roughly 0.5 GB at the decode step
and 0.4 GB while sharp encodes, plus exiftool (a separate Perl process of about 35 MB). On libheif
1.17 `heif-info` also decodes the image, so the whole conversion includes a second decode.
