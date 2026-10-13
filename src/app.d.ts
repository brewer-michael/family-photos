// See https://svelte.dev/docs/kit/types#app.d.ts
import type { Role } from '#lib/server/auth';

declare global {
	namespace App {
		interface Locals {
			/** null = no valid fp_access cookie. 'admin' also has family access. */
			role: Role | null;
			/** Random id from the fp_device cookie (null until /name). Owner identity for uploads/memories. */
			deviceId: string | null;
			/** First name from the fp_device cookie (null until /name). */
			name: string | null;
		}
		interface Error {
			message: string;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
