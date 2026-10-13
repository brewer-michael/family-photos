/**
 * Printable QR cards (docs/PLAN.md "Access, QR codes and names"): one that signs people into the
 * whole site and one per album. Each encodes auth.joinUrl(PUBLIC_URL, albumId?), so "Reset access"
 * (or a new family code) makes every printed card stop working.
 */
import QRCode from 'qrcode';
import { joinUrl } from './auth';
import { publicOrigin } from './config';
import { listAlbumTitles } from './repo/admin';

export interface QrCard {
	/** null = the whole site. */
	albumId: number | null;
	title: string;
	whenText: string | null;
	/** The join URL the code holds (it signs people in: keep it off screens other people see). */
	url: string;
	/** Self-contained SVG markup (black on white, quiet zone included). */
	svg: string;
}

/** A QR code for `text` as SVG. Medium error correction survives a crease or a smudge. */
export function qrSvg(text: string): Promise<string> {
	return QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, color: { dark: '#000000', light: '#ffffff' } });
}

/** The whole-site card, then one per album (A to Z). */
export async function qrCards(siteTitle: string): Promise<QrCard[]> {
	const origin = publicOrigin();
	const targets = [
		{ albumId: null, title: siteTitle, whenText: null },
		...listAlbumTitles().map((a) => ({ albumId: a.id, title: a.title, whenText: a.when_text }))
	];
	return Promise.all(
		targets.map(async (t) => {
			const url = joinUrl(origin, t.albumId);
			return { ...t, url, svg: await qrSvg(url) };
		})
	);
}
