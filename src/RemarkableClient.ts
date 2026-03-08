import { requestUrl, RequestUrlResponse } from "obsidian";
import {
	RawEntry,
	EntriesFile,
	RootHashResponse,
} from "./types";
import {
	RM_DEVICE_REGISTER_URL,
	RM_TOKEN_REFRESH_URL,
	RM_RAW_HOST,
} from "./constants";

const TAG = "[RemarkableSync]";
const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_SERVER_RETRIES = 3;
const BASE_DELAY_MS = 1000;

async function rmRequest(opts: {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	contentType?: string;
}): Promise<RequestUrlResponse> {
	const { url, method = "GET", headers, body, contentType } = opts;

	for (let attempt = 0; ; attempt++) {
		try {
			return await requestUrl({ url, method, headers, body, contentType });
		} catch (err: unknown) {
			const statusCode = (err as { status?: number })?.status;
			const shortUrl = url.split("?")[0].slice(0, 80);
			const retryLimit = getRetryLimit(statusCode);

			if (retryLimit > 0 && attempt < retryLimit) {
				const delay = BASE_DELAY_MS * Math.pow(2, attempt);
				console.warn(
					`${TAG} ${method} ${shortUrl} → ${statusCode}, retry ${attempt + 1}/${retryLimit} in ${delay}ms`,
				);
				await sleep(delay);
				continue;
			}

			console.error(`${TAG} ${method} ${shortUrl} → ${statusCode ?? "network_error"}`, err);
			throw new RmApiError(statusCode ? String(statusCode) : "network_error", statusCode ?? 0);
		}
	}
}

function getRetryLimit(statusCode?: number): number {
	if (statusCode === 429) {
		return MAX_RATE_LIMIT_RETRIES;
	}

	if (statusCode === 500 || statusCode === 502 || statusCode === 503) {
		return MAX_SERVER_RETRIES;
	}

	return 0;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isHtmlResponse(text: string): boolean {
	const normalized = text.trimStart().toLowerCase();
	return normalized.startsWith("<html") || normalized.startsWith("<!doctype html");
}

async function getTextWithHtmlRetry(requestFn: () => Promise<RequestUrlResponse>, hash: string): Promise<string> {
	for (let attempt = 0; ; attempt++) {
		const response = await requestFn();
		if (!isHtmlResponse(response.text)) {
			return response.text;
		}

		if (attempt < MAX_SERVER_RETRIES) {
			const delay = BASE_DELAY_MS * Math.pow(2, attempt);
			console.warn(`${TAG} GET file/${hash.slice(0, 12)}... returned HTML, retry ${attempt + 1}/${MAX_SERVER_RETRIES} in ${delay}ms`);
			await sleep(delay);
			continue;
		}

		throw new RmApiError(`html_error_response:${hash}`, 500);
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
		const [, id, , sizeStr] = infoLine.split(":");
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
	}

	async getRootHash(): Promise<RootHashResponse> {
		const response = await this.authedRequest(`${RM_RAW_HOST}/sync/v4/root`);
		return response.json as RootHashResponse;
	}

	async getEntries(hash: string): Promise<EntriesFile> {
		const text = await getTextWithHtmlRetry(
			() => this.authedRequest(`${RM_RAW_HOST}/sync/v3/files/${hash}`),
			hash,
		);
		return parseEntriesText(text);
	}

	async getTextByHash(hash: string): Promise<string> {
		return await getTextWithHtmlRetry(
			() => this.authedRequest(`${RM_RAW_HOST}/sync/v3/files/${hash}`),
			hash,
		);
	}

	async getBinaryByHash(hash: string): Promise<ArrayBuffer> {
		const response = await this.authedRequest(`${RM_RAW_HOST}/sync/v3/files/${hash}`);
		return response.arrayBuffer;
	}

	get isRegistered(): boolean { return !!this.deviceToken; }
	get isAuthenticated(): boolean { return !!this.userToken; }

	updateDeviceToken(token: string): void {
		this.deviceToken = token;
		this.userToken = null;
	}

	private async authedRequest(url: string): Promise<RequestUrlResponse> {
		if (!this.userToken) {
			await this.refreshToken();
		}

		try {
			return await rmRequest({
				url,
				method: "GET",
				headers: { "Authorization": `Bearer ${this.userToken}` },
			});
		} catch (err) {
			if (err instanceof RmApiError && (err.status === 401 || err.status === 403)) {
				await this.refreshToken();
				return await rmRequest({
					url,
					method: "GET",
					headers: { "Authorization": `Bearer ${this.userToken}` },
				});
			}
			throw err;
		}
	}
}

export function generateDeviceId(): string {
	return crypto.randomUUID();
}
