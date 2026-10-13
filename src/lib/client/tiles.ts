/**
 * Album tiles from /album/<id>/items, which answers at most a few hundred per request.
 */
import type { TileDTO } from './dto';

/** One answer: the tiles after a cursor, and the cursor after them (null at the end). */
export interface TilePage {
	items: TileDTO[];
	next: string | null;
}

/**
 * Loads `count` tiles after cursor `from`, asking again from each answer's `next` until it has
 * them all or the album ends: the endpoint caps each answer, so a refresh after many "Show more"
 * taps would otherwise drop the rest (and the page would jump).
 */
export async function fetchTilesUpTo(
	fetchPage: (before: string, limit: number) => Promise<TilePage>,
	from: string,
	count: number
): Promise<TilePage> {
	const items: TileDTO[] = [];
	let next: string | null = from;
	while (next !== null && items.length < count) {
		const page = await fetchPage(next, count - items.length);
		items.push(...page.items);
		next = page.next;
		if (page.items.length === 0) break;
	}
	return { items, next };
}
