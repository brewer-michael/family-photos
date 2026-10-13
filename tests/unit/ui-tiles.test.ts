import { describe, expect, it } from 'vitest';
import type { TileDTO } from '#lib/client/dto';
import { fetchTilesUpTo, type TilePage } from '#lib/client/tiles';

/** An album of `total` tiles behind an endpoint that answers at most `cap` per request, like items/+server.ts. */
function album(total: number, cap = 500) {
	const tiles = Array.from({ length: total }, (_, i) => ({ id: `t${i}` }) as TileDTO);
	const asked: number[] = [];
	const fetchPage = async (before: string, limit: number): Promise<TilePage> => {
		asked.push(limit);
		const start = Number(before.slice(1));
		const items = tiles.slice(start, start + Math.min(limit, cap));
		const end = start + items.length;
		return { items, next: end < total ? `c${end}` : null };
	};
	return { fetchPage, asked };
}

describe('fetchTilesUpTo (refresh after "Show more")', () => {
	it('reloads more tiles than one request returns, page after page', async () => {
		const { fetchPage, asked } = album(5000);
		const page = await fetchTilesUpTo(fetchPage, 'c60', 720);
		expect(page.items).toHaveLength(720);
		expect(page.items[0].id).toBe('t60');
		expect(page.items.at(-1)!.id).toBe('t779');
		expect(page.next).toBe('c780');
		expect(asked).toEqual([720, 220]);
	});

	it('stops at the end of the album', async () => {
		const { fetchPage } = album(100);
		const page = await fetchTilesUpTo(fetchPage, 'c60', 720);
		expect(page.items.map((t) => t.id)).toEqual(Array.from({ length: 40 }, (_, i) => `t${60 + i}`));
		expect(page.next).toBeNull();
	});

	it('stops when an answer is empty but still has a cursor', async () => {
		let calls = 0;
		const page = await fetchTilesUpTo(async () => (calls++, { items: [], next: 'c1' }), 'c0', 10);
		expect(page).toEqual({ items: [], next: 'c1' });
		expect(calls).toBe(1);
	});
});
