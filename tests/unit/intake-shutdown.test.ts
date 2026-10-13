/**
 * boot.ts shutdown(): intake and the lanes are stopped (intake finishing the item it is on)
 * before the database is closed.
 */
import { describe, expect, it, vi } from 'vitest';
import { closeDb } from '#lib/server/db';
import { stopIntake } from '#lib/server/intake';
import { stopMaintenance } from '#lib/server/maintenance';
import { stopQueue } from '#lib/server/queue';
import { shutdown } from '#lib/server/boot';

vi.mock('#lib/server/db', () => ({ closeDb: vi.fn(), getDb: vi.fn() }));
vi.mock('#lib/server/intake', () => ({ startIntake: vi.fn(), stopIntake: vi.fn() }));
vi.mock('#lib/server/queue', () => ({ startQueue: vi.fn(), stopQueue: vi.fn(async () => {}) }));
vi.mock('#lib/server/maintenance', () => ({ startMaintenance: vi.fn(), stopMaintenance: vi.fn() }));

describe('shutdown', () => {
	it('waits for intake and the lanes before closing the database, once', async () => {
		let finishItem!: () => void;
		vi.mocked(stopIntake).mockReturnValue(new Promise<void>((r) => (finishItem = r)));
		const done = shutdown();
		expect(shutdown()).toBe(done);
		await new Promise((r) => setTimeout(r, 20));
		expect(stopMaintenance).toHaveBeenCalledTimes(1);
		expect(stopIntake).toHaveBeenCalledTimes(1);
		expect(stopQueue).toHaveBeenCalledTimes(1);
		expect(closeDb).not.toHaveBeenCalled();
		finishItem();
		await done;
		expect(closeDb).toHaveBeenCalledTimes(1);
	});
});
