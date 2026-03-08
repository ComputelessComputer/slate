import { App, Modal } from "obsidian";
import type RemarkableSyncPlugin from "../main";

export class SyncProgressModal extends Modal {
	private refreshTimer: number | null = null;

	constructor(
		app: App,
		private plugin: RemarkableSyncPlugin,
		private onModalClose?: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Slate Sync Progress");
		this.render();
		if (this.refreshTimer !== null) {
			window.clearInterval(this.refreshTimer);
		}
		this.refreshTimer = window.setInterval(() => this.render(), 1000);
	}

	onClose(): void {
		if (this.refreshTimer !== null) {
			window.clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}

		this.contentEl.empty();
		this.onModalClose?.();
	}

	private render(): void {
		const snapshot = this.plugin.getSyncProgress();
		const { contentEl } = this;
		contentEl.empty();

		if (!snapshot) {
			contentEl.createEl("p", { text: "No sync in progress." });
			return;
		}

		contentEl.createEl("p", { text: `Phase: ${snapshot.phase}` });
		contentEl.createEl("p", { text: `Elapsed: ${formatDuration(Date.now() - snapshot.startedAt)}` });

		if (snapshot.currentItem) {
			contentEl.createEl("p", { text: `Current item: ${snapshot.currentItem}` });
		}

		contentEl.createEl("p", {
			text: `Cloud items: ${snapshot.inspectedItemCount}/${snapshot.cloudItemCount} inspected | ${snapshot.listedCount} listed`,
		});
		contentEl.createEl("p", {
			text: `Documents: ${snapshot.processedDocumentCount}/${snapshot.documentCount} processed | ${snapshot.syncedCount} completed | ${snapshot.skippedCount} skipped | ${snapshot.failedCount} errors`,
		});

		if (snapshot.fatalError) {
			contentEl.createEl("p", { text: `Fatal error: ${snapshot.fatalError}` });
		}

		renderNameList(contentEl, "Recent completed", snapshot.recentSynced);
		renderDetailedList(
			contentEl,
			"Recent skipped",
			snapshot.recentSkipped.map((item) => `${item.name}: ${item.reason}`),
		);
		renderDetailedList(
			contentEl,
			"Recent errors",
			snapshot.recentFailures.map((item) => `${item.name}: ${item.error}`),
		);

		if (snapshot.logPath) {
			contentEl.createEl("p", { text: `Log file: ${snapshot.logPath}` });
		}
	}
}

function renderNameList(containerEl: HTMLElement, heading: string, items: string[]): void {
	if (items.length === 0) {
		return;
	}

	containerEl.createEl("h4", { text: heading });
	const listEl = containerEl.createEl("ul");
	for (const item of items) {
		listEl.createEl("li", { text: item });
	}
}

function renderDetailedList(containerEl: HTMLElement, heading: string, items: string[]): void {
	if (items.length === 0) {
		return;
	}

	containerEl.createEl("h4", { text: heading });
	const listEl = containerEl.createEl("ul");
	for (const item of items) {
		listEl.createEl("li", { text: item });
	}
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1000) {
		return `${durationMs}ms`;
	}

	return `${(durationMs / 1000).toFixed(1)}s`;
}
