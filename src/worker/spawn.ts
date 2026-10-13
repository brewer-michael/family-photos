/**
 * Run an external tool (heif-dec, ffmpeg, ffprobe, …) from a worker lane.
 *
 * - The lane process already runs at nice 10 (photo) / 15 (video); children inherit it.
 * - `ionice: true` prefixes `ionice -c2 -n7` when ionice exists (only matters under BFQ).
 * - `timeoutMs` is a hard cap; `stallMs` kills the process when it produces no output for that long.
 * - `signal` (e.g. ctx.signal) aborts the run.
 * - Kill sequence: SIGTERM, then SIGKILL after 10 s.
 * - Rejects with RunError on a non-zero exit, a timeout, a stall or an abort; stderr's tail is kept for
 *   diagnostics (admin-only `error_detail`).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface RunOptions {
	timeoutMs: number;
	stallMs?: number;
	signal?: AbortSignal;
	ionice?: boolean;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** Collect stdout into `stdout` (default true). Set false for large outputs streamed via onStdout. */
	collectStdout?: boolean;
	/** Max stdout bytes kept when collecting (default 64 MiB); beyond that the run fails. */
	maxStdoutBytes?: number;
	onStdout?(chunk: Buffer): void;
	/** Called for every complete stdout line (e.g. ffmpeg -progress pipe:1). */
	onStdoutLine?(line: string): void;
}

export interface RunResult {
	code: number;
	stdout: Buffer;
	stderr: string;
}

export type RunFailure = 'exit' | 'timeout' | 'stall' | 'aborted' | 'spawn' | 'output';

export class RunError extends Error {
	constructor(
		readonly reason: RunFailure,
		readonly cmd: string,
		readonly code: number | null,
		readonly stderr: string,
		message: string
	) {
		super(message);
		this.name = 'RunError';
	}
}

const STDERR_KEEP = 8 * 1024;
const IONICE = existsSync('/usr/bin/ionice') ? '/usr/bin/ionice' : null;

export function run(cmd: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
	const useIonice = opts.ionice && IONICE;
	const file = useIonice ? IONICE! : cmd;
	const argv = useIonice ? ['-c2', '-n7', cmd, ...args] : [...args];
	const collect = opts.collectStdout !== false;
	const maxOut = opts.maxStdoutBytes ?? 64 * 1024 * 1024;

	return new Promise<RunResult>((resolve, reject) => {
		if (opts.signal?.aborted) {
			reject(new RunError('aborted', cmd, null, '', `${cmd} aborted before start`));
			return;
		}
		const child = spawn(file, argv, {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const out: Buffer[] = [];
		let outBytes = 0;
		let stderr = '';
		let lineBuf = '';
		let failure: { reason: RunFailure; message: string } | null = null;
		let killTimer: NodeJS.Timeout | null = null;
		let stallTimer: NodeJS.Timeout | null = null;

		const kill = (reason: RunFailure, message: string) => {
			if (failure) return;
			failure = { reason, message };
			child.kill('SIGTERM');
			killTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
			killTimer.unref();
		};
		const armStall = () => {
			if (!opts.stallMs) return;
			if (stallTimer) clearTimeout(stallTimer);
			stallTimer = setTimeout(
				() => kill('stall', `${cmd} produced no output for ${Math.round(opts.stallMs! / 1000)} s`),
				opts.stallMs
			);
		};
		const hardTimer = setTimeout(
			() => kill('timeout', `${cmd} exceeded ${Math.round(opts.timeoutMs / 1000)} s`),
			opts.timeoutMs
		);
		const onAbort = () => kill('aborted', `${cmd} aborted`);
		opts.signal?.addEventListener('abort', onAbort, { once: true });
		armStall();

		child.stdout.on('data', (chunk: Buffer) => {
			armStall();
			if (collect) {
				outBytes += chunk.length;
				if (outBytes > maxOut) kill('output', `${cmd} stdout exceeded ${maxOut} bytes`);
				else out.push(chunk);
			}
			opts.onStdout?.(chunk);
			if (opts.onStdoutLine) {
				lineBuf += chunk.toString('utf8');
				let nl: number;
				while ((nl = lineBuf.indexOf('\n')) >= 0) {
					opts.onStdoutLine(lineBuf.slice(0, nl).replace(/\r$/, ''));
					lineBuf = lineBuf.slice(nl + 1);
				}
			}
		});
		child.stderr.on('data', (chunk: Buffer) => {
			armStall();
			stderr += chunk.toString('utf8');
			if (stderr.length > STDERR_KEEP * 2) stderr = stderr.slice(-STDERR_KEEP);
		});

		const cleanup = () => {
			clearTimeout(hardTimer);
			if (stallTimer) clearTimeout(stallTimer);
			if (killTimer) clearTimeout(killTimer);
			opts.signal?.removeEventListener('abort', onAbort);
		};
		child.on('error', (err) => {
			cleanup();
			reject(new RunError('spawn', cmd, null, stderr, `${cmd} failed to start: ${err.message}`));
		});
		child.on('close', (code, sig) => {
			cleanup();
			if (lineBuf && opts.onStdoutLine) opts.onStdoutLine(lineBuf);
			const tail = stderr.slice(-STDERR_KEEP);
			if (failure) {
				reject(new RunError(failure.reason, cmd, code, tail, failure.message));
			} else if (code !== 0) {
				const why = code === null ? `signal ${sig}` : `exit code ${code}`;
				reject(new RunError('exit', cmd, code, tail, `${cmd} failed (${why}): ${tail.trim().split('\n').slice(-3).join(' | ')}`));
			} else {
				resolve({ code: 0, stdout: Buffer.concat(out), stderr: tail });
			}
		});
	});
}
