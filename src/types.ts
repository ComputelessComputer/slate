// ── reMarkable Cloud API Types (New Hash-Based API) ─────────────────────────

/**
 * Root hash response from GET /sync/v4/root
 */
export interface RootHashResponse {
	hash: string;
	generation: number;
	schemaVersion: number;
}

/**
 * A raw entry from the entries file (text-based format).
 * Format per line: hash:type:id:subfiles:size
 */
export interface RawEntry {
	hash: string;
	/** 80000000 for schema 3 collection type, 0 for files/schema 4 */
	type: number;
	id: string;
	subfiles: number;
	size: number;
}

/**
 * Parsed entries file (the root or a document's file listing).
 */
export interface EntriesFile {
	schemaVersion: number;
	entries: RawEntry[];
	/** Only present in schema 4 */
	id?: string;
	/** Only present in schema 4 */
	totalSize?: number;
}

/**
 * Metadata stored with the ".metadata" extension in each item's entry list.
 * This is what the reMarkable cloud stores per-item.
 */
export interface ItemMetadata {
	createdTime?: string;
	deleted?: boolean;
	lastModified: string;
	lastOpened?: string;
	lastOpenedPage?: number;
	metadatamodified?: boolean;
	modified?: boolean;
	parent: string;
	pinned: boolean;
	synced?: boolean;
	type: "DocumentType" | "CollectionType";
	version?: number;
	visibleName: string;
}

/**
 * High-level representation of a reMarkable item (document or collection)
 * built from walking the entry tree.
 */
export interface RemarkableItem {
	/** Document UUID */
	id: string;
	/** Hash of this item's entry list */
	hash: string;
	/** Display name */
	visibleName: string;
	/** Epoch timestamp as string */
	lastModified: string;
	/** Parent folder id ("" = root, "trash" = trash) */
	parent: string;
	/** Whether the item is starred */
	pinned: boolean;
	/** "DocumentType" or "CollectionType" */
	type: "DocumentType" | "CollectionType";
	/** Sub-entries for this item (individual files: .rm, .pdf, .content, .metadata) */
	fileEntries: RawEntry[];
}

// ── Document Content (from .content JSON file) ─────────────────────────────

export interface DocumentContent {
	fileType: string; // "", "pdf", "epub", "notebook"
	pages: string[]; // page UUIDs in order
	pageCount: number;
	lastOpenedPage: number;
	lineHeight: number;
	margins: number;
	textScale: number;
	extraMetadata: Record<string, string>;
	transform: {
		m11: number; m12: number; m13: number;
		m21: number; m22: number; m23: number;
		m31: number; m32: number; m33: number;
	};
	/** cPages-based page metadata (newer format) */
	cPages?: {
		pages: Array<{ id: string; idx: { value: string } }>;
	};
}

// ── .rm Binary Format Types ────────────────────────────────────────────────

export interface RmPage {
	layers: RmLayer[];
	highlights: RmHighlight[];
	version: number;
}

export interface RmLayer {
	strokes: RmStroke[];
}

export interface RmHighlightRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface RmHighlight {
	color: number;
	text: string;
	rects: RmHighlightRect[];
}

export interface RmStroke {
	pen: number;
	color: number;
	width: number;
	segments: RmSegment[];
}

export interface RmSegment {
	x: number;
	y: number;
	speed: number;
	direction: number;
	width: number;
	pressure: number;
}

// ── Parsed Document (after fetching all files) ──────────────────────────────

export interface ParsedDocument {
	id: string;
	name: string;
	parent: string;
	hash: string;
	lastModified: string;
	content: DocumentContent;
	pages: RmPage[];
	/** Raw PDF bytes if the document is an annotated PDF */
	basePdf: ArrayBuffer | null;
}

// ── Sync State ─────────────────────────────────────────────────────────────

export interface SyncRecord {
	/** Hash of the item entry (changes when item is modified) */
	hash: string;
	lastModified: string;
	vaultPath: string;
}

// ── Plugin Settings ────────────────────────────────────────────────────────

export interface PluginSettings {
	deviceToken: string;
	syncFolder: string;
	syncOnStartup: boolean;
	lastSyncTimestamp: number;
	syncState: Record<string, SyncRecord>;
	deviceId: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	deviceToken: "",
	syncFolder: "remarkable",
	syncOnStartup: true,
	lastSyncTimestamp: 0,
	syncState: {},
	deviceId: "",
};
