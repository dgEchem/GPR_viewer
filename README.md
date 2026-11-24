# GPR Viewer (web)

A browser version of the GPR Analyze viewer: open GSSI `.DZT` / `.DZX` scans, adjust the display, pick rebar, export the picks.

## Files

The version in use is the staff portal's, in `gpr_viewer portal/`. There is no build step.

| File here | Name on the portal | What it is |
|---|---|---|
| `gpr_viewer portal/gpr_viewer.php` | `tools/gpr/gpr_viewer.php` | the page |
| `gpr_viewer portal/gpr_picks.js` | `tools/gpr/gpr-viewer.js` | the viewer: DZT/DZX reader, radargram, picking, map, 3D, projects |
| `gpr_viewer portal/gpr_picks.css` | `tools/gpr/gpr-viewer.css` | styles, all scoped under `.gprv` |
| `gpr_viewer portal/gpr_picks.php` | `api/gpr_picks.php` | saves and opens projects (MySQL) |
| `index.html` | – | a plain page that loads the same script with no portal, for trying things locally or on GitHub Pages |

Tests are in `../webtest/` (see its README).

## How it works

Scans are read in the browser from the user's own disk. Scan files are never uploaded, so there is no upload limit and no client scan data on the server.

On the portal, work is kept in **projects**: picks, dielectric, scan positions and the display settings are saved to the database under a project number and opened again from there. On the plain page there are no projects and everything below is kept in the browser only.

**Open folder…** replaces the scan list instead of adding to it, so two jobs are never listed, or saved, together (`openFolder()` in the script):

- With no project open, the folder's scans take the place of the list.
- With a project open, its saved scans stay listed when the folder holds at least one of them (or the project has nothing saved yet). Scans left from an earlier folder with no picks or position are dropped.
- With a project open and a folder that holds none of its saved scans, the folder is taken as another job: the project is closed first (its work is already saved) and the page asks for the new project number. To add those scans to the same project after all, open the project again; they stay in the list and join it.

**Open scans…** and dropping files add to the list.

Without a project, picks and the per-scan dielectric are saved in the browser's `localStorage`, keyed by file name and file size. They survive a reload on the same browser and computer, but they do not follow the user to another device, and clearing site data removes them. The export buttons are the durable copy:

- **Export picks (CSV)** – every pick on every listed scan: distance, depth, two-way time, dielectric.
- **Export scan (JSON)** – the current scan's picks in the desktop app's `plugins/analyze/picks/<name>.json` layout.

## Analysis panel

The **Analysis** checkbox shows a panel under the scan, lined up with it trace for trace. It works on a depth band, drawn as two dashed lines on the scan that can be dragged.

- **Band energy** – strength of the reflections inside the band along the scan, in dB relative to the scan's median. Bars and other reflectors stand out as peaks; weak or attenuated stretches sit low.
- **Spectral centroid** – the centre frequency of the band's signal along the scan, in GHz. A drop means the high frequencies are being lost.
- **Spectrum** (side panel) – the frequency content of the band at the cursor or at the selected pick, with its centroid, peak and bandwidth.

"Average ±" sets how far along the scan each reading is averaged. The processing is the desktop app's (trace DC removal, running-median background removal, Hilbert envelope) and gives the same numbers. Scans over about 3 million samples are analysed on every second or third trace to keep the page responsive.

## Map tab

The **Map** tab puts every scan's picks on one plan view of the surface. Each scan needs a start position (X, Y) and a direction (+X, −X, +Y or −Y); a pick then sits at its distance along that line. Picks are drawn as short bars across the scan line, darker for deeper cover. Clicking a pick opens it in its scan.

Positions can be typed into the table or imported from a CSV with these columns (the same file the desktop app's merge setup imports):

| Scan | Origin X | Origin Y | Direction |
|---|---|---|---|
| File____012 or just 12 | 0 | 24 | +X |

The importer accepts the usual variations of those headings. Without a Scan column, rows are paired with the open scans in list order. Values are read in the unit selected on the Scan tab, and +Y points up the screen. Positions are saved with the picks, and the picks CSV gains `map_x` / `map_y` columns for placed scans.

A scan's line is drawn to its real length as soon as it has a position, even if it has never been displayed: the length is read from the first 1024 bytes of the file.

Not carried over from the desktop merge: reference frames (rotated or offset groups of scans) and the cover heat map.

## 3D tab

The **3D** tab shows the same picks in three dimensions: each one at its map position and at its cover depth below the surface, drawn as a short bar across its scan line and coloured by cover like the map. It uses the Map tab's positions, so there is nothing more to set up.

- **Rotate, pan, zoom** – drag to rotate, Shift+drag or right-drag to pan, wheel to zoom. **Top** matches the Map tab, **Front** and **Side** look along Y and X, **Reset view** goes back to the starting angle, **Fit** refits without changing the angle.
- **Z Scale** – cover is small next to the length of a scan, so depth is stretched to make differences visible. *Auto* picks a round factor (never more than ×10); the factor is written beside the depth axis, and the depth numbers are always true depths.
- **Drop lines** – a line from each pick up to the surface, to show where it sits in plan.
- **Grid + axes** – the depth lines on the back walls and the X, Y and depth scales. Turn it off for a clean picture.
- **Radargram of current scan** – hangs the current scan's radargram under its scan line, so the picks can be seen against the data. Click another scan line to move it there.
- **Hover and click** – hovering a pick shows its scan, X, Y and cover; clicking it opens it on the Scan tab.
- **Save PNG** – saves the view as a picture.

It is drawn with the browser's ordinary 2D canvas (no WebGL and no extra library), so there is nothing more to install on the site and it works on locked-down PCs. The view is orthographic: lengths do not shrink with distance, which keeps the radargram exact.

Not in this version: joining picks into bars, radargrams for more than one scan at a time, and rotated groups of scans.

## Trying it

Open `index.html` in a browser, or serve this folder (with its `gpr_viewer portal` subfolder) from any static host; GitHub Pages works. That is the plain page: no projects, nothing saved to a server.

## Updating the portal

Upload the files from `gpr_viewer portal/` under their portal names (table above). The page versions the script and stylesheet by file time, so browsers pick up a new upload without any `?v=` change.

The page and the script should go up together. If the page is older than the script, the script still runs: a tab whose markup is missing is simply not there.

## Limits of this version

- GSSI DZT only. 32-bit files are checked against the desktop reader; 16-bit and 8-bit files are read but have not been tested on real data.
- Single-channel scans.
- Manual picking only; no automatic detection, migration or per-pick feature table.
- The spectral centroid is taken over 0.3 to 5 GHz, which suits the high-frequency antennas used on concrete. Lower-frequency antennas would need that range changed (`MOMENT_BAND_GHZ` in the script).
