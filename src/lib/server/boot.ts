/**
 * Web-process startup and shutdown, called from hooks.server.ts `init`.
 * Guarded by globalThis so dev-server reloads and double init are harmless.
 */
import { getConfig, ConfigError } from './config';
import { ensureDirs } from './paths';
import { closeDb, getDb } from './db';
import { restoreAccessGen } from './repo/settings';
import { startIntake, stopIntake } from './intake';
import { startQueue, stopQueue } from './queue';
import { startMaintenance, stopMaintenance } from './maintenance';

const BOOTED = Symbol.for('family-photos.booted');
/** server.js awaits globalThis[SHUTDOWN]() before exiting. */
export const SHUTDOWN = Symbol.for('family-photos.shutdown');

type G = typeof globalThis & { [BOOTED]?: boolean; [SHUTDOWN]?: () => Promise<void> };
const g = globalThis as G;

let shuttingDown: Promise<void> | null = null;

/**
 * Stops timers, intake (waiting for the item it is on) and the lanes (killing worker children),
 * then closes the DB. Idempotent.
 */
export function shutdown(): Promise<void> {
	shuttingDown ??= (async () => {
		try {
			stopMaintenance();
			const stopped = await Promise.allSettled([stopIntake(), stopQueue()]);
			for (const r of stopped) if (r.status === 'rejected') console.error('[shutdown]', r.reason);
		} catch (e) {
			console.error('[shutdown]', e);
		} finally {
			closeDb();
		}
	})();
	return shuttingDown;
}

export function boot(): void {
	if (g[BOOTED]) return;
	let config;
	try {
		config = getConfig();
	} catch (e) {
		if (e instanceof ConfigError) {
			console.error(`\n${e.message}\n`);
			(e as ConfigError & { logged?: boolean }).logged = true;
		}
		throw e;
	}
	for (const w of config.warnings) console.warn(`[config] ${w}`);
	ensureDirs();
	getDb(); // migrations + first-boot seed
	restoreAccessGen(); // a database restored from an older copy keeps the last "Reset access"
	g[BOOTED] = true;
	g[SHUTDOWN] = shutdown;
	process.once('sveltekit:shutdown' as never, () => void shutdown());
	startIntake();
	startQueue();
	startMaintenance();
}
