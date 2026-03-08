import { Notice, Vault, TFile } from "obsidian";
import { RemarkableClient } from "./RemarkableClient";
import { parseRmFile } from "./RmParser";
import { generatePdf, overlayAnnotations } from "./PdfGenerator";
import { generateMarkdown } from "./MarkdownGenerator";
import { SyncLogger } from "./SyncLogger";
import {
	RawEntry,
	ItemMetadata,
	RemarkableItem,
	DocumentContent,
	RmPage,
	ParsedDocument,
	PluginSettings,
	SyncFailure,
	SyncProgressSnapshot,
	SyncRecord,
	SyncReport,
	SyncSkip,
} from "./types";

type SyncDocumentResult =
	| { status: "synced" }
	| { status: "skipped"; reason: string; kind: SyncSkip["kind"] };

interface LocalDocumentRecord {
	lastModified: string;
	vaultPath: string;
}

interface QueuedDocument {
	doc: RemarkableItem;
	existingLocalDocument: boolean;
}

const MAX_PROGRESS_ITEMS = 8;

export class SyncEngine {
	private isSyncing = false;
	private progress: SyncProgressSnapshot | null = null;

	constructor(
		private client: RemarkableClient,
		private vault: Vault,
		private settings: PluginSettings,
		private saveSettings: () => Promise<void>,
	) {}

	get syncing(): boolean {
		return this.isSyncing;
	}

	getProgressSnapshot(): SyncProgressSnapshot | null {
		if (!this.progress) {
			return null;
		}

		return {
			...this.progress,
			recentCompleted: this.progress.recentCompleted.map((item) => ({ ...item })),
			recentSkipped: this.progress.recentSkipped.map((item) => ({ ...item })),
			recentFailures: this.progress.recentFailures.map((item) => ({ ...item })),
		};
	}

	async sync(): Promise<void> {
		if (this.isSyncing) {
			return;
		}

		if (!this.client.isRegistered) {
			new Notice("Slate: not registered. Go to settings to connect your device.");
			return;
		}

		this.isSyncing = true;
		this.startProgress();
		const syncLogger = new SyncLogger();
		syncLogger.setLogPath(this.getSyncLogPath());

		try {
			await this.ensureFolderExists(this.getSyncRootPath());
			const localDocumentIndex = await this.buildLocalDocumentIndex();

			this.setProgressPhase("Authenticating");
			new Notice("Slate: authenticating...");
			await this.client.refreshToken();

			this.setProgressPhase("Listing cloud items");
			new Notice("Slate: fetching document list...");
			const root = await this.client.getRootHash();
			const rootEntries = await this.client.getEntries(root.hash);
			syncLogger.setCloudItemCount(rootEntries.entries.length);
			this.setCloudItemCount(rootEntries.entries.length);

			const allItems: RemarkableItem[] = [];
			const documentsToSync: QueuedDocument[] = [];

			for (const entry of rootEntries.entries) {
				const cached = this.settings.syncState[entry.id];
				this.hydrateCachedVaultPath(cached, localDocumentIndex.get(entry.id));
				const cachedItem = this.getCachedItem(entry, cached);
				this.setProgressPhase("Listing cloud items", cachedItem?.visibleName ?? cached?.visibleName ?? entry.id);

				try {
					if (cachedItem?.type === "CollectionType") {
						allItems.push(cachedItem);
						syncLogger.logListed(cachedItem.id, cachedItem.visibleName);
						this.recordListedFromCache(cachedItem.type);
						continue;
					}

					if (cachedItem?.type === "DocumentType" && this.hasLocalMarkdown(cachedItem, cached)) {
						allItems.push(cachedItem);
						syncLogger.logListed(cachedItem.id, cachedItem.visibleName);
						syncLogger.logSkipped(cachedItem.id, cachedItem.visibleName);
						this.recordListedFromCache(cachedItem.type);
						this.recordDocumentQueued();
						this.recordSkipped(
							cachedItem.id,
							cachedItem.visibleName,
							"unchanged (already synced)",
							"cached_unchanged",
						);
						continue;
					}

					const item = await this.fetchItem(entry);
					if (!item) {
						continue;
					}

					allItems.push(item);
					syncLogger.logListed(item.id, item.visibleName);
					this.recordListedFromCloud();
					this.cacheItem(item);

					if (item.type === "DocumentType") {
						this.recordDocumentQueued();
						const localDocument = localDocumentIndex.get(item.id);
						const existingLocalDocument = this.hasExistingLocalDocument(item, cached, localDocument);
						if (this.canReuseLocalDocument(item, localDocument)) {
							this.settings.syncState[item.id].vaultPath = localDocument.vaultPath;
							syncLogger.logSkipped(item.id, item.visibleName);
							this.recordSkipped(
								item.id,
								item.visibleName,
								"unchanged (reused local markdown)",
								"reused_local_markdown",
							);
							continue;
						}
						documentsToSync.push({ doc: item, existingLocalDocument });
					}
				} catch (err) {
					const name = cached?.visibleName ?? entry.id;
					console.warn(`[RemarkableSync] Failed to read entry ${entry.id}:`, err);
					syncLogger.logFailed(entry.id, name, this.getErrorMessage(err));
					this.recordFailure(entry.id, name, this.getErrorMessage(err), false);
				} finally {
					this.recordInspectedItem();
				}
			}

			this.setProgressPhase("Syncing documents");
			for (const queuedDocument of documentsToSync) {
				const { doc, existingLocalDocument } = queuedDocument;
				this.setProgressPhase("Syncing documents", doc.visibleName);
				try {
					const result = await this.syncDocument(doc, allItems);
					if (result.status === "synced") {
						syncLogger.logSynced(doc.id, doc.visibleName);
						this.recordSynced(
							doc.visibleName,
							existingLocalDocument ? "redownloaded" : "new_download",
						);
					} else {
						syncLogger.logSkipped(doc.id, doc.visibleName);
						this.recordSkipped(doc.id, doc.visibleName, result.reason, result.kind);
					}
				} catch (err) {
					console.error(`Failed to sync "${doc.visibleName}":`, err);
					syncLogger.logFailed(doc.id, doc.visibleName, this.getErrorMessage(err));
					this.recordFailure(doc.id, doc.visibleName, this.getErrorMessage(err));
				}
			}

			const cloudIds = new Set(rootEntries.entries.map((entry) => entry.id));
			for (const id of Object.keys(this.settings.syncState)) {
				if (!cloudIds.has(id)) {
					delete this.settings.syncState[id];
				}
			}

			const report = await this.finalizeSync(syncLogger);
			this.finishProgress(report);
			new Notice(syncLogger.formatNotice(report));
		} catch (err) {
			syncLogger.logSessionFailure(this.getErrorMessage(err));
			console.error("Slate error:", err);
			const report = await this.finalizeSync(syncLogger);
			this.finishProgress(report);
			new Notice(syncLogger.formatNotice(report));
		} finally {
			this.isSyncing = false;
		}
	}

	private async syncDocument(
		doc: RemarkableItem,
		allItems: RemarkableItem[],
	): Promise<SyncDocumentResult> {
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
			return { status: "skipped", reason: "excluded PDF", kind: "excluded_pdf" };
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
			return { status: "skipped", reason: "no supported content", kind: "no_supported_content" };
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
			visibleName: doc.visibleName,
			parent: doc.parent,
			type: doc.type,
		};
		await this.saveSettings();

		return { status: "synced" };
	}

	private async fetchItem(entry: RawEntry): Promise<RemarkableItem | null> {
		const itemEntries = await this.client.getEntries(entry.hash);
		const fileEntries = itemEntries.entries;

		const metaEntry = fileEntries.find((fileEntry) => fileEntry.id.endsWith(".metadata"));
		if (!metaEntry) {
			console.warn(`[RemarkableSync] No metadata for entry ${entry.id}, skipping`);
			return null;
		}

		const metaText = await this.client.getTextByHash(metaEntry.hash);
		const metadata = JSON.parse(metaText) as ItemMetadata;

		if (metadata.deleted) {
			return null;
		}

		if (metadata.type !== "DocumentType" && metadata.type !== "CollectionType") {
			return null;
		}

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

	private getCachedItem(entry: RawEntry, cached?: SyncRecord): RemarkableItem | null {
		if (!cached || cached.hash !== entry.hash || !cached.visibleName || !cached.type) {
			return null;
		}

		return {
			id: entry.id,
			hash: entry.hash,
			visibleName: cached.visibleName,
			lastModified: cached.lastModified,
			parent: cached.parent ?? "",
			pinned: false,
			type: cached.type,
			fileEntries: [],
		};
	}

	private cacheItem(item: RemarkableItem): void {
		const existing = this.settings.syncState[item.id];
		this.settings.syncState[item.id] = {
			hash: item.hash,
			lastModified: item.lastModified,
			vaultPath: existing?.vaultPath ?? "",
			visibleName: item.visibleName,
			parent: item.parent,
			type: item.type,
		};
	}

	private hasLocalMarkdown(item: RemarkableItem, cached?: SyncRecord): boolean {
		if (!cached?.vaultPath) {
			return false;
		}

		const safeName = sanitizeFilename(item.visibleName);
		const mdPath = `${cached.vaultPath}/${safeName}.md`;
		return !!this.vault.getAbstractFileByPath(mdPath);
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

	private getSyncRootPath(): string {
		return this.settings.syncFolder || "remarkable";
	}

	private getSyncLogPath(): string {
		return `${this.getSyncRootPath()}/.sync-log.md`;
	}

	private async buildLocalDocumentIndex(): Promise<Map<string, LocalDocumentRecord>> {
		if (!this.shouldBuildLocalDocumentIndex()) {
			return new Map();
		}

		const index = new Map<string, LocalDocumentRecord>();
		const prefix = `${this.getSyncRootPath()}/`;

		for (const file of this.vault.getMarkdownFiles()) {
			if (!file.path.startsWith(prefix)) {
				continue;
			}

			const content = await this.vault.cachedRead(file);
			const remarkableId = extractFrontmatterValue(content, "remarkable_id");
			const lastModified = extractFrontmatterValue(content, "last_modified");

			if (!remarkableId || !lastModified) {
				continue;
			}

			index.set(remarkableId, {
				lastModified,
				vaultPath: getParentPath(file.path),
			});
		}

		return index;
	}

	private shouldBuildLocalDocumentIndex(): boolean {
		if (this.settings.lastSyncTimestamp === 0) {
			return true;
		}

		for (const record of Object.values(this.settings.syncState)) {
			if (record.type === "DocumentType" && !record.vaultPath) {
				return true;
			}
		}

		return false;
	}

	private hydrateCachedVaultPath(
		cached: SyncRecord | undefined,
		localDocument: LocalDocumentRecord | undefined,
	): void {
		if (!cached || cached.vaultPath || !localDocument) {
			return;
		}

		if (cached.lastModified === localDocument.lastModified) {
			cached.vaultPath = localDocument.vaultPath;
		}
	}

	private canReuseLocalDocument(
		item: RemarkableItem,
		localDocument: LocalDocumentRecord | undefined,
	): localDocument is LocalDocumentRecord {
		return !!localDocument && item.lastModified === localDocument.lastModified;
	}

	private hasExistingLocalDocument(
		item: RemarkableItem,
		cached: SyncRecord | undefined,
		localDocument: LocalDocumentRecord | undefined,
	): boolean {
		if (localDocument) {
			return true;
		}

		return this.hasLocalMarkdown(item, cached);
	}

	private startProgress(): void {
		this.progress = {
			phase: "Starting",
			startedAt: Date.now(),
			cloudItemCount: 0,
			inspectedItemCount: 0,
			documentCount: 0,
			processedDocumentCount: 0,
			listedCount: 0,
			listedFromCacheCount: 0,
			listedFromCloudCount: 0,
			cachedCollectionCount: 0,
			cachedDocumentCount: 0,
			syncedCount: 0,
			newDownloadCount: 0,
			redownloadCount: 0,
			skippedCount: 0,
			cachedSkipCount: 0,
			reusedLocalSkipCount: 0,
			excludedPdfSkipCount: 0,
			unsupportedContentSkipCount: 0,
			otherSkipCount: 0,
			failedCount: 0,
			recentCompleted: [],
			recentSkipped: [],
			recentFailures: [],
			logPath: this.getSyncLogPath(),
		};
	}

	private setProgressPhase(phase: string, currentItem?: string): void {
		if (!this.progress) {
			return;
		}

		this.progress.phase = phase;
		this.progress.currentItem = currentItem;
	}

	private setCloudItemCount(count: number): void {
		if (this.progress) {
			this.progress.cloudItemCount = count;
		}
	}

	private recordInspectedItem(): void {
		if (this.progress) {
			this.progress.inspectedItemCount += 1;
		}
	}

	private recordListedFromCache(type: RemarkableItem["type"]): void {
		if (!this.progress) {
			return;
		}

		this.progress.listedCount += 1;
		this.progress.listedFromCacheCount += 1;
		if (type === "CollectionType") {
			this.progress.cachedCollectionCount += 1;
		} else {
			this.progress.cachedDocumentCount += 1;
		}
	}

	private recordListedFromCloud(): void {
		if (!this.progress) {
			return;
		}

		this.progress.listedCount += 1;
		this.progress.listedFromCloudCount += 1;
	}

	private recordDocumentQueued(): void {
		if (this.progress) {
			this.progress.documentCount += 1;
		}
	}

	private recordSynced(name: string, kind: "new_download" | "redownloaded"): void {
		if (!this.progress) {
			return;
		}

		this.progress.processedDocumentCount += 1;
		this.progress.syncedCount += 1;
		if (kind === "new_download") {
			this.progress.newDownloadCount += 1;
		} else {
			this.progress.redownloadCount += 1;
		}

		this.pushRecentCompleted(name, kind);
	}

	private recordSkipped(id: string, name: string, reason: string, kind: SyncSkip["kind"]): void {
		if (!this.progress) {
			return;
		}

		this.progress.processedDocumentCount += 1;
		this.progress.skippedCount += 1;
		switch (kind) {
			case "cached_unchanged":
				this.progress.cachedSkipCount += 1;
				break;
			case "reused_local_markdown":
				this.progress.reusedLocalSkipCount += 1;
				break;
			case "excluded_pdf":
				this.progress.excludedPdfSkipCount += 1;
				break;
			case "no_supported_content":
				this.progress.unsupportedContentSkipCount += 1;
				break;
			default:
				this.progress.otherSkipCount += 1;
		}

		this.pushRecentSkipped({ id, name, reason, kind });
	}

	private recordFailure(id: string, name: string, error: string, countsAsDocument = true): void {
		if (!this.progress) {
			return;
		}

		if (countsAsDocument) {
			this.progress.processedDocumentCount += 1;
		}

		this.progress.failedCount += 1;
		this.pushRecentFailure({ id, name, error });
	}

	private pushRecentCompleted(name: string, kind: "new_download" | "redownloaded"): void {
		if (!this.progress) {
			return;
		}

		this.progress.recentCompleted = [{ name, kind }, ...this.progress.recentCompleted].slice(0, MAX_PROGRESS_ITEMS);
	}

	private pushRecentSkipped(skip: SyncSkip): void {
		if (!this.progress) {
			return;
		}

		this.progress.recentSkipped = [skip, ...this.progress.recentSkipped].slice(0, MAX_PROGRESS_ITEMS);
	}

	private pushRecentFailure(failure: SyncFailure): void {
		if (!this.progress) {
			return;
		}

		this.progress.recentFailures = [failure, ...this.progress.recentFailures].slice(0, MAX_PROGRESS_ITEMS);
	}

	private finishProgress(report: SyncReport): void {
		if (!this.progress) {
			return;
		}

		this.progress.phase = report.fatalError ? "Failed" : "Completed";
		this.progress.currentItem = undefined;
		this.progress.listedCount = report.listedCount;
		this.progress.syncedCount = report.syncedCount;
		this.progress.skippedCount = report.skippedCount;
		this.progress.failedCount = report.failedCount;
		this.progress.fatalError = report.fatalError;
		this.progress.logPath = report.logPath ?? this.progress.logPath;
	}

	private async finalizeSync(syncLogger: SyncLogger): Promise<SyncReport> {
		this.settings.lastSyncTimestamp = Date.now();
		const report = syncLogger.getReport();
		this.settings.lastSyncReport = report;

		try {
			await this.writeSyncLog(syncLogger, report);
		} catch (err) {
			console.error("Slate log write error:", err);
		}

		await this.saveSettings();
		return report;
	}

	private async writeSyncLog(syncLogger: SyncLogger, report: SyncReport): Promise<void> {
		const logPath = this.getSyncLogPath();
		const existing = this.vault.getAbstractFileByPath(logPath);

		if (existing instanceof TFile) {
			const currentContent = await this.vault.read(existing);
			await this.vault.modify(existing, syncLogger.updateLogContent(currentContent, report));
			return;
		}

		await this.vault.create(logPath, syncLogger.createLogContent(report));
	}

	private getErrorMessage(err: unknown): string {
		if (err instanceof Error && err.message) {
			return err.message;
		}

		return "Unknown error";
	}
}

function sanitizeFilename(name: string): string {
	return name
		.replace(/[\\/:*?"<>|]/g, "_")
		.replace(/\s+/g, " ")
		.trim();
}

function extractFrontmatterValue(content: string, key: string): string | null {
	const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
	if (!frontmatterMatch) {
		return null;
	}

	const valueMatch = frontmatterMatch[1].match(new RegExp(`^${key}:\\s*"([^"]*)"$`, "m"));
	return valueMatch?.[1] ?? null;
}

function getParentPath(path: string): string {
	const lastSlash = path.lastIndexOf("/");
	if (lastSlash === -1) {
		return "";
	}

	return path.slice(0, lastSlash);
}
