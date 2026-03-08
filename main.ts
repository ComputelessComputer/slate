import { Plugin } from "obsidian";
import { PluginSettings, DEFAULT_SETTINGS, SyncProgressSnapshot } from "./src/types";
import { RemarkableClient } from "./src/RemarkableClient";
import { SyncEngine } from "./src/SyncEngine";
import { RemarkableSyncSettingTab } from "./src/SettingsTab";
import { SyncProgressModal } from "./src/SyncProgressModal";
import { EpubView, EPUB_VIEW_TYPE } from "./src/EpubView";

export default class RemarkableSyncPlugin extends Plugin {
	settings!: PluginSettings;
	private client: RemarkableClient | null = null;
	private syncEngine: SyncEngine | null = null;
	private statusBarItemEl!: HTMLElement;
	private syncProgressModal: SyncProgressModal | null = null;

	async onload(): Promise<void> {
		await this.loadPluginSettings();

		// Initialize client if we have a device token
		if (this.settings.deviceToken) {
			this.initClient();
		}

		this.registerView(EPUB_VIEW_TYPE, (leaf) => new EpubView(leaf));
		this.registerExtensions(["epub"], EPUB_VIEW_TYPE);

		this.addSettingTab(new RemarkableSyncSettingTab(this.app, this));

		// Status bar
		const statusBarItem = this.addStatusBarItem();
		this.statusBarItemEl = statusBarItem;
		statusBarItem.addClass("mod-clickable");
		statusBarItem.addEventListener("click", () => {
			if (this.syncEngine?.syncing) {
				this.showSyncProgress();
				return;
			}

			void this.runSync();
		});
		this.updateStatusBar();
		this.registerInterval(window.setInterval(() => this.updateStatusBar(), 1000));

		// Commands
		this.addCommand({
			id: "sync-remarkable",
			name: "Sync notes",
			callback: () => { void this.runSync(); },
		});

		this.addCommand({
			id: "force-sync-remarkable",
			name: "Force re-sync all notes",
			callback: async () => {
				this.settings.syncState = {};
				await this.savePluginSettings();
				await this.runSync();
			},
		});

		// Auto-sync on startup
		if (this.settings.syncOnStartup && this.settings.deviceToken) {
			this.app.workspace.onLayoutReady(() => {
				// Small delay to let Obsidian fully initialize
				setTimeout(() => { void this.runSync(); }, 3000);
			});
		}
	}

	onunload(): void {
		// Cleanup if needed
	}

	// ── Public API ──────────────────────────────────────────────────────────

	initClient(): void {
		this.client = new RemarkableClient(
			this.settings.deviceToken,
			this.settings.deviceId,
		);
		this.syncEngine = new SyncEngine(
			this.client,
			this.app.vault,
			this.settings,
			() => this.savePluginSettings(),
		);
	}

	async runSync(): Promise<void> {
		if (!this.syncEngine) {
			return;
		}

		if (this.syncEngine.syncing) {
			this.showSyncProgress();
			return;
		}

		this.showSyncProgress();
		await this.syncEngine.sync();
	}

	getSyncProgress(): SyncProgressSnapshot | null {
		return this.syncEngine?.getProgressSnapshot() ?? null;
	}

	private showSyncProgress(): void {
		if (!this.syncProgressModal) {
			this.syncProgressModal = new SyncProgressModal(this.app, this, () => {
				this.syncProgressModal = null;
			});
		}

		this.syncProgressModal.open();
	}

	private updateStatusBar(): void {
		if (!this.statusBarItemEl) {
			return;
		}

		const progress = this.getSyncProgress();
		if (!this.syncEngine?.syncing || !progress) {
			this.statusBarItemEl.setText("Slate");
			return;
		}

		if (progress.phase === "Listing cloud items") {
			this.statusBarItemEl.setText(`Slate ${progress.inspectedItemCount}/${progress.cloudItemCount}`);
			return;
		}

		if (progress.documentCount > 0) {
			this.statusBarItemEl.setText(`Slate ${progress.processedDocumentCount}/${progress.documentCount}`);
			return;
		}

		this.statusBarItemEl.setText(`Slate ${progress.phase}`);
	}

	// ── Settings Persistence ────────────────────────────────────────────────

	async loadPluginSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async savePluginSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Update client token if it changed
		if (this.client && this.settings.deviceToken) {
			this.client.updateDeviceToken(this.settings.deviceToken);
		}
	}
}
