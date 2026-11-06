# Batch Doc Downloader

A Chrome extension that finds all the downloadable files on a web page and saves the ones you pick into one folder, in one click.

## Why I built this

My university uses Moodle, and every course page is full of lecture slides, PDFs, notes and assignments. To save them, I had to click each file, wait for it to open, hit download, rename it and move it to the right folder. I did that dozens of times per course, every semester.

I just wanted something that would make that job easier: open the course page, click once, and have everything land in a folder named after the course. So I built this.

It started as a Moodle tool. It now works on almost any website with files on it: government and company sites, Google Drive links, document libraries, and so on.

## What it does

- Scans the page you're on and lists every file it finds (PDFs, Word, Excel, PowerPoint, zips, images, audio and video)
- Lets you filter the list by file type and untick anything you don't want
- Saves everything you selected into `Downloads/<folder-name>/`, with the folder name filled in from the page title (you can change it)
- Keeps the real file names the website gives, so a Word file isn't saved as `.pdf`
- Keeps downloading in the background after you close the popup. The toolbar icon shows progress (`3/10`), then `✓` when done, or `!2` if 2 files failed
- Never overwrites anything: duplicates become `file (1).pdf`, `file (2).pdf`

## Install (developer mode)

1. Download or clone this repo
2. Open Chrome and go to `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and select this folder
5. Pin the extension to your toolbar

## How to use it

1. Open a page with files on it (for example, a Moodle course page)
2. Click the extension icon
3. Click **🔍 Scan This Page**
4. Rename the folder if you want, and untick anything you don't need
5. Click **⬇ Download Selected**

## How it finds files

- Links that end in a file type (`report.pdf`, `data.xlsx?token=…`)
- Files named in the link (`?file=slides.pptx`, `?format=csv`)
- Download-style links: the `download` attribute, `/download`, `/attachments/…`, Google Drive download links, Moodle `pluginfile.php` and `mod/resource` links
- Links with a file-type icon (like Moodle's PDF icon), or text such as "Budget (PDF, 2 MB)" or "Download brochure"
- PDFs and media embedded in the page
- Links inside same-site frames and web components (shadow DOM)
- The tab itself, if you're viewing a file directly

When the type or name is a guess, the file is marked "name from site", and the real name from the server is used.

### Moodle extras

- Detects file type from Moodle's file icons when the link has no extension
- Adds `forcedownload=1` to resource links so files download instead of opening in the browser viewer

## Supported file types

| Kind | Types |
| --- | --- |
| Documents | `pdf`, `doc`, `docx`, `xls`, `xlsx`, `csv`, `ppt`, `pptx`, `txt`, `rtf`, `odt`, `ods`, `odp`, `md`, `epub` |
| Archives | `zip`, `rar`, `7z`, `tar`, `gz` |
| Images | `png`, `jpg`, `jpeg`, `gif`, `svg`, `webp` |
| Media | `mp3`, `mp4`, `wav` |
| Data | `json`, `xml` |

## Saving straight to Google Drive

1. Install [Google Drive for desktop](https://www.google.com/drive/download/). It adds a `Google Drive` folder to your computer that syncs automatically.
2. In Chrome, go to **Settings → Downloads → Location** and pick a folder inside Google Drive.
3. Every batch you download now syncs to Drive by itself.

## Limits

- Files behind buttons that only run JavaScript (no real link) can't be detected.
- Links whose text just says "Download …" are sometimes ordinary web pages. Untick those.
- Only frames from the same site as the page can be scanned.

## Project files

```
├── manifest.json   # Extension settings (Manifest V3)
├── popup.html      # The popup UI
├── popup.js        # Scanning the page and the file list
├── background.js   # Runs downloads, picks file names, tracks progress
└── icons/          # Toolbar icons
```
