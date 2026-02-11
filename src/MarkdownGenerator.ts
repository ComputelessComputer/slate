import { ParsedDocument } from "./types";

/**
 * Generate a Markdown file for a synced reMarkable document.
 *
 * Output format:
 * ---
 * title: Document Name
 * remarkable_id: uuid
 * last_modified: ISO timestamp
 * page_count: N
 * file_type: pdf|notebook|epub
 * ---
 *
 * ![[Document Name.pdf]]
 */
export function generateMarkdown(doc: ParsedDocument, pdfFileName: string): string {
	const lines: string[] = [];

	// Frontmatter
	lines.push("---");
	lines.push(`title: "${escapeYaml(doc.name)}"`);
	lines.push(`remarkable_id: "${doc.id}"`);
	lines.push(`last_modified: "${doc.lastModified}"`);
	lines.push(`page_count: ${doc.pages.length}`);
	lines.push(`file_type: "${doc.content.fileType || "notebook"}"`);
	lines.push("---");
	lines.push("");

	// PDF embed
	lines.push(`![[${pdfFileName}]]`);
	lines.push("");

	// Page count info
	lines.push(`*${doc.pages.length} page${doc.pages.length !== 1 ? "s" : ""} synced from reMarkable*`);
	lines.push("");

	return lines.join("\n");
}

function escapeYaml(str: string): string {
	return str.replace(/"/g, '\\"');
}
