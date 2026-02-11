import { Plugin } from "obsidian";
import { PluginSettings, DEFAULT_SETTINGS } from "./src/types";
import { RemarkableClient } from "./src/RemarkableClient";
import { SyncEngine } from "./src/SyncEngine";
import { RemarkableSyncSettingTab } from "./src/SettingsTab";
import { EpubView, EPUB_VIEW_TYPE } from "./src/EpubView";

export default class RemarkableSyncPlugin extends Plugin {
	settings!: PluginSettings;
	private client: RemarkableClient | null = null;
	private syncEngine: SyncEngine | null = null;

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
		statusBarItem.addClass("mod-clickable");
		statusBarItem.setText("reMarkable");
		statusBarItem.addEventListener("click", () => this.runSync());

		// Commands
		this.addCommand({
			id: "sync-remarkable",
			name: "Sync reMarkable notes",
			callback: () => this.runSync(),
		});

		this.addCommand({
			id: "force-sync-remarkable",
			name: "Force re-sync all reMarkable notes",
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
				setTimeout(() => this.runSync(), 3000);
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
		await this.syncEngine.sync();
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
