import { RmPage, RmLayer, RmStroke, RmSegment, RmHighlight, RmHighlightRect } from "./types";
import { HEADER_V3_OLD, HEADER_VERSIONED, HEADER_LENGTH } from "./constants";

export function parseRmFile(data: ArrayBuffer): RmPage {
	const view = new DataView(data);
	const bytes = new Uint8Array(data);

	const headerStr = textDecoder.decode(bytes.slice(0, HEADER_LENGTH));
	let version: number;

	if (headerStr.startsWith(HEADER_VERSIONED)) {
		const versionChar = headerStr.charAt(HEADER_VERSIONED.length);
		version = parseInt(versionChar, 10);
		if (isNaN(version)) {
			throw new RmParseError(`Invalid version character: '${versionChar}'`);
		}
	} else if (headerStr === HEADER_V3_OLD) {
		version = 3;
	} else {
		throw new RmParseError(
			`Unrecognized .rm file header. Got: "${headerStr.slice(0, 40)}..."`
		);
	}

	if (version === 6) {
		return parseV6File(view, bytes);
	}

	if (version !== 3 && version !== 5) {
		throw new RmParseError(
			`Unsupported .rm version ${version}. Only v3, v5, and v6 are supported.`
		);
	}

	let offset = HEADER_LENGTH;
	const layers = parsePageData(view, offset, version);

	return { layers, highlights: [], version };
}

function parsePageData(
	view: DataView,
	startOffset: number,
	version: number,
): RmLayer[] {
	let offset = startOffset;

	// Page header: n_layers(u8), pad(u8), pad(u16) = 4 bytes
	const nLayers = view.getUint8(offset);
	offset += 4; // skip the full 4-byte page struct

	const layers: RmLayer[] = [];

	for (let l = 0; l < nLayers; l++) {
		const result = parseLayer(view, offset, version);
		layers.push(result.layer);
		offset = result.offset;
	}

	return layers;
}

function parseLayer(
	view: DataView,
	startOffset: number,
	version: number,
): { layer: RmLayer; offset: number } {
	let offset = startOffset;

	const nStrokes = view.getUint32(offset, true);
	offset += 4;

	const strokes: RmStroke[] = [];

	for (let s = 0; s < nStrokes; s++) {
		const result = parseStroke(view, offset, version);
		strokes.push(result.stroke);
		offset = result.offset;
	}

	return { layer: { strokes }, offset };
}

function parseStroke(
	view: DataView,
	startOffset: number,
	version: number,
): { stroke: RmStroke; offset: number } {
	let offset = startOffset;

	const pen = view.getUint32(offset, true);       offset += 4;
	const color = view.getUint32(offset, true);     offset += 4;
	// skip unk1
	offset += 4;
	const width = view.getFloat32(offset, true);    offset += 4;

	if (version === 5) {
		// v5 has an extra uint32 field (unk2)
		offset += 4;
	}

	const nSegments = view.getUint32(offset, true); offset += 4;

	const segments: RmSegment[] = [];

	for (let i = 0; i < nSegments; i++) {
		const x         = view.getFloat32(offset, true);  offset += 4;
		const y         = view.getFloat32(offset, true);  offset += 4;
		const speed     = view.getFloat32(offset, true);  offset += 4;
		const direction = view.getFloat32(offset, true);  offset += 4;
		const segWidth  = view.getFloat32(offset, true);  offset += 4;
		const pressure  = view.getFloat32(offset, true);  offset += 4;

		segments.push({ x, y, speed, direction, width: segWidth, pressure });
	}

	return {
		stroke: { pen, color, width, segments },
		offset,
	};
}

export class RmParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RmParseError";
	}
}

const textDecoder = new TextDecoder("ascii");

// ── v6 Tagged Block Format Parser ───────────────────────────────────────────

const TAG_ID = 0xF;
const TAG_LENGTH4 = 0xC;
const TAG_BYTE8 = 0x8;
const TAG_BYTE4 = 0x4;
const TAG_BYTE1 = 0x1;

const BLOCK_TYPE_GLYPH_ITEM = 0x03;
const BLOCK_TYPE_LINE_ITEM = 0x05;
const GLYPH_ITEM_TYPE = 0x01;
const LINE_ITEM_TYPE = 0x03;

class V6Reader {
	pos: number;
	private view: DataView;
	private bytes: Uint8Array;

	constructor(view: DataView, bytes: Uint8Array, startPos: number) {
		this.view = view;
		this.bytes = bytes;
		this.pos = startPos;
	}

	readVaruint(): number {
		let shift = 0;
		let result = 0;
		while (this.pos < this.bytes.length) {
			const b = this.bytes[this.pos++];
			result |= (b & 0x7F) << shift;
			shift += 7;
			if (!(b & 0x80)) break;
		}
		return result;
	}

	readUint8(): number {
		return this.bytes[this.pos++];
	}

	readUint16(): number {
		const v = this.view.getUint16(this.pos, true);
		this.pos += 2;
		return v;
	}

	readUint32(): number {
		const v = this.view.getUint32(this.pos, true);
		this.pos += 4;
		return v;
	}

	readFloat32(): number {
		const v = this.view.getFloat32(this.pos, true);
		this.pos += 4;
		return v;
	}

	readFloat64(): number {
		const v = this.view.getFloat64(this.pos, true);
		this.pos += 8;
		return v;
	}

	readBool(): boolean {
		return this.readUint8() !== 0;
	}

	readCrdtId(): [number, number] {
		const part1 = this.readUint8();
		const part2 = this.readVaruint();
		return [part1, part2];
	}

	readTag(): { index: number; tagType: number } {
		const x = this.readVaruint();
		return { index: x >> 4, tagType: x & 0xF };
	}

	checkTag(expectedIndex: number, expectedType: number): boolean {
		const saved = this.pos;
		try {
			const { index, tagType } = this.readTag();
			if (index === expectedIndex && tagType === expectedType) return true;
			this.pos = saved;
			return false;
		} catch {
			this.pos = saved;
			return false;
		}
	}

	expectTag(expectedIndex: number, expectedType: number): void {
		const saved = this.pos;
		const { index, tagType } = this.readTag();
		if (index !== expectedIndex || tagType !== expectedType) {
			this.pos = saved;
			throw new RmParseError(
				`Expected tag idx=${expectedIndex} type=0x${expectedType.toString(16)}, got idx=${index} type=0x${tagType.toString(16)} at pos ${saved}`
			);
		}
	}

	readTaggedId(index: number): [number, number] {
		this.expectTag(index, TAG_ID);
		return this.readCrdtId();
	}

	readTaggedInt(index: number): number {
		this.expectTag(index, TAG_BYTE4);
		return this.readUint32();
	}

	readTaggedFloat(index: number): number {
		this.expectTag(index, TAG_BYTE4);
		return this.readFloat32();
	}

	readTaggedDouble(index: number): number {
		this.expectTag(index, TAG_BYTE8);
		return this.readFloat64();
	}

	readTaggedBool(index: number): boolean {
		this.expectTag(index, TAG_BYTE1);
		return this.readBool();
	}

	readSubblockHeader(index: number): number {
		this.expectTag(index, TAG_LENGTH4);
		return this.readUint32();
	}

	skip(n: number): void {
		this.pos += n;
	}
}

function parseV6File(view: DataView, bytes: Uint8Array): RmPage {
	const reader = new V6Reader(view, bytes, HEADER_LENGTH);
	const strokes: RmStroke[] = [];
	const highlights: RmHighlight[] = [];

	while (reader.pos < bytes.length) {
		const blockStart = reader.pos;

		let blockLength: number;
		try {
			blockLength = reader.readUint32();
		} catch {
			break;
		}

		if (blockStart + 4 + blockLength > bytes.length) break;

		const _unknown = reader.readUint8();
		const _minVersion = reader.readUint8();
		const currentVersion = reader.readUint8();
		const blockType = reader.readUint8();

		const dataStart = reader.pos;
		const blockEnd = dataStart + blockLength;

		if (blockType === BLOCK_TYPE_LINE_ITEM) {
			try {
				const stroke = parseV6LineBlock(reader, currentVersion, blockEnd);
				if (stroke) strokes.push(stroke);
			} catch {
				// skip malformed blocks
			}
		} else if (blockType === BLOCK_TYPE_GLYPH_ITEM) {
			try {
				const highlight = parseV6GlyphBlock(reader, blockEnd);
				if (highlight) highlights.push(highlight);
			} catch {
				// skip malformed blocks
			}
		}

		reader.pos = blockEnd;
	}

	return { layers: [{ strokes }], highlights, version: 6 };
}

function parseV6LineBlock(
	reader: V6Reader,
	blockVersion: number,
	blockEnd: number,
): RmStroke | null {
	// SceneItemBlock: parent_id, item_id, left_id, right_id, deleted_length
	reader.readTaggedId(1);
	reader.readTaggedId(2);
	reader.readTaggedId(3);
	reader.readTaggedId(4);
	const deletedLength = reader.readTaggedInt(5);

	if (deletedLength > 0) return null;

	if (!reader.checkTag(6, TAG_LENGTH4)) return null;
	const valueLength = reader.readUint32();
	const valueEnd = reader.pos + valueLength;

	const itemType = reader.readUint8();
	if (itemType !== LINE_ITEM_TYPE) {
		reader.pos = valueEnd;
		return null;
	}

	// Line data: tool, color, thickness_scale, starting_length, points, timestamp
	const pen = reader.readTaggedInt(1);
	const color = reader.readTaggedInt(2);
	const thicknessScale = reader.readTaggedDouble(3);
	const _startingLength = reader.readTaggedFloat(4);

	// Points subblock
	const pointsLength = reader.readSubblockHeader(5);
	const pointsEnd = reader.pos + pointsLength;

	const pointVersion = blockVersion >= 2 ? 2 : 1;
	const pointSize = pointVersion === 2 ? 14 : 24;
	const numPoints = Math.floor(pointsLength / pointSize);

	const segments: RmSegment[] = [];
	for (let i = 0; i < numPoints; i++) {
		const x = reader.readFloat32();
		const y = reader.readFloat32();

		let speed: number, direction: number, width: number, pressure: number;

		if (pointVersion === 2) {
			const rawSpeed = reader.readUint16();
			const rawWidth = reader.readUint16();
			const rawDirection = reader.readUint8();
			const rawPressure = reader.readUint8();
			speed = rawSpeed;
			direction = rawDirection;
			width = rawWidth / 4;
			pressure = rawPressure / 255;
		} else {
			speed = reader.readFloat32() * 4;
			direction = 255 * reader.readFloat32() / (Math.PI * 2);
			width = reader.readFloat32();
			pressure = reader.readFloat32();
		}

		segments.push({ x, y, speed, direction, width, pressure });
	}

	reader.pos = pointsEnd;

	// Skip remaining fields (timestamp, move_id) — advance to value end
	reader.pos = valueEnd;

	return { pen, color, width: thicknessScale, segments };
}

function parseV6GlyphBlock(
	reader: V6Reader,
	blockEnd: number,
): RmHighlight | null {
	reader.readTaggedId(1);
	reader.readTaggedId(2);
	reader.readTaggedId(3);
	reader.readTaggedId(4);
	const deletedLength = reader.readTaggedInt(5);

	if (deletedLength > 0) return null;

	if (!reader.checkTag(6, TAG_LENGTH4)) return null;
	const valueLength = reader.readUint32();
	const valueEnd = reader.pos + valueLength;

	const itemType = reader.readUint8();
	if (itemType !== GLYPH_ITEM_TYPE) {
		reader.pos = valueEnd;
		return null;
	}

	let color = 9;
	let text = "";
	const rects: RmHighlightRect[] = [];

	if (reader.checkTag(2, TAG_BYTE4)) {
		reader.readUint32();
	}
	if (reader.checkTag(3, TAG_BYTE4)) {
		reader.readUint32();
	}

	color = reader.readTaggedInt(4);

	const textSubLen = reader.readSubblockHeader(5);
	const textSubEnd = reader.pos + textSubLen;
	const strLen = reader.readVaruint();
	const _isAscii = reader.readUint8();
	const textBytes = new Uint8Array(strLen);
	for (let i = 0; i < strLen; i++) {
		textBytes[i] = reader.readUint8();
	}
	text = new TextDecoder().decode(textBytes);
	reader.pos = textSubEnd;

	const rectsSubLen = reader.readSubblockHeader(6);
	const rectsSubEnd = reader.pos + rectsSubLen;
	const numRects = reader.readVaruint();
	for (let i = 0; i < numRects; i++) {
		const x = reader.readFloat64();
		const y = reader.readFloat64();
		const w = reader.readFloat64();
		const h = reader.readFloat64();
		rects.push({ x, y, w, h });
	}
	reader.pos = rectsSubEnd;

	reader.pos = valueEnd;

	if (rects.length === 0) return null;

	return { color, text, rects };
}
