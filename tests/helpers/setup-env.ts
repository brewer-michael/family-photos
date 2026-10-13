import { afterAll } from 'vitest';
import { installTestEnv, removeTestEnv } from './env';

installTestEnv();

afterAll(() => {
	removeTestEnv();
});
