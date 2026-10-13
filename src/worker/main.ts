/**
 * Worker lane entry: node build-worker/worker.js --lane=photo|video (spawned by queue.ts with
 * an IPC channel). Opens its own DB connection (no migrations), sends `hello`, finishes sources
 * a dead lane left unsettled after a commit (./settle.ts), then runs one `job` at a time and
 * answers each with exactly one `done`. See src/worker/README.md.
 */
import { useLaneConfig } from '#lib/server/config';
import * as paths from '#lib/server/paths';
import { openDb, setDb, closeDb } from '#lib/server/db';
import * as media from '#lib/server/repo/media';
import { MediaError, errorDetail } from '#lib/shared/errors';
import {
	isMainToWorker,
	parseLaneArg,
	type DoneMessage,
	type Lane,
	type WorkerToMain
} from '#lib/shared/worker-protocol';
import { createLogger, type WorkerContext } from './context';
import { processPhoto } from './photo';
import { processVideo } from './video';
import { settleInterrupted } from './settle';
import { rebuildPreviews } from './previews';

const lane: Lane | null = parseLaneArg(process.argv.slice(2));
if (!lane) {
	console.error('usage: worker.js --lane=photo|video');
	process.exit(2);
}
if (!process.send) {
	console.error('worker.js must be started with an IPC channel (stdio "ipc")');
	process.exit(2);
}

const log = createLogger(`[worker:${lane}]`);
// Started without the family code, admin password and SMTP password (queue.ts); they are dropped
// here too, so ffmpeg/heif-dec/exiftool never inherit them (config.ts SECRET_ENV).
const config = useLaneConfig();
const db = openDb({ migrate: false });
setDb(db);

function send(msg: WorkerToMain): void {
	if (process.connected) process.send!(msg);
}

/** Test hook: FP_TEST_CRASH_IDS=<id>[,<id>] makes the worker abort on those jobs. */
const crashIds = new Set((process.env.FP_TEST_CRASH_IDS ?? '').split(',').filter(Boolean));

let current: { id: string; abort: AbortController } | null = null;
let stopping = false;
/** Jobs run one after another, after the sources an interrupted job left unsettled. */
let chain: Promise<void> = settleInterrupted(lane, log).then(
	(n) => {
		if (n > 0) log.warn(`archived or deleted the sources of ${n} item(s) an interrupted job had committed`);
	},
	(e: unknown) => log.error('could not settle the sources of interrupted jobs', { error: errorDetail(e, 500) })
);

async function runJob(id: string, kind: 'photo' | 'video', task?: 'previews'): Promise<void> {
	const abort = new AbortController();
	current = { id, abort };
	let lastSent = 0;
	const ctx: WorkerContext = {
		db,
		config,
		paths,
		lane: lane!,
		signal: abort.signal,
		log,
		progress(pct, etaS) {
			const now = Date.now();
			if (now - lastSent < 500) return;
			lastSent = now;
			const p = Math.max(0, Math.min(99, Math.floor(pct)));
			send({ type: 'progress', id, pct: p, ...(etaS !== undefined && Number.isFinite(etaS) ? { etaS: Math.round(etaS) } : {}) });
		}
	};
	let done: DoneMessage;
	try {
		if (crashIds.has(id)) process.abort();
		const row = media.getById(id);
		if (!row) throw new MediaError('unsupported', `media ${id} not found`);
		// A redo (admin "Redo them") runs on a row that stays `ready` (media.claimRedo).
		// A previews job (./previews.ts) runs on a ready row it never changes.
		if (task !== 'previews' && row.status !== 'processing' && !media.isRedo(row)) {
			throw new MediaError('retryable', `media ${id} is ${row.status}, expected processing`);
		}
		if (kind !== lane) throw new MediaError('retryable', `job kind ${kind} sent to the ${lane} lane`);
		if (task === 'previews') await rebuildPreviews(id, ctx);
		else if (kind === 'photo') await processPhoto(id, ctx);
		else await processVideo(id, ctx);
		done = { type: 'done', id, outcome: 'ready' };
	} catch (e) {
		if (MediaError.is(e)) {
			done = { type: 'done', id, outcome: 'failed', errorCode: e.code, detail: e.detail };
		} else {
			log.error(`job ${id} crashed`, { error: errorDetail(e, 500) });
			done = { type: 'done', id, outcome: 'failed', errorCode: 'retryable', detail: errorDetail(e) };
		}
	} finally {
		current = null;
	}
	send(done);
}

function shutdown(code = 0): void {
	if (stopping) return;
	stopping = true;
	current?.abort.abort(new Error('worker shutting down'));
	// Give the running job a moment to clean up its tmp/work dirs.
	const t = setTimeout(() => finish(code), 5000);
	t.unref();
	void chain.finally(() => finish(code));
}

function finish(code: number): never {
	try {
		closeDb();
	} catch {
		// ignore
	}
	process.exit(code);
}

process.on('message', (msg: unknown) => {
	if (!isMainToWorker(msg)) return;
	switch (msg.type) {
		case 'job':
			if (stopping) return;
			chain = chain.then(() => runJob(msg.id, msg.kind, msg.task === 'previews' ? 'previews' : undefined));
			break;
		case 'cancel':
			if (current?.id === msg.id) current.abort.abort(new Error('cancelled'));
			break;
		case 'shutdown':
			shutdown(0);
			break;
	}
});

// The main process went away (crash or exit): don't linger as an orphan.
process.on('disconnect', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

send({ type: 'hello', lane, pid: process.pid });
log.info(`ready (pid ${process.pid})`);
