import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-node';
import { defineConfig } from 'vite';

// SvelteKit 3: all Kit options live here (svelte.config.js is no longer supported).
// Imports use `#lib/...` (package.json "imports"), not `$lib`.
export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapter({ out: 'build', precompress: true }),
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['self'],
					'script-src': ['self'],
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'blob:', 'data:'],
					'media-src': ['self', 'blob:'],
					'connect-src': ['self'],
					'font-src': ['self'],
					'worker-src': ['self', 'blob:'],
					'manifest-src': ['self'],
					'object-src': ['none'],
					'base-uri': ['self'],
					'form-action': ['self'],
					'frame-ancestors': ['none']
				}
			}
		})
	],
	server: {
		port: 5173
	}
});
