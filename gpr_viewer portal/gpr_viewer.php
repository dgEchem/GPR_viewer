<?php
/**
 * GPR Scan Viewer - Echem Staff Portal (GPR Survey section)
 *
 * Reads GSSI .DZT/.DZX scans in the browser, shows the radargram, and lets the
 * user pick rebar for cover depth and spacing. Scan files are not uploaded;
 * picks, dielectric, scan positions and settings are saved per project number
 * through api/gpr_picks.php, and opened again from there.
 *
 * Files: tools/gpr/gpr_viewer.php, tools/gpr/gpr-viewer.css, tools/gpr/gpr-viewer.js
 */
require_once '../../check_auth.php';

// Version the assets by file time so an updated file is never served from cache.
function gpr_asset($file) {
    $t = @filemtime(__DIR__ . '/' . $file);
    return htmlspecialchars($file . '?v=' . ($t ? $t : 1));
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GPR Scan Viewer - Echem Staff Portal</title>
    <link rel="stylesheet" href="<?php echo gpr_asset('gpr-viewer.css'); ?>">
</head>
<body class="gprp-page">
    <div class="gprp-header">
        <div class="gprp-brand">
            <span class="gprp-logo">Echem Consultants LLC</span>
            <span class="gprp-crumb">Staff Portal &rsaquo; GPR Survey &rsaquo; Scan Viewer</span>
        </div>
        <div class="gprp-user">
            <a href="../../dashboard.php" class="gprp-btn">&larr; Dashboard</a>
            <span><?php echo htmlspecialchars($_SESSION['full_name']); ?> (<?php echo htmlspecialchars($_SESSION['role']); ?>)</span>
            <a href="../../logout.php" class="gprp-btn">Logout</a>
        </div>
    </div>

    <div id="gprv" class="gprv" data-api="../../api/gpr_picks.php">
        <div class="gprv-bar">
            <strong class="gprv-title">GPR Scan Viewer</strong>
            <span class="gprv-tabs">
                <button type="button" id="gprv-tabScan" class="is-current">Scan</button>
                <button type="button" id="gprv-tabMap">Map</button>
                <button type="button" id="gprv-tab3d">3D</button>
            </span>
            <button type="button" id="gprv-openFiles" class="gprv-primary">Open scans…</button>
            <button type="button" id="gprv-openFolder">Open folder…</button>
            <input type="file" id="gprv-files" multiple accept=".dzt,.dzx,.DZT,.DZX" hidden>
            <input type="file" id="gprv-folder" webkitdirectory hidden>
            <span class="gprv-spacer"></span>
            <button type="button" id="gprv-csv">Export picks (CSV)</button>
            <button type="button" id="gprv-json" title="This scan's picks in the desktop app's format">Export scan (JSON)</button>
        </div>

        <div id="gprv-proj" class="gprv-proj" hidden>
            <label class="gprv-job">Project no.
                <input type="text" id="gprv-job" maxlength="40" placeholder="e.g. 26-08204" autocomplete="off">
            </label>
            <button type="button" id="gprv-jobOpen" title="Open this project from the portal (Enter)">Open</button>
            <select id="gprv-jobList" aria-label="Saved projects"><option value="">Saved projects…</option></select>
            <button type="button" id="gprv-jobSave" class="gprv-primary" title="Save everything in this project to the portal now (Ctrl+S)">Save</button>
            <button type="button" id="gprv-jobClose" title="Close the project and clear the scan list">Close project</button>
            <span id="gprv-sync" class="gprv-hint" role="status"></span>
        </div>

        <div id="gprv-scanView" class="gprv-main">
            <aside class="gprv-side">
                <h2>Scans</h2>
                <p id="gprv-empty" class="gprv-hint">Open GSSI <b>.DZT</b> files (select the matching <b>.DZX</b> files too, they carry the dielectric), or drop them anywhere on this page. Scan files are read on your computer and are not uploaded; your picks, positions and settings are saved to the portal under the project number.</p>
                <div id="gprv-scanList" class="gprv-scans"></div>
            </aside>

            <section class="gprv-center">
                <div class="gprv-tools">
                    <button type="button" id="gprv-zoomIn" title="Zoom in">+</button>
                    <button type="button" id="gprv-zoomOut" title="Zoom out">−</button>
                    <button type="button" id="gprv-fit">Fit</button>
                    <label><input type="checkbox" id="gprv-pickMode"> Pick rebar</label>
                    <label title="Move each click to the strongest peak within about 1/4 in"><input type="checkbox" id="gprv-snap"> Snap to peak</label>
                    <label title="Show the band energy / spectrum panel"><input type="checkbox" id="gprv-analysis"> Analysis</label>
                    <button type="button" id="gprv-undo">Undo</button>
                    <button type="button" id="gprv-delete">Delete pick</button>
                    <span id="gprv-info" class="gprv-hint"></span>
                </div>
                <div id="gprv-wrap" class="gprv-wrap"><canvas id="gprv-canvas"></canvas></div>
                <div id="gprv-awrap" class="gprv-wrap gprv-awrap"><canvas id="gprv-acanvas"></canvas></div>
                <div class="gprv-foot">
                    <span id="gprv-readout"></span>
                    <span id="gprv-status" class="gprv-status" role="status"></span>
                </div>
                <p class="gprv-hint gprv-help">Click to pick · click a pick to select it · right-click or Delete removes it · drag to pan · wheel zooms along the scan · Shift+wheel zooms depth · drag a dashed line to move the analysis band · ↑/↓ changes scan</p>
            </section>

            <aside class="gprv-side gprv-right">
                <h2>Display</h2>
                <label class="gprv-row">Depth gain <input type="range" id="gprv-depthGain" min="0" max="6" step="0.1"></label>
                <label class="gprv-row">Contrast <input type="range" id="gprv-contrast" min="0.3" max="6" step="0.1" class="gprv-rev"></label>
                <label class="gprv-row">Colors
                    <select id="gprv-colormap"><option value="gray">Gray</option><option value="seismic">Blue / red</option><option value="hot">Hot</option></select>
                </label>
                <label class="gprv-row">Units
                    <select id="gprv-unit"><option value="in">in</option><option value="ft">ft</option><option value="mm">mm</option><option value="cm">cm</option><option value="m">m</option></select>
                </label>
                <label class="gprv-row">Dielectric
                    <span><input type="number" id="gprv-eps" min="1" max="81" step="0.1"> <button type="button" id="gprv-epsReset" title="Back to the value in the file">Reset</button></span>
                </label>
                <label class="gprv-check"><input type="checkbox" id="gprv-invert"> Invert polarity</label>

                <div id="gprv-apanel" class="gprv-group">
                    <h2>Analysis</h2>
                    <label class="gprv-row">Profile
                        <select id="gprv-profile"><option value="energy">Band energy</option><option value="centroid">Spectral centroid</option></select>
                    </label>
                    <label class="gprv-row">Average ±
                        <span><input type="number" id="gprv-smooth" min="0" step="any"> <span id="gprv-smoothUnit"></span></span>
                    </label>
                    <p id="gprv-bandText" class="gprv-hint"></p>
                    <div class="gprv-spec"><canvas id="gprv-spec"></canvas></div>
                    <p id="gprv-specText" class="gprv-hint"></p>
                </div>

                <h2>Picks</h2>
                <p id="gprv-stats" class="gprv-hint"></p>
                <div class="gprv-tablewrap">
                    <table class="gprv-table">
                        <thead><tr id="gprv-pickHead"></tr></thead>
                        <tbody id="gprv-pickBody"></tbody>
                    </table>
                </div>
                <button type="button" id="gprv-clear">Clear this scan's picks</button>
            </aside>
        </div>

        <div id="gprv-mapView" class="gprv-main" hidden>
            <aside class="gprv-side gprv-place">
                <h2>Scan positions</h2>
                <p class="gprv-hint">Where each scan starts on the surface and which way it runs. Positions are in <b id="gprv-posUnit"></b> (change it under Units on the Scan tab).</p>
                <div class="gprv-tools">
                    <button type="button" id="gprv-posImport">Import CSV…</button>
                    <button type="button" id="gprv-posExport">Export CSV</button>
                    <input type="file" id="gprv-posFile" accept=".csv,text/csv" hidden>
                </div>
                <p id="gprv-mapStatus" class="gprv-status" role="status"></p>
                <div class="gprv-tablewrap">
                    <table class="gprv-table gprv-ptable">
                        <thead><tr><th>Scan</th><th>Start X</th><th>Start Y</th><th>Direction</th><th>Picks</th></tr></thead>
                        <tbody id="gprv-placeBody"></tbody>
                    </table>
                </div>
                <p class="gprv-hint">CSV columns: <b>Scan</b> (file name or number), <b>Origin X</b>, <b>Origin Y</b>, <b>Direction</b> (+X, −X, +Y or −Y).</p>
            </aside>
            <section class="gprv-center">
                <div class="gprv-tools">
                    <button type="button" id="gprv-mapFit">Fit</button>
                    <span id="gprv-mapSummary" class="gprv-hint"></span>
                </div>
                <div id="gprv-mapWrap" class="gprv-wrap"><canvas id="gprv-mapCanvas"></canvas></div>
                <div class="gprv-foot"><span id="gprv-mapReadout"></span></div>
                <p class="gprv-hint gprv-help">Each pick is a short bar across its scan line, darker for deeper cover · drag to pan · wheel to zoom · click a pick to open it in its scan</p>
            </section>
        </div>
        <div id="gprv-view3d" class="gprv-main" hidden>
            <section class="gprv-center">
                <div class="gprv-tools">
                    <button type="button" id="gprv-v3Reset" title="Back to the starting angle, fitted to the window">Reset view</button>
                    <button type="button" id="gprv-v3Fit" title="Fit to the window, keeping this angle">Fit</button>
                    <button type="button" id="gprv-v3Top" title="From above, as on the Map tab">Top</button>
                    <button type="button" id="gprv-v3Front" title="From the side, looking along Y">Front</button>
                    <button type="button" id="gprv-v3Side" title="From the side, looking along X">Side</button>
                    <label title="How much depth is stretched so cover differences can be seen">Z Scale <select id="gprv-v3Z"></select></label>
                    <label title="A line from each pick up to the surface"><input type="checkbox" id="gprv-v3Drops"> Drop lines</label>
                    <label><input type="checkbox" id="gprv-v3Grid"> Grid + axes</label>
                    <label title="Hang the current scan's radargram under its scan line"><input type="checkbox" id="gprv-v3Radar"> Radargram of current scan</label>
                    <button type="button" id="gprv-v3Png" title="Save this view as a picture">Save PNG</button>
                    <span id="gprv-v3Summary" class="gprv-hint"></span>
                </div>
                <div id="gprv-v3Wrap" class="gprv-wrap gprv-v3wrap"><canvas id="gprv-v3Canvas"></canvas></div>
                <div class="gprv-foot"><span id="gprv-v3Readout"></span></div>
                <p class="gprv-hint gprv-help">Each pick is a short bar at its cover depth, darker for deeper cover · drag to rotate · Shift+drag or right-drag to pan · wheel to zoom · click a pick to open it in its scan · click a scan line to make it the current scan · scan positions come from the Map tab</p>
            </section>
        </div>
    </div>
    <script src="<?php echo gpr_asset('gpr-viewer.js'); ?>"></script>
</body>
</html>
