import type { ErrorCode } from './media-types';

export type MediaErrorCode = ErrorCode;

/**
 * Thrown by media code (detect, probe, photo/video lanes) to fail an item with a
 * specific code. Anything else thrown inside a job is treated as `retryable`.
 *
 * - retryable:   transient (timeout, disk, crash) → re-queued until MAX_ATTEMPTS
 * - unsupported: we can't handle this type (SVG, PDF, DV profile 5, …)
 * - corrupt:     the bytes are broken (truncated, undecodable)
 * - too_large:   over a size/duration/pixel cap
 */
export class MediaError extends Error {
	readonly code: MediaErrorCode;
	/** Admin-only technical detail (stderr excerpt, probe facts, …). */
	readonly detail: string;

	constructor(code: MediaErrorCode, detail: string, options?: { cause?: unknown }) {
		super(`${code}: ${detail}`, options);
		this.name = 'MediaError';
		this.code = code;
		this.detail = detail;
	}

	get retryable(): boolean {
		return this.code === 'retryable';
	}

	static is(e: unknown): e is MediaError {
		return (
			e instanceof MediaError ||
			(typeof e === 'object' &&
				e !== null &&
				(e as { name?: unknown }).name === 'MediaError' &&
				typeof (e as { code?: unknown }).code === 'string')
		);
	}
}

/** Input validation failure from a repo/service function; routes map it to a 400. */
export class ValidationError extends Error {
	readonly field: string | undefined;
	constructor(message: string, field?: string) {
		super(message);
		this.name = 'ValidationError';
		this.field = field;
	}
}

/** Converts anything thrown into a short single-line string for error_detail/logs. */
export function errorDetail(e: unknown, max = 2000): string {
	let s: string;
	if (MediaError.is(e)) s = e.detail;
	else if (e instanceof Error) s = e.stack ?? `${e.name}: ${e.message}`;
	else s = String(e);
	return s.length > max ? s.slice(0, max) + '…' : s;
}
