# Family Photos

A private website where your whole family shares photos and short videos, running on your own Unraid
server.

- **Getting in is easy.** Everyone uses one shared family code, or scans a printed QR card that signs
  them straight in. The site asks for their first name once on each phone. There are no accounts or
  apps.
- **Anyone can add and save.** People add photos and videos from any phone or computer, make albums,
  write memories under a photo, and save anything back to their own phone at full quality.
- **Nobody deals with formats.** iPhone photos (HEIC) and videos (HEVC, HDR, Dolby Vision) are turned
  into high-quality JPEG and MP4 on the server automatically, so every phone and computer can open
  them. The family never sees a format name.
- **Nothing disappears by accident.** Family members can't delete anything. They ask, you get an
  email, and you decide on the admin page. Removed items stay in the trash for 30 days.

It's built for ages 5 to 95: big buttons with words next to the icons, large text that follows the
phone's text size, and no gestures you have to know about.

## Contents

- [Screenshots](#screenshots)
- [Quick start on Unraid](#quick-start-on-unraid)
- [Putting it on the internet safely](#putting-it-on-the-internet-safely)
- [Email](#email)
- [QR cards and resetting access](#qr-cards-and-resetting-access)
- [How photos and videos are handled](#how-photos-and-videos-are-handled)
- [Backups](#backups)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [All settings](#all-settings)
- [Development](#development)
- [Release checklist (real devices)](#release-checklist-real-devices)

## Screenshots

_Screenshots of the home page, an album, the photo viewer and the admin page go here (in
`docs/screenshots/`) once the first release is running on real phones._

## Quick start on Unraid

You need Unraid 6.10 or newer, a share for the photos, and a domain name if family outside your
home should reach the site (see [Putting it on the internet safely](#putting-it-on-the-internet-safely)).

### 1. One time only: make the image public

GitHub builds the Docker image and stores it in the GitHub Container Registry (GHCR) whenever `main`
changes. A new GHCR package starts out **private**, and Unraid can't download private images. After
the first successful run of the **Docker image** workflow:

1. On GitHub, open your profile → **Packages** → **family-photos** → **Package settings**.
2. Under **Danger Zone**, choose **Change visibility** → **Public**.

You can check it worked from the Unraid terminal: `docker pull ghcr.io/brewer-michael/family-photos:latest`.

### 2. Add the template

Unraid 6.10 and newer no longer take template repository URLs, so download the template file
directly. Open the Unraid terminal (the `>_` icon at the top right) and run:

```sh
wget -O /boot/config/plugins/dockerMan/templates-user/my-family-photos.xml \
  https://raw.githubusercontent.com/brewer-michael/family-photos/main/unraid/family-photos.xml
```

Then go to **Docker** → **Add Container**, and pick **family-photos** from the **Template** list (under
"User templates").

> Do this once. Unraid saves your filled-in settings into that same file, so downloading the template
> again later would wipe them.

### 3. First-run checklist

Fill in the form. The ones marked with \* are required.

- [ ] **Site address (`PUBLIC_URL`)\***: the address your family will use, without a path, e.g.
      `https://photos.example.com`. Email links and QR cards use it. For a home-only trial,
      `http://192.168.1.10:3000` (your server's IP) works too.
- [ ] **Family code (`FAMILY_PASSWORD`)\***: pick **three short words** that are easy to say on the
      phone and hard to guess, e.g. `blue lake cabin`. Capitals and extra spaces don't matter when
      people type it.
- [ ] **Admin password (`ADMIN_PASSWORD`)\***: at least 8 characters and different from the family
      code. It opens the admin page.
- [ ] **Admin email (`ADMIN_EMAIL`)** and **Admin first name (`ADMIN_NAME`)**: removal requests and
      problem alerts go to this address, and the family sees things like "Michael has been told."
- [ ] **Email server (`SMTP_…`)**: see [Email](#email). You can leave it empty at first; emails are
      then saved as files in the app data folder.
- [ ] **Paths**: keep **App data** (`/config`) on your cache or SSD pool so the site stays quick. The
      **Photos and videos** share (`/photos`) can live on the array.
- [ ] **Extra Parameters** (switch on **Advanced View** at the top right): leave
      `--cpu-shares=128 --memory=4g` there. Without it, getting a video ready takes about half the CPU
      from Plex and your other containers; with it, Plex gets priority whenever both are busy.

Click **Apply**. When the container is running:

1. Open the **WebUI** (or your `PUBLIC_URL`), type the family code and your name. You're in.
2. Go to `/admin` and sign in with the admin password.
3. Under **Media tools**, check that it says everything is in place.
4. Under **Email**, press **Send test email**.
5. Under **QR cards**, print cards for the family (see [QR cards](#qr-cards-and-resetting-access)).

## Putting it on the internet safely

Never forward port 3000 on your router straight to the server: that's plain, unencrypted HTTP. Put
one of these in front of it. Both give you HTTPS. Set `PUBLIC_URL` to the `https://` address you
choose.

### Option A: Cloudflare Tunnel (no ports to open)

1. In the Cloudflare dashboard, open **Zero Trust** → **Networks** → **Tunnels** and create a tunnel.
2. Run the connector on Unraid, e.g. the **cloudflared** container from Community Applications, with
   the tunnel token Cloudflare shows you.
3. In the tunnel, add a **public hostname**: `photos.example.com` → service type **HTTP**, URL
   `<unraid-ip>:3000` (e.g. `192.168.1.10:3000`).

Good to know:

- Cloudflare limits a single request to 100 MB on its free plan. Uploads are sent in 50 MB pieces
  and resume after a dropped connection, so even multi-gigabyte videos get through.
- Cloudflare's terms for its free and Pro plans restrict serving lots of video and large files
  through its proxy. A family sharing occasional clips is normally fine; if your family shares a lot
  of video, use Nginx Proxy Manager instead.
- The default `TRUSTED_PROXIES=private` is right when `cloudflared` runs on your server or home
  network.

### Option B: Nginx Proxy Manager

1. Forward ports 80 and 443 on your router to Nginx Proxy Manager (NPM), and point
   `photos.example.com` at your home IP address (a dynamic DNS name works too).
2. In NPM, add a **Proxy Host**: domain `photos.example.com`, scheme `http`, forward hostname/IP
   `<unraid-ip>`, port `3000`. Turn on **Block Common Exploits**. **Websockets Support** isn't needed.
3. On the **SSL** tab, request a Let's Encrypt certificate and turn on **Force SSL** and **HTTP/2**.
4. On the **Advanced** tab, allow the 50 MB upload pieces through:

   ```nginx
   client_max_body_size 64m;
   ```

5. `TRUSTED_PROXIES=private` is right when NPM runs on your Unraid server or home network. If NPM runs
   somewhere else, put its IP address there instead (comma-separated, ranges like `172.17.0.0/16` are
   fine).

### Why TRUSTED_PROXIES matters

Wrong family codes are limited to 10 tries per visitor every 15 minutes. To tell visitors apart, the
app believes the visitor address that Cloudflare or NPM passes on, but only when the request really
comes from one of the `TRUSTED_PROXIES`. Everyone else's claims are ignored, so nobody can fake their
way around the limit. QR cards keep working even while typing the code is paused.

The site also tells search engines not to index it, and every page except sign-in needs the family
code.

## Email

Emails go to `ADMIN_EMAIL`: one for each removal request (with a small picture of the photo, the
reason, and links to review it) and at most one an hour listing uploads that didn't work.

Without `SMTP_HOST`, nothing is sent: each email is saved as an `.eml` file in
`/mnt/user/appdata/family-photos/outbox/`. Any mail program (Apple Mail, Outlook, Thunderbird) opens
them.

Port 587 uses STARTTLS; port 465 uses TLS from the start. After changing these settings, use **Send
test email** on the admin page.

**Gmail** (needs 2-Step Verification; create an app password at Google Account → Security → App
passwords):

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=the 16-letter app password
SMTP_FROM=Family Photos <you@gmail.com>
```

**Resend** (verify your domain in Resend first; the user name is literally `resend`):

```
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_USER=resend
SMTP_PASS=re_your_api_key
SMTP_FROM=Family Photos <photos@yourdomain.com>
```

**Your own mail host** (e.g. the mailbox that comes with your web hosting):

```
SMTP_HOST=mail.yourdomain.com
SMTP_PORT=465
SMTP_USER=photos@yourdomain.com
SMTP_PASS=that mailbox's password
SMTP_FROM=Family Photos <photos@yourdomain.com>
```

`SMTP_FROM` must be an address your provider lets you send from. When it's empty, the sender is the
site title with `SMTP_USER` (if it's an email address) or `ADMIN_EMAIL`.

## QR cards and resetting access

**Printing QR cards.** On the admin page, open **QR cards**. There's one card for the whole site and
one for each album. Pointing a phone camera at a card signs that person straight in (and opens the
album, for album cards); they're asked for their first name once. They're handy for anyone who'd
rather not type a code.

**Reset access.** If the family code or a card ended up with someone it shouldn't have, press
**Reset access** on the admin page. Everyone is signed out on every device and has to type the family
code again, and every printed card stops working, so print new ones. You stay signed in.

**Changing the family code.** Change `FAMILY_PASSWORD` in the template and click **Apply**. That also
signs everyone out and stops old cards. Names and everything people added stay as they are.

## How photos and videos are handled

**What the family sees.** Every photo and video ends up as one file that every phone and computer
opens: a JPEG (PNG for images with transparency, GIF for animations) or an MP4. That file is what the
viewer shows, what "Save to my phone" saves, and what album downloads contain. Saved items land in the
phone's camera roll on the date they were taken.

**Photos.** iPhone HEIC photos become high-quality JPEGs (quality 92) with their colours, date and
location kept. Ordinary JPEG, PNG and GIF files are normally kept exactly as sent. Less common types
(WebP, TIFF, …) are converted too, and RAW camera files use the JPEG preview the camera stored in
them. A photo is usually ready a few seconds after it arrives.

**Videos.** Videos become MP4s at up to 1080p (Full HD), in either orientation. iPhone HDR and Dolby
Vision videos are toned down to normal colours so they don't look washed out on other screens,
slow-motion clips play slowly, and the date and location are kept. Videos that are already
compatible are just repackaged, without any loss. Converting takes a while: roughly 3–4 minutes per
minute of 4K HDR iPhone video on 4 CPU cores, one video at a time. Photos have their own queue, so
they never wait behind a long video. The uploader sees "Getting your video ready… 40%" and can leave
the page.

**Live Photos.** The short video part of a Live Photo is kept with the photo but hidden from albums
and downloads.

**Duplicates.** The same file sent twice to the same album is only added once.

**What doesn't work.** Things that aren't photos or videos (PDFs, documents, drawings saved as SVG,
some rare video types) can't be added. They show up on the admin page under **Uploads that didn't
work**, with their file kept, and you get an email. The person who sent it sees "We couldn't add this
one. Michael has been told."

**Originals archive (`KEEP_ORIGINALS`).** With the default `true`, whenever a file had to be
converted, the file exactly as the phone sent it is moved to `/photos/originals/`. Only you, as admin,
can download it. Keeping them means items can be redone later, for example in 4K or with a better
converter, and you have the untouched original if something ever looks wrong.

The cost is storage: for a busy family (3,000 iPhone photos and 100 minutes of 4K video a year) the
site needs about 35 GB a year without the archive and about 85 GB with it. A 1 TB share lasts more
than 10 years either way. Set `KEEP_ORIGINALS=false` to stop keeping new originals; **Delete all
archived originals** on the admin page frees the space already used. Uploads that didn't work always
keep their file, so they can be tried again.

**Limits.** One file can be up to `MAX_UPLOAD_GB` (50 GB) and a video up to `MAX_VIDEO_MINUTES`
(120 minutes).

### What's in each folder

| Where | What | Notes |
|---|---|---|
| `/photos/library/` | The photos and videos everyone sees | The files that matter most |
| `/photos/originals/` | Archived originals (admin only) | Only with `KEEP_ORIGINALS=true` |
| `/photos/.backups/` | Nightly copies of the database, the newest 7 | |
| `/photos/.incoming/`, `/photos/.work/` | Uploads and conversions in progress | Temporary; cleaned up automatically |
| `/config/app.sqlite` | The database: albums, memories, names, who added what | |
| `/config/cache/` | Previews and thumbnails | |
| `/config/outbox/` | Saved emails when no email server is set | |
| `/config/tmp/` | Scratch space while converting | Temporary |

## Backups

Back up both folders. Some backup tools skip folders whose names start with a dot, so check that
`.backups` is included.

- **The photos share** (`/mnt/user/family-photos`): `library/`, `originals/` and `.backups/`. The
  database is copied into `.backups/` every night (the last 7 days are kept), so this share on its
  own holds everything, with the database at most a day old. Skip `.incoming/` and `.work/`.
- **App data** (`/mnt/user/appdata/family-photos`): the live database and the previews. The
  **Appdata Backup** plugin stops the container for a moment while it copies, so the database copy is
  consistent.

Keep at least one copy away from the server (another machine, a USB disk you rotate, or a cloud
backup).

**Restoring the database** from a nightly copy: stop the container, copy
`/mnt/user/family-photos/.backups/app-YYYY-MM-DD.sqlite` to
`/mnt/user/appdata/family-photos/app.sqlite`, delete `app.sqlite-wal` and `app.sqlite-shm` next to
it if they exist, and start the container.

## Updating

- **Docker** tab → **Check for Updates** → **apply update**, or let the **Auto Update Applications**
  plugin do it. The database is upgraded automatically when the new version starts.
- `latest` follows the `main` branch. To move only when you choose, set **Repository** to a version,
  e.g. `ghcr.io/brewer-michael/family-photos:1.2` (follows 1.2.x fixes) or `…:1.2.3` (exactly that).
- A new release is published by pushing a git tag like `v1.2.3`. GitHub then builds the image,
  smoke-tests it and pushes `1.2.3`, `1.2` and `sha-<commit>`.
- Don't download the template again (it would replace your settings). If a release adds a setting
  you want, add it at the bottom of the container's edit page with **Add another Path, Port,
  Variable, Label or Device**.

## Troubleshooting

Start with the container's **Logs** (Docker tab → the container's icon → **Logs**) and the admin page.

**The container stops right after starting.** The log starts with "Family Photos cannot start because
of its settings" and lists what to fix, for example a missing `PUBLIC_URL`.

**"Permission denied" / EACCES in the log.** Files are written as `PUID`:`PGID` (99:100, Unraid's
nobody:users). At every start the container fixes the owner of the app data folder and of the
top-level folders in the photos share. It never changes the photos inside the share, which could take
hours. If you changed `PUID`/`PGID` or copied files in as root, run **Tools → New Permissions** on the
`family-photos` share, or in the terminal: `chown -R 99:100 /mnt/user/family-photos`.

**Videos take very long, or Plex stutters while videos are converting.** Near the top of the log a line
like `[entrypoint] cgroup v2: cpu.weight=… ` shows the CPU share. If the next line starts with
"Hint: no --cpu-shares is set", put `--cpu-shares=128 --memory=4g` back into **Extra Parameters**.
Lower `VIDEO_THREADS` (e.g. `2`) to leave more cores free, or raise it to finish videos sooner. CPU
pinning set in Unraid is respected.

**Emails don't arrive.** On the admin page, press **Send test email**; it shows the error if sending
failed. Without `SMTP_HOST`, look in `/mnt/user/appdata/family-photos/outbox/` instead. Also check
the spam folder, that Gmail uses an app password, and that `SMTP_FROM` is an address your provider
allows. Requests whose email failed can be resent from the admin page.

**Uploads stall or fail through the proxy.** With NPM, check `client_max_body_size 64m;` in the proxy
host's Advanced tab. Uploads continue where they stopped; keeping the page open finishes them.

**Family members are told "Too many tries".** They typed a wrong code 10 times in 15 minutes and must
wait, or, if it happens to everyone, the proxy isn't in `TRUSTED_PROXIES`, so everyone looks like one
visitor. QR cards work in the meantime.

**The admin page lists problems under "Media tools".** The official image always has everything; make
sure you're running it (Repository `ghcr.io/brewer-michael/family-photos`) and update it.

**Forgot the admin password.** Set a new `ADMIN_PASSWORD` in the template and click **Apply**.

**The container restarts while converting very large files.** `--memory=4g` covers a 200-megapixel
photo and a 4K video at the same time. If the log shows restarts and the server has memory to spare,
raise it to `--memory=6g`.

## All settings

Set in the Unraid template. Empty means "use the default". Unraid also passes your time zone (`TZ`).

| Setting | Default | What it does |
|---|---|---|
| `PUBLIC_URL` | (required) | The site address, without a path. Used in emails and QR cards |
| `FAMILY_PASSWORD` | (required) | The family code |
| `ADMIN_PASSWORD` | (required) | Admin page password; at least 8 characters, not the family code |
| `ADMIN_EMAIL` | empty | Where removal requests and problem alerts go |
| `ADMIN_NAME` | the site admin | Your first name, as the family sees it |
| `SITE_TITLE` | Family Photos | Name at the top of the site and in emails |
| `SMTP_HOST` | empty | Email server; empty saves emails to `/config/outbox` |
| `SMTP_PORT` | 587 | 465 means TLS from the start |
| `SMTP_USER`, `SMTP_PASS` | empty | Email login |
| `SMTP_FROM` | site title + user | Sender address |
| `KEEP_ORIGINALS` | true | Archive the original of every converted item |
| `MAX_UPLOAD_GB` | 50 | Largest single file, in GB |
| `MAX_VIDEO_MINUTES` | 120 | Longest video |
| `VIDEO_THREADS` | auto | CPU threads per video; auto is half the cores, at least 2 |
| `TRUSTED_PROXIES` | private | Who may report the visitor's address: IPs, ranges, `private` or `none` |
| `PUID`, `PGID` | 99, 100 | Owner of the files the app writes |
| `UMASK` | 022 | Permissions for new files (`002` adds group write) |

**Extra Parameters** (required): `--cpu-shares=128 --memory=4g`.

Rarely needed: `HEIF_DEC_BIN`, `EXIFTOOL_BIN`, `FFMPEG_BIN` and `FFPROBE_BIN` point at other tool
binaries. The image itself sets `PORT=3000`, `CONFIG_DIR=/config`, `PHOTOS_DIR=/photos`,
`PROTOCOL_HEADER=x-forwarded-proto`, `BODY_SIZE_LIMIT=64M` and `UV_THREADPOOL_SIZE=8`.
[`.env.example`](.env.example) describes every setting in detail.

## Development

SvelteKit 3 and Svelte 5 on Node.js (22.17 or newer; the image runs 24), SQLite through
better-sqlite3, sharp, ffmpeg, libheif and exiftool. [`docs/PLAN.md`](docs/PLAN.md) is the design
and [`docs/media-pipeline.md`](docs/media-pipeline.md) the detailed media spec. The media worker is a
separate entry point (see [`src/worker/README.md`](src/worker/README.md)).

The media tools, on Ubuntu 24.04 (libheif 1.17 there has `heif-convert` instead of `heif-dec`; the app
uses either):

```sh
sudo apt install ffmpeg libimage-exiftool-perl unzip \
  libheif-examples libheif-plugin-libde265 libheif-plugin-dav1d libheif-plugin-ffmpegdec libheif-plugin-x265
```

Run it locally:

```sh
npm ci --ignore-scripts && npm run prepare
cp .env.example .env        # then delete the CONFIG_DIR and PHOTOS_DIR lines (defaults: ./data/…)
                            # and set PUBLIC_URL=http://localhost:5173
npm run build:worker        # the web app starts the media worker from build-worker/
node --env-file=.env node_modules/vite/bin/vite.js dev
```

`--ignore-scripts` keeps npm from compiling better-sqlite3, which ships ready-made binaries; a plain
`npm ci` works too when Python and a C++ compiler are installed. The Dockerfile and CI install the same
way.

`npm run dev:worker` rebuilds the worker on change. For the production build:
`npm run build`, then `node --env-file=.env server.js` (with `PUBLIC_URL=http://localhost:3000`).

| Command | What it runs |
|---|---|
| `npm run check` | svelte-check and TypeScript |
| `npm test` | Unit tests (Vitest) |
| `npm run test:media` | Photo and video pipeline tests with the real ffmpeg, libheif and exiftool. Tests that need ffmpeg 7.1 skip on older versions with a message |
| `npm run build && npm run test:e2e` | Playwright tests against the built app, on a free port with temporary folders (Chromium; run `npx playwright install chromium` once) |
| `npm run smoke:worker` | Starts each built worker lane and sends it a test job |
| `docker build -t family-photos . && sh scripts/ci-docker-smoke.sh family-photos` | Builds the image and runs the same smoke test as CI |

**Continuous integration** (`.github/workflows/`):

- `ci.yml`, on every push and pull request: check, unit tests, build and end-to-end tests on Node 22
  and 24; plus **media-parity**, which runs `npm run test:media` inside `node:24-trixie-slim` with
  exactly the image's media packages (installed by `docker/media-tools.sh`), so tests that skip on a
  laptop run there.
- `docker.yml`, on `main`, `v*` tags and pull requests: builds the image, smoke-tests it
  (`scripts/ci-docker-smoke.sh`: healthy, sign-in page served, files owned by 99:100, both worker
  lanes start, time zone, media self-check passes) and, except for pull requests, pushes it to
  `ghcr.io/brewer-michael/family-photos`.

## Release checklist (real devices)

Automated tests can't hold a real phone. Before telling the family about a release, check by hand,
on the site as it's really reached (through Cloudflare or NPM):

- [ ] **iPhone (iOS 17 and iOS 18):** a HEIC photo arrives as a JPEG that looks right (colours,
      rotation).
- [ ] **iPhone:** an HDR / Dolby Vision video arrives as an MP4 that looks right (not washed out or
      too dark).
- [ ] **iPhone:** "Save to my phone" puts both the photo and the video in the camera roll on the
      **date they were taken**, not today.
- [ ] **iPhone:** a slow-motion clip plays slowly, a spatial-audio clip (iPhone 16) plays with sound,
      and a ProRAW photo arrives.
- [ ] **Android:** saves and plays a video that came from an iPhone.
- [ ] **Windows:** the Photos app opens a downloaded JPEG and MP4.
- [ ] **Through Cloudflare Tunnel or NPM:** a 500 MB video upload finishes.

## License

[MIT](LICENSE)
