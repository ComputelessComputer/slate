import { RmPage, RmLayer, RmStroke, RmSegment } from "./types";
import { HEADER_V3_OLD, HEADER_VERSIONED, HEADER_LENGTH } from "./constants";

/**
 * Parser for reMarkable .rm binary files (v3 and v5 formats).
 *
 * Binary format:
 *   Header (43 bytes): "reMarkable .lines file, version=N" + padding
 *                    OR "reMarkable lines with selections and layers"
 *   Then per page (one page per file in v3+):
 *     n_layers (uint8), pad (uint8), pad (uint16)  — 4 bytes
 *     Per layer:
 *       n_strokes (uint32)
 *       Per stroke:
 *         v3: pen(u32), color(u32), unk(u32), width(f32), n_segments(u32) = 20 bytes
 *         v5: pen(u32), color(u32), unk(u32), width(f32), unk2(u32), n_segments(u32) = 24 bytes
 *       Per segment:
 *         x(f32), y(f32), speed(f32), direction(f32), width(f32), pressure(f32) = 24 bytes
 */
export function parseRmFile(data: ArrayBuffer): RmPage {
	const view = new DataView(data);
	const bytes = new Uint8Array(data);

	// ── Parse Header ──────────────────────────────────────────────────────
	const headerStr = textDecoder.decode(bytes.slice(0, HEADER_LENGTH));
	let version: number;

	if (headerStr.startsWith(HEADER_VERSIONED)) {
		// New-style header: "reMarkable .lines file, version=N"
		const versionChar = headerStr.charAt(HEADER_VERSIONED.length);
		version = parseInt(versionChar, 10);
		if (isNaN(version)) {
			throw new RmParseError(`Invalid version character: '${versionChar}'`);
		}
	} else if (headerStr === HEADER_V3_OLD) {
		// Old-style header: v3 implied
		version = 3;
	} else {
		throw new RmParseError(
			`Unrecognized .rm file header. Got: "${headerStr.slice(0, 40)}..."`
		);
	}

	if (version !== 3 && version !== 5) {
		throw new RmParseError(
			`Unsupported .rm version ${version}. Only v3 and v5 are supported.`
		);
	}

	// ── Parse Page Data ───────────────────────────────────────────────────
	let offset = HEADER_LENGTH;
	const layers = parsePageData(view, offset, version);

	return { layers, version };
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
