/**
 * Top-level ISO BMFF box walker for the canonical MP4: moov must come before mdat (+faststart, so
 * playback starts before the download finishes) and the boxes must cover the file exactly.
 */
import fs from 'node:fs/promises';

export interface TopBox {
	type: string;
	offset: number;
	size: number;
}

/** Reads the top-level box headers. Throws on a malformed or truncated layout. */
export async function topLevelBoxes(file: string): Promise<TopBox[]> {
	const fh = await fs.open(file, 'r');
	try {
		const { size: fileSize } = await fh.stat();
		const boxes: TopBox[] = [];
		const head = Buffer.alloc(16);
		let offset = 0;
		while (offset < fileSize) {
			const { bytesRead } = await fh.read(head, 0, 16, offset);
			if (bytesRead < 8) throw new Error(`truncated box header at ${offset}`);
			let size = head.readUInt32BE(0);
			const type = head.toString('latin1', 4, 8);
			if (size === 1) {
				if (bytesRead < 16) throw new Error(`truncated 64-bit box header at ${offset}`);
				size = Number(head.readBigUInt64BE(8));
			} else if (size === 0) {
				size = fileSize - offset;
			}
			if (size < 8 || offset + size > fileSize) throw new Error(`box '${type}' at ${offset} (size ${size}) overruns the file (${fileSize} bytes)`);
			boxes.push({ type, offset, size });
			offset += size;
		}
		return boxes;
	} finally {
		await fh.close();
	}
}

/** null when the layout is fine, else what is wrong. */
export function faststartProblem(boxes: readonly TopBox[]): string | null {
	const types = boxes.map((b) => b.type);
	if (types[0] !== 'ftyp') return `the file starts with '${types[0] ?? 'nothing'}', not 'ftyp'`;
	const moov = types.indexOf('moov');
	const mdat = types.indexOf('mdat');
	if (moov < 0) return 'no moov box';
	if (types.lastIndexOf('moov') !== moov) return 'more than one moov box';
	if (mdat < 0) return 'no mdat box';
	if (moov > mdat) return 'moov comes after mdat';
	return null;
}
