import { RmPage, RmStroke, RmSegment } from "./types";
import {
	RM_WIDTH,
	RM_HEIGHT,
	NormalizedPen,
	getNormalizedPen,
	getStrokeColor,
	getStrokeOpacity,
	PEN_WIDTH_MULTIPLIER,
} from "./constants";

/**
 * Render an RmPage to an SVG string.
 * Each stroke becomes a <polyline> element with per-pen styling.
 */
export function renderPageToSvg(page: RmPage): string {
	const parts: string[] = [];

	parts.push(
		`<svg xmlns="http://www.w3.org/2000/svg" ` +
		`width="${RM_WIDTH}" height="${RM_HEIGHT}" ` +
		`viewBox="0 0 ${RM_WIDTH} ${RM_HEIGHT}">`
	);

	// White background
	parts.push(
		`<rect width="${RM_WIDTH}" height="${RM_HEIGHT}" fill="#ffffff"/>`
	);

	for (const layer of page.layers) {
		for (const stroke of layer.strokes) {
			const svgElement = renderStroke(stroke);
			if (svgElement) {
				parts.push(svgElement);
			}
		}
	}

	parts.push("</svg>");
	return parts.join("\n");
}

/**
 * Render a single stroke to an SVG element string.
 * Returns null for eraser strokes (handled via white color instead).
 */
function renderStroke(stroke: RmStroke): string | null {
	if (stroke.segments.length === 0) return null;

	const pen = getNormalizedPen(stroke.pen);

	// Skip erase-area tool entirely (area eraser)
	if (pen === NormalizedPen.ERASE_AREA) return null;

	const color = getStrokeColor(pen, stroke.color);
	const opacity = getStrokeOpacity(pen);
	const widthMult = PEN_WIDTH_MULTIPLIER[pen] ?? 2;
	const baseWidth = stroke.width * widthMult;

	// For highlighter, use wider strokes with lower opacity
	if (pen === NormalizedPen.HIGHLIGHTER) {
		return renderHighlighterStroke(stroke.segments, color, baseWidth);
	}

	// For pressure-sensitive pens, render with variable width segments
	if (isPressureSensitive(pen)) {
		return renderVariableWidthStroke(stroke.segments, color, opacity, pen, stroke.width);
	}

	// For constant-width pens (fineliner, etc.), single polyline
	return renderConstantWidthStroke(stroke.segments, color, opacity, baseWidth);
}

function renderConstantWidthStroke(
	segments: RmSegment[],
	color: string,
	opacity: number,
	width: number,
): string {
	const points = segments.map(s => `${s.x.toFixed(1)},${s.y.toFixed(1)}`).join(" ");
	const opacityAttr = opacity < 1 ? ` opacity="${opacity}"` : "";

	return (
		`<polyline fill="none" stroke="${color}" ` +
		`stroke-width="${width.toFixed(2)}" ` +
		`stroke-linecap="round" stroke-linejoin="round"` +
		`${opacityAttr} points="${points}"/>`
	);
}

function renderHighlighterStroke(
	segments: RmSegment[],
	color: string,
	width: number,
): string {
	const points = segments.map(s => `${s.x.toFixed(1)},${s.y.toFixed(1)}`).join(" ");

	return (
		`<polyline fill="none" stroke="${color}" ` +
		`stroke-width="${width.toFixed(2)}" ` +
		`stroke-linecap="square" stroke-linejoin="miter" ` +
		`opacity="0.4" points="${points}"/>`
	);
}

/**
 * Render a pressure-sensitive stroke as grouped line segments with varying width.
 * Groups consecutive segments with similar widths for efficiency.
 */
function renderVariableWidthStroke(
	segments: RmSegment[],
	color: string,
	opacity: number,
	pen: NormalizedPen,
	baseWidth: number,
): string {
	if (segments.length < 2) {
		// Single point — draw as a small circle
		const s = segments[0];
		const r = Math.max(0.5, baseWidth * 0.5);
		return `<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}"/>`;
	}

	const parts: string[] = [];
	const opacityAttr = opacity < 1 ? ` opacity="${opacity}"` : "";
	const SEGMENT_GROUP_SIZE = 5;

	for (let i = 0; i < segments.length - 1; i += SEGMENT_GROUP_SIZE) {
		const end = Math.min(i + SEGMENT_GROUP_SIZE + 1, segments.length);
		const group = segments.slice(i, end);

		// Calculate average width for this group
		const avgWidth = calculateSegmentWidth(pen, baseWidth, group);
		const points = group.map(s => `${s.x.toFixed(1)},${s.y.toFixed(1)}`).join(" ");

		parts.push(
			`<polyline fill="none" stroke="${color}" ` +
			`stroke-width="${avgWidth.toFixed(2)}" ` +
			`stroke-linecap="round" stroke-linejoin="round"` +
			`${opacityAttr} points="${points}"/>`
		);
	}

	return `<g>${parts.join("")}</g>`;
}

/**
 * Calculate rendered width for a group of segments based on pen type.
 * Based on rmc/writing_tools.py pressure calculations.
 */
function calculateSegmentWidth(
	pen: NormalizedPen,
	baseWidth: number,
	segments: RmSegment[],
): number {
	// Average pressure/speed across the group
	const avgPressure = segments.reduce((sum, s) => sum + s.pressure, 0) / segments.length;
	const avgSpeed = segments.reduce((sum, s) => sum + s.speed, 0) / segments.length;
	const avgSegWidth = segments.reduce((sum, s) => sum + s.width, 0) / segments.length;

	switch (pen) {
		case NormalizedPen.BALLPOINT: {
			// width = (0.5 + pressure/255) + (segWidth/4) - 0.5 * ((speed/4)/50)
			const w = (0.5 + avgPressure / 255) + (avgSegWidth / 4) - 0.5 * ((avgSpeed / 4) / 50);
			return Math.max(0.4, w);
		}
		case NormalizedPen.PENCIL:
		case NormalizedPen.MECH_PENCIL: {
			const w = avgSegWidth * 0.8 + avgPressure * 0.3;
			return Math.max(0.3, w);
		}
		case NormalizedPen.BRUSH:
		case NormalizedPen.CALLIGRAPHY: {
			const w = avgSegWidth + avgPressure * 2;
			return Math.max(0.5, w);
		}
		case NormalizedPen.MARKER: {
			return Math.max(1.0, avgSegWidth);
		}
		default:
			return Math.max(0.5, avgSegWidth);
	}
}

function isPressureSensitive(pen: NormalizedPen): boolean {
	return (
		pen === NormalizedPen.BALLPOINT ||
		pen === NormalizedPen.PENCIL ||
		pen === NormalizedPen.MECH_PENCIL ||
		pen === NormalizedPen.BRUSH ||
		pen === NormalizedPen.CALLIGRAPHY ||
		pen === NormalizedPen.MARKER
	);
}

/**
 * Generate an SVG path "d" attribute string from stroke segments.
 * Useful for pdf-lib's drawSvgPath().
 */
export function segmentsToSvgPathData(segments: RmSegment[]): string {
	if (segments.length === 0) return "";

	const parts: string[] = [];
	parts.push(`M ${segments[0].x.toFixed(2)} ${segments[0].y.toFixed(2)}`);

	for (let i = 1; i < segments.length; i++) {
		parts.push(`L ${segments[i].x.toFixed(2)} ${segments[i].y.toFixed(2)}`);
	}

	return parts.join(" ");
}
