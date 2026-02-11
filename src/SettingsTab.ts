import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type RemarkableSyncPlugin from "../main";
import { generateDeviceId, RemarkableClient } from "./RemarkableClient";

export class RemarkableSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: RemarkableSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── Header ────────────────────────────────────────────────────────
		containerEl.createEl("h2", { text: "Slate" });

		// ── Connection Status ─────────────────────────────────────────────
		const statusEl = containerEl.createEl("div", {
			cls: "remarkable-sync-status",
		});

		if (this.plugin.settings.deviceToken) {
			statusEl.createEl("p", {
				text: "Connected to reMarkable Cloud",
				cls: "remarkable-sync-connected",
			});
			statusEl.createEl("p", {
				text: `Device ID: ${this.plugin.settings.deviceId.slice(0, 8)}...`,
				cls: "remarkable-sync-device-id setting-item-description",
			});
		} else {
			statusEl.createEl("p", {
				text: "Not connected",
				cls: "remarkable-sync-disconnected",
			});
		}

		// ── Device Registration ───────────────────────────────────────────
		containerEl.createEl("h3", { text: "Device Registration" });

		if (this.plugin.settings.deviceToken) {
			new Setting(containerEl)
				.setName("Disconnect device")
				.setDesc("Remove the connection to your reMarkable cloud account.")
				.addButton((btn) =>
					btn
						.setButtonText("Disconnect")
						.setWarning()
						.onClick(async () => {
							this.plugin.settings.deviceToken = "";
							this.plugin.settings.deviceId = "";
							this.plugin.settings.syncState = {};
							await this.plugin.savePluginSettings();
							new Notice("Disconnected from reMarkable Cloud.");
							this.display(); // Refresh
						})
				);
		} else {
			const descFrag = document.createDocumentFragment();
			descFrag.appendText("Get a one-time code from ");
			const link = descFrag.createEl("a", {
				text: "my.remarkable.com",
				href: "https://my.remarkable.com/device/desktop/connect",
			});
			link.setAttr("target", "_blank");
			descFrag.appendText(" and enter it below.");

			let codeValue = "";

			new Setting(containerEl)
				.setName("One-time code")
				.setDesc(descFrag)
				.addText((text) => {
					text.setPlaceholder("abcdefgh")
						.onChange((value) => {
							codeValue = value;
						});
					text.inputEl.addEventListener("keydown", (e) => {
						if (e.key === "Enter") {
							registerDevice(this.plugin, codeValue, this);
						}
					});
				})
				.addButton((btn) =>
					btn
						.setButtonText("Connect")
						.setCta()
						.onClick(() => registerDevice(this.plugin, codeValue, this))
				);
		}

		// ── Sync Settings ─────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Sync Settings" });

		new Setting(containerEl)
			.setName("Sync folder")
			.setDesc('Vault folder where reMarkable files will be saved. Default: "remarkable"')
			.addText((text) =>
				text
					.setPlaceholder("remarkable")
					.setValue(this.plugin.settings.syncFolder)
					.onChange(async (value) => {
						this.plugin.settings.syncFolder = value || "remarkable";
						await this.plugin.savePluginSettings();
					})
			);

		new Setting(containerEl)
			.setName("Sync on startup")
			.setDesc("Automatically sync when Obsidian starts.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.syncOnStartup = value;
						await this.plugin.savePluginSettings();
					})
			);

		// ── Manual Sync ───────────────────────────────────────────────────
		if (this.plugin.settings.deviceToken) {
			containerEl.createEl("h3", { text: "Actions" });

			new Setting(containerEl)
				.setName("Sync now")
				.setDesc(
					this.plugin.settings.lastSyncTimestamp
						? `Last synced: ${new Date(this.plugin.settings.lastSyncTimestamp).toLocaleString()}`
						: "Never synced"
				)
				.addButton((btn) =>
					btn
						.setButtonText("Sync")
						.setCta()
						.onClick(async () => {
							await this.plugin.runSync();
							this.display(); // Refresh to show new timestamp
						})
				);

			new Setting(containerEl)
				.setName("Reset sync state")
				.setDesc("Force re-download all documents on next sync.")
				.addButton((btn) =>
					btn
						.setButtonText("Reset")
						.setWarning()
						.onClick(async () => {
							this.plugin.settings.syncState = {};
							this.plugin.settings.lastSyncTimestamp = 0;
							await this.plugin.savePluginSettings();
							new Notice("Sync state reset. Next sync will re-download everything.");
							this.display();
						})
				);
		}
	}
}

async function registerDevice(
	plugin: RemarkableSyncPlugin,
	code: string,
	tab: RemarkableSyncSettingTab,
): Promise<void> {
	if (!code.trim()) {
		new Notice("Please enter a one-time code.");
		return;
	}

	try {
		new Notice("Connecting to reMarkable...");
		const deviceId = plugin.settings.deviceId || generateDeviceId();
		const deviceToken = await RemarkableClient.register(code, deviceId);

		plugin.settings.deviceToken = deviceToken;
		plugin.settings.deviceId = deviceId;
		await plugin.savePluginSettings();
		plugin.initClient();

		new Notice("Successfully connected to reMarkable Cloud!");
		tab.display(); // Refresh to show connected state
	} catch (err) {
		new Notice(`Connection failed: ${(err as Error).message}`);
		console.error("reMarkable registration error:", err);
	}
}
