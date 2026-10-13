/// <reference types="vite/client" />
/**
 * Migration registry. `import.meta.glob(..., { eager: true, query: '?raw' })` inlines
 * every migrations/NNN_*.sql file as a string at build time, so this works the same
 * in the SvelteKit server bundle, the worker bundle (vite.worker.config.ts) and vitest.
 *
 * To add a migration, drop `002_something.sql` next to 001_init.sql.
 */
export interface Migration {
	version: number;
	name: string;
	sql: string;
}

const files = import.meta.glob('./*.sql', {
	eager: true,
	query: '?raw',
	import: 'default'
}) as Record<string, string>;

export const migrations: readonly Migration[] = Object.entries(files)
	.map(([file, sql]) => {
		const name = file.replace(/^.*\//, '');
		const m = /^(\d{3})_[\w-]+\.sql$/.exec(name);
		if (!m) throw new Error(`Bad migration file name: ${name} (expected NNN_name.sql)`);
		return { version: Number(m[1]), name, sql };
	})
	.sort((a, b) => a.version - b.version);

for (let i = 0; i < migrations.length; i++) {
	if (migrations[i].version !== i + 1) {
		throw new Error(`Migrations must be numbered 001, 002, … without gaps (found ${migrations[i].name})`);
	}
}

export const LATEST_VERSION = migrations.length;
