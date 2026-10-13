import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { getConfig } from '#lib/server/config';

// Sanity check that the media toolchain the lanes rely on is installed (CI: the trixie image).
function run(bin: string, args: string[]): string {
	return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function which(bin: string): boolean {
	try {
		execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

describe('media toolchain', () => {
	it('has ffmpeg and ffprobe with libx264', () => {
		const c = getConfig();
		expect(run(c.ffprobeBin, ['-version'])).toMatch(/ffprobe version/);
		expect(run(c.ffmpegBin, ['-hide_banner', '-encoders'])).toMatch(/libx264/);
	});

	it('has exiftool', () => {
		expect(run(getConfig().exiftoolBin ?? 'exiftool', ['-ver']).trim()).toMatch(/^\d+\.\d+/);
	});

	it('has a HEIF decoder (heif-dec, or heif-convert on libheif < 1.18)', () => {
		const c = getConfig();
		const bin = c.heifDecBin ?? (which('heif-dec') ? 'heif-dec' : 'heif-convert');
		expect(which(bin), `${bin} not found`).toBe(true);
	});
});
