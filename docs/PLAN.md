# Family Photos: implementation plan

## Context
The repo is empty apart from the LICENSE (MIT). The user wants one central, private place for an extended family spread across the country to share photos and short videos. It has to be simple enough for anyone aged 5 to 95 with a smartphone.

**Decided with the user:**
- **Hosting:** a Docker container installed from an **Unraid template on their home server**. They will expose it themselves (Cloudflare Tunnel or Nginx Proxy Manager).
- **Access:** a shared **family code** plus **printable QR codes** that sign people straight into the site or into a specific album.
- **Names:** each person is **asked for their first name once** on their device. There are no accounts.
- **Content:** photos and **short videos**, albums, **memories** (journal entries) on photos, and downloading anything.
- **Deletion:** people can't delete. They send a **removal request**, which emails the admin a link plus the reason. The admin approves or dismisses it.
- **Nobody ever picks a format.** HEIC becomes a high-quality JPEG and HEVC becomes a high-quality MP4, automatically on the server. Everyone views and downloads only JPEG, PNG, GIF or MP4.
- **Original files** are **kept as an admin-only archive** (`KEEP_ORIGINALS=true`). **Videos are delivered at high-quality 1080p.**

All work goes on branch `claude/youthful-hypatia-l2cgkm`, committed and pushed per milestone.

## Stack (pin exact versions)
| Area | Choice |
|---|---|
| Web framework | SvelteKit 3.0.x + adapter-node 6, Svelte 5, Vite 8, TypeScript ~6.0.3. Fallback if Kit 3 blocks during M0: Kit 2.x + adapter-node 5 |
| Data | better-sqlite3 (WAL), plain SQL migrations via `PRAGMA user_version` |
| Photos | sharp ^0.35.5; `heif-dec` from Debian trixie libheif 1.19.8 (+ libde265, dav1d and ffmpegdec plugins); exiftool through `exiftool-vendored` with `/usr/bin/exiftool`; `file-type` for magic-byte detection |
| Video | ffmpeg/ffprobe 7.1 (Debian trixie apt) |
| Uploads | `@tus/server` 2.x (`handleWeb`) + `@tus/file-store`, with `tus-js-client` in the browser |
| Other | nodemailer, qrcode, archiver 8 (ZIP64, store) |
| Styling | Plain CSS with design tokens, no Tailwind; static PWA manifest |
| Tests | Vitest; `@playwright/test@1.56.1` (matches the preinstalled Chromium, iPhone viewport forced to Chromium); `@axe-core/playwright` |

Native and WASM modules go in `dependencies`, because Kit 3 bundles devDependencies.

The **media worker** is a separate entry point, `src/worker/main.ts`. A second `vite build --ssr` step builds it to `build-worker/worker.js`. sharp never loads in the web process.

## Key findings that shape the design
- **Plain HTTP breaks SvelteKit's CSRF check.** adapter-node assumes `https` when the proto header is missing, so on plain HTTP (LAN access and e2e tests) form actions and tus POSTs fail it.
  - Fix: a custom **`server.js`** sets `x-forwarded-proto` from the socket when it's missing, then mounts `build/handler.js`.
  - The Dockerfile sets `PROTOCOL_HEADER=x-forwarded-proto` and `BODY_SIZE_LIMIT=64M`.
  - Don't set `ADDRESS_HEADER`. Client IP is `cf-connecting-ip` ?? `x-real-ip` ?? the socket address, but the headers are believed only when the socket peer is a trusted proxy (`TRUSTED_PROXIES`, default loopback/private ranges; the `cloudflare` keyword adds Cloudflare's published ranges for Cloudflare → app directly). Rate limiting keys on both headers at once (IPv6 per /64) plus a global ceiling, because Cloudflare and NPM each pass the *other* header through from the client.
  - Proxy hops: next to a `cf-connecting-ip`, an `x-real-ip` that is a Cloudflare edge or a trusted proxy is skipped (Cloudflare → NPM, cloudflared → NPM), so visitors behind one edge aren't limited together. `cf-connecting-ip` always counts (a Cloudflare address there is a Worker, keyed on its own), and an `x-real-ip` on its own always counts (each LAN device reaching NPM directly has its own key).
  - Browsers with a valid signed device cookie are keyed by device too and have a global ceiling of their own (same size) instead of being exempt, so a stranger flood can't lock the family out, and device ids minted with an old family code can't guess without limit.
- **HEIC/HEVC always arrive at some point.** Desktops, the Files app, Samsung's high-efficiency mode and iPhone videos (usually HEVC, often HDR or Dolby Vision 8.4) all produce them. The server normalizes everything; the client never converts.
- **Two libraries can't be trusted for this:**
  - sharp's prebuilt libvips can't decode HEVC.
  - heic-decode picks the wrong image in multi-image files and drops ICC/EXIF.
  - Decoding is therefore `heif-dec` → 16-bit PNG, which handles the nclx matrix/range, ICC, rotation and EXIF correctly. sharp then encodes the JPEG. libheif's own JPEG writer is avoided because it shifts colours on BT.709 and limited-range sources.
- **Writing metadata to MP4s:**
  - ffmpeg writes Apple metadata keys into the wrong box (`udta/meta`).
  - **exiftool writes `Keys:CreationDate` and GPS** after encoding, so saved videos land on the right date in the camera roll.
- **Nice values don't protect Plex on their own.** Docker gives each container its own cgroup. Without `--cpu-shares=128`, ffmpeg takes about 50% of the CPU from Plex whatever its nice value. This flag is **required in the template's ExtraParams**, alongside `--memory=4g`.
- **The tus GET handler would leak raw uploads** (HEIC/MOV) to anyone who knows the ID. The upload route therefore exports only POST/PATCH/HEAD/OPTIONS, uses a random 128-bit tus token separate from the media ID, and checks uploader ownership on HEAD/PATCH.
- **iOS specifics:**
  - Video playback needs HTTP Range (206) responses.
  - Home Screen web apps have their own cookie jar, so the code is asked for once more.
  - Never list HEIC in `accept` on Apple browsers: Safari 17+ then re-encodes picked JPEGs into HEIC.
- **Installing on Unraid:**
  - Unraid 6.10+ removed template-repo URLs. Install by `wget`-ing the XML into `/boot/config/plugins/dockerMan/templates-user/my-family-photos.xml`.
  - The GHCR package must be made public.
- **Cloudflare limits:**
  - Request bodies are limited to 100 MB, so 50 MiB tus chunks fit.
  - The README notes that Cloudflare's terms restrict heavy video serving and recommends NPM for video-heavy families.

## Configuration
**Unraid template variables:**
- `PUBLIC_URL` (required)
- `FAMILY_PASSWORD` (masked)
- `ADMIN_PASSWORD` (masked)
- `ADMIN_EMAIL`, `ADMIN_NAME`
- `SITE_TITLE`
- `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASS` (masked), `SMTP_FROM`
- Advanced: `KEEP_ORIGINALS` (true), `MAX_UPLOAD_GB` (50), `MAX_VIDEO_MINUTES` (120), `VIDEO_THREADS` (auto: max(2, cores/2)), `TRUSTED_PROXIES` (private; IPs/ranges, `private`, `cloudflare` or `none`), `PUID` (99), `PGID` (100), `UMASK` (022)
- **ExtraParams** (required): `--cpu-shares=128 --memory=4g`
- TZ is injected by Unraid.

**Dockerfile-only `ENV`:** `PORT=3000`, `PROTOCOL_HEADER`, `BODY_SIZE_LIMIT=64M`, `CONFIG_DIR=/config`, `PHOTOS_DIR=/photos`, `UV_THREADPOOL_SIZE=8`.

**Email:** with no `SMTP_HOST`, emails go as `.eml` files to `/config/outbox`. This is also the test mode. TLS is used when the port is 465.

## Storage layout
```
/photos/  (array share)
  library/<sh>/<id>.<jpg|png|gif|mp4>   canonical file: the only full-size file anyone views or downloads
  originals/<sh>/<id>.<heic|mov|dng|…>  archived source, admin only (KEEP_ORIGINALS)
  .incoming/<token>(+.json)             tus partials (same filesystem → atomic rename)
  .work/<id>/                           canonical output before verify + rename
  .backups/app-YYYY-MM-DD.sqlite        nightly db.backup(), keep 7
/config/  (keep on the cache/SSD pool)
  app.sqlite (+wal/shm)
  cache/<sh>/<id>/{thumb,display,poster}.webp   rebuildable from library/ (missing ones are rebuilt at startup and from the admin page)
  tmp/<id>/                             decoded intermediates
  outbox/*.eml
```
`<sh>` is the last two characters of the ULID.

Commit order for each item:
1. Write the output.
2. Verify it.
3. fsync.
4. Rename into `library/`.
5. Run the DB transaction.
6. Archive or delete the source.

Each job runs in try/finally, which cleans up its tmp and work directories. Startup clears `/config/tmp` and `/photos/.work` and requeues interrupted jobs. A sweep removes orphaned `.incoming` files older than 48 h.

## Data model (`001_init.sql`)
- **`settings(key, value)`**: `secret`, `access_gen`.
- **`albums`**: `id`, `title`, `when_text`, `description`, `cover_media_id`, `created_by_name/device`, timestamps, `deleted_at`.
- **`media`**:
  - Identity and placement: `id` (ULID), `upload_token` (UNIQUE; set to NULL after intake), `album_id`, `uploaded_by_name`, `uploaded_by_device`.
  - Type and status: `kind` (photo or video), `status` (received, queued, processing, ready, failed or duplicate), `attempts`, `error_code` (retryable, unsupported, corrupt or too_large), `error_detail`, `pipeline_version`.
  - Source: `source_name`, `source_mime`, `source_size`, `source_sha256`, `source_kept`, `client_mtime_ms`.
  - Canonical result: `conversion` (none, remux or transcode), `canonical_ext` (jpg, png, gif or mp4), `canonical_size`, `width`, `height` (as displayed), `duration_ms`.
  - Conversion flags: `hdr_tonemapped`, `audio_dropped`, `slowmo_retimed`, `est_cost_s`, `queued_ms`.
  - Date and place: `taken_at` (local time + offset), `taken_ms` (UTC; sort key), `gps_lat/lon/alt`.
  - Links and lifecycle: `content_id` (Apple), `live_photo_of`, `duplicate_of`, `created_at`, `deleted_at`, `deleted_reason`.
  - `UNIQUE(album_id, source_sha256)`, plus indexes for the album view, the queue and Live Photo pairing.
- **`memories`**: `id`, `media_id`, `author_name`, `author_device`, `body` (1–5000 characters), timestamps.
- **`deletion_requests`**: `id`, `media_id`, `requester_name/device`, `reason`, `status` (pending, approved or dismissed), `email_status` (pending, sent, saved or failed), `email_error`, timestamps.

On first boot the app seeds `secret`, sets `access_gen=1` and creates the **"Everyday Photos"** album.

## Code layout
```
server.js  vite.config.ts  vite.worker.config.ts  Dockerfile  docker/entrypoint.sh  unraid/family-photos.xml
.github/workflows/ci.yml  static/{robots.txt,manifest.webmanifest,icons/}  docs/media-pipeline.md
src/app.css  src/hooks.server.ts
src/lib/server/ config.ts  db/  repo/{settings,albums,media,memories,requests}.ts  auth.ts  ratelimit.ts
                uploads/tus.ts  intake.ts  queue.ts (spawns/IPC to worker lanes)  serve.ts  zip.ts  mail.ts
                maintenance.ts  disk.ts  filenames.ts
src/lib/media/allowlist.ts         shared: server allowlist → desktop accept string
src/worker/ main.ts  detect.ts  photo.ts  heif.ts  raw.ts  video-probe.ts  video-plan.ts  video-run.ts
            exif.ts  verify.ts
src/lib/client/uploader.svelte.ts  save.ts (Web Share / download)
src/lib/components/{Button,AlbumCard,MediaGrid,Uploader,Viewer,MemoryList,RemoveDialog,SaveButton}.svelte
tests/{unit,e2e,media}/  tests/fixtures/{heif (vendored + LICENSES.md), generated}/
```

## Routes
| Route | Who | Purpose |
|---|---|---|
| `/login` | public | Family code entry, rate-limited to 10 failures per 15 min per IP |
| `/join/[token]` | public | QR landing: sets the cookie, then `/name?next=…` or straight to the album (token stripped) |
| `/name` | family | "What should we call you?" |
| `/` | family | Big **Add photos & videos**, "New photos", album cards, **New album** |
| `/add`, `/album/new`, `/album/[id]` | family | Pick/create album + Uploader. Album grid with "Show more" paging. Creator or admin can edit |
| `/album/[id]/download` | family | Desktop only: streamed ZIP of canonical files, friendly names, `memories.txt`. Phones get "Save all" instead |
| `/view/[id]` | family | Viewer: Save to my phone, Write a memory, Ask to remove, memories list, prev/next |
| `/media/[id]/[variant]` | family | `thumb`, `display`, `poster`, `file` (canonical; `?dl=1`). Range/206, ETag `"<id>-<pipeline_version>"`, private immutable caching, Last-Modified = taken date |
| `/api/upload/[...path]` | family | tus: POST/PATCH/HEAD/OPTIONS only (GET/DELETE → 405, method-override → 400) |
| `/api/status?ids=` | family | `{id, status, pct?, queuePos?, posterUrl?, duplicateOf?}` |
| `/admin` | admin | Pending requests, failed items, email banner, test email, storage + archive size, **Reset access** |
| `/admin/requests/[id]` | admin | POST-only **Remove** (to trash), **Move to album**, **Dismiss** |
| `/admin/trash` | admin | Restore; auto-purge after 30 days |
| `/admin/qr` | admin | Printable QR cards: whole site + one per album |
| `/admin/original/[id]` | admin | Archived source as an attachment (`octet-stream`, CSP sandbox) |
| `/healthz` | public | DB ping |

**`hooks.server.ts`:**
- `init` (guarded):
  - validates config and runs migrations;
  - runs the media self-check, using each lane's own detection (the video lane's ffmpeg capabilities: libx264, zscale, tonemap, sidedata; the photo lane's HEIF decoder, its plugins and heif-info) plus ffprobe, the video/AAC decoders, `exiftool -ver` and free space;
  - starts the worker lanes and daily maintenance.
- `handle`:
  - auth and name redirects, validating `next` against open redirects;
  - the admin gate;
  - headers: `noindex`, `nosniff`, `Referrer-Policy`, `frame-ancestors 'none'`, plus Kit's CSP.

## Access, QR codes and names (`auth.ts`)
- **Cookies.** Two HMAC-signed, HttpOnly, SameSite=Lax cookies lasting 400 days; `Secure` is set when the request is over https.
  - `fp_access` `{role, v, iat}`: `v` = `HMAC(secret, 'fam:'+norm(code)+':'+gen)`. Re-issued when it's more than 7 days old.
  - `fp_device` `{deviceId, name}`: survives access resets.
- **Forgiving family code:** NFKC, trimmed, lowercased, spaces collapsed. Recommend a three-word code.
- **Join token:** `HMAC(secret,'join:'+norm(code)+':'+gen)`, truncated.
- **Revoking access:** changing the code in Unraid, or **Reset access** (`gen++`), invalidates every cookie and printed QR code. Nothing needs storing.

## Media normalization (full spec → `docs/media-pipeline.md`)
The full spec is the workflow output at `/tmp/claude-0/-home-user-family-photos/fef07327-1cfb-5bb3-aa3e-3cb776218645/tasks/wy5sw4izt.output` (`result.final`). It holds the exact argument arrays, the remux criteria, the fixture list and the assertions. Commit it into the repo as `docs/media-pipeline.md` during M4, adjusted for the two decisions above: no 4K opt-in, and `KEEP_ORIGINALS=true`.

**Format rules.** Everything is detected from the file's bytes, never from its extension.

| Input | Canonical file (viewed and downloaded) |
|---|---|
| JPEG (RGB or grey) | Original bytes (`none`). CMYK JPEG → sRGB JPEG |
| HEIC/HEIF/AVIF (incl. sequences: primary still) | **JPEG q92**, or PNG if it has real transparency |
| PNG, GIF (incl. animated) | Original bytes. PNG with EXIF rotation → losslessly rotated PNG |
| WebP | Lossy → JPEG; lossless or transparent → PNG; animated → GIF |
| TIFF, BMP, JXL, JP2, PSD | JPEG (PNG if transparent; BMP → PNG), decoded with ffmpeg |
| RAW (DNG/ProRAW/CR2/CR3/NEF/ARW/…) | Largest embedded JPEG preview (≥1600 px) with tags copied; otherwise `unsupported` |
| H.264 8-bit 4:2:0 SDR within the remux rules (≤1080p box, ≤60 fps, level ≤4.2, ≤20 Mbps) | **MP4 remux** + faststart; audio copied if AAC-LC ≤2 ch, otherwise AAC |
| HEVC (SDR/HLG/PQ/Dolby Vision 8.x), VP8/9, AV1, ProRes, MPEG-2/4, DV, MJPEG, WMV, other H.264 | **MP4: H.264 High 8-bit BT.709, fitted to 1920×1080 (either orientation), AAC-LC ≤2 ch** |
| Live Photo `.MOV` matching a photo's ContentIdentifier | Transcoded, linked via `live_photo_of`, hidden from grids and ZIPs |
| SVG, PDF, Dolby Vision profile 5, undecodable files | `failed/unsupported`: the source is kept, the admin is alerted, and the uploader sees friendly copy |

**Photo pipeline** (worker child process; photo lane is FIFO at nice 10):
1. Detect the type: `file-type` plus ISOBMFF brand/WebP/APNG overrides. A mislabelled `.heic` that's really a JPEG goes the JPEG route.
2. Decode HEIF with `heif-info` (find the primary), then `heif-dec -d ffmpeg` → PNG in `/config/tmp/<id>/`. Fall back to libde265/dav1d. Timeout 180 s, doubled for multi-image files.
   - If an image is P3 tagged only by nclx (no ICC), embed the Display P3 ICC.
3. sharp, with `autoOrient`:
   - `keepIccProfile()` for RGB sources (CMYK/grey are converted to sRGB) and `keepExif()`.
   - Then `.jpeg({quality:92, chromaSubsampling:'4:2:0', optimiseCoding:true})`, or `.png()` if there's real transparency.
   - Orientation is applied exactly once. XMP is dropped.
4. Metadata via exiftool from the **source**: date (DateTimeOriginal+offset → CreateDate → XMP → client mtime → upload time), GPS, ContentIdentifier.
5. Derivatives come from the canonical file:
   - `display.webp`: 2048 box, q82, ICC kept, date-only EXIF.
   - `thumb.webp`: 480 box, q76.

**Video pipeline** (worker child process; video lane at nice 15, ordered by `est_cost_s − 0.5×wait_s`):
1. Probe and plan:
   - ffprobe JSON; pick the largest non-attached-pic video stream.
   - Audio: the first decodable non-APAC stream, preferring AAC. If none is usable, set `audio_dropped`.
   - Displayed size accounts for SAR and rotation; output is even dimensions fitted to 1920×1080.
   - Slow motion (≥100 fps with Apple playback-intent=0) → retimed to 30 fps with an atempo chain. Otherwise >60 fps → 60. Otherwise passthrough.
   - HDR class: PQ, HLG, DV (by compatibility id; profile 5 → unsupported), WCG or SDR. Interlaced → bwdif.
2. Encoder settings:
   - `libx264 -preset medium -crf 18 -profile:v high`, with explicit `-level:v` 4.0/4.2.
   - VBV maxrate from a pixel-rate formula (bufsize = 2×).
   - `-g 2×fps -x264-params aq-mode=3 -pix_fmt yuv420p`, bt709 tags, `-color_range tv`.
   - `-map_metadata -1`, plus `creation_time`; `+faststart`; `-threads/-filter_threads VIDEO_THREADS`.
   - Measured cost: about 3.5 min of encoding per minute of 4K60 HDR on 4 vCPU. Output about 60–110 MB/min.
3. Colour paths:
   - SDR: `scale` with explicit in/out matrix and range.
   - WCG: zscale 2020→709.
   - HDR: `zscale (tin=HLG|PQ, linear, npl=100) → gbrpf32le → zscale p=bt709 → tonemap=mobius:desat=0:peak=… → zscale bt709 limited, dither → yuv420p`, then `sidedata=delete` for mastering/CLL/ambient data. Mobius, not hable; no GPU.
4. Poster: a frame from about min(1 s, 10%) through the same colour chain plus `thumbnail=n=24`, piped to sharp → `poster.webp` and `thumb.webp`. It's generated first, so tiles show a picture early.
5. exiftool post-step (required) writes `Keys:CreationDate` (with offset) and `Keys`/`UserData` GPS from the DB.
6. Verify, then commit:
   - one h264 yuv420p track, level ≤4.2, AAC-LC ≤2 ch at 44.1/48 kHz;
   - bt709 with no rotation, mastering or Dolby Vision data;
   - duration within ±max(0.1 s, 2%);
   - moov before mdat.
7. Progress: `-progress pipe:1` → IPC → an in-memory map → `/api/status` "Getting your video ready… 40%".

**Resilience:**
- Each lane is a child process with `--max-old-space-size=512`.
- `attempts++` happens in the same transaction as `processing`. After 3 attempts the item is `failed` and the admin is alerted.
- Timeouts:
  - photo job 300 s (600 s if over 100 MP), with SIGKILL and respawn;
  - ffmpeg stall 180 s with no progress → SIGTERM, then SIGKILL;
  - hard cap `120 s + 30×duration`.
- Space checks: tus creation needs free space ≥ 2×size + 2 GiB; each job needs ≥2 GiB free on `/config`.
- Dedupe is on `source_sha256` per album, computed in the intake step after the upload completes, never inside the request.

**Source retention:** with `KEEP_ORIGINALS=true`, every `transcode` (and any remux that dropped or re-encoded a stream) moves the source to `/photos/originals/`.
- `none`/lossless remux: the source *becomes* the canonical file.
- Failed items always keep their source.
- Admin tools: archive size with "Delete all archived originals", per-item "Download original", and "Reprocess items below pipeline version N".
- Storage: about 85 GB/yr instead of about 35 GB/yr for a heavy-use family.

## Uploader UX
- **`accept` attribute:**
  - `image/*,video/*` on Apple browsers and Android (never HEIC on Apple; wildcards keep Android in its Photo Picker).
  - Desktop adds the server allowlist's extensions so no format is hidden.
  - Never `capture`. No client-side conversion, resizing or hashing.
- **Instant tiles** on `change`, with icon + filename.
- **Photo previews** via `createImageBitmap` (on iOS one at a time, ≤8 MB). If decoding fails, the placeholder stays silently. Videos show a placeholder until the server poster is ready.
- **tus-js-client:** `chunkSize` 50 MiB, retry delays `[0,1e3,3e3,5e3,1e4,2e4,6e4]`, resume via fingerprint, metadata `{filename, lastModified, albumId}`. Two files in parallel, a Screen Wake Lock, and "Keep this screen open until it says Done."
- **Copy never mentions formats.** Examples:
  - "Sending 3 of 12…"
  - "Getting it ready…"
  - "Getting your video ready… 40%: videos can take a few minutes. You can leave this page."
  - "Waiting its turn (2 ahead)"
  - "✓ Added"
  - "✓ Already in this album"
  - "This one didn't work. [Try again]" (retryable)
  - "We couldn't add this one. Michael has been told." (otherwise)

## Downloads
- **Every download path serves only the canonical JPEG/PNG/GIF/MP4.**
- **Filenames:**
  - `IMG_1234.HEIC → IMG_1234.jpg`.
  - Generic names (`image`, `trim.*`, UUIDs) become `Photo_YYYY-MM-DD_HH-MM-SS.jpg`.
  - RFC 5987 `filename*`.
- **Save to my phone:**
  - **iOS:** `navigator.share({files:[new File([blob], name, {type, lastModified: taken_ms})]})`.
    - Photos ≤3 MB are prefetched after the photo has been open 1.5 s (not in save-data mode).
    - Larger files use two taps: "Getting it ready… 45%", then "Tap to save".
    - Videos over 250 MB fall back to a plain download.
  - **Android/desktop:** `<a download>`.
- **Long-press / right-click** on the viewer image opens the Save sheet, so people always get the full-quality canonical file rather than the WebP preview.
- **Albums:** desktop gets a streamed STORE ZIP64 of canonical files (entries dated to `taken_at`, name clashes as `(2)`, plus `memories.txt`). Phones get "Save all": iOS shares in batches of 10, Android downloads one file every 500 ms.

## Removal requests
1. **Dialog:**
   - Reason chips: "I'm in it and don't want it shared", "Blurry or duplicate", "Wrong album", "Something else" (requires text).
   - Reassurance: "Nothing is deleted yet — Michael will look at it."
   - One pending request per device per item.
2. **Store first, then email asynchronously:**
   - Subject: `Removal request: photo in "Retreat 2023" from Aunt Linda`.
   - Escaped text + HTML body.
   - 600px **JPEG** inline CID thumbnail.
   - Links to `PUBLIC_URL/view/<id>` and `PUBLIC_URL/admin/requests/<rid>`.
   - `email_status` is recorded; the admin can resend.
3. **Approve/dismiss are POST-only** on the review page, so email link scanners can't act. Failed media also alerts the admin by email, batched at most hourly.

## Permissions
- **Anyone** can add photos, create albums and write memories.
- **Memory authors** (by device) can edit or delete their own memories.
- **Album creators** can edit the title and description.
- **Admin only:** delete or move items, delete albums, restore, download originals, reprocess.

## UX rules for ages 5–95
- 18px+ rem type that respects iOS text size, and tap targets ≥56px.
- Icon **+ word** labels. Visible ← → buttons; swipe is an extra. Controls in the bottom thumb zone, with "← Back to album".
- Never disable pinch-zoom; reduced motion respected; axe reports zero serious or critical issues.
- "Family code", not "password": a visible field with `autocapitalize=off`.
- "Not Linda?" link. Add-to-Home-Screen tip with the iOS note.
- Only the uploader and the admin see unfinished tiles.

## Packaging
- **`Dockerfile`** (`node:24-trixie-slim`, two stages):
  - Build stage: `npm ci`, `npm run build` (app + worker), `npm prune --omit=dev`.
  - Runtime stage installs `ffmpeg libimage-exiftool-perl libheif-examples libheif-plugin-libde265 libheif-plugin-dav1d libheif-plugin-ffmpegdec tini tzdata ca-certificates`.
  - Build-time sanity check: zscale, libx264 and the heif decoders exist.
  - `VOLUME /config /photos`, `EXPOSE 3000`, `HEALTHCHECK` on `/healthz`.
  - `ENTRYPOINT ["tini","--","/entrypoint.sh"]`, `CMD ["node","server.js"]`.
- **`docker/entrypoint.sh`:**
  - As root: chown `/config` only when ownership differs.
  - Create the `/photos` subdirectories and chown them non-recursively.
  - Apply `umask`, then `exec setpriv --reuid=$PUID --regid=$PGID --clear-groups`.
  - At startup, log the cgroup `cpu.weight` and `cpu.max`.
- **`unraid/family-photos.xml`:**
  - `<Container version="2">` with Repository `ghcr.io/brewer-michael/family-photos:latest`, WebUI `http://[IP]:[PORT:3000]/`, Overview, Icon, TemplateURL and Category.
  - **ExtraParams** `--cpu-shares=128 --memory=4g --restart=unless-stopped`.
  - Paths: `/config` → `/mnt/user/appdata/family-photos` (cache), `/photos` → `/mnt/user/family-photos`.
  - The variables above, with Mask and Required set.
- **CI:**
  - `ci.yml` runs in a `node:24-trixie-slim` container with the same apt packages as production: check, vitest (including the media suite), build, Playwright e2e.
  - Its `image` job: buildx amd64, smoke-test `/healthz`. Its `publish` job (`main` and `v*` tags, never pull requests) runs only after every other job passed and pushes that smoke-tested image, not a rebuild, to GHCR (`latest`, semver, sha).
- **`README.md`:**
  - Unraid install; first-run checklist; make the GHCR package public.
  - Cloudflare Tunnel vs Nginx Proxy Manager (`client_max_body_size ≥ 64m`).
  - SMTP examples, printing QR codes, backups, and the real-device QA checklist.

## Milestones (commit and push each)
The local sandbox is Ubuntu 24.04 with ffmpeg 6.1 and no heif-dec or exiftool.
- For local media tests, try `apt-get install libheif-examples libheif-plugin-libde265 libheif-plugin-x265 libimage-exiftool-perl`.
- Media tests that need ffmpeg 7.1 features (e.g. sidedata ambient deletion) skip with a message locally. **CI in the trixie container is the source of truth.**

Each milestone lists its work, then **Verify:**.

0. **Scaffold:** Kit 3 + TypeScript, pinned dependencies, `server.js`, worker build entry, `/healthz`, Vitest/Playwright config.
   **Verify:** `npm run check && npx vitest run && npm run build`, `node server.js`, and `curl /healthz`.
1. **Config, DB, auth:** `/login`, `/join`, `/name`, admin login, rate limit, hooks.
   **Verify:** unit tests for signing/tampering, normalization, invalidation and the rate-limit window. e2e over plain HTTP:
   - code → name → home (the CSRF fix works);
   - the QR URL lands on the album;
   - the 11th wrong attempt gets a 429.
2. **Shell and albums:** tokens, layout, home, create/edit album.
   **Verify:** e2e creates an album; axe is clean on login, name, home and album.
3. **Uploads and intake:** tus route hardening, Uploader, intake (hash/dedupe/detect/ffprobe), status API.
   **Verify:**
   - 120 MB upload in 50 MiB chunks: abort, resume, byte-identical result;
   - GET/DELETE → 405; method-override → 400; another device's HEAD/PATCH → 403;
   - oversize and low-disk uploads rejected; a duplicate upload → `duplicate`.
4. **Photo lane:** detect, heif-dec, sharp JPEG/PNG, RAW previews, ffmpeg-decoded oddities, exiftool metadata, derivatives, worker child process and retries. Commit `docs/media-pipeline.md`.
   **Verify:**
   - Fixtures: vendored HEIF (pillow_heif, BSD-3: `arrow.heic`, `zPug_3.heic`, 10-bit, RGBA, corrupt; exifr `heic-iphone7.heic`, MIT) and generated ones (8 orientations as JPEG and HEIC, P3, BT.709-limited, P3-nclx, CMYK, WebP variants, TIFF/BMP/JXL, mislabelled files, PDF/SVG).
   - Assertions:
     - quadrant colours correct for all 8 orientations;
     - ΔE2000 < 2 on the colour patches;
     - ICC reads "Display P3";
     - date, GPS and Make/Model preserved;
     - the primary image is chosen; a broken image → `corrupt`, with no retry loop;
     - an injected worker crash → attempts go up → `failed` while the site stays up.
5. **Video lane:** probe/plan, remux, SDR/WCG/HDR transcode, slow-mo, poster, exiftool Keys, verify, progress, cost ordering.
   **Verify:**
   - Generated fixtures F1–F19 from the spec:
     - HLG portrait 4K60 with extra tracks;
     - PQ HDR10; H.264 remux with an identical stream hash; PCM→AAC;
     - 240 fps slow-mo; VFR; no audio; DV; MJPEG/AVI; WMV; VP9/AV1;
     - MPEG-2 1080i 5.1; ProRes HLG; SAR 4:3; odd dimensions; truncated file;
     - the tone-map grey-level check (luma 205–228).
   - Every output passes the verify rules, and exiftool reads back CreationDate and GPS with moov still before mdat.
6. **Viewer, memories, downloads:** viewer, Range serving, Save to my phone, "Save all", ZIP.
   **Verify:**
   - e2e with two browser contexts covers memory edit permissions;
   - prev/next works;
   - download filename is `IMG_xxx.jpg` with no HEIC anywhere;
   - Range → 206;
   - `zipinfo` shows the names, `memories.txt` and no hidden Live Photo files.
7. **Removal requests, email, admin, trash, QR, Reset access, originals archive.**
   **Verify:**
   - e2e request → `.eml`, checking the subject, links and an `image/jpeg` CID part;
   - approve → hidden → in trash → restore;
   - Reset access kills the old session and the old QR code;
   - `/admin/original` → 403 for family users.
8. **Packaging:** Dockerfile, entrypoint, Unraid XML, workflows, README.
   **Verify:** `xmllint --noout unraid/family-photos.xml`; CI green including the docker smoke job; the image is pullable from GHCR anonymously.
9. **Hand-off release gate** (manual, in the README checklist):
   - iPhone (iOS 17/18): HEIC photo → JPEG and HDR/Dolby Vision video → MP4 both look right; both save to the camera roll on the **taken date**; slow-mo, spatial-audio and ProRAW samples work.
   - Android: saves and plays an iPhone video.
   - Windows Photos: opens the JPEG and the MP4.
   - Cloudflare/NPM: a 500 MB upload succeeds.

## Out of scope for v1
- 4K delivery (the originals archive allows reprocessing later)
- Hardware transcoding (VAAPI/QuickSync)
- HDR tone mapping for HDR still photos
- Multi-select download, memories feed, search, people tagging, family email notifications
