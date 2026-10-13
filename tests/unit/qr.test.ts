/**
 * QR cards: each SVG is read back into its module matrix and compared with the QR code of the
 * join URL, so a card provably holds that URL; Reset access changes every card.
 */
import QRCode from 'qrcode';
import { beforeEach, describe, expect, it } from 'vitest';
import { qrCards, qrSvg } from '#lib/server/qr';
import { currentJoinToken, joinUrl, rotateAccess } from '#lib/server/auth';
import * as albums from '#lib/server/repo/albums';
import { getDefaultAlbumId } from '#lib/server/repo/settings';
import { freshDb } from '../helpers/env';

const MARGIN = 4;

/** Dark modules of a qrcode SVG ("M<x> <y+0.5>h<n>m<dx> 0h<n>…" runs, quiet zone removed). */
function svgModules(svg: string): Set<string> {
	const d = /<path[^>]*stroke="#000000"[^>]*d="([^"]+)"/.exec(svg)?.[1];
	if (!d) throw new Error('no dark path in the SVG');
	const dark = new Set<string>();
	let x = 0;
	let y = 0;
	for (const [, cmd, a, b] of d.matchAll(/([Mmh])(-?[\d.]+)(?:\s(-?[\d.]+))?/g)) {
		if (cmd === 'M') {
			x = Number(a);
			y = Number(b) - 0.5;
		} else if (cmd === 'm') {
			x += Number(a);
			y += Number(b);
		} else {
			for (let i = 0; i < Number(a); i++) dark.add(`${x + i - MARGIN},${y - MARGIN}`);
			x += Number(a);
		}
	}
	return dark;
}

/** Dark modules of the QR code that encodes `text`. */
function expectedModules(text: string): Set<string> {
	const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
	const dark = new Set<string>();
	for (let row = 0; row < modules.size; row++) {
		for (let col = 0; col < modules.size; col++) if (modules.get(row, col)) dark.add(`${col},${row}`);
	}
	return dark;
}

beforeEach(() => {
	freshDb();
});

describe('qrSvg', () => {
	it('draws exactly the QR code of the text, black on white', async () => {
		const url = 'http://localhost:3000/join/abcdefghijklmnopqrstuv?album=12';
		const svg = await qrSvg(url);
		expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 \d+ \d+"/);
		expect(svg).toContain('fill="#ffffff"');
		expect(svgModules(svg)).toEqual(expectedModules(url));
		expect(svgModules(svg)).not.toEqual(expectedModules(`${url}3`));
	});
});

describe('qrCards', () => {
	it('makes a whole-site card and one per album, each holding its join URL', async () => {
		const beach = albums.create({ title: 'Beach 2024', whenText: 'July 2024', createdByName: 'Jo', createdByDevice: null });
		const cards = await qrCards('Family Photos');
		const token = currentJoinToken();

		expect(cards[0]).toMatchObject({ albumId: null, title: 'Family Photos', url: `http://localhost:3000/join/${token}` });
		expect(cards.map((c) => c.albumId).slice(1).sort()).toEqual([beach.id, getDefaultAlbumId()].sort());
		const beachCard = cards.find((c) => c.albumId === beach.id)!;
		expect(beachCard).toMatchObject({ title: 'Beach 2024', whenText: 'July 2024' });
		expect(beachCard.url).toBe(joinUrl('http://localhost:3000', beach.id));
		expect(beachCard.url).toBe(`http://localhost:3000/join/${token}?album=${beach.id}`);
		for (const card of cards) expect(svgModules(card.svg), card.title).toEqual(expectedModules(card.url));
	});

	it('leaves out deleted albums, and Reset access changes every card', async () => {
		const gone = albums.create({ title: 'Gone', createdByName: null, createdByDevice: null });
		albums.softDelete(gone.id);
		const before = await qrCards('Family Photos');
		expect(before.some((c) => c.albumId === gone.id)).toBe(false);

		rotateAccess();
		const after = await qrCards('Family Photos');
		expect(after.map((c) => c.albumId)).toEqual(before.map((c) => c.albumId));
		after.forEach((card, i) => {
			expect(card.url).not.toBe(before[i].url);
			expect(card.svg).not.toBe(before[i].svg);
		});
	});
});
