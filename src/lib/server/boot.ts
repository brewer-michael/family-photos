/**
 * Web-process startup and shutdown, called from hooks.server.ts `init`.
 * Guarded by globalThis so dev-server reloads and double init are harmless.
 */
import { getConfig, ConfigError } from './config';
import { ensureDirs } from './paths';
import { closeDb, getDb } from './db';
import { startIntake } from './intake';
import { startQueue, stopQueue } from './queue';
import { startMaintenance, stopMaintenance } from './maintenance';

const BOOTED = Symbol.for('family-photos.booted');
/** server.js awaits globalThis[SHUTDOWN]() before exiting. */
export const SHUTDOWN = Symbol.for('family-photos.shutdown');

type G = typeof globalThis & { [BOOTED]?: boolean; [SHUTDOWN]?: () => Promise<void> };
const g = globalThis as G;

let shuttingDown: Promise<void> | null = null;

/** Stops lanes (killing worker children), timers and closes the DB. Idempotent. */
export function shutdown(): Promise<void> {
	shuttingDown ??= (async () => {
		try {
			stopMaintenance();
			await stopQueue();
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
	g[BOOTED] = true;
	g[SHUTDOWN] = shutdown;
	process.once('sveltekit:shutdown' as never, () => void shutdown());
	startIntake();
	startQueue();
	startMaintenance();
}
