import type { Cookies } from '@sveltejs/kit';

/** Minimal in-memory stand-in for SvelteKit's Cookies, recording the options of each set(). */
export class FakeCookies {
	readonly jar = new Map<string, string>();
	readonly options = new Map<string, Record<string, unknown> | undefined>();

	get = (name: string) => this.jar.get(name);
	getAll = () => [...this.jar].map(([name, value]) => ({ name, value }));
	set = (name: string, value: string, opts?: Record<string, unknown>) => {
		this.jar.set(name, value);
		this.options.set(name, opts);
	};
	delete = (name: string, opts?: Record<string, unknown>) => {
		this.jar.delete(name);
		this.options.set(name, opts);
	};
	serialize = (name: string, value: string) => `${name}=${value}`;
	parse = (() => {
		throw new Error('not implemented');
	}) as unknown as Cookies['parse'];

	asCookies(): Cookies {
		return this as unknown as Cookies;
	}
}
