# Media pipeline specification

> **How to read this document.** It was produced by the research and critique workflow and is the detailed spec for the photo and video workers. Where it disagrees with the decisions below, the decisions win:
>
> - **No 4K option.** Ignore `VIDEO_MAX_LONG_EDGE`, `has_play` and `.play.mp4`. Videos are always fitted to a 1920×1080 box, in either orientation. 4K detail stays only in the archived original.
> - **`KEEP_ORIGINALS` defaults to `true`.** Only the admin can see archived originals.
> - **There are no user accounts.** Wherever this spec says `uploader_id` / `people(id)` / `session.userId`, read it as the device identity: `uploaded_by_device` (the random deviceId from the `fp_device` cookie) plus `uploaded_by_name`. The tus ownership check compares `metadata.device` with the requesting deviceId.
> - **The authoritative schema** is `src/lib/server/db/migrations/001_init.sql`. It follows the "Data model" in `docs/PLAN.md`, which adds `deleted_at` / `deleted_reason` (soft delete / trash) on top of the columns listed here.
> - **HEIF decoder binary.** libheif ≥ 1.18 (Debian trixie, production) ships `heif-dec`; libheif 1.17 (Ubuntu 24.04, local dev) ships `heif-convert` with the same core flags. Detect it at startup: prefer `heif-dec`, fall back to `heif-convert`. `HEIF_DEC_BIN` overrides the choice.
> - **SVG uploads are rejected** as `unsupported` ("That one isn't a photo or video"). They are not rasterised, which removes the security surface. The table below says SVG is rasterised; ignore that.


**Principle.** Nobody who uploads or views ever chooses a format or sees a format name. Each item has exactly **one canonical file**, and it is always JPEG, PNG, GIF or MP4. That file is what the viewer plays, what "Save to my phone" saves, what album ZIPs contain, and what derivatives are built from. The uploaded source is at most an archive that only the admin can reach.

Confidence tags: **[H]** high, **[M]** medium, **[L]** low.

---

## 1. Format rules

The type always comes from the file's bytes, never from its extension or `file.type` (detection rules in §2).

**Encoding rule:**
- A lossy source without real transparency becomes **JPEG q92**.
- A lossless source, or one with real transparency, becomes **PNG**. Transparency is never flattened.
- Exception: TIFF becomes JPEG. TIFFs are usually scans, JPEG keeps them a sensible size for phones, and the source is archived anyway.
- "Real transparency" means `hasAlpha && !stats().isOpaque`.

| Input (detected from bytes) | Canonical file (stored, viewed, downloaded) | `conversion` | Derivatives (`/config/cache`) |
|---|---|---|---|
| JPEG (RGB or grey) | **Original bytes**. Keeps EXIF orientation, the Ultra HDR gain map and the Motion Photo video tail | `none` | `thumb.webp`, `display.webp` |
| JPEG in CMYK/YCCK | JPEG q92, converted to sRGB | `transcode` | same |
| HEIC/HEIF (HEVC), AVIF, HEIF-wrapped AVIF | JPEG q92, or PNG if real transparency | `transcode` | same |
| HEIF/AVIF sequences (`avis`, `msf1`, `hevc` brands) | Still of the primary image → JPEG q92 | `transcode` | same |
| PNG (8 or 16-bit, APNG) | **Original bytes**. If EXIF Orientation ≠ 1, a lossless PNG with the pixels rotated | `none` / `transcode` | same; APNG thumbnail from frame 0, and the viewer shows the canonical file |
| GIF (still or animated) | **Original bytes** | `none` | thumbnail from frame 0; the viewer shows the canonical file when animated |
| WebP, lossy still | JPEG q92 | `transcode` | same |
| WebP, lossless (`VP8L`) or with transparency | PNG | `transcode` | same |
| WebP, animated | GIF | `transcode` | thumbnail from frame 0 |
| TIFF (page 0) | JPEG q92, or PNG if real transparency | `transcode` | same |
| BMP | PNG | `transcode` | same |
| JPEG XL, JPEG 2000, PSD (flattened composite) | JPEG q92, or PNG if transparency (decoded by ffmpeg) | `transcode` | same |
| RAW: DNG/ProRAW, CR2, CR3, NEF, ARW, RAF, ORF, RW2 | Largest embedded JPEG preview (long edge must be ≥ 1600), with the RAW's tags copied in. Otherwise the item fails as `unsupported` | `transcode` | same |
| SVG (≤ 5 MB) | Rasterised PNG, long edge ≤ 4096. The SVG itself is never canonical and never served inline | `transcode` | same |
| H.264 8-bit 4:2:0 SDR that passes the remux rules (§3), in any container | MP4 remux with `+faststart`. Audio is copied, or re-encoded to AAC | `remux` | `poster.webp`, `thumb.webp` |
| HEVC (SDR, HLG, PQ, Dolby Vision 8.1/8.4), VP8/VP9/AV1, ProRes, MPEG-2/4, H.263, DV, MJPEG, WMV/VC-1, or H.264 outside the remux rules | MP4: H.264 High 8-bit, BT.709 SDR, fitted to 1920×1080 (either orientation), AAC-LC with at most 2 channels | `transcode` | same |
| Live Photo `.MOV` that matches a photo's ContentIdentifier | Transcoded as above. Linked with `live_photo_of` and hidden from the feed and ZIPs | `transcode` | same |
| Dolby Vision profile 5, no decodable video track, PDF/HTML/ICO/anything else | Rejected as `failed/unsupported`. The source is kept for the admin | — | — |

---

## 2. Photo conversion

### Detection (photo or video, and which route)
- Read the first 4,100 bytes with `file-type` 22.1.1, then apply these overrides:
  - **ISOBMFF major brand** in {`heic heix heim heis hevc hevx hevm hevs mif1 mif2 msf1 miaf MiHE MiHB MiHA avif avis`} → HEIF route.
  - Major brand in {`qt  `, `isom`, `iso2`, `mp41`, `mp42`, `M4V `, `3g*`} → video.
  - Any other brand: HEIF if a compatible brand is a HEIF brand, otherwise video. `crx` → RAW.
- **WebP:** chunk `VP8L` means lossless. In `VP8X`, flag 0x10 means transparency and 0x02 means animated.
- **APNG:** an `acTL` chunk before `IDAT`. TIFF-based RAW formats are identified by file-type.
- **Mislabelled files go to the right place:** a `.heic` that is really a JPEG takes the JPEG route, and a `.jpg` that is really HEIC goes to `heif-dec`.

### Container packages (replace heic-decode and exifr)
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libimage-exiftool-perl \
      libheif-examples libheif-plugin-libde265 libheif-plugin-dav1d libheif-plugin-ffmpegdec \
 && rm -rf /var/lib/apt/lists/*
```
- **Debian trixie libheif is 1.19.8** [H]. Why not sharp or heic-decode:
  - sharp's prebuilt libvips is built with `-DWITH_LIBDE265=0`, so it can never decode HEVC itself [H].
  - **heic-decode is dropped.** It returns the wrong image when a file holds several (file `zPug_3.heic`), it drops ICC and EXIF, and it decodes synchronously in WASM.
- **exiftool replaces exifr** for every metadata read and write. It is driven through `exiftool-vendored` in `-stay_open` mode with `exiftoolPath: '/usr/bin/exiftool'`. One tool covers HEIC, JPEG, RAW, Apple MakerNote `ContentIdentifier` and QuickTime Keys.
- **sharp `^0.35.5`** (latest, 2026-09-27) [H] ([npm](https://www.npmjs.com/package/sharp)).

### HEIF decode (always to PNG, never `heif-dec … out.jpg`)
```
heif-info SRC                      # parse /^image: (\d+)x(\d+) \(id=(\d+)\)(, primary)?$/ → count of top-level images, which one is primary
heif-dec -d <ffmpegId> --quiet --png-compression-level 1 SRC /config/tmp/<id>/dec.png
   # if that fails → run again without -d (libde265 for HEVC, dav1d for AV1)
   # output: dec.png (one image) or dec-<k>.png (k = 1-based position of the primary)
   # timeout 180 s, or 360 s if there is more than one top-level image
   # "Security limit exceeded" → one retry with --disable-limits, only if W×H ≤ 250 MP and the file is ≤ 100 MB
```
- **Decoder IDs.** Read them from `heif-dec --list-decoders` at startup. Fail fast if libde265 or dav1d is missing.
- **Decoder order: ffmpegdec first.** It picks up Debian's ffmpeg security updates [M]. CI runs every HEIF fixture with both decoders; if ffmpegdec doesn't match libde265 on any fixture, libde265 goes first instead.
- **Why PNG and not heif-dec's JPEG writer.** libheif's JPEG writer copies the YCbCr planes straight in as JFIF (BT.601, full range). BT.709 or limited-range sources come out with lifted blacks and a hue shift [H] ([encoder_jpeg.cc](https://github.com/strukturag/libheif/blob/v1.19.8/heifio/encoder_jpeg.cc), [context.cc](https://github.com/strukturag/libheif/blob/v1.19.8/libheif/context.cc)).
- **What the PNG route does right** [H]:
  - Converts colour using the file's nclx matrix and range.
  - Applies rotation, mirroring and crop (irot/imir/clap).
  - Writes the ICC profile into the PNG (iCCP) and EXIF into the PNG (eXIf) with **Orientation forced to 1**.
  - Writes 10-bit sources as 16-bit PNG.
- **heif-dec decodes every top-level image** and exits on the first failure ([heif_dec.cc](https://github.com/strukturag/libheif/blob/v1.19.8/examples/heif_dec.cc)) [H]. If a non-primary image is corrupt, the item fails cleanly as `corrupt`: the source is archived, the admin is notified, and the uploader gets no retry loop.
- **P3 tagged only by nclx (no ICC profile).** If exiftool reports nclx `ColorPrimaries` = P3 and there's no ICC profile, insert the Display P3 ICC into `dec.png` before sharp. Get those bytes once from `sharp(...).withIccProfile('p3')` output metadata [M].
- **HDR camera HEIF (PQ/HLG `.HIF`)** is not tone-mapped in v1 and will look flat. This is a known limitation; it gets an admin note.

### Other decoders
- **JPEG XL, JPEG 2000, BMP, PSD:** `ffmpeg -v error -nostdin -i SRC -frames:v 1 -c:v png /config/tmp/<id>/dec.png`.
  - The startup check needs the `libjxl`, `jpeg2000`, `bmp` and `psd` decoders, which the local ffmpeg 6.1 has. A missing decoder means that type fails as `unsupported`.
- **RAW:**
  - `exiftool -b -JpgFromRaw SRC`, falling back to `-PreviewImage`, written to `/config/tmp/<id>/preview.jpg`.
  - Require a long edge ≥ 1600.
  - `exiftool -overwrite_original -TagsFromFile SRC -all:all preview.jpg` copies the tags in, including Orientation.
  - The canonical file is that JPEG, not re-encoded [M].
- **SVG:**
  - `sharp(buf, { density })` with `density = min(300, 72·4096/max(w,h))`, then `.png()`.
  - This runs in the worker child process; the input must be ≤ 5 MB.
- **Animated WebP:** `sharp(src, { animated: true }).gif({ effort: 7 })`.

### JPEG/PNG encode (sharp, inside the photo worker child process)
```ts
sharp.concurrency(2); sharp.cache(false);
const meta     = await sharp(input).metadata();
const keepIcc  = meta.hasProfile && (meta.space === 'srgb' || meta.space === 'rgb16'); // CMYK/grey → default sRGB conversion
const alpha    = meta.hasAlpha && !(await sharp(input).stats()).isOpaque;
let p = sharp(input, { autoOrient: true });       // limitInputPixels default ≈268 MP (200 MP fits); failOn default 'warning'
if (keepIcc) p = p.keepIccProfile();              // tags the profile, does not transform pixels [H]
p = p.keepExif();                                 // never withMetadata()/keepMetadata()/keepXmp()
alpha ? p.png({ compressionLevel: 6 })
      : p.jpeg({ quality: 92, chromaSubsampling: '4:2:0', optimiseCoding: true, progressive: false, mozjpeg: false });
await p.toFile(`/photos/.work/${id}/${id}.${ext}`);
```
- **Orientation is applied exactly once.** `autoOrient` rotates the pixels and then removes `orientation` and `exif-ifd0-Orientation`. For HEIF, the pixels are already rotated and Orientation is already 1, so nothing more happens.
- **XMP is dropped.** autoOrient ignores XMP orientation, and iPhone XMP describes a gain map that no longer exists.
- **Colour space:** the canonical file stays Display P3, the same as iPhone's own "Most Compatible" export. There is no setting for this.
- **EXIF that is kept:**
  - DateTimeOriginal, OffsetTime*, SubSec*, Make, Model, Lens and GPS.
  - GPS is kept because this is a family-only app, and passthrough JPEGs carry it anyway.
  - Apple's MakerNote may not survive, so read `ContentIdentifier` from the **source** first.
- **Lost (kept only in the archived original):** the HDR gain map, depth maps, non-primary images and 10-bit precision.
- **Metadata read** (exiftool `-j -n -G1` on the source):
  - Date fallback order: DateTimeOriginal + OffsetTimeOriginal → CreateDate → XMP date → the client's `lastModified` → upload time.
  - Stored as `taken_at` (local time, plus the offset when known) and `taken_ms` (UTC).

### Derivatives (always built from the canonical file, one after another, after the canonical file is written)
- **display:** `sharp(canon,{autoOrient:true}).resize({width:2048,height:2048,fit:'inside',withoutEnlargement:true})` → `keepIccProfile()` if the canonical has a profile → `.withExif({IFD0:{DateTime:d}, IFD2:{DateTimeOriginal:d, OffsetTimeOriginal:o}})` → `.webp({quality:82, smartSubsample:true, effort:4})`.
  - The EXIF is date only, with no GPS. IFD2 is the EXIF IFD in libvips naming [M].
- **thumb:** 480 px box, `.webp({quality:76, smartSubsample:true, effort:4})`, no EXIF.
- **Why build from the canonical file:** JPEG shrink-on-load makes 48 MP → 2048 px cheap, and the same code path rebuilds `/config/cache` from `library/`.
- **Passthrough JPEG that fails only on a decoder warning:** retry the derivatives once with `failOn:'error'`.

---

## 3. Video conversion

### Probe and plan (video worker child process)
- **Probe:** `['ffprobe','-v','error','-print_format','json','-show_format','-show_streams',SRC]`. The intake step already ran it; its JSON is reused.
- **Video stream** (`vIdx`): the largest W×H among streams with `disposition.attached_pic != 1`.
- **Audio stream** (`aIdx`):
  - Candidates must have a `codec_name` that appears in `AUDIO_DECODERS` (parsed once from `ffmpeg -hide_banner -decoders`) and a `codec_tag_string` whose lower-case form is not `apac`.
  - Prefer `aac`, then the default stream, then the lowest index.
  - If the source had audio but none is decodable, the output has no audio, `audio_dropped=1` is set, and the admin gets a note.
- **Output size:**
  - The box is `LONG×SHORT` = 1920×1080. It becomes 3840×2160 only when `VIDEO_MAX_LONG_EDGE=3840`.
  - Displayed dimensions are `w·SAR × h`, swapped if `|rotation| % 180 == 90`.
  - `s = min(1, LONG/long, SHORT/short)`, then `W,H = max(2, round(x·s/2)·2)`. Even dimensions are mandatory for zscale.
- **Frame rate:**
  - `fpsIn` = `avg_frame_rate`, falling back to `r_frame_rate`.
  - **Slow motion:** if `fpsIn ≥ 100` and `format.tags['com.apple.quicktime.full-frame-rate-playback-intent'] === '0'` → **retime to 30 fps**. This key is iOS 18+, where 0 means "play as slow-mo" [M] ([ExifTool forum](https://exiftool.org/forum/index.php?msg=90353), [Apple Discussions](https://discussions.apple.com/thread/256093261)).
  - Otherwise, `fpsIn > 60.5` → `fps=60`.
  - Otherwise, frame timing is passed through unchanged.
- **HDR class:**
  - Transfer `smpte2084` → PQ; `arib-std-b67` → HLG.
  - Otherwise use the Dolby Vision record's compatibility id: 4 → HLG, 1 → PQ, 2 → SDR, 0 (profile 5) → **fail as `unsupported`**.
  - Otherwise BT.2020 primaries → wide-gamut SDR ("WCG").
  - Otherwise SDR.
- **Interlaced:** `field_order` is one of tt/bb/tb/bt, or the codec is dvvideo/mpeg2video.
- **Estimated cost:** `est_cost_s = dur × (srcW·srcH·fpsIn)/(1920·1080·30) × (hdr ? 1.5 : 1) × (remux ? 0.02 : 1)`.

### Remux criteria (all must hold; otherwise transcode)
- **Container:** mov, mp4, m4v, 3gp or matroska.
- **Video stream:**
  - `h264` with profile Constrained Baseline, Baseline, Main or High.
  - `pix_fmt` is `yuv420p` or `yuvj420p`, and the tag is not `avc3`.
  - Progressive or unknown field order; level ≤ 42 (≤ 51 for 4K output).
  - Fits the box; SAR 1:1; fps ≤ 60.5; video bitrate ≤ 20 Mbps.
- **SDR only:** transfer is not PQ or HLG, primaries and matrix are not BT.2020, and there is no Dolby Vision record.
- **Audio:** copied if it is `aac` profile `LC`, ≤ 2 channels, at 44.1 or 48 kHz. Otherwise it is re-encoded and the source is archived (§4).

### Shared argument blocks (TypeScript)
```ts
const T    = String(cfg.videoThreads);  // VIDEO_THREADS ?? max(2, floor(os.availableParallelism()/2))
const head = ['ffmpeg','-hide_banner','-nostdin','-v','error','-nostats','-progress','pipe:1','-stats_period','1',
              '-filter_threads',T,'-threads',T,'-i',SRC];
const maps = ['-map',`0:${vIdx}`, ...(aIdx!=null ? ['-map',`0:${aIdx}`] : [])];
const meta = ['-map_metadata','-1','-map_chapters','-1', ...(utc ? ['-metadata',`creation_time=${utc}`] : [])]; // skip if year < 2000
const tail = ['-movflags','+faststart','-f','mp4', OUT];          // OUT = /photos/.work/<id>/<id>.mp4
const big  = W*H > 1920*1080;
const lvl  = big ? (fpsOut>30?'5.2':'5.1') : (fpsOut>30?'4.2':'4.0');
const mr   = clamp(10000*Math.pow(W*H/2073600,0.75)*(fpsOut>30?1.4:1), 1500, big?40000:14000) | 0;
const x264 = ['-fps_mode','passthrough','-c:v','libx264','-preset','medium','-crf','18',
  '-profile:v','high','-level:v',lvl,'-maxrate',`${mr}k`,'-bufsize',`${2*mr}k`,
  '-g',String(2*Math.round(fpsOut)),'-x264-params','aq-mode=3','-pix_fmt','yuv420p',
  '-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-threads',T];
const tempo = slowmo ? atempoChain(30/fpsIn) : null;  // e.g. 240 fps → 'atempo=0.5,atempo=0.5,atempo=0.5' (atempo accepts 0.5–100 each)
const audio = (audioCopy && !slowmo) ? ['-c:a','copy']
  : [...(tempo ? ['-af',tempo] : []), '-c:a','aac','-b:a', ch>=2?'192k':'96k','-ac',String(Math.min(ch,2)),
     ...(sr===44100||sr===48000 ? [] : ['-ar','48000'])];
const pre  = [...(interlaced ? ['bwdif=mode=send_frame:parity=auto:deint=interlaced'] : []),
              ...(slowmo ? [`setpts=${fpsIn/30}*PTS`,'fps=30'] : fpsIn>60.5 ? ['fps=60'] : [])];
```
- **Explicit `-level:v` is required.** Without it, x264 at 1080p60 can emit Level 5.0, which exceeds what many devices guarantee. This was measured locally [H].
- **`-preset medium`, not `slow`.** Slow was 25% slower (13.6 vs 17 fps measured) for about 5% smaller files.
- **Expected speed and size:** about 3.5 min of encoding per minute of 4K60 HDR footage on a 4-vCPU box. Output is about 60–110 MB/min at 1080p60.

### Command lines
**(a) Remux:**
```ts
[...head, ...maps, '-c:v','copy', ...audio, ...meta, ...tail]
```
- The rotation matrix is copied as-is.
- `aac_adtstoasc` is inserted automatically for ADTS audio.

**(b) SDR transcode:**
```ts
const vf = [...pre,
 `scale=w=${W}:h=${H}:flags=lanczos+accurate_rnd+full_chroma_int:in_color_matrix=${inM}:out_color_matrix=bt709:in_range=${inR}:out_range=tv`,
 ...(sarNot1 ? ['setsar=1'] : []), 'format=yuv420p'].join(',');
// inM: bt709|bt601|bt2020 from color_space; untagged → H>=720 ? 'bt709' : 'bt601'
// inR: 'pc' if color_range=pc or pix_fmt yuvj*, else 'tv'
[...head, ...maps, '-vf', vf, ...x264, ...audio, ...meta, ...tail]
```
- For wide-gamut SDR, replace `scale` with:
  `zscale=w=W:h=H:filter=lanczos:pin=bt2020:min=bt2020nc:tin=bt2020-10:rin=limited:p=bt709:m=bt709:t=bt709:r=limited:dither=ordered,format=yuv420p`

**(c) HDR transcode** (HLG, PQ, and Dolby Vision 8.4/8.1 via the base layer; the per-frame DV data is ignored):
```ts
const tin  = cls==='hlg' ? 'arib-std-b67' : 'smpte2084';
const peak = cls==='hlg' ? 10 : clamp((maxCLL || mdcvMaxLum || 1000)/100, 2, 40);
const vf = [...pre,
 `zscale=w=${W}:h=${H}:filter=lanczos:tin=${tin}:pin=bt2020:min=${min}:rin=${rin}:t=linear:npl=100`,
 'format=gbrpf32le','zscale=p=bt709',
 `tonemap=tonemap=mobius:desat=0:peak=${peak}`,
 'zscale=t=bt709:m=bt709:r=limited:dither=ordered','format=yuv420p',
 'sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA',
 'sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL',
 ...(hasAmbient ? ['sidedata=mode=delete:type=AMBIENT_VIEWING_ENVIRONMENT'] : [])].join(',');
[...head, ...maps, '-vf', vf, ...x264, ...audio, ...meta, ...tail]
```
- **Mobius replaces the draft's hable.** Hable put reference white at about 76% and looked dim [M, measured].
- **libplacebo and OpenCL are not used**, because they need a GPU driver.
- **Why the `sidedata` deletes:** without them, ffmpeg 7.1 writes HDR mastering boxes (`mdcv`/`clli`) into an SDR file [H].

**(d) Poster** (generated first, from the source; same colour chain without `pre` and without the `sidedata` deletes):
```ts
['ffmpeg','-hide_banner','-nostdin','-v','error','-ss',String(dur>=2?Math.min(1,dur*0.1):0),'-threads',T,'-i',SRC,
 '-map',`0:${vIdx}`,'-vf',`${colourChain},thumbnail=n=24`,'-frames:v','1','-c:v','png','-f','image2pipe','pipe:1']
```
- stdout goes to sharp, producing `poster.webp` (≤ 1920 box, q80) and `thumb.webp` (480 px, q76). Timeout 120 s.
- While the video is still processing, the tile shows the poster.

### Renditions
- **Default:** one file. The canonical MP4, fitted to 1920×1080, is used for playback and for downloads. 4K detail survives only in the archived original.
- **`VIDEO_MAX_LONG_EDGE=3840` (opt-in):**
  - The canonical file is up to 4K (Level 5.1/5.2, maxrate ≤ 40M).
  - When the canonical is bigger than the 1080p box, a playback copy `library/<sh>/<id>.play.mp4` is also made, by running (b) on the 4K canonical with the 1920 box.
  - The viewer plays `.play.mp4`; downloads get the canonical file.

### Metadata, rotation, audio, tracks
- **Metadata:**
  - ffmpeg writes only `creation_time` (in mvhd). `-map_metadata -1` drops everything else, including the slow-mo intent key, which is reported to break Windows thumbnails [M].
  - Then a **required exiftool step** runs on `OUT`, before verification:
    ```
    exiftool -q -overwrite_original -api QuickTimeUTC=1 \
      [-Keys:CreationDate='2024:07:04 11:22:31-07:00'] \                 # only when the local offset is known
      [-Keys:GPSCoordinates='37.3349, -122.0090, 10' -UserData:GPSCoordinates='37.3349, -122.0090, 10'] OUT
    ```
  - Values come from the database, which is the source of truth.
  - ExifTool writes Keys into `moov/meta`, where Apple reads them. ffmpeg would put them in `udta/meta` ([#4209](https://fftrac-bg.ffmpeg.org/ticket/4209)).
  - ExifTool fixes up chunk offsets (stco/co64) and keeps atom order, so the moov box stays before the media data [M-H] ([WriteQuickTime.pl](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/WriteQuickTime.pl)).
  - `UserData:GPSCoordinates` is the `©xyz` tag that Google Photos reads.
- **Rotation:**
  - `-autorotate` stays on (the default). In 7.1 it inserts the rotate/flip filters before ours and removes the rotation flag from the output, so W and H are the rotated values.
  - Remux keeps the rotation matrix. Never use `-metadata:s:v rotate=0`.
- **Tracks:** exactly one video track and at most one audio track. Timecode, `mebx`, depth/disparity tracks, subtitles, chapters and APAC are all dropped.
- **Other video cases:**
  - MV-HEVC (spatial video): the base view only.
  - Interlaced: `bwdif`.
  - Non-square pixels: `setsar=1`.
  - MJPEG (full range): `in_range=pc`.
  - Untagged SD: `bt601`.

### Verify and commit
- **ffprobe checks on `OUT`:**
  - Exactly one h264 track in `yuv420p`, level ≤ 42 (≤ 52 when the output is 4K).
  - At most one audio track: AAC LC, ≤ 2 channels, 44.1 or 48 kHz.
- **After a transcode, also:**
  - bt709 primaries, transfer and matrix.
  - No rotation matrix, and no mastering-display, light-level or Dolby Vision data.
- **Duration** within ±max(0.1 s, 2%) of the expected value (the source duration, × fpsIn/30 for slow-mo).
- **moov before mdat**, checked with a Node walker over the top-level boxes.
- Then `fsync`, rename into `library/`, and the database transaction.

### Resource limits
| Item | Setting |
|---|---|
| Container (Unraid template ExtraParams, **required**) | `--cpu-shares=128 --memory=4g`. nice only orders work inside the container. Between containers the CPU is split by cgroup weight, so without this ffmpeg gets about 50% against Plex [H] ([Docker resource limits](https://docs.docker.com/engine/containers/resource_constraints/)). Log `/sys/fs/cgroup/cpu.weight` and `cpu.max` at startup |
| Worker processes | Photo lane: `spawn('nice',['-n','10',process.execPath,'--max-old-space-size=512','worker.js','--lane=photo'],{stdio:['ignore','inherit','inherit','ipc']})`. Video lane: the same at nice 15. Child processes (heif-dec, ffmpeg, exiftool) inherit the nice value; ffmpeg is also run under `ionice -c2 -n7`, which only matters under the BFQ disk scheduler and is harmless otherwise |
| Threads | `T` (above) for decoder, filter and encoder; respects Unraid CPU pinning. `sharp.concurrency(2)`. `UV_THREADPOOL_SIZE=8` in the main process (tus, file serving, hashing) and 4 in the workers. sharp never loads in the main process |
| Lane order | Photos: first in, first out. Videos: lowest `est_cost_s − 0.5 × wait_s` first, so short clips aren't stuck behind a 1-hour 4K60 job, and long jobs still age forward |
| Timeouts | heif-dec 180/360 s. Photo job 300 s (600 s if > 100 MP); on overrun, SIGKILL the worker and respawn it. ffmpeg: if `out_time_us` hasn't advanced for 180 s, SIGTERM, then SIGKILL 10 s later. Hard cap `120 s + 30 × duration` |
| Retries | `attempts++` in the same transaction that sets `processing`. On startup, rows with `attempts ≥ 3` → `failed` and an admin alert. Only `retryable` errors are retried |
| Caps | `UPLOAD_MAX_BYTES` = 50 GiB (tus `maxSize`). `VIDEO_MAX_DURATION_S` = 7200. Source fps ≤ 240, dimensions ≤ 8192 (photos: ≤ ~268 MP). At tus create, require free space on `/photos` ≥ 2 × Upload-Length + 2 GiB. Before each job, require ≥ 2 GiB free on `/config` |
| Startup self-check | ffmpeg has `libx264`, `zscale`, `tonemap`, `sidedata`, and `AMBIENT_VIEWING_ENVIRONMENT` (via `ffmpeg -h filter=sidedata`). Parse the decoder list. Check `heif-dec --list-decoders` and `exiftool -ver`. Then `rm -rf /config/tmp/* /photos/.work/*` and requeue interrupted jobs |

### Progress
- ffmpeg `-progress pipe:1 -stats_period 1`. Parse `out_time_us`: `pct = min(99, ⌊100·t/expectedDur⌋)`. The ETA comes from `speed=` and is shown only as "about N minutes" or "a few minutes".
- Workers send progress to the main process over the IPC channel, into an in-memory `Map<id,{pct,eta}>`. It is not stored in the database; a restart re-runs the job anyway.
- `GET /api/media/status?ids=…` returns `{id, status, pct?, queuePos?, posterUrl?, duplicateOf?}`. The client polls every 3 s, every 10 s when the tab is hidden, and stops once everything is finished. Photos show a spinner only.

---

## 4. Source files

- **Setting:** `KEEP_ORIGINALS` (default `true`).
- **Archived** (moved by rename from `.incoming/<token>` to `/photos/originals/<sh>/<id>.<ext>`, `source_kept=1`) whenever the canonical file isn't a lossless copy:
  - every `transcode`;
  - any `remux` that re-encoded audio or dropped a stream (APAC, depth, timecode…).
- **Deleted after commit:**
  - `conversion='none'`: the source *is* the canonical file. It is renamed into `library/`, so there's no copy.
  - Remuxes that copied every source stream.
- **Failed items always keep their source**, whatever the setting, so the admin can retry.
- **`KEEP_ORIGINALS=false`:** delete after commit (failed items still keep theirs).
- **Admin-only controls:** "Archived originals: 41 GB [Delete all]", per-item "Download original", and "Reprocess items below pipeline version N". Without an archive, reprocessing only rebuilds the derivatives.
- **Storage math** (one year: 3,000 × 24 MP photos plus 100 min of 4K60, worst case with everything arriving as HEIC/HEVC):
  - Canonical files: ≈ 27 GB + 8.5 GB ≈ **35 GB**.
  - The archive adds ≈ 10.5 GB HEIC + 40 GB HEVC, for **≈ 85 GB/yr total (≈ 2.4×)**.
  - 1 TB lasts more than 10 years.

---

## 5. Schema & storage changes

```sql
CREATE TABLE media (
  id               TEXT PRIMARY KEY,             -- ULID; the on-disk key; NEVER the tus id
  upload_token     TEXT UNIQUE,                  -- tus id (random 128-bit); set to NULL after intake
  album_id         INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  uploader_id      INTEGER NOT NULL REFERENCES people(id),
  kind             TEXT CHECK (kind IN ('photo','video')),               -- NULL until detected
  status           TEXT NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received','queued','processing','ready','failed','duplicate')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  error_code       TEXT CHECK (error_code IN ('retryable','unsupported','corrupt','too_large')),
  error_detail     TEXT,                         -- admin only
  pipeline_version INTEGER NOT NULL,
  source_name      TEXT NOT NULL,                -- sanitized basename, e.g. 'IMG_1234.HEIC'
  source_mime      TEXT,                         -- detected from bytes; the originals/ extension comes from it
  source_size      INTEGER NOT NULL,
  source_sha256    TEXT,                         -- set by the intake step
  source_kept      INTEGER NOT NULL DEFAULT 0,
  client_mtime_ms  INTEGER,                      -- from tus metadata; last-resort date
  conversion       TEXT CHECK (conversion IN ('none','remux','transcode')),
  canonical_ext    TEXT CHECK (canonical_ext IN ('jpg','png','gif','mp4')),
  canonical_size   INTEGER,
  has_play         INTEGER NOT NULL DEFAULT 0,   -- <id>.play.mp4 exists (4K opt-in only)
  width INTEGER, height INTEGER,                 -- as displayed
  duration_ms      INTEGER,
  hdr_tonemapped   INTEGER NOT NULL DEFAULT 0,
  audio_dropped    INTEGER NOT NULL DEFAULT 0,
  slowmo_retimed   INTEGER NOT NULL DEFAULT 0,
  est_cost_s       REAL,
  queued_ms        INTEGER,
  taken_at         TEXT,                         -- local wall time, plus offset when known
  taken_ms         INTEGER,                      -- UTC epoch ms: sort order, Last-Modified, File.lastModified
  gps_lat REAL, gps_lon REAL, gps_alt REAL,
  content_id       TEXT,                         -- Apple ContentIdentifier (photo MakerNote / MOV key)
  live_photo_of    TEXT REFERENCES media(id) ON DELETE CASCADE,
  duplicate_of     TEXT REFERENCES media(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (album_id, source_sha256)
);
CREATE INDEX media_album_view ON media(album_id, status, live_photo_of, taken_ms);
CREATE INDEX media_queue      ON media(status, kind, queued_ms) WHERE status IN ('received','queued','processing');
CREATE INDEX media_live       ON media(album_id, content_id) WHERE content_id IS NOT NULL;
```

### Item lifecycle
1. **tus upload finishes:** insert a row with `status='received'` and respond immediately.
2. **Intake step** (main process, one item at a time, a few seconds each):
   - streaming SHA-256 of the upload;
   - look for a duplicate in the same album → `duplicate` with `duplicate_of`; delete the upload; purge the row after 24 h;
   - detect the type; ffprobe for videos (30 s timeout);
   - set `kind`, `source_mime` and `est_cost_s`, then `queued`.
   - Unknown types → `failed/unsupported`.
3. **Photo or video lane** (in the worker child process): `processing` → `ready` or `failed`.
4. **Live Photo pairing on `ready`:** a video with `duration ≤ 4.5 s` and `content_id` equal to a photo's `content_id` in the same album gets `live_photo_of = photo.id`.

### On-disk layout
```
/photos/
  library/<sh>/<id>.<jpg|png|gif|mp4>   canonical: the only full-size file anyone views or downloads
  library/<sh>/<id>.play.mp4            only with VIDEO_MAX_LONG_EDGE=3840
  originals/<sh>/<id>.<heic|mov|dng|…>  archived source (admin only)
  .incoming/<token>(+.json)             tus FileStore; same filesystem as library
  .work/<id>/                           canonical output before verify + rename
/config/
  app.sqlite (+ -wal, -shm)             WAL mode, busy_timeout 5000; workers open their own connection
  cache/<sh>/<id>/thumb.webp display.webp poster.webp   rebuildable from library/
  tmp/<id>/                             decoded intermediates (heif-dec/ffmpeg PNG, RAW preview), derivatives before rename
```
`<sh>` is the last two characters of the ULID.

### Rules
- Intermediates go only in `/config/tmp/<id>`. Canonical outputs go only in `/photos/.work/<id>`, so the final rename never crosses filesystems.
- Each job runs inside `try/finally`, which removes both directories.
- **Commit order:** write → verify → fsync → rename into `library/` → database transaction (`ready` plus metadata) → archive or delete the source.
- **`.incoming` sweep:** delete files older than 48 h that have no `received`/`queued`/`processing` row.

---

## 6. Uploader UX changes

### Upload endpoint
- **Methods:** the route `src/routes/upload/[...p]/+server.ts` exports only `POST`, `PATCH`, `HEAD` and `OPTIONS`. SvelteKit answers `GET` and `DELETE` with 405.
  - So `@tus/server`'s GetHandler can never stream a raw HEIC/MOV, and nobody can delete someone else's upload [H] ([GetHandler.ts](https://github.com/tus/tus-node-server/blob/main/packages/server/src/handlers/GetHandler.ts)).
  - Any request carrying `X-HTTP-Method-Override` is rejected with 400 (defence in depth).
- **Upload id:** `namingFunction` returns a random 128-bit base64url token.
- **`onUploadCreate`:**
  - requires a session;
  - sets `metadata.uploader_id` on the server side;
  - returns 413 if the size is over `UPLOAD_MAX_BYTES` or free space is short (logged for the admin).
- **`onIncomingRequest`:** for HEAD and PATCH, require the stored upload's `metadata.uploader_id === session.userId`; otherwise 403.
- **`onUploadFinish`:** inserts the row and returns 204 right away. Hashing is never done inside the request, which avoids Cloudflare's 100 s timeout.
- **tus-js-client options:**
  - `chunkSize: 50 * 1024 * 1024`: Cloudflare Free/Pro rejects request bodies over 100 MB ([limits](https://developers.cloudflare.com/workers/platform/limits/)).
  - `retryDelays: [0,1000,3000,5000,10000,20000,60000]`
  - `removeFingerprintOnSuccess: true`
  - `metadata: { filename, lastModified: String(file.lastModified), albumId }`

### File input
```ts
const BASE = 'image/*,video/*';
const ua = navigator.userAgent;
const appleWebKit = /AppleWebKit/.test(ua) && !/Chrome\/|Chromium\/|Android/.test(ua); // every iOS browser + macOS Safari
const android = /Android/.test(ua);
// ALLOWED_EXTS is generated at build time from the server allowlist (src/lib/media/allowlist.ts)
const accept = (appleWebKit || android) ? BASE : `${BASE},${ALLOWED_EXTS.map(e => '.' + e).join(',')}`;
// <input type="file" multiple {accept}>  (never `capture`)
```
- **Apple browsers:** never list HEIC. On iOS Safari 17+, listing it makes Safari re-encode picked JPEG/PNG files into HEIC [H] ([Apple forum 743049](https://developer.apple.com/forums/thread/743049)).
- **Android:** wildcards only, because any other entry drops users out of the Photo Picker [H] ([SelectFileDialog.java](https://github.com/chromium/chromium/blob/main/ui/android/java/src/org/chromium/ui/base/SelectFileDialog.java)).
- **Desktop:** the full extension list, so no format is hidden by the dialog filter.
- **The client never filters by MIME type** except to skip obvious non-media (PDF, DOCX), with the message "That one isn't a photo or video."
- **No client-side conversion, resizing, metadata stripping or hashing.**

### Previews and placeholders
- **On `change`:** one tile per file immediately, with a photo or film icon and a small filename.
- **Photo previews:**
  - Use `createImageBitmap(file, {resizeWidth: 240})` where supported, otherwise `img.decode()`. If decoding fails, keep the placeholder silently.
  - **iOS:** one at a time, skip files over 8 MB.
  - **Other platforms:** ≤ 4 at once, ≤ 15 MB, ≤ 30 per batch.
  - Revoke object URLs immediately.
- **Videos:** a placeholder until the server's poster arrives.
- **iOS "nothing happened" gap:** if focus returns with no `change` event, show "Getting your photos from your phone…". Clear it on `change` or `cancel`.
- **During upload:** a Screen Wake Lock plus "Keep this screen open until it says Done."

### Status copy (never mentions HEIC, HEVC, "format" or "convert")
| State | Copy |
|---|---|
| uploading | "Sending 3 of 12…" with an overall progress bar |
| received / photo processing | spinner, "Getting it ready…" |
| video processing | "Getting your video ready… 40%" + "Videos can take a few minutes. You can leave this page — we'll keep going." |
| queued video | "Waiting its turn (2 ahead)" |
| ready | thumbnail swaps in with "✓ Added" |
| duplicate | "✓ Already in this album" |
| failed / `retryable` | "This one didn't work." [Try again] |
| failed / `unsupported`, `corrupt` or `too_large` | "We couldn't add this one. {Admin name} has been told." (no retry) plus an admin alert |

Only the uploader and the admin see unfinished tiles.

---

## 7. Downloads

| Path | Serves | How |
|---|---|---|
| Viewer | `display.webp` for photos (the canonical file for animated GIF/APNG); the canonical MP4 (or `.play.mp4`) for video | Native long-press and right-click are blocked on the `<img>`/`<video>` (`-webkit-touch-callout:none`, `draggable=false`, `contextmenu` → `preventDefault()` and open "Save to my phone"). The derivative also carries date-only EXIF as a fallback |
| "Save to my phone", iOS/iPadOS | Canonical file | `navigator.share({files:[new File([blob], name, {type, lastModified: taken_ms})]})`. Photos ≤ 3 MB are prefetched once the photo has been open 1.5 s (skipped when `navigator.connection.saveData` is on; only one blob held at a time). Larger photos and all videos use two taps: tap 1 shows "Getting it ready… 45%", tap 2 says "Tap to save", which counts as a fresh tap for Safari's share permission. Videos over 250 MB [L] get a plain download into Files instead |
| "Save to my phone", Android | Canonical file | `<a download>` with `Content-Disposition: attachment`. Lands in Downloads, which Google Photos shows |
| Desktop download | Canonical file | `<a download>` |
| Album, desktop | ZIP of canonical files only (no archived originals, no derivatives, no hidden Live Photo videos) | Streamed, no compression (STORE), ZIP64. Entry times set to `taken_at` |
| Album, phones | No ZIP | "Save all": iOS shares in batches of 10 ("Save next 10" button); Android downloads one file every 500 ms |
| Admin "Download original" | Archived source under `source_name` | Admin role only (not the uploader). Sent as `application/octet-stream`, `attachment`, with `Content-Security-Policy: sandbox` |
| tus `/upload/*` | Nothing | GET returns 405 |

### Filenames
- **Base name:** `stem(source_name)` normalised to NFC; control characters and `/\:*?"<>|` replaced; trimmed; cut to 100 characters; then the lower-case `.canonical_ext`.
  - Examples: `IMG_1234.HEIC → IMG_1234.jpg`, `IMG_5678.MOV → IMG_5678.mp4`.
- **Generic names** (`image`, `tempImage*`, `trim.*`, `video`, `blob`, UUID-like) become `Photo_YYYY-MM-DD_HH-MM-SS.jpg` or `Video_….mp4`, built from `taken_at` (falling back to upload time).
- **In ZIPs,** name clashes become `IMG_1234 (2).jpg`.

### Serving (one handler that supports byte ranges)
- **Headers and responses:**
  - `Accept-Ranges: bytes`, 206 for range requests (iOS needs it for video), `If-Range`.
  - `ETag: "<id>-<pipeline_version>"`, `Cache-Control: private, max-age=31536000, immutable`.
  - `Last-Modified` from `taken_ms`.
  - `X-Content-Type-Options: nosniff`.
  - `Content-Disposition: attachment; filename="<ascii>"; filename*=UTF-8''<pct>` on downloads.
- **Docs:**
  - Recommend Nginx Proxy Manager for families with a lot of video.
  - Cloudflare Tunnel is fine at family scale, but its Free/Pro terms restrict serving video and large files through its proxy [M] ([Cloudflare service-specific terms](https://www.cloudflare.com/service-specific-terms-application-services/)).

---

## 8. Tests & fixtures

### Vendored HEIF fixtures (`test/fixtures/heif/` + `LICENSES.md`)
| File | Source and licence | What it tests |
|---|---|---|
| `arrow.heic` | [pillow_heif tests/images](https://github.com/bigcat88/pillow_heif/tree/master/tests/images), BSD-3-Clause | iPhone grid image with irot 270 **and** EXIF Orientation 6: must not rotate twice |
| `zPug_3.heic` | pillow_heif | 3 top-level images; the primary is the 2nd |
| `RGB_10__128x128.heif`, `RGBA_8__128x128.heif` | pillow_heif | 10-bit source; transparency → PNG |
| `200MP.heic` | pillow_heif `heif_special/` | Memory and security-limit handling (nightly run) |
| truncated and corrupted HEIC/HEIF | pillow_heif | Fails cleanly; the source is kept |
| `heic-iphone7.heic` | [exifr test/fixtures](https://github.com/MikeKovarik/exifr/tree/master/test/fixtures), MIT | Display P3 ICC, GPS, grid image |
| `example.avif` | [libheif examples](https://github.com/strukturag/libheif/tree/master/examples), MIT | AVIF route |

Avoid anything from nokiatech/heif (non-commercial licence), exifr's `heic-single`/`heic-collection`, and pillow_heif's `nokia/` folder.

### Generated photo fixtures (committed, a few KB each)
Built in a Docker `fixtures` stage: `debian:trixie-slim` + `libheif-examples libheif-plugin-x265 libheif-plugin-aomenc libimage-exiftool-perl`.
```
node gen-quad.mjs                                   # sharp: 256×192 four-colour quadrants → quad.jpg, quad-p3.jpg (withIccProfile('p3')), patches.png (24 colour patches, no ICC)
for n in 1..8: exiftool -Orientation#=$n -o o$n.jpg quad.jpg && heif-enc -q 90 o$n.jpg -o o$n.heic
heif-enc -q 90 quad-p3.jpg -o p3.heic
heif-enc -q 95 --matrix_coefficients=1 --full_range_flag=0 patches.png -o bt709-limited.heic
heif-enc -q 95 --colour_primaries=12 --matrix_coefficients=6 --full_range_flag=1 patches.png -o p3-nclx.heic
heif-enc -A -L patches.png -o gbr-lossless.avif     # assert matrix_coefficients=0 with exiftool before committing [M]
```
- **Broken-first-image fixture:** a test helper parses the `iloc` box of `zPug_3.heic` and zeroes 256 bytes of item 1's data → `zPug_3-broken1.heic`.
- **Other photo fixtures,** also generated with sharp, ffmpeg or exiftool:
  - CMYK JPEG; PNG with Orientation 6;
  - WebP lossy, lossless, with transparency and animated;
  - TIFF, BMP, JXL;
  - SVG, including one with a `<script>` and an external `href`;
  - mislabelled `.heic`/`.jpg` pairs; PDF/HTML.

### Video fixtures (generated at test time inside the built ffmpeg 7.1 image, not committed)
- **F1–F17** exactly as in the video proposal:
  - HLG portrait 4K60 with an extra 4-channel track, timecode and Apple metadata;
  - PQ with HDR10 metadata; H.264 remux (stream hash must be identical); PCM → AAC; 4K30 scaled down;
  - 240 fps; variable frame rate; no audio; NTSC DV; MJPEG in AVI; WMV; VP9 and AV1;
  - MPEG-2 1080i with AC-3 5.1; ProRes HLG; SAR 4:3; odd dimensions; truncated file.
- **F18 (slow-mo):** `-f lavfi -i testsrc2=s=1280x720:r=240:d=2 -c:v libx265 -metadata com.apple.quicktime.full-frame-rate-playback-intent=0 -movflags use_metadata_tags`. Expect 30 fps and a duration of about 16 s.
- **F19 (tone-map regression):** 10-bit HLG 75% grey (`nullsrc,format=yuv420p10le,geq=lum=721:cb=512:cr=512` + HLG tags). Output `signalstats` average luma must be within 205–228 (mobius gives about 218).
- **Unit tests** on hand-written ffprobe JSON:
  - an APAC track listed before the AAC track;
  - a stream with `codec_name` missing;
  - only undecodable audio → `audio_dropped=1`.

### Assertions
- **Photos:**
  - format follows §1;
  - width/height swapped for rotated sources; EXIF Orientation absent or 1;
  - an 8×8 downscale of each quadrant has the expected colour (all 8 orientations);
  - colour fixtures: mean of each patch within **ΔE2000 < 2** of `patches.png`;
  - ICC description reads "Display P3" for the P3 and P3-nclx fixtures;
  - exiftool reads the same DateTimeOriginal, GPS and Make/Model as the source;
  - `zPug_3` gives the primary image; `zPug_3-broken1` ends as `failed/corrupt` with the source kept and no retry;
  - animated WebP → GIF with the same frame count;
  - the SVG becomes a PNG, the script never runs, and the server never serves `image/svg+xml`;
  - PDF/HTML → `unsupported`;
  - time and peak memory for 12 MP and 48 MP are recorded;
  - both heif-dec decoders give the same output on every fixture.
- **Video:** every check in "Verify and commit" (§3), plus:
  - exiftool reads back `Keys:CreationDate` and `UserData:GPSCoordinates`;
  - moov still comes before mdat after the exiftool step;
  - the F3 stream hash is identical;
  - `slowmo_retimed=1` for F18.
- **System:**
  - `GET` and `DELETE /upload/<token>` → 405, both mid-upload and after finish;
  - a POST with `X-HTTP-Method-Override` → 400;
  - HEAD or PATCH by another user → 403;
  - the same file uploaded twice → `duplicate`;
  - a worker test hook that calls `process.abort()` on a given id → `attempts` goes up, and the item is `failed` after 3 tries while the site stays up;
  - Range requests return 206 with the right bytes; a mismatched `If-Range` returns 200;
  - archived-original URLs return 403 for non-admins;
  - after a simulated crash, startup clears `/config/tmp` and `/photos/.work`.
- **Release gate, on real devices:**
  - an iPhone (iOS 17 and 18) and an Android phone save a photo and a video, and each lands in the camera roll on the **taken date**;
  - Windows Photos opens the JPEG and the MP4;
  - from the owner's family: one iPhone 16 spatial-audio clip, one slow-mo clip, one Dolby Vision 8.4 HDR clip (visual check of the tone mapping), and one ProRAW photo.

---

## 9. Open question for the user

**Should the server quietly keep each phone's original file after converting it?** It would be visible to the admin only, never to the family. Keeping it lets you re-convert later (for example to 4K, or with a better converter) and costs about 2.4× the storage, roughly 85 GB a year instead of 35 GB in the worst case. **Recommended default: yes (`KEEP_ORIGINALS=true`).** You can switch it off later and delete the archive with one button.

---

## 10. Rejected critique items

- **Custom C program that decodes only the primary HEIF image:** rejected. A broken non-primary image is rare and already fails cleanly with the source archived; heif-dec plus the ffmpegdec/libde265 fallback and a doubled timeout is enough without maintaining our own C code.
- **Hashing uploads incrementally as chunks arrive (teeing PATCH bodies):** rejected. Persisting hash state across resumed uploads is fragile; the intake step after upload is simpler and avoids the Cloudflare timeout anyway.
- **Archiving whenever *metadata* is dropped:** partly rejected. A remux that copies every stream deletes its source, because date and GPS are re-written from the database and doubling storage for metadata-only differences isn't worth it.
- **Ownership check for tus DELETE:** replaced by something stricter. DELETE returns 405 for everyone; a cancelled upload just stops sending, and the `.incoming` sweep cleans up.
- **Opt-in VAAPI hardware decoding via `/dev/dri`:** deferred to v2. It needs a driver test matrix, and the CPU-weight and cost-ordering fixes already address the latency problem.
- **`--memory=3g`:** changed to 4g, because a 200 MP HEIF decode and a 4K HDR ffmpeg job can run at the same time.