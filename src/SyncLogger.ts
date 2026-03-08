import { SyncFailure, SyncReport } from "./types";

type SyncAction = "listed" | "synced" | "skipped" | "failed";

interface SyncEvent {
	id: string;
	name: string;
	action: SyncAction;
	error?: string;
}

const LOG_HEADER = "# Slate Sync Log\n\nNewest entries appear first.\n";
const MAX_LOG_ENTRIES = 50;
const MAX_NOTICE_FAILURES = 3;

export class SyncLogger {
	private readonly startTime = Date.now();
	private events: SyncEvent[] = [];
	private cloudItemCount = 0;
	private fatalError: string | null = null;
	private logPath = "";

	setCloudItemCount(count: number): void {
		this.cloudItemCount = count;
	}

	setLogPath(path: string): void {
		this.logPath = path;
	}

	logListed(id: string, name: string): void {
		this.events.push({ id, name, action: "listed" });
	}

	logSynced(id: string, name: string): void {
		this.events.push({ id, name, action: "synced" });
	}

	logSkipped(id: string, name: string): void {
		this.events.push({ id, name, action: "skipped" });
	}

	logFailed(id: string, name: string, error: string): void {
		this.events.push({ id, name, action: "failed", error });
	}

	logSessionFailure(error: string): void {
		this.fatalError = error;
	}

	getReport(): SyncReport {
		const endTime = Date.now();
		const failedItems = this.events
			.filter((event): event is SyncEvent & { error: string } => event.action === "failed" && !!event.error)
			.map((event): SyncFailure => ({
				id: event.id,
				name: event.name,
				error: event.error,
			}));

		return {
			startTime: this.startTime,
			endTime,
			durationMs: endTime - this.startTime,
			cloudItemCount: this.cloudItemCount,
			listedCount: this.events.filter((event) => event.action === "listed").length,
			syncedCount: this.events.filter((event) => event.action === "synced").length,
			skippedCount: this.events.filter((event) => event.action === "skipped").length,
			failedCount: failedItems.length,
			failedItems,
			fatalError: this.fatalError ?? undefined,
			logPath: this.logPath || undefined,
		};
	}

	formatNotice(report: SyncReport): string {
		if (report.fatalError) {
			const logPath = report.logPath ?? ".sync-log.md";
			return `Slate sync failed: ${report.fatalError}. Check ${logPath} for details.`;
		}

		const parts = [
			`${report.cloudItemCount} found`,
			`${report.syncedCount} synced`,
			`${report.skippedCount} unchanged`,
		];

		if (report.failedCount > 0) {
			const failedNames = report.failedItems
				.slice(0, MAX_NOTICE_FAILURES)
				.map((item) => item.name)
				.join(", ");
			const extraFailures = report.failedCount - MAX_NOTICE_FAILURES;
			const suffix = extraFailures > 0 ? `, +${extraFailures} more` : "";
			parts.push(`${report.failedCount} failed (${failedNames}${suffix})`);
		}

		return `Slate: ${parts.join(", ")}.`;
	}

	formatLogEntry(report: SyncReport): string {
		const lines = [
			`## ${new Date(report.endTime).toLocaleString()}`,
			"",
			`- **Duration:** ${formatDuration(report.durationMs)}`,
			`- **Cloud items:** ${report.cloudItemCount}`,
			`- **Listed:** ${report.listedCount}`,
			`- **Synced:** ${report.syncedCount}`,
			`- **Unchanged:** ${report.skippedCount}`,
			`- **Failed:** ${report.failedCount}`,
		];

		if (report.fatalError) {
			lines.push(`- **Fatal error:** ${escapeLogText(report.fatalError)}`);
		}

		if (report.failedItems.length > 0) {
			lines.push("- **Failed items:**");
			for (const item of report.failedItems) {
				lines.push(`  - \"${escapeLogText(item.name)}\" - ${escapeLogText(item.error)}`);
			}
		}

		return `${lines.join("\n")}\n`;
	}

	updateLogContent(existingContent: string, report: SyncReport): string {
		const sections = splitLogSections(existingContent);
		const nextSections = [this.formatLogEntry(report), ...sections].slice(0, MAX_LOG_ENTRIES);
		return `${LOG_HEADER}${nextSections.join("\n")}`.trimEnd() + "\n";
	}

	createLogContent(report: SyncReport): string {
		return `${LOG_HEADER}${this.formatLogEntry(report)}`;
	}
}

function splitLogSections(content: string): string[] {
	const trimmed = content.trim();
	if (!trimmed) {
		return [];
	}

	const withoutHeader = trimmed.replace(/^# Slate Sync Log\n\nNewest entries appear first\.\n?/, "").trim();
	if (!withoutHeader) {
		return [];
	}

	return withoutHeader
		.split(/\n(?=## )/)
		.map((section) => section.trim())
		.filter(Boolean)
		.map((section) => `${section}\n`);
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1000) {
		return `${durationMs}ms`;
	}

	return `${(durationMs / 1000).toFixed(1)}s`;
}

function escapeLogText(value: string): string {
	return value.replace(/\n+/g, " ").replace(/[<>]/g, "").trim();
}
