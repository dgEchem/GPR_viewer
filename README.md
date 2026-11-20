# GPR Viewer (web)

A browser version of the GPR Analyze viewer: open GSSI `.DZT` / `.DZX` scans, adjust the display, pick rebar, export the picks.

It is three static files with no build step and no server code:

- `index.html` – the page
- `gpr-viewer.js` – DZT/DZX reader, radargram, picking
- `gpr-viewer.css` – styles, all scoped under `.gprv`

## How it works

Scans are read in the browser from the user's own disk. Nothing is uploaded, so there is no upload limit, no storage cost and no client data on the server.

Picks and the per-scan dielectric are saved in the browser's `localStorage`, keyed by file name and file size. They survive a reload on the same browser and computer, but they do not follow the user to another device, and clearing site data removes them. The export buttons are the durable copy:

- **Export picks (CSV)** – every pick on every listed scan: distance, depth, two-way time, dielectric.
- **Export scan (JSON)** – the current scan's picks in the desktop app's `plugins/analyze/picks/<name>.json` layout.

## Trying it

Open `index.html` in a browser, or serve the folder from any static host (GitHub Pages works).

## Putting it on a PHP site

No port to PHP is needed. Copy the `.js` and `.css` files to the site, then paste the block between `GPR VIEWER START` and `GPR VIEWER END` from `index.html` into a PHP page, with the stylesheet link in that page's `<head>`. The existing login / subscription check at the top of the PHP page is what restricts access:

```php
<?php require 'subscriber_check.php'; // whatever the other tools use ?>
<link rel="stylesheet" href="gpr-viewer.css">
<!-- paste the GPR VIEWER block here -->
```

The viewer fills the window height by default. Inside a page with its own header, set a height on it, for example `.gprv { height: 80vh; }`.

## Later, if wanted

Saving picks to the subscriber's account needs one small PHP endpoint (store and return a JSON blob per user and scan) and a database table. The viewer already keeps picks as JSON, so that is a change to two functions in `gpr-viewer.js` (`storeGet` / `storeSet`).

## Limits of this version

- GSSI DZT only. 32-bit files are checked against the desktop reader; 16-bit and 8-bit files are read but have not been tested on real data.
- Single-channel scans.
- Manual picking only; no automatic detection, migration or feature analysis.
