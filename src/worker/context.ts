/**
 * What a lane job receives. Built by main.ts for each job.
 */
import type { DB } from '#lib/server/db';
import type { Config } from '#lib/server/config';
import type { Lane } from '#lib/shared/worker-protocol';
import * as paths from '#lib/server/paths';

export type Paths = typeof paths;

export interface WorkerLogger {
	info(msg: string, extra?: Record<string, unknown>): void;
	warn(msg: string, extra?: Record<string, unknown>): void;
	error(msg: string, extra?: Record<string, unknown>): void;
}

export interface WorkerContext {
	/** This worker's own connection (also installed as the repo connection via setDb). */
	db: DB;
	config: Config;
	paths: Paths;
	lane: Lane;
	/** Report progress for the current job: pct 0–99, optional seconds remaining. Throttled by main.ts. */
	progress(pct: number, etaS?: number): void;
	/** Aborted when the main process sends `cancel` for this job or the worker is shutting down. */
	signal: AbortSignal;
	log: WorkerLogger;
}

export function createLogger(prefix: string): WorkerLogger {
	const fmt = (msg: string, extra?: Record<string, unknown>) =>
		`${prefix} ${msg}${extra && Object.keys(extra).length ? ' ' + JSON.stringify(extra) : ''}`;
	return {
		info: (m, e) => console.log(fmt(m, e)),
		warn: (m, e) => console.warn(fmt(m, e)),
		error: (m, e) => console.error(fmt(m, e))
	};
}
