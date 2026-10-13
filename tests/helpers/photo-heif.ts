/**
 * HEIF test helper: damages one item's coded data, located through the `iloc` box, to build the
 * "broken non-primary image" fixture from zPug_3.heic at test time (docs/media-pipeline.md §8).
 */
import fs from 'node:fs';

interface Box {
	type: string;
	start: number;
	/** First byte after the box header. */
	body: number;
	end: number;
}

function boxes(buf: Buffer, from: number, to: number): Box[] {
	const out: Box[] = [];
	for (let p = from; p + 8 <= to; ) {
		let size = buf.readUInt32BE(p);
		let header = 8;
		if (size === 1) {
			size = Number(buf.readBigUInt64BE(p + 8));
			header = 16;
		} else if (size === 0) size = to - p;
		if (size < header || p + size > to) throw new Error(`bad box at ${p}`);
		out.push({ type: buf.toString('latin1', p + 4, p + 8), start: p, body: p + header, end: p + size });
		p += size;
	}
	return out;
}

function readUInt(buf: Buffer, at: number, size: number): number {
	if (size === 0) return 0;
	if (size === 2) return buf.readUInt16BE(at);
	if (size === 4) return buf.readUInt32BE(at);
	if (size === 8) return Number(buf.readBigUInt64BE(at));
	throw new Error(`unsupported field size ${size}`);
}

/** File offsets of an item's extents (construction method 0, file offsets only). */
export function itemExtents(buf: Buffer, itemId: number): { offset: number; length: number }[] {
	const meta = boxes(buf, 0, buf.length).find((b) => b.type === 'meta');
	if (!meta) throw new Error('no meta box');
	const iloc = boxes(buf, meta.body + 4, meta.end).find((b) => b.type === 'iloc'); // meta is a full box
	if (!iloc) throw new Error('no iloc box');
	let p = iloc.body;
	const version = buf[p];
	p += 4;
	const offsetSize = buf[p] >> 4;
	const lengthSize = buf[p] & 15;
	const baseOffsetSize = buf[p + 1] >> 4;
	const indexSize = version >= 1 ? buf[p + 1] & 15 : 0;
	p += 2;
	const count = version < 2 ? buf.readUInt16BE(p) : buf.readUInt32BE(p);
	p += version < 2 ? 2 : 4;
	for (let i = 0; i < count; i++) {
		const id = version < 2 ? buf.readUInt16BE(p) : buf.readUInt32BE(p);
		p += version < 2 ? 2 : 4;
		const method = version >= 1 ? buf.readUInt16BE(p) & 15 : 0;
		if (version >= 1) p += 2;
		p += 2; // data_reference_index
		const base = readUInt(buf, p, baseOffsetSize);
		p += baseOffsetSize;
		const extentCount = buf.readUInt16BE(p);
		p += 2;
		const extents: { offset: number; length: number }[] = [];
		for (let e = 0; e < extentCount; e++) {
			p += indexSize;
			const offset = readUInt(buf, p, offsetSize);
			p += offsetSize;
			const length = readUInt(buf, p, lengthSize);
			p += lengthSize;
			extents.push({ offset: base + offset, length });
		}
		if (id === itemId) {
			if (method !== 0) throw new Error(`item ${itemId} uses construction method ${method}`);
			return extents;
		}
	}
	throw new Error(`item ${itemId} not in iloc`);
}

/** Copies `src` to `dest` with `bytes` zeroed at the start of `itemId`'s first extent. */
export function zeroItemData(src: string, dest: string, itemId: number, bytes = 256): void {
	const buf = fs.readFileSync(src);
	const [first] = itemExtents(buf, itemId);
	buf.fill(0, first.offset, Math.min(first.offset + bytes, first.offset + first.length));
	fs.writeFileSync(dest, buf);
}
