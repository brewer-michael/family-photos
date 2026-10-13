import type { RequestHandler } from './$types';
import { tusHandler } from '#lib/server/uploads/tus';

// tus endpoint. Only these methods are exported on purpose: GET/DELETE get SvelteKit's 405,
// so raw uploads can never be downloaded or deleted through tus (see uploads/tus.ts).
export const POST: RequestHandler = (event) => tusHandler.handle(event);
export const PATCH: RequestHandler = (event) => tusHandler.handle(event);
export const HEAD: RequestHandler = (event) => tusHandler.handle(event);
export const OPTIONS: RequestHandler = (event) => tusHandler.handle(event);
