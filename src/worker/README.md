# Media worker lanes

`src/worker/main.ts` is a separate entry point, built by `vite build --config vite.worker.config.ts`
into **`build-worker/worker.js`** (an ESM Node bundle; `node_modules` stay external, `#lib/*` is
bundled in). `npm run build` builds the app and the worker. sharp/heif-dec/ffmpeg/exiftool only ever
run here, never in the web process.

## Starting a lane

```
nice -n 10 node --max-old-space-size=512 build-worker/worker.js --lane=photo   # photo lane
nice -n 15 node --max-old-space-size=512 build-worker/worker.js --lane=video   # video lane
```

Spawned by `src/lib/server/queue.ts` with `stdio: ['ignore', 'inherit', 'inherit', 'ipc']` and the
same environment as the web process (it reads the same `CONFIG_DIR`, `PHOTOS_DIR`, … via
`#lib/server/config`). It exits with code 2 without `--lane` or without an IPC channel, and exits
by itself when the IPC channel disconnects (the web process died).

## Protocol (`#lib/shared/worker-protocol`)

| Direction | Message |
|---|---|
| worker → main | `{type:'hello', lane, pid}` once the DB is open |
| main → worker | `{type:'job', id, kind}` — the row is already `processing` (main called `media.claimForProcessing`) |
| worker → main | `{type:'progress', id, pct, etaS?}` (throttled to 2/s) |
| worker → main | `{type:'done', id, outcome:'ready'|'failed'|'duplicate', errorCode?, detail?}` exactly once per job |
| main → worker | `{type:'cancel', id}` aborts `ctx.signal`; `{type:'shutdown'}` finishes/aborts and exits |

Jobs run one at a time, in the order received.

## Who writes the database

- **Success** is committed by the job itself (`processPhoto` / `processVideo` call `media.markReady`
  as part of the commit order: write → verify → fsync → rename into `library/` → DB → archive/delete
  source).
- **Failure** is reported, not written: a thrown `MediaError(code, detail)` becomes
  `done {outcome:'failed', errorCode: code}`; any other exception becomes `errorCode:'retryable'`.
  The main process decides retry (`media.requeue`, attempts < 3) vs `media.markFailed`. A crash or
  timeout (no `done`) is a retryable failure too.
- **After `markReady` returns true the item is done.** Don't throw from the remaining steps
  (archive/delete the source): log and carry on. If a failure still reaches the main process
  (timeout, crash), `requeue`/`markFailed` return false for the `ready` row and leave it alone.

## Job modules

```ts
// src/worker/photo.ts
export async function processPhoto(id: string, ctx: WorkerContext): Promise<void>;
// src/worker/video.ts
export async function processVideo(id: string, ctx: WorkerContext): Promise<void>;
```

`WorkerContext` (`src/worker/context.ts`): `{ db, config, paths, lane, progress(pct, etaS?), signal, log }`.
Use `media.sourcePath(row)` for the source file, `ctx.paths.tmpDir(id)` for intermediates,
`ctx.paths.workDir(id)` for the canonical output, and clean both in `finally`.

Test hook: `FP_TEST_CRASH_IDS=<id>,…` makes the worker `process.abort()` when it receives those ids.

## Development

`npm run dev` runs only the web app. Build the worker once with `npm run build:worker` (or keep
`npm run dev:worker` running in another terminal to rebuild on change); the web process spawns
`config.workerEntry` (`WORKER_ENTRY`, default `./build-worker/worker.js`).

`npm run smoke:worker` (after `npm run build` and one start of the web server against the same
`CONFIG_DIR`) spawns each lane over IPC, sends a job for a non-existent id and expects
`done {outcome:'failed'}`.
