import { PDFDocument, rgb, PDFPage } from "pdf-lib";
import { RmPage, RmStroke, RmHighlight, DocumentContent } from "./types";
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

type Transform = DocumentContent["transform"];

interface PageLayout {
	scale: number;
	offsetX: number;
	offsetY: number;
	pageWidth: number;
	pageHeight: number;
}

function computePageLayout(pages: RmPage[], transform: Transform): PageLayout {
	let minX = Infinity, maxX = -Infinity;
	let minY = Infinity, maxY = -Infinity;

	for (const page of pages) {
		for (const layer of page.layers) {
			for (const stroke of layer.strokes) {
				for (const seg of stroke.segments) {
					const tx = transform.m11 * seg.x + transform.m12 * seg.y + transform.m13;
					const ty = transform.m21 * seg.x + transform.m22 * seg.y + transform.m23;
					if (tx < minX) minX = tx;
					if (tx > maxX) maxX = tx;
					if (ty < minY) minY = ty;
					if (ty > maxY) maxY = ty;
				}
			}
		}
		for (const hl of page.highlights) {
			for (const r of hl.rects) {
				const corners = [
					[r.x, r.y],
					[r.x + r.w, r.y],
					[r.x, r.y + r.h],
					[r.x + r.w, r.y + r.h],
				];
				for (const [cx, cy] of corners) {
					const tx = transform.m11 * cx + transform.m12 * cy + transform.m13;
					const ty = transform.m21 * cx + transform.m22 * cy + transform.m23;
					if (tx < minX) minX = tx;
					if (tx > maxX) maxX = tx;
					if (ty < minY) minY = ty;
					if (ty > maxY) maxY = ty;
				}
			}
		}
	}

	if (!isFinite(minX)) {
		return {
			scale: PDF_SCALE,
			offsetX: 0,
			offsetY: 0,
			pageWidth: PDF_WIDTH,
			pageHeight: PDF_HEIGHT,
		};
	}

	const fitsStandardCanvas =
		minX >= -1 && maxX <= RM_WIDTH + 1 &&
		minY >= -1 && maxY <= RM_HEIGHT + 1;

	if (fitsStandardCanvas) {
		return {
			scale: PDF_SCALE,
			offsetX: 0,
			offsetY: 0,
			pageWidth: PDF_WIDTH,
			pageHeight: PDF_HEIGHT,
		};
	}

	const PADDING = 20;
	minX -= PADDING;
	minY -= PADDING;
	maxX += PADDING;
	maxY += PADDING;

	const contentW = maxX - minX;
	const contentH = maxY - minY;

	const scaleX = PDF_WIDTH / contentW;
	const scaleY = PDF_HEIGHT / contentH;
	const fitScale = Math.min(scaleX, scaleY);

	return {
		scale: fitScale,
		offsetX: -minX,
		offsetY: -minY,
		pageWidth: PDF_WIDTH,
		pageHeight: PDF_HEIGHT,
	};
}

export async function generatePdf(
	pages: RmPage[],
	transform?: Transform,
): Promise<ArrayBuffer> {
	const xform = transform ?? { m11: 1, m12: 0, m13: 0, m21: 0, m22: 1, m23: 0, m31: 0, m32: 0, m33: 1 };
	const layout = computePageLayout(pages, xform);
	const pdfDoc = await PDFDocument.create();

	for (const rmPage of pages) {
		const page = pdfDoc.addPage([layout.pageWidth, layout.pageHeight]);
		drawPage(page, rmPage, xform, layout);
	}

	const pdfBytes = await pdfDoc.save();
	return pdfBytes.buffer as ArrayBuffer;
}

function drawPage(page: PDFPage, rmPage: RmPage, transform: Transform, layout: PageLayout): void {
	for (const highlight of rmPage.highlights) {
		drawHighlight(page, highlight, transform, layout);
	}

	for (const layer of rmPage.layers) {
		for (const stroke of layer.strokes) {
			drawStroke(page, stroke, transform, layout);
		}
	}
}

function drawStroke(
	page: PDFPage,
	stroke: RmStroke,
	transform: Transform,
	layout: PageLayout,
): void {
	if (stroke.segments.length < 2) return;

	const pen = getNormalizedPen(stroke.pen);

	if (pen === NormalizedPen.ERASE_AREA) return;

	const colorHex = getStrokeColor(pen, stroke.color);
	const color = hexToRgb(colorHex);
	const opacity = getStrokeOpacity(pen);

	if (pen === NormalizedPen.ERASER) {
		drawStrokePath(page, stroke, rgb(1, 1, 1), 1.0, transform, layout);
		return;
	}

	drawStrokePath(page, stroke, color, opacity, transform, layout);
}

function drawStrokePath(
	page: PDFPage,
	stroke: RmStroke,
	color: ReturnType<typeof rgb>,
	opacity: number,
	transform: Transform,
	layout: PageLayout,
): void {
	const pen = getNormalizedPen(stroke.pen);
	const widthMult = PEN_WIDTH_MULTIPLIER[pen] ?? 2;
	const lineWidth = stroke.width * widthMult * layout.scale;

	const svgPath = segmentsToSvgPathData(
		stroke.segments.map(s => {
			const tx = transform.m11 * s.x + transform.m12 * s.y + transform.m13;
			const ty = transform.m21 * s.x + transform.m22 * s.y + transform.m23;
			return {
				...s,
				x: (tx + layout.offsetX) * layout.scale,
				y: (ty + layout.offsetY) * layout.scale,
			};
		})
	);

	if (!svgPath) return;

	try {
		page.drawSvgPath(svgPath, {
			borderColor: color,
			borderWidth: Math.max(0.1, lineWidth),
			borderOpacity: opacity,
			x: 0,
			y: layout.pageHeight,
		});
	} catch {
		// noop
	}
}

const HIGHLIGHT_COLORS: Record<number, [number, number, number]> = {
	3: [1, 0.92, 0],
	4: [0, 0.8, 0.4],
	5: [1, 0.55, 0.65],
	6: [0.3, 0.55, 1],
	7: [1, 0.2, 0.2],
	9: [1, 0.92, 0],
	10: [0, 0.8, 0.4],
	11: [0, 0.8, 0.85],
	12: [0.8, 0.3, 0.8],
	13: [1, 0.92, 0],
};

function drawHighlight(
	page: PDFPage,
	highlight: RmHighlight,
	transform: Transform,
	layout: PageLayout,
): void {
	const [r, g, b] = HIGHLIGHT_COLORS[highlight.color] ?? [1, 0.92, 0];

	for (const rect of highlight.rects) {
		const tx = transform.m11 * rect.x + transform.m12 * rect.y + transform.m13;
		const ty = transform.m21 * rect.x + transform.m22 * rect.y + transform.m23;
		const tw = rect.w * Math.abs(transform.m11);
		const th = rect.h * Math.abs(transform.m22);

		const pdfX = (tx + layout.offsetX) * layout.scale;
		const pdfY = layout.pageHeight - (ty + layout.offsetY) * layout.scale;
		const pdfW = tw * layout.scale;
		const pdfH = th * layout.scale;

		page.drawRectangle({
			x: pdfX,
			y: pdfY - pdfH,
			width: pdfW,
			height: pdfH,
			color: rgb(r, g, b),
			opacity: 0.35,
		});
	}
}

export async function overlayAnnotations(
	basePdfBytes: ArrayBuffer,
	annotationPages: RmPage[],
): Promise<ArrayBuffer> {
	const pdfDoc = await PDFDocument.load(basePdfBytes);
	const pdfPages = pdfDoc.getPages();
	const identity: Transform = { m11: 1, m12: 0, m13: 0, m21: 0, m22: 1, m23: 0, m31: 0, m32: 0, m33: 1 };

	for (let i = 0; i < annotationPages.length && i < pdfPages.length; i++) {
		const rmPage = annotationPages[i];
		const pdfPage = pdfPages[i];

		const hasContent =
			rmPage.highlights.length > 0 ||
			rmPage.layers.some(l => l.strokes.length > 0);

		if (!hasContent) continue;

		const { width: pageW, height: pageH } = pdfPage.getSize();
		const scaleX = pageW / RM_WIDTH;
		const scaleY = pageH / RM_HEIGHT;

		// Annotation coordinates are centered around X=0 (range ~ -483 to +484),
		// while the RM canvas is 0-1404. Offset by RM_WIDTH/2 to map to page coords.
		const layout: PageLayout = {
			scale: Math.min(scaleX, scaleY),
			offsetX: RM_WIDTH / 2,
			offsetY: 0,
			pageWidth: pageW,
			pageHeight: pageH,
		};

		drawPage(pdfPage, rmPage, identity, layout);
	}

	const result = await pdfDoc.save();
	return result.buffer as ArrayBuffer;
}

// ── Color Conversion ────────────────────────────────────────────────────────

function hexToRgb(hex: string): ReturnType<typeof rgb> {
	const h = hex.replace("#", "");
	const r = parseInt(h.substring(0, 2), 16) / 255;
	const g = parseInt(h.substring(2, 4), 16) / 255;
	const b = parseInt(h.substring(4, 6), 16) / 255;
	return rgb(r, g, b);
}
