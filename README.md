# Confluence to BookStack Wizard

An interactive terminal wizard for migrating Confluence spaces to BookStack. Features a full TUI (Terminal User Interface) with guided workflows, progress tracking, and post-import cleanup tools.

![Main Menu](screenshots/mainmenu.png)

## Features

- **Interactive TUI** - Guided menus instead of memorizing CLI commands
- **HTML & XML Export Support** - Works with both Confluence export formats
- **Full Import Workflow** - One-click import with attachments and cleanup
- **Progress Tracking** - Live status bar showing current operation
- **Post-Import Cleanup Tools** - Fix broken links, images, and Confluence artifacts
- **Safe Delete** - Remove shelves with confirmation prompts
- **Rate Limiting** - Built-in retry logic to handle API throttling
- **Cross-Platform** - Works on macOS, Linux, and Windows

## Prerequisites

- Node.js (v16 or higher recommended)
- A BookStack instance with API access
- Confluence HTML or XML export files

## Installation

```bash
git clone https://github.com/transcriptionstream/confluence-to-bookstack-wizard.git
cd confluence-to-bookstack-wizard
npm install
```

## Usage

Start the wizard:

```bash
npm run setup
```

### First Run - Configuration

On first run (or if no `.env` file exists), the wizard will guide you through configuration:

![Configuration](screenshots/configuration.png)

You'll be prompted to enter:
- **BookStack URL** - Your BookStack instance URL
- **API Token ID** - Generate in BookStack under **Settings > API Tokens**
- **API Token Secret** - The secret for your API token
- **Export Path** - Path to your Confluence export files

The wizard saves these settings to a `.env` file automatically.

### Full Import Workflow (Recommended)

Select **Full Import Workflow** to run a complete migration:

![Full Import](screenshots/fullimport.png)

1. Choose a Confluence export folder
2. Import all pages and structure
3. Upload attachments
4. Run cleanup scripts

A summary is displayed when complete showing books/pages created.

### Individual Operations

You can also run steps individually:

- **Import Space** - Import a single Confluence export
- **Upload Attachments** - Upload attachments for an already-imported space
- **Post-Import Cleanup** - Fix links, embedded images, and remove Confluence artifacts
- **Delete Shelf** - Remove a shelf and all its contents (with confirmation)

## Export Formats

Place your Confluence export ZIP files in the `import` folder within the project directory. The wizard will extract them automatically.

### XML Export (Recommended)
1. In Confluence, go to **Space Settings > Content Tools > Export**
2. Select **XML** format
3. Place the ZIP file in the `import` folder

XML exports are faster to process and require less post-import cleanup.

### HTML Export
1. In Confluence, go to **Space Settings > Content Tools > Export**
2. Select **HTML** format
3. Place the ZIP file in the `import` folder

HTML exports work but may require more post-processing to fix links and embedded content.

## How It Works

BookStack has a more rigid structure than Confluence:
- **Shelves** contain **Books**
- **Books** contain **Chapters** and/or **Pages**
- **Chapters** contain **Pages**

The wizard maps Confluence's freeform structure:
- Each Confluence **Space** becomes a **Shelf**
- Top-level pages become **Books**
- Child pages become **Chapters** or **Pages** based on nesting

Pages that would otherwise live directly on a Shelf are placed in a Book with a "_General" page.

## Post-Import Cleanup

The cleanup tools fix common issues after import:

| Tool | Purpose |
|------|---------|
| Fix Attachment Links | Updates `href` attributes to point to uploaded attachments |
| Fix Embedded Images | Converts base64 and broken image references |
| Remove Placeholders | Removes Confluence plugin placeholder images |
| Remove Thumbnails | Removes document conversion thumbnails and emoticons |

## Troubleshooting

### Rate Limiting (429 Errors)
The wizard includes automatic retry with exponential backoff. If you see frequent rate limiting, the scripts will wait and retry automatically.

### Missing Attachments
Run the **Upload Attachments** step after importing. Attachments require page IDs which are only available after import.

### Broken Internal Links
Run **Post-Import Cleanup** to update internal links to their new BookStack URLs.

## Author

Developed by [Affordable Magic](https://affordablemagic.net) | [GitHub](https://github.com/transcriptionstream)

## Credits

Built upon [confluence-server-to-bookstack-importer](https://github.com/gloverab/confluence-server-to-bookstack-importer) by [@gloverab](https://github.com/gloverab).

## License

MIT
