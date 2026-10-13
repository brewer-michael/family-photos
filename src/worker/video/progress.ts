/**
 * Runs the conversion ffmpeg with `-progress pipe:1`: reports pct/ETA, kills it when out_time
 * stops advancing for 180 s (a stall) or after the hard cap of 120 s + 30 × duration, and maps
 * failures to MediaError.
 */
import { MediaError } from '#lib/shared/errors';
import { run, RunError } from '../spawn';

export const STALL_MS = 180_000;

/** Hard cap for one conversion: 120 s + 30 × source duration. */
export function hardCapMs(sourceDurationS: number): number {
	return (120 + 30 * sourceDurationS) * 1000;
}

/** Parses `-progress` key=value lines; `update()` returns pct (0–99) and ETA at the end of each block. */
export class ProgressParser {
	outTimeS = 0;
	speed: number | null = null;
	/** When out_time last moved forward (ms, from `now`). */
	lastAdvanceMs: number;

	constructor(
		private readonly expectedS: number,
		now: number = Date.now()
	) {
		this.lastAdvanceMs = now;
	}

	/** Feeds one line; returns the progress at the end of a block (`progress=continue|end`), else null. */
	line(l: string, now: number = Date.now()): { pct: number; etaS?: number } | null {
		const eq = l.indexOf('=');
		if (eq < 0) return null;
		const key = l.slice(0, eq).trim();
		const val = l.slice(eq + 1).trim();
		if (key === 'out_time_us' || key === 'out_time_ms') {
			// Both are microseconds (out_time_ms is misnamed); 'N/A' before the first frame.
			const t = Number(val) / 1e6;
			if (Number.isFinite(t) && t > this.outTimeS) {
				this.outTimeS = t;
				this.lastAdvanceMs = now;
			}
		} else if (key === 'speed') {
			const s = parseFloat(val);
			this.speed = Number.isFinite(s) && s > 0 ? s : null;
		} else if (key === 'progress') {
			const pct = this.expectedS > 0 ? Math.min(99, Math.floor((100 * this.outTimeS) / this.expectedS)) : 0;
			const etaS = this.speed ? Math.max(0, (this.expectedS - this.outTimeS) / this.speed) : undefined;
			return etaS === undefined ? { pct } : { pct, etaS };
		}
		return null;
	}
}

/** Decode/demux errors in ffmpeg's stderr: the source itself is broken. */
const CORRUPT_STDERR = /Invalid data found|moov atom not found|error while decoding|Invalid NAL|corrupt|truncat|Error splitting the input|could not find codec parameters|Packet mismatch/i;

/** RunError → MediaError. Timeouts, stalls, signals and spawn failures are retryable. */
export function toMediaError(e: unknown, what: string, stalled = false): unknown {
	if (!(e instanceof RunError)) return e;
	const tail = e.stderr.trim().split('\n').slice(-5).join(' | ');
	if (stalled) return new MediaError('retryable', `${what} stalled: no progress for ${STALL_MS / 1000} s`);
	if (e.reason === 'exit' && e.code !== null && CORRUPT_STDERR.test(e.stderr)) {
		return new MediaError('corrupt', `${what} could not read the video: ${tail}`);
	}
	return new MediaError('retryable', `${e.message}${tail && !e.message.includes(tail) ? ` (${tail})` : ''}`);
}

export interface ConversionOptions {
	expectedDurationS: number;
	sourceDurationS: number;
	signal: AbortSignal;
	progress(pct: number, etaS?: number): void;
}

/** Runs ffmpeg for the conversion. Rejects with MediaError. */
export async function runConversion(ffmpegBin: string, args: readonly string[], o: ConversionOptions): Promise<void> {
	const parser = new ProgressParser(o.expectedDurationS);
	const local = new AbortController();
	const forward = () => local.abort(o.signal.reason);
	if (o.signal.aborted) forward();
	o.signal.addEventListener('abort', forward, { once: true });
	let stalled = false;
	const watchdog = setInterval(() => {
		if (Date.now() - parser.lastAdvanceMs > STALL_MS) {
			stalled = true;
			local.abort(new Error('stalled'));
		}
	}, 5_000);
	try {
		await run(ffmpegBin, args, {
			timeoutMs: hardCapMs(o.sourceDurationS),
			signal: local.signal,
			ionice: true,
			collectStdout: false,
			onStdoutLine: (l) => {
				const p = parser.line(l);
				if (p) o.progress(p.pct, p.etaS);
			}
		});
	} catch (e) {
		throw toMediaError(e, 'ffmpeg', stalled);
	} finally {
		clearInterval(watchdog);
		o.signal.removeEventListener('abort', forward);
	}
}
