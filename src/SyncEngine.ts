import { Notice, Vault, TFile } from "obsidian";
import { RemarkableClient } from "./RemarkableClient";
import { parseRmFile } from "./RmParser";
import { generatePdf, overlayAnnotations } from "./PdfGenerator";
import { generateMarkdown } from "./MarkdownGenerator";
import {
	RemarkableItem,
	RawEntry,
	ItemMetadata,
	DocumentContent,
	RmPage,
	ParsedDocument,
	PluginSettings,
} from "./types";


export class SyncEngine {
	private isSyncing = false;

	constructor(
		private client: RemarkableClient,
		private vault: Vault,
		private settings: PluginSettings,
		private saveSettings: () => Promise<void>,
	) {}

	get syncing(): boolean {
		return this.isSyncing;
	}

	async sync(): Promise<void> {
		if (this.isSyncing) {
			new Notice("Slate: Already syncing...");
			return;
		}

		if (!this.client.isRegistered) {
			new Notice("Slate: Not registered. Go to Settings to connect your device.");
			return;
		}

		this.isSyncing = true;

		try {
		new Notice("Slate: Authenticating...");
			await this.client.refreshToken();

			new Notice("Slate: Fetching document list...");
			const root = await this.client.getRootHash();
			const rootEntries = await this.client.getEntries(root.hash);

			const allItems: RemarkableItem[] = [];
			const changedDocs: RemarkableItem[] = [];

			for (const entry of rootEntries.entries) {
				const cached = this.settings.syncState[entry.id];

				if (cached && cached.hash === entry.hash && cached.visibleName && cached.type) {
					// Unchanged — reconstruct from cache, skip API calls
					const item: RemarkableItem = {
						id: entry.id,
						hash: entry.hash,
						visibleName: cached.visibleName,
						lastModified: cached.lastModified,
						parent: cached.parent ?? "",
						pinned: false,
						type: cached.type,
						fileEntries: [],
					};
					allItems.push(item);
					continue;
				}

				// Changed or new — full fetch
				try {
					const item = await this.fetchItem(entry);
					if (!item) continue;
					allItems.push(item);

					// Cache metadata for all items (documents + collections)
					this.settings.syncState[item.id] = {
						hash: item.hash,
						lastModified: item.lastModified,
						vaultPath: this.settings.syncState[item.id]?.vaultPath ?? "",
						visibleName: item.visibleName,
						parent: item.parent,
						type: item.type,
					};

					if (item.type === "DocumentType") {
						changedDocs.push(item);
					}
				} catch (err) {
					console.warn(`[RemarkableSync] Failed to read entry ${entry.id}:`, err);
				}
			}

			let syncedCount = 0;
			let errorCount = 0;

			for (const doc of changedDocs) {
				const existing = this.settings.syncState[doc.id];
				if (existing && existing.hash === doc.hash && existing.vaultPath) {
					const safeName = sanitizeFilename(doc.visibleName);
					const mdPath = `${existing.vaultPath}/${safeName}.md`;
					const localExists = !!this.vault.getAbstractFileByPath(mdPath);
					if (localExists) continue;
				}

				try {
					await this.syncDocument(doc, allItems);
					syncedCount++;
				} catch (err) {
					console.error(`Failed to sync "${doc.visibleName}":`, err);
					errorCount++;
				}
			}

			// Clean up stale entries (deleted on cloud)
			const cloudIds = new Set(rootEntries.entries.map(e => e.id));
			for (const id of Object.keys(this.settings.syncState)) {
				if (!cloudIds.has(id)) {
					delete this.settings.syncState[id];
				}
			}

			this.settings.lastSyncTimestamp = Date.now();
			await this.saveSettings();

			if (syncedCount === 0 && errorCount === 0) {
				new Notice("Slate: Everything is up to date.");
			} else {
				const msg = [];
				if (syncedCount > 0) msg.push(`${syncedCount} synced`);
				if (errorCount > 0) msg.push(`${errorCount} failed`);
				new Notice(`Slate: ${msg.join(", ")}.`);
			}
		} catch (err) {
			console.error("Slate error:", err);
			new Notice(`Slate failed: ${(err as Error).message}`);
		} finally {
			this.isSyncing = false;
		}
	}

	/**
	 * Fetch full item details (sub-entries + metadata) for a single root entry.
	 * Returns null if the item should be skipped (deleted, unknown type).
	 */
	private async fetchItem(entry: RawEntry): Promise<RemarkableItem | null> {
		const TAG = "[RemarkableSync]";
		const itemEntries = await this.client.getEntries(entry.hash);
		const fileEntries = itemEntries.entries;

		const metaEntry = fileEntries.find(e => e.id.endsWith(".metadata"));
		if (!metaEntry) {
			console.warn(`${TAG} No metadata for entry ${entry.id}, skipping`);
			return null;
		}

		const metaText = await this.client.getTextByHash(metaEntry.hash);
		const metadata = JSON.parse(metaText) as ItemMetadata;

		if (metadata.deleted) return null;
		if (metadata.type !== "DocumentType" && metadata.type !== "CollectionType") return null;

		return {
			id: entry.id,
			hash: entry.hash,
			visibleName: metadata.visibleName,
			lastModified: metadata.lastModified,
			parent: metadata.parent,
			pinned: metadata.pinned,
			type: metadata.type,
			fileEntries,
		};
	}

	private async syncDocument(
		doc: RemarkableItem,
		allItems: RemarkableItem[],
	): Promise<void> {


		const contentEntry = doc.fileEntries.find(e => e.id.endsWith(".content"));
		let content: DocumentContent = {
			fileType: "",
			pages: [],
			pageCount: 0,
			lastOpenedPage: 0,
			lineHeight: -1,
			margins: 100,
			textScale: 1,
			extraMetadata: {},
			transform: { m11: 1, m12: 0, m13: 0, m21: 0, m22: 1, m23: 0, m31: 0, m32: 0, m33: 1 },
		};

		if (contentEntry) {
			try {
				const contentText = await this.client.getTextByHash(contentEntry.hash);
				content = { ...content, ...JSON.parse(contentText) };
			} catch {
				console.warn(`Failed to parse .content for "${doc.visibleName}"`);
			}
		}

		if (this.settings.excludePdfs && content.fileType === "pdf") {
			return;
		}

		let basePdf: ArrayBuffer | null = null;
		const pdfEntry = doc.fileEntries.find(e => e.id.endsWith(".pdf"));
		if (pdfEntry) {
			basePdf = await this.client.getBinaryByHash(pdfEntry.hash);
		}

		let baseEpub: ArrayBuffer | null = null;
		const epubEntry = doc.fileEntries.find(e => e.id.endsWith(".epub"));
		if (epubEntry) {
			baseEpub = await this.client.getBinaryByHash(epubEntry.hash);
		}

		const pageOrder = this.getPageOrder(content, doc);
		const pages: RmPage[] = [];
		const rawRmFiles: Map<string, ArrayBuffer> = new Map();

		for (const pageId of pageOrder) {
			const rmEntry = doc.fileEntries.find(
				e => e.id.includes(pageId) && e.id.endsWith(".rm"),
			);
			if (!rmEntry) continue;

			try {
				const rmData = await this.client.getBinaryByHash(rmEntry.hash);
				rawRmFiles.set(pageId, rmData);
				const page = parseRmFile(rmData);
				pages.push(page);
			} catch (err) {
				console.warn(`Skipping page ${pageId}: ${(err as Error).message}`);
			}
		}

		const vaultFolderPath = this.getVaultPath(doc, allItems);
		const attachmentsPath = `${vaultFolderPath}/attachments`;
		await this.ensureFolderExists(attachmentsPath);

		const safeName = sanitizeFilename(doc.visibleName);
		const pdfPath = `${attachmentsPath}/${safeName}.pdf`;
		const mdPath = `${vaultFolderPath}/${safeName}.md`;

		let pdfBytes: ArrayBuffer | null = null;
		const hasAnnotations = pages.some(p =>
			p.highlights.length > 0 || p.layers.some(l => l.strokes.length > 0)
		);

		if (basePdf && hasAnnotations) {
			pdfBytes = await overlayAnnotations(basePdf, pages);
		} else if (basePdf) {
			pdfBytes = basePdf;
		} else if (pages.length > 0) {
			pdfBytes = await generatePdf(pages, content.transform);
		}

		if (!pdfBytes && !baseEpub && rawRmFiles.size === 0) {
			return;
		}

		if (pdfBytes) {
			await this.writeFile(pdfPath, pdfBytes);
		}

		let epubRelPath = "";
		if (baseEpub) {
			const epubPath = `${attachmentsPath}/${safeName}.epub`;
			await this.writeFile(epubPath, baseEpub);
			epubRelPath = `attachments/${safeName}.epub`;
		}

		for (const [pageId, rmData] of rawRmFiles) {
			const rmPath = `${attachmentsPath}/${safeName}_${pageId}.rm`;
			await this.writeFile(rmPath, rmData);
		}

		const parsed: ParsedDocument = {
			id: doc.id,
			name: doc.visibleName,
			parent: doc.parent,
			hash: doc.hash,
			lastModified: doc.lastModified,
			content,
			pages,
			basePdf,
		};

		const pdfRelPath = pdfBytes ? `attachments/${safeName}.pdf` : "";
		const mdContent = generateMarkdown(parsed, pdfRelPath, epubRelPath);
		await this.writeFile(mdPath, new TextEncoder().encode(mdContent).buffer as ArrayBuffer);

		this.settings.syncState[doc.id] = {
			hash: doc.hash,
			lastModified: doc.lastModified,
			vaultPath: vaultFolderPath,
		};
		await this.saveSettings();
	}

	private getPageOrder(content: DocumentContent, doc: RemarkableItem): string[] {
		if (content.pages?.length > 0) {
			return content.pages;
		}

		if (content.cPages?.pages?.length) {
			return content.cPages.pages
				.sort((a, b) => a.idx.value.localeCompare(b.idx.value))
				.map(p => p.id);
		}

		return doc.fileEntries
			.filter(e => e.id.endsWith(".rm"))
			.map(e => {
				const parts = e.id.split("/");
				const filename = parts[parts.length - 1];
				return filename.replace(".rm", "");
			})
			.sort();
	}

	private getVaultPath(
		doc: RemarkableItem,
		allItems: RemarkableItem[],
	): string {
		const pathParts: string[] = [];
		let currentParent = doc.parent;

		while (currentParent && currentParent !== "" && currentParent !== "trash") {
			const parentItem = allItems.find(i => i.id === currentParent);
			if (!parentItem) break;
			pathParts.unshift(sanitizeFilename(parentItem.visibleName));
			currentParent = parentItem.parent;
		}

		const base = this.settings.syncFolder || "remarkable";
		if (pathParts.length > 0) {
			return `${base}/${pathParts.join("/")}`;
		}
		return base;
	}

	private async ensureFolderExists(path: string): Promise<void> {
		const parts = path.split("/");
		let current = "";

		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.vault.getAbstractFileByPath(current);
			if (!existing) {
				try {
					await this.vault.createFolder(current);
				} catch {
					// Folder may have been created concurrently
				}
			}
		}
	}

	private async writeFile(path: string, data: ArrayBuffer): Promise<void> {
		const existing = this.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.vault.modifyBinary(existing, data);
		} else {
			await this.vault.createBinary(path, data);
		}
	}
}

function sanitizeFilename(name: string): string {
	return name
		.replace(/[\\/:*?"<>|]/g, "_")
		.replace(/\s+/g, " ")
		.trim();
}
