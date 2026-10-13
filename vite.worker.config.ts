/**
 * Second build: the media worker lanes (src/worker/main.ts → build-worker/worker.js).
 * An SSR (Node) bundle: `#lib/*` and our sources are bundled; every package in
 * node_modules stays external and is loaded at runtime from the production node_modules.
 */
import { builtinModules } from 'node:module';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};
const deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];

export default defineConfig({
	// The worker never needs the Svelte/Kit plugins.
	plugins: [],
	publicDir: false,
	logLevel: 'warn',
	ssr: {
		target: 'node',
		// Externalise every bare package import (only `#lib/*` and relative imports are bundled).
		external: true,
		noExternal: []
	},
	build: {
		ssr: 'src/worker/main.ts',
		outDir: 'build-worker',
		emptyOutDir: true,
		target: 'node22',
		sourcemap: true,
		minify: false,
		copyPublicDir: false,
		rolldownOptions: {
			external: (id: string) =>
				id.startsWith('node:') ||
				builtinModules.includes(id) ||
				deps.some((d) => id === d || id.startsWith(`${d}/`)),
			output: {
				format: 'esm',
				entryFileNames: 'worker.js',
				chunkFileNames: 'chunks/[name]-[hash].js'
			}
		}
	}
});
