import { defineConfig } from 'vitest/config';

// Two projects:
//   unit  — fast tests of server modules (no SvelteKit plugin; `#lib/*` resolves via package.json "imports")
//   media — photo/video pipeline tests with real binaries (heif-dec, ffmpeg, exiftool); long timeouts
// Each test file gets its own temp CONFIG_DIR/PHOTOS_DIR and env (tests/helpers/setup-env.ts).
export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'unit',
					include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts'],
					environment: 'node',
					pool: 'forks',
					setupFiles: ['tests/helpers/setup-env.ts'],
					testTimeout: 20_000
				}
			},
			{
				test: {
					name: 'media',
					include: ['tests/media/**/*.test.ts'],
					environment: 'node',
					pool: 'forks',
					setupFiles: ['tests/helpers/setup-env.ts'],
					testTimeout: 600_000,
					hookTimeout: 600_000,
					fileParallelism: false
				}
			}
		]
	}
});
