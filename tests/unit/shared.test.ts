import { describe, expect, it } from 'vitest';
import { MediaError, ValidationError, errorDetail } from '#lib/shared/errors';
import { isMainToWorker, isWorkerToMain, parseLaneArg } from '#lib/shared/worker-protocol';
import { isMediaId, isStatus } from '#lib/shared/media-types';
import { estimateCostS, parseRate, summarize } from '#lib/server/media/probe';

describe('shared contracts', () => {
	it('MediaError carries a code and detail', () => {
		const e = new MediaError('corrupt', 'truncated');
		expect(e).toBeInstanceOf(Error);
		expect(e.code).toBe('corrupt');
		expect(e.detail).toBe('truncated');
		expect(e.retryable).toBe(false);
		expect(MediaError.is(e)).toBe(true);
		expect(MediaError.is({ name: 'MediaError', code: 'retryable', detail: 'x' })).toBe(true); // crossed a module boundary
		expect(MediaError.is(new Error('x'))).toBe(false);
		expect(new MediaError('retryable', 'x').retryable).toBe(true);
		expect(errorDetail(e)).toBe('truncated');
		expect(new ValidationError('bad', 'f').field).toBe('f');
	});

	it('worker protocol guards', () => {
		expect(parseLaneArg(['--lane=photo'])).toBe('photo');
		expect(parseLaneArg(['x', '--lane=video'])).toBe('video');
		expect(parseLaneArg(['--lane=audio'])).toBeNull();
		expect(isMainToWorker({ type: 'job', id: 'x', kind: 'photo' })).toBe(true);
		expect(isMainToWorker({ type: 'done' })).toBe(false);
		expect(isWorkerToMain({ type: 'progress', id: 'x', pct: 3 })).toBe(true);
		expect(isWorkerToMain(null)).toBe(false);
	});

	it('media-type guards', () => {
		expect(isMediaId('01HZX3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
		expect(isMediaId('01HZX3NDEKTSV4RRFFQ69G5FAI')).toBe(false); // no I in Crockford base32
		expect(isStatus('ready')).toBe(true);
		expect(isStatus('done')).toBe(false);
	});

	it('probe summary and cost estimate', () => {
		expect(parseRate('30000/1001')).toBeCloseTo(29.97, 2);
		expect(parseRate('0/0')).toBe(0);
		const p = summarize({
			format: { duration: '60' },
			streams: [
				{ index: 0, codec_type: 'video', codec_name: 'mjpeg', width: 320, height: 320, disposition: { attached_pic: 1 } },
				{ index: 1, codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, avg_frame_rate: '60/1', color_transfer: 'arib-std-b67' },
				{ index: 2, codec_type: 'audio', codec_name: 'aac' }
			]
		});
		expect(p).toMatchObject({ videoIndex: 1, width: 3840, height: 2160, fps: 60, hdr: true, hasAudio: true, durationS: 60 });
		// 60 s × (4K60 / 1080p30 = 8) × 1.5 HDR = 720 s
		expect(estimateCostS(p)).toBeCloseTo(720, 5);
		expect(estimateCostS(p, { remux: true })).toBeCloseTo(14.4, 5);
		expect(() => summarize({ format: {}, streams: [{ index: 0, codec_type: 'audio' }] })).toThrow(MediaError);
	});
});
