import { requestUrl, RequestUrlResponse } from "obsidian";
import {
	RawEntry,
	EntriesFile,
	ItemMetadata,
	RemarkableItem,
	RootHashResponse,
} from "./types";
import {
	RM_DEVICE_REGISTER_URL,
	RM_TOKEN_REFRESH_URL,
	RM_RAW_HOST,
} from "./constants";

const TAG = "[RemarkableSync]";

async function rmRequest(opts: {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	contentType?: string;
}): Promise<RequestUrlResponse> {
	const { url, method = "GET", headers, body, contentType } = opts;
	const shortUrl = url.split("?")[0].slice(0, 80);
	console.log(`${TAG} ${method} ${shortUrl}`);

	try {
		return await requestUrl({ url, method, headers, body, contentType });
	} catch (err: unknown) {
		const e = err as Record<string, unknown>;
		const status = e?.status ?? "network_error";
		console.error(`${TAG} ${method} ${shortUrl} → ${status}`, err);
		throw new RmApiError(String(status), typeof status === "number" ? status : 0);
	}
}

class RmApiError extends Error {
	constructor(message: string, public status: number) {
		super(message);
		this.name = "RmApiError";
	}
}

function parseEntriesText(raw: string): EntriesFile {
	const lines = raw.slice(0, -1).split("\n");
	const versionStr = lines[0];
	const version = parseInt(versionStr, 10);

	if (version === 3) {
		return {
			schemaVersion: 3,
			entries: lines.slice(1).map(parseEntryLine),
		};
	} else if (version === 4) {
		const infoLine = lines[1];
		const [, id, countStr, sizeStr] = infoLine.split(":");
		return {
			schemaVersion: 4,
			entries: lines.slice(2).map(parseEntryLine),
			id,
			totalSize: parseInt(sizeStr, 10),
		};
	}
	throw new Error(`Unsupported schema version: ${versionStr}`);
}

function parseEntryLine(line: string): RawEntry {
	const [hash, typeStr, id, subfilesStr, sizeStr] = line.split(":");
	return {
		hash,
		type: typeStr === "80000000" ? 80000000 : 0,
		id,
		subfiles: parseInt(subfilesStr, 10),
		size: parseInt(sizeStr, 10),
	};
}

export class RemarkableClient {
	private userToken: string | null = null;

	constructor(
		private deviceToken: string,
		private deviceId: string,
	) {}

	static async register(code: string, deviceId: string): Promise<string> {
		const response = await rmRequest({
			url: RM_DEVICE_REGISTER_URL,
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({
				code: code.trim(),
				deviceDesc: "desktop-windows",
				deviceID: deviceId,
			}),
		});
		console.log(`${TAG} Device registered`);
		return response.text;
	}

	async refreshToken(): Promise<void> {
		if (!this.deviceToken) throw new Error("No device token");

		const response = await rmRequest({
			url: RM_TOKEN_REFRESH_URL,
			method: "POST",
			headers: { "Authorization": `Bearer ${this.deviceToken}` },
		});

		this.userToken = response.text;
		console.log(`${TAG} Token refreshed`);
	}

	async getRootHash(): Promise<RootHashResponse> {
		this.ensureAuth();
		const response = await rmRequest({
			url: `${RM_RAW_HOST}/sync/v4/root`,
			method: "GET",
			headers: { "Authorization": `Bearer ${this.userToken}` },
		});
		return response.json as RootHashResponse;
	}

	async getEntries(hash: string): Promise<EntriesFile> {
		this.ensureAuth();
		const response = await rmRequest({
			url: `${RM_RAW_HOST}/sync/v3/files/${hash}`,
			method: "GET",
			headers: { "Authorization": `Bearer ${this.userToken}` },
		});
		return parseEntriesText(response.text);
	}

	async getTextByHash(hash: string): Promise<string> {
		this.ensureAuth();
		const response = await rmRequest({
			url: `${RM_RAW_HOST}/sync/v3/files/${hash}`,
			method: "GET",
			headers: { "Authorization": `Bearer ${this.userToken}` },
		});
		return response.text;
	}

	async getBinaryByHash(hash: string): Promise<ArrayBuffer> {
		this.ensureAuth();
		const response = await rmRequest({
			url: `${RM_RAW_HOST}/sync/v3/files/${hash}`,
			method: "GET",
			headers: { "Authorization": `Bearer ${this.userToken}` },
		});
		return response.arrayBuffer;
	}

	async listItems(): Promise<RemarkableItem[]> {
		this.ensureAuth();

		const root = await this.getRootHash();
		console.log(`${TAG} Root hash: ${root.hash}, schema: ${root.schemaVersion}`);

		const rootEntries = await this.getEntries(root.hash);
		console.log(`${TAG} Found ${rootEntries.entries.length} top-level entries`);

		const items: RemarkableItem[] = [];

		for (const entry of rootEntries.entries) {
			try {
				const itemEntries = await this.getEntries(entry.hash);
				const fileEntries = itemEntries.entries;

				const metaEntry = fileEntries.find(e => e.id.endsWith(".metadata"));
				if (!metaEntry) {
					console.warn(`${TAG} No metadata for entry ${entry.id}, skipping`);
					continue;
				}

				const metaText = await this.getTextByHash(metaEntry.hash);
				const metadata = JSON.parse(metaText) as ItemMetadata;

				if (metadata.deleted) continue;

				if (metadata.type !== "DocumentType" && metadata.type !== "CollectionType") {
					continue;
				}

				items.push({
					id: entry.id,
					hash: entry.hash,
					visibleName: metadata.visibleName,
					lastModified: metadata.lastModified,
					parent: metadata.parent,
					pinned: metadata.pinned,
					type: metadata.type,
					fileEntries,
				});
			} catch (err) {
				console.warn(`${TAG} Failed to read entry ${entry.id}:`, err);
			}
		}

		console.log(`${TAG} Listed ${items.length} items (${items.filter(i => i.type === "DocumentType").length} docs, ${items.filter(i => i.type === "CollectionType").length} folders)`);
		return items;
	}

	get isRegistered(): boolean { return !!this.deviceToken; }
	get isAuthenticated(): boolean { return !!this.userToken; }

	updateDeviceToken(token: string): void {
		this.deviceToken = token;
		this.userToken = null;
	}

	private ensureAuth(): void {
		if (!this.userToken) throw new Error("Not authenticated. Call refreshToken() first.");
	}
}

export function generateDeviceId(): string {
	return crypto.randomUUID();
}
