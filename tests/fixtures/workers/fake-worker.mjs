// Fake worker lane for tests/unit/queue.test.ts. It speaks the IPC protocol of src/worker/main.ts
// (hello → job → progress/done) and behaves according to the item's source_name prefix:
//
//   ok              progress 50, commit (status=ready), done ready
//   hold            progress 42 (ETA 90 s), waits for <FAKE_WORKER_LOG>.release-<id>, then like ok
//   fail-retryable  done failed/retryable          fail-corrupt   done failed/corrupt
//   crash           exits with code 3              kill           SIGKILLs itself
//   hang            never answers                  stall          one progress message, then nothing
//   stubborn        ignores SIGTERM and `shutdown`, never answers (needs SIGKILL)
//   ready-then-fail commits, then reports failed/retryable
//   ready-then-crash commits, then exits with code 1
//   abortable       never answers until `shutdown`, then reports failed/retryable (like the real
//                   lane, whose running job is aborted) and exits
//
// A `job` with task 'previews' is logged as {type:'previews'}: it writes the item's cache files
// (thumb + display, or thumb + poster) and answers done ready, or done failed/corrupt when the
// source_name starts with previews-fail. The row is never touched.
//
// With FAKE_WORKER_HELLO=never the lane starts but never says hello (a hung startup).
// Every event is appended as a JSON line to FAKE_WORKER_LOG.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const lane = process.argv.find((a) => a.startsWith('--lane='))?.slice('--lane='.length);
const logFile = process.env.FAKE_WORKER_LOG;
const configDir = process.env.CONFIG_DIR;
if (!lane || !process.send || !logFile || !configDir) process.exit(2);

const db = new Database(path.join(configDir, 'app.sqlite'), { timeout: 5000 });
let stubborn = false;
/** @type {string | null} An `abortable` job in progress. */
let abortable = null;

/** @param {Record<string, unknown>} event */
function log(event) {
	fs.appendFileSync(/** @type {string} */ (logFile), JSON.stringify({ lane, pid: process.pid, ...event }) + '\n');
}

/** @param {Record<string, unknown>} msg */
function send(msg) {
	if (process.connected) process.send?.(msg);
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The commit step of a real lane: processing → ready. @param {string} id */
function markReady(id) {
	db.prepare(
		`UPDATE media SET status = 'ready', conversion = 'none', canonical_ext = 'jpg', canonical_size = 1, width = 1,
			height = 1, taken_ms = 0, upload_token = NULL, updated_at = ? WHERE id = ? AND status = 'processing'`
	).run(Date.now(), id);
}

/** @param {string} id */
async function waitForRelease(id) {
	while (!fs.existsSync(`${logFile}.release-${id}`)) await sleep(20);
}

/** @param {string} id */
async function runJob(id) {
	const row = /** @type {{ source_name: string, status: string, attempts: number } | undefined} */ (
		db.prepare('SELECT source_name, status, attempts FROM media WHERE id = ?').get(id)
	);
	const behaviour = (row?.source_name ?? '').replace(/(-\d+)?\.[^.]+$/, '');
	log({ type: 'job', id, behaviour, status: row?.status, attempts: row?.attempts });
	switch (behaviour) {
		case 'ok':
		case 'hold':
			if (behaviour === 'hold') {
				send({ type: 'progress', id, pct: 42, etaS: 90 });
				await waitForRelease(id);
			} else {
				send({ type: 'progress', id, pct: 50 });
			}
			markReady(id);
			send({ type: 'done', id, outcome: 'ready' });
			return;
		case 'fail-retryable':
			send({ type: 'done', id, outcome: 'failed', errorCode: 'retryable', detail: 'flaky disk' });
			return;
		case 'fail-corrupt':
			send({ type: 'done', id, outcome: 'failed', errorCode: 'corrupt', detail: 'broken bytes' });
			return;
		case 'crash':
			process.exit(3);
			return;
		case 'kill':
			process.kill(process.pid, 'SIGKILL');
			return;
		case 'stall':
			send({ type: 'progress', id, pct: 5 });
			return;
		case 'stubborn':
			stubborn = true;
			process.on('SIGTERM', () => log({ type: 'ignored-sigterm', id }));
			return;
		case 'ready-then-fail':
			markReady(id);
			send({ type: 'done', id, outcome: 'failed', errorCode: 'retryable', detail: 'cleanup failed after commit' });
			return;
		case 'ready-then-crash':
			markReady(id);
			process.exit(1);
			return;
		case 'abortable':
			abortable = id;
			return;
		default: // 'hang'
			return;
	}
}

/** A previews job: the cache files the real lane would rebuild from library/. @param {string} id */
function runPreviews(id) {
	const row = /** @type {{ source_name: string, kind: string, status: string } | undefined} */ (
		db.prepare('SELECT source_name, kind, status FROM media WHERE id = ?').get(id)
	);
	log({ type: 'previews', id, status: row?.status });
	if (row?.source_name.startsWith('previews-fail')) {
		send({ type: 'done', id, outcome: 'failed', errorCode: 'corrupt', detail: 'its file in library/ is missing' });
		return;
	}
	const dir = path.join(/** @type {string} */ (configDir), 'cache', id.slice(-2), id);
	fs.mkdirSync(dir, { recursive: true });
	for (const variant of ['thumb', row?.kind === 'video' ? 'poster' : 'display']) fs.writeFileSync(path.join(dir, `${variant}.webp`), 'webp');
	send({ type: 'done', id, outcome: 'ready' });
}

process.on('message', (/** @type {any} */ msg) => {
	if (msg?.type === 'shutdown') {
		log({ type: stubborn ? 'ignored-shutdown' : 'shutdown' });
		if (abortable) {
			process.send?.({ type: 'done', id: abortable, outcome: 'failed', errorCode: 'retryable', detail: 'ffmpeg aborted' }, () =>
				process.exit(0)
			);
		} else if (!stubborn) process.exit(0);
	}
	if (msg?.type === 'job') void (msg.task === 'previews' ? runPreviews(String(msg.id)) : runJob(String(msg.id)));
});
process.on('disconnect', () => process.exit(0));

log({
	type: 'start',
	execArgv: process.execArgv,
	argv: process.argv.slice(2),
	uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE,
	niceness: os.getPriority(),
	secrets: ['FAMILY_PASSWORD', 'ADMIN_PASSWORD', 'SMTP_PASS'].filter((k) => k in process.env)
});
if (process.env.FAKE_WORKER_HELLO !== 'never') send({ type: 'hello', lane, pid: process.pid });
