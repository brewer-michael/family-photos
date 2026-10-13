// Smoke test for the built worker lane: spawns build-worker/worker.js --lane=<lane> with an IPC
// channel, waits for `hello`, sends a job for a non-existent media id and expects a `done`
// with outcome 'failed', then kills the child.
//
// Usage: CONFIG_DIR=… PHOTOS_DIR=… FAMILY_PASSWORD=… ADMIN_PASSWORD=… PUBLIC_URL=… node scripts/smoke-worker.mjs [photo|video]
// The database must already be migrated (start the web server once first).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const lane = process.argv[2] ?? 'photo';
const entry = fileURLToPath(new URL('../build-worker/worker.js', import.meta.url));
const child = spawn(process.execPath, [entry, `--lane=${lane}`], {
	stdio: ['ignore', 'inherit', 'inherit', 'ipc']
});

const fakeId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const timer = setTimeout(() => fail('timed out'), 15_000);

child.on('message', (/** @type {any} */ msg) => {
	console.log('smoke-worker: received', JSON.stringify(msg));
	if (msg.type === 'hello') {
		if (msg.lane !== lane) fail(`hello for wrong lane ${msg.lane}`);
		child.send({ type: 'job', id: fakeId, kind: lane });
	} else if (msg.type === 'done') {
		if (msg.id !== fakeId || msg.outcome !== 'failed' || !msg.errorCode) fail('unexpected done message');
		clearTimeout(timer);
		child.removeAllListeners('exit');
		child.on('exit', (code, signal) => {
			console.log(`smoke-worker: OK (worker exited code=${code} signal=${signal})`);
			process.exit(0);
		});
		child.kill('SIGTERM');
	}
});
child.on('exit', (code, signal) => fail(`worker exited early (code=${code} signal=${signal})`));

/** @param {string} why */
function fail(why) {
	console.error(`smoke-worker: FAIL — ${why}`);
	child.kill('SIGKILL');
	process.exit(1);
}
