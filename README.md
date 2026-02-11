# Remarkable Sync

An [Obsidian](https://obsidian.md) plugin that syncs your [reMarkable](https://remarkable.com) tablet notes directly into your vault as PDF and Markdown.

## Features

- **Cloud sync** — Connects to reMarkable Cloud and pulls your documents automatically
- **Handwriting to PDF** — Renders `.rm` notebook strokes into clean PDF files
- **PDF annotation overlay** — Merges your handwritten annotations onto imported PDFs
- **Markdown notes** — Creates a Markdown file per document with YAML frontmatter (title, page count, file type, etc.)
- **EPUB reader** — Opens `.epub` files synced from your reMarkable directly in Obsidian
- **Folder structure** — Preserves your reMarkable folder hierarchy in the vault
- **Incremental sync** — Only downloads documents that have changed since the last sync
- **Auto-sync** — Optionally syncs on Obsidian startup

## Installation

### From Obsidian Community Plugins

1. Open **Settings → Community Plugins → Browse**
2. Search for **Remarkable Sync**
3. Click **Install**, then **Enable**

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/johnjeong/slate/releases/latest)
2. Create a folder `remarkable-sync` inside your vault's `.obsidian/plugins/` directory
3. Copy the downloaded files into that folder
4. Enable the plugin in **Settings → Community Plugins**

## Setup

1. Go to **Settings → Remarkable Sync**
2. Click the link to [my.remarkable.com](https://my.remarkable.com/device/desktop/connect) to get a one-time code
3. Enter the code and click **Connect**

Once connected, your reMarkable documents will sync into the configured vault folder (default: `remarkable/`).

## Usage

### Syncing

- **Automatic** — Enable "Sync on startup" in settings to sync every time Obsidian opens
- **Manual** — Click the **reMarkable** button in the status bar, or run the command palette action:
  - `Remarkable Sync: Sync reMarkable notes` — Incremental sync (only changed documents)
  - `Remarkable Sync: Force re-sync all reMarkable notes` — Re-downloads everything

### Output Structure

```
remarkable/
├── My Notebook.md
├── attachments/
│   └── My Notebook.pdf
└── Work/
    ├── Meeting Notes.md
    └── attachments/
        └── Meeting Notes.pdf
```

Each synced document produces:
- A **Markdown file** with frontmatter and an embedded link to the PDF
- A **PDF file** in an `attachments/` subfolder (rendered from handwriting or annotated PDF)
- An **EPUB file** in `attachments/` if the source was an ebook

### Settings

| Setting | Description | Default |
|---|---|---|
| Sync folder | Vault folder for synced files | `remarkable` |
| Sync on startup | Auto-sync when Obsidian launches | On |

## Development

```bash
# Install dependencies
pnpm install

# Build for development (with watch)
pnpm dev

# Production build
pnpm build
```

## License

[MIT](LICENSE)
