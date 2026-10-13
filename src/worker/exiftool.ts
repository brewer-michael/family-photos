/**
 * The one exiftool instance a worker lane uses (photo and video lanes each have their own
 * process, so each gets its own instance). Runs the system exiftool (`libimage-exiftool-perl`,
 * /usr/bin/exiftool) in -stay_open mode. EXIFTOOL_BIN overrides the binary, as for the startup
 * self-check (config.exiftoolBin); EXIFTOOL_PATH is still read when EXIFTOOL_BIN is unset.
 *
 * Use `exiftool()` for reads/writes and `endExiftool()` on lane shutdown.
 */
import { existsSync } from 'node:fs';
import { ExifTool } from 'exiftool-vendored';

let instance: ExifTool | null = null;

/** EXIFTOOL_BIN, else EXIFTOOL_PATH, else /usr/bin/exiftool, else exiftool-vendored's own. */
export function exiftoolBinary(): string | undefined {
	const fromEnv = process.env.EXIFTOOL_BIN?.trim() || process.env.EXIFTOOL_PATH?.trim();
	if (fromEnv) return fromEnv;
	return existsSync('/usr/bin/exiftool') ? '/usr/bin/exiftool' : undefined;
}

export function exiftool(): ExifTool {
	if (!instance) {
		const exiftoolPath = exiftoolBinary();
		instance = new ExifTool({
			maxProcs: 1,
			taskTimeoutMillis: 60_000,
			...(exiftoolPath ? { exiftoolPath } : {})
		});
	}
	return instance;
}

export async function endExiftool(): Promise<void> {
	const current = instance;
	instance = null;
	if (current) await current.end();
}
