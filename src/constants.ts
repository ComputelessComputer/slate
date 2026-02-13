// ── reMarkable Canvas Dimensions ────────────────────────────────────────────

export const RM_WIDTH = 1404;
export const RM_HEIGHT = 1872;
export const RM_DPI = 226;

/** Scale factor from remarkable pixels to PDF points (72 DPI) */
export const PDF_SCALE = 72 / RM_DPI;

/** Page dimensions in PDF points */
export const PDF_WIDTH = RM_WIDTH * PDF_SCALE;
export const PDF_HEIGHT = RM_HEIGHT * PDF_SCALE;

// ── .rm File Headers ────────────────────────────────────────────────────────

export const HEADER_V3_OLD = "reMarkable lines with selections and layers";
export const HEADER_VERSIONED = "reMarkable .lines file, version=";
export const HEADER_LENGTH = 43;

// ── Pen Tool IDs ────────────────────────────────────────────────────────────

export const enum PenType {
	BRUSH_1         = 0,
	PENCIL_1        = 1,
	BALLPOINT_1     = 2,
	MARKER_1        = 3,
	FINELINER_1     = 4,
	HIGHLIGHTER_1   = 5,
	ERASER          = 6,
	MECH_PENCIL_1   = 7,
	ERASE_AREA      = 8,
	CALLIGRAPHY     = 9,
	BRUSH_2         = 12,
	MECH_PENCIL_2   = 13,
	PENCIL_2        = 14,
	BALLPOINT_2     = 15,
	MARKER_2        = 16,
	FINELINER_2     = 17,
	HIGHLIGHTER_2   = 18,
}

/** Map raw pen ID to normalized tool category */
export function getNormalizedPen(penId: number): NormalizedPen {
	switch (penId as PenType) {
		case PenType.BRUSH_1:
		case PenType.BRUSH_2:
			return NormalizedPen.BRUSH;
		case PenType.PENCIL_1:
		case PenType.PENCIL_2:
			return NormalizedPen.PENCIL;
		case PenType.BALLPOINT_1:
		case PenType.BALLPOINT_2:
			return NormalizedPen.BALLPOINT;
		case PenType.MARKER_1:
		case PenType.MARKER_2:
			return NormalizedPen.MARKER;
		case PenType.FINELINER_1:
		case PenType.FINELINER_2:
			return NormalizedPen.FINELINER;
		case PenType.HIGHLIGHTER_1:
		case PenType.HIGHLIGHTER_2:
			return NormalizedPen.HIGHLIGHTER;
		case PenType.ERASER:
			return NormalizedPen.ERASER;
		case PenType.MECH_PENCIL_1:
		case PenType.MECH_PENCIL_2:
			return NormalizedPen.MECH_PENCIL;
		case PenType.ERASE_AREA:
			return NormalizedPen.ERASE_AREA;
		case PenType.CALLIGRAPHY:
			return NormalizedPen.CALLIGRAPHY;
		default:
			return NormalizedPen.FINELINER;
	}
}

export const enum NormalizedPen {
	BRUSH        = "brush",
	PENCIL       = "pencil",
	BALLPOINT    = "ballpoint",
	MARKER       = "marker",
	FINELINER    = "fineliner",
	HIGHLIGHTER  = "highlighter",
	ERASER       = "eraser",
	MECH_PENCIL  = "mech_pencil",
	ERASE_AREA   = "erase_area",
	CALLIGRAPHY  = "calligraphy",
}

// ── Pen Rendering Properties ────────────────────────────────────────────────

export interface PenStyle {
	color: string;
	widthMultiplier: number;
	opacity: number;
}

/** Base width multipliers per tool type */
export const PEN_WIDTH_MULTIPLIER: Record<string, number> = {
	[NormalizedPen.BRUSH]:       8,
	[NormalizedPen.PENCIL]:      4,
	[NormalizedPen.BALLPOINT]:   2,
	[NormalizedPen.MARKER]:      6,
	[NormalizedPen.FINELINER]:   2,
	[NormalizedPen.HIGHLIGHTER]: 12,
	[NormalizedPen.ERASER]:      16,
	[NormalizedPen.MECH_PENCIL]: 4,
	[NormalizedPen.ERASE_AREA]:  1,
	[NormalizedPen.CALLIGRAPHY]: 4,
};

// ── Color Codes ─────────────────────────────────────────────────────────────

export const STROKE_COLORS: Record<number, string> = {
	0: "#000000", // black
	1: "#808080", // gray
	2: "#ffffff", // white
	6: "#0062cc", // blue
	7: "#d90707", // red
};

export const HIGHLIGHTER_COLORS: Record<number, string> = {
	0: "#ffff00", // yellow (default highlight)
	1: "#ffff00", // yellow
	3: "#fefd60", // yellow
	4: "#a9fa5c", // green
	5: "#ff55cf", // pink
	8: "#808080", // gray blend
};

/** Get stroke color string from pen type and color code */
export function getStrokeColor(pen: NormalizedPen, colorCode: number): string {
	if (pen === NormalizedPen.HIGHLIGHTER) {
		return HIGHLIGHTER_COLORS[colorCode] ?? "#ffff00";
	}
	if (pen === NormalizedPen.ERASER || pen === NormalizedPen.ERASE_AREA) {
		return "#ffffff";
	}
	return STROKE_COLORS[colorCode] ?? "#000000";
}

/** Get stroke opacity for a given pen type */
export function getStrokeOpacity(pen: NormalizedPen): number {
	if (pen === NormalizedPen.HIGHLIGHTER) {
		return 0.4;
	}
	return 1.0;
}

// ── reMarkable Cloud API Endpoints ──────────────────────────────────────────

export const RM_DEVICE_REGISTER_URL =
	"https://webapp.cloud.remarkable.com/token/json/2/device/new";

export const RM_TOKEN_REFRESH_URL =
	"https://webapp.cloud.remarkable.com/token/json/2/user/new";

export const RM_RAW_HOST = "https://eu.tectonic.remarkable.com";
