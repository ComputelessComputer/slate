import { ParsedDocument } from "./types";

export function generateMarkdown(doc: ParsedDocument, pdfRelativePath: string, epubRelativePath = ""): string {
	const lines: string[] = [];

	lines.push("---");
	lines.push(`title: "${escapeYaml(doc.name)}"`);
	lines.push(`remarkable_id: "${doc.id}"`);
	lines.push(`last_modified: "${doc.lastModified}"`);
	lines.push(`page_count: ${doc.pages.length}`);
	lines.push(`file_type: "${doc.content.fileType || "notebook"}"`);
	if (epubRelativePath) {
		lines.push(`epub: "${epubRelativePath}"`);
	}
	lines.push("---");
	lines.push("");

	if (pdfRelativePath) {
		lines.push(`![[${pdfRelativePath}]]`);
		lines.push("");
	}

	const pageLabel = doc.pages.length !== 1 ? "pages" : "page";
	lines.push(`*${doc.pages.length} ${pageLabel} synced from reMarkable*`);
	lines.push("");

	return lines.join("\n");
}

function escapeYaml(str: string): string {
	return str.replace(/"/g, '\\"');
}
