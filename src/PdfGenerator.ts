import { PDFDocument, rgb, PDFPage } from "pdf-lib";
import { RmPage, RmStroke } from "./types";
import {
	RM_WIDTH,
	RM_HEIGHT,
	PDF_SCALE,
	PDF_WIDTH,
	PDF_HEIGHT,
	getNormalizedPen,
	NormalizedPen,
	getStrokeColor,
	getStrokeOpacity,
	PEN_WIDTH_MULTIPLIER,
} from "./constants";
import { segmentsToSvgPathData } from "./StrokeRenderer";

/**
 * Generate a multi-page PDF from parsed reMarkable pages.
 * Returns the PDF as an ArrayBuffer ready to be written to the vault.
 */
export async function generatePdf(pages: RmPage[]): Promise<ArrayBuffer> {
	const pdfDoc = await PDFDocument.create();

	for (const rmPage of pages) {
		const page = pdfDoc.addPage([PDF_WIDTH, PDF_HEIGHT]);
		drawPage(page, rmPage);
	}

	const pdfBytes = await pdfDoc.save();
	return pdfBytes.buffer as ArrayBuffer;
}

/**
 * Draw all strokes from an RmPage onto a PDF page.
 *
 * Coordinate conversion:
 *   - reMarkable: origin top-left, Y increases downward
 *   - PDF: origin bottom-left, Y increases upward
 *   - rm_x * scale → pdf_x
 *   - (RM_HEIGHT - rm_y) * scale → pdf_y
 */
function drawPage(page: PDFPage, rmPage: RmPage): void {
	for (const layer of rmPage.layers) {
		for (const stroke of layer.strokes) {
			drawStroke(page, stroke);
		}
	}
}

function drawStroke(page: PDFPage, stroke: RmStroke): void {
	if (stroke.segments.length < 2) return;

	const pen = getNormalizedPen(stroke.pen);

	// Skip erase tools in PDF output
	if (pen === NormalizedPen.ERASE_AREA) return;

	const colorHex = getStrokeColor(pen, stroke.color);
	const color = hexToRgb(colorHex);
	const opacity = getStrokeOpacity(pen);

	// For erasers, use white
	if (pen === NormalizedPen.ERASER) {
		drawStrokePath(page, stroke, rgb(1, 1, 1), 1.0);
		return;
	}

	drawStrokePath(page, stroke, color, opacity);
}

function drawStrokePath(
	page: PDFPage,
	stroke: RmStroke,
	color: ReturnType<typeof rgb>,
	opacity: number,
): void {
	const pen = getNormalizedPen(stroke.pen);
	const widthMult = PEN_WIDTH_MULTIPLIER[pen] ?? 2;
	const lineWidth = stroke.width * widthMult * PDF_SCALE;

	// Convert remarkable coordinates to PDF coordinates
	const svgPath = segmentsToSvgPathData(
		stroke.segments.map(s => ({
			...s,
			x: s.x * PDF_SCALE,
			// Flip Y: PDF origin is bottom-left
			y: (RM_HEIGHT - s.y) * PDF_SCALE,
		}))
	);

	if (!svgPath) return;

	try {
		page.drawSvgPath(svgPath, {
			borderColor: color,
			borderWidth: Math.max(0.1, lineWidth),
			borderOpacity: opacity,
			x: 0,
			y: 0,
		});
	} catch {
		// Some paths may be invalid (e.g., zero-length). Skip silently.
	}
}

// ── Color Conversion ────────────────────────────────────────────────────────

function hexToRgb(hex: string): ReturnType<typeof rgb> {
	const h = hex.replace("#", "");
	const r = parseInt(h.substring(0, 2), 16) / 255;
	const g = parseInt(h.substring(2, 4), 16) / 255;
	const b = parseInt(h.substring(4, 6), 16) / 255;
	return rgb(r, g, b);
}
