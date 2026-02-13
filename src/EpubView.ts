import { FileView, TFile, WorkspaceLeaf } from "obsidian";
import { unzipSync, strFromU8 } from "fflate";

export const EPUB_VIEW_TYPE = "epub-reader";

export class EpubView extends FileView {
	private container!: HTMLDivElement;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return EPUB_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.file?.basename ?? "EPUB";
	}

	getIcon(): string {
		return "book-open";
	}

	async onLoadFile(file: TFile): Promise<void> {
		this.contentEl.empty();

		this.container = this.contentEl.createDiv({ cls: "epub-reader-container" });

		try {
			const data = await this.app.vault.readBinary(file);
			const files = unzipSync(new Uint8Array(data));
			await this.renderEpub(files);
		} catch (err) {
			this.container.createEl("p", {
				text: `Failed to load epub: ${(err as Error).message}`,
				cls: "epub-reader-error",
			});
		}
	}

	onUnloadFile(): Promise<void> {
		this.contentEl.empty();
		return Promise.resolve();
	}

	private renderEpub(files: Record<string, Uint8Array>): void {
		const containerXml = this.findContainerXml(files);
		if (!containerXml) {
			this.container.createEl("p", { text: "Invalid epub: missing META-INF/container.xml" });
			return;
		}

		const rootfilePath = this.parseContainerXml(containerXml);
		if (!rootfilePath) {
			this.container.createEl("p", { text: "Invalid epub: cannot find rootfile in container.xml" });
			return;
		}

		const opfContent = this.getFileContent(files, rootfilePath);
		if (!opfContent) {
			this.container.createEl("p", { text: `Invalid epub: missing ${rootfilePath}` });
			return;
		}

		const opfDir = rootfilePath.includes("/")
			? rootfilePath.substring(0, rootfilePath.lastIndexOf("/") + 1)
			: "";

		const { manifest, spine, metadata } = this.parseOpf(opfContent);

		if (metadata.title) {
			this.container.createEl("h1", { text: metadata.title, cls: "epub-title" });
		}
		if (metadata.creator) {
			this.container.createEl("p", { text: metadata.creator, cls: "epub-author" });
		}

		const separator = this.container.createDiv({ cls: "epub-separator" });
		separator.createEl("hr");

		for (const itemRef of spine) {
			const item = manifest.get(itemRef);
			if (!item) continue;

			const href = opfDir + item.href;
			const content = this.getFileContent(files, href);
			if (!content) continue;

			const chapterEl = this.container.createDiv({ cls: "epub-chapter" });
			this.renderXhtml(chapterEl, content, files, opfDir, item.href);
		}
	}

	private findContainerXml(files: Record<string, Uint8Array>): string | null {
		const key = Object.keys(files).find(k =>
			k.toLowerCase() === "meta-inf/container.xml"
		);
		if (!key) return null;
		return strFromU8(files[key]);
	}

	private getFileContent(files: Record<string, Uint8Array>, path: string): string | null {
		const normalized = path.replace(/^\//, "");
		const key = Object.keys(files).find(k => k === normalized || k === path);
		if (!key) return null;
		return strFromU8(files[key]);
	}

	private getFileBinary(files: Record<string, Uint8Array>, path: string): Uint8Array | null {
		const normalized = path.replace(/^\//, "");
		const key = Object.keys(files).find(k => k === normalized || k === path);
		if (!key) return null;
		return files[key];
	}

	private parseContainerXml(xml: string): string | null {
		const match = xml.match(/rootfile[^>]+full-path="([^"]+)"/);
		return match ? match[1] : null;
	}

	private parseOpf(opf: string): {
		manifest: Map<string, { href: string; mediaType: string }>;
		spine: string[];
		metadata: { title: string; creator: string };
	} {
		const manifest = new Map<string, { href: string; mediaType: string }>();
		const spine: string[] = [];
		const metadata = { title: "", creator: "" };

		const titleMatch = opf.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/);
		if (titleMatch) metadata.title = this.decodeHtmlEntities(titleMatch[1]);

		const creatorMatch = opf.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/);
		if (creatorMatch) metadata.creator = this.decodeHtmlEntities(creatorMatch[1]);

		const manifestRegex = /<item\s+([^>]+)\/?\s*>/g;
		let m;
		while ((m = manifestRegex.exec(opf)) !== null) {
			const attrs = m[1];
			const id = this.getAttr(attrs, "id");
			const href = this.getAttr(attrs, "href");
			const mediaType = this.getAttr(attrs, "media-type");
			if (id && href) {
				manifest.set(id, { href: decodeURIComponent(href), mediaType: mediaType || "" });
			}
		}

		const spineRegex = /<itemref\s+([^>]+)\/?\s*>/g;
		while ((m = spineRegex.exec(opf)) !== null) {
			const idref = this.getAttr(m[1], "idref");
			if (idref) spine.push(idref);
		}

		return { manifest, spine, metadata };
	}

	private getAttr(attrs: string, name: string): string {
		const match = attrs.match(new RegExp(`${name}="([^"]+)"`));
		return match ? match[1] : "";
	}

	private decodeHtmlEntities(text: string): string {
		const doc = new DOMParser().parseFromString(text, "text/html");
		return doc.body.textContent ?? text;
	}

	private renderXhtml(
		container: HTMLElement,
		xhtml: string,
		files: Record<string, Uint8Array>,
		opfDir: string,
		chapterHref: string,
	): void {
		const chapterDir = chapterHref.includes("/")
			? chapterHref.substring(0, chapterHref.lastIndexOf("/") + 1)
			: "";

		const parsed = new DOMParser().parseFromString(xhtml, "text/html");
		const wrapper = parsed.body;

		const images = wrapper.querySelectorAll("img");
		images.forEach(img => {
			const src = img.getAttribute("src");
			if (!src || src.startsWith("data:") || src.startsWith("http")) return;

			const imgPath = opfDir + chapterDir + src;
			const imgData = this.getFileBinary(files, imgPath);
			if (!imgData) return;

			const ext = src.split(".").pop()?.toLowerCase() ?? "png";
			const mimeMap: Record<string, string> = {
				jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
				gif: "image/gif", svg: "image/svg+xml", webp: "image/webp",
			};
			const mime = mimeMap[ext] ?? "image/png";
			const blob = new Blob([imgData.buffer as ArrayBuffer], { type: mime });
			img.setAttribute("src", URL.createObjectURL(blob));
		});

		const svgImages = wrapper.querySelectorAll("image");
		svgImages.forEach(img => {
			const href = img.getAttribute("xlink:href") ?? img.getAttribute("href");
			if (!href || href.startsWith("data:") || href.startsWith("http")) return;

			const imgPath = opfDir + chapterDir + href;
			const imgData = this.getFileBinary(files, imgPath);
			if (!imgData) return;

			const ext = href.split(".").pop()?.toLowerCase() ?? "png";
			const mimeMap: Record<string, string> = {
				jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
				gif: "image/gif", svg: "image/svg+xml", webp: "image/webp",
			};
			const mime = mimeMap[ext] ?? "image/png";
			const blob = new Blob([imgData.buffer as ArrayBuffer], { type: mime });
			img.setAttribute("href", URL.createObjectURL(blob));
		});

		while (wrapper.firstChild) {
			container.appendChild(wrapper.firstChild);
		}
	}
}
