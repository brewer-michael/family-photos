/**
 * Adds a Dolby Vision configuration box (dvcC) to the video sample entry of an MP4/MOV whose moov
 * comes after mdat (ffmpeg's default without +faststart), so no chunk offsets move. ffmpeg can't
 * produce real Dolby Vision locally; ffprobe reports the injected record like a camera file's.
 */
import fs from 'node:fs';

interface Box {
	type: string;
	start: number;
	size: number;
}

function children(buf: Buffer, start: number, end: number): Box[] {
	const out: Box[] = [];
	for (let p = start; p + 8 <= end; ) {
		const size = buf.readUInt32BE(p);
		if (size < 8) throw new Error(`unsupported box size ${size} at ${p}`);
		out.push({ type: buf.toString('latin1', p + 4, p + 8), start: p, size });
		p += size;
	}
	return out;
}

function child(buf: Buffer, parent: Box, type: string, headerExtra = 0): Box {
	const found = children(buf, parent.start + 8 + headerExtra, parent.start + parent.size).find((b) => b.type === type);
	if (!found) throw new Error(`no '${type}' in '${parent.type}'`);
	return found;
}

export function injectDvcc(file: string, rec: { profile: number; level: number; compatId: number }): void {
	const buf = fs.readFileSync(file);
	const top = children(buf, 0, buf.length);
	const moov = top.find((b) => b.type === 'moov');
	const mdat = top.find((b) => b.type === 'mdat');
	if (!moov || !mdat || moov.start < mdat.start) throw new Error('need a file with moov after mdat');
	const trak = children(buf, moov.start + 8, moov.start + moov.size).find((t) => {
		if (t.type !== 'trak') return false;
		const hdlr = child(buf, child(buf, t, 'mdia'), 'hdlr');
		return buf.toString('latin1', hdlr.start + 16, hdlr.start + 20) === 'vide';
	});
	if (!trak) throw new Error('no video track');
	const mdia = child(buf, trak, 'mdia');
	const minf = child(buf, mdia, 'minf');
	const stbl = child(buf, minf, 'stbl');
	const stsd = child(buf, stbl, 'stsd');
	// stsd: full box (4) + entry count (4); a visual sample entry has 78 bytes before its child boxes.
	const entry = children(buf, stsd.start + 16, stsd.start + stsd.size)[0];
	const dvcc = Buffer.alloc(32);
	dvcc.writeUInt32BE(32, 0);
	dvcc.write('dvcC', 4, 'latin1');
	dvcc.writeUInt8(1, 8); // dv_version_major
	dvcc.writeUInt8(0, 9); // dv_version_minor
	dvcc.writeUInt16BE((rec.profile << 9) | (rec.level << 3) | (1 << 2) | 1, 10); // rpu + bl present
	dvcc.writeUInt8(rec.compatId << 4, 12);
	const at = entry.start + entry.size;
	const out = Buffer.concat([buf.subarray(0, at), dvcc, buf.subarray(at)]);
	for (const b of [entry, stsd, stbl, minf, mdia, trak, moov]) out.writeUInt32BE(b.size + dvcc.length, b.start);
	fs.writeFileSync(file, out);
}
