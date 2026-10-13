/**
 * Runs processPhoto() for one row that is already 'processing', in a fresh Node process, and
 * prints how long it took and the process's peak resident memory (Linux VmHWM, which includes
 * sharp/libvips native memory but not child processes such as heif-dec or exiftool).
 *
 * Used by the performance test in tests/media/photo.test.ts, which bundles this file with the
 * worker's Vite config and starts it like a photo lane (`node --max-old-space-size=512`), with the
 * test's CONFIG_DIR/PHOTOS_DIR in the environment:
 *
 *   node photo-perf-runner.js <media id>   →   {"ms":…,"peakMb":…,"idleMb":…} on the last line
 */
import fs from 'node:fs';
import { getConfig } from '#lib/server/config';
import { openDb, setDb } from '#lib/server/db';
import * as paths from '#lib/server/paths';
import { createLogger, type WorkerContext } from '../../src/worker/context';
import { endExiftool } from '../../src/worker/exiftool';
import { processPhoto } from '../../src/worker/photo';

function vmHwmMb(): number {
	const kb = /VmHWM:\s+(\d+) kB/.exec(fs.readFileSync('/proc/self/status', 'utf8'))?.[1];
	return Math.round(Number(kb) / 1024);
}

const id = process.argv[2];
if (!id) {
	console.error('usage: photo-perf-runner.js <media id>');
	process.exit(2);
}

const db = openDb({ migrate: false });
setDb(db);
const ctx: WorkerContext = {
	db,
	config: getConfig(),
	paths,
	lane: 'photo',
	progress: () => undefined,
	signal: new AbortController().signal,
	log: createLogger('[perf]')
};

// sharp is loaded and the database open: what an idle photo lane holds.
const idleMb = vmHwmMb();
const started = performance.now();
await processPhoto(id, ctx);
const ms = Math.round(performance.now() - started);
const peakMb = vmHwmMb();
await endExiftool();
db.close();
console.log(JSON.stringify({ ms, peakMb, idleMb }));
