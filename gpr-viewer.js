/* GPR Viewer (web) - reads GSSI DZT/DZX in the browser, shows the radargram,
 * and lets the user pick rebar. Nothing is uploaded: files are read locally.
 * Ported from the desktop app: core/dzt_reader.py, core/dzx_reader.py,
 * core/scan_loader.py (pre-zero crop) and the Display tab's gain/clamp.
 */
(function () {
  'use strict';

  var C_M_PER_S = 299792458.0;
  var UNIT_M = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };
  var UNIT_DECIMALS = { m: 3, cm: 1, mm: 0, ft: 2, in: 2, trace: 0 };
  var EMBEDDED_ROWS = 2; // trace counter + aux word at the top of every trace
  var STORE_PREFIX = 'gprv1:';
  var TILE_W = 4096;

  // ------------------------------------------------------------------ parsing

  function unitKey(s) {
    s = String(s || '').toLowerCase().trim();
    if (['m', 'meter', 'meters', 'metre', 'metres'].indexOf(s) >= 0) return 'm';
    if (['ft', 'foot', 'feet'].indexOf(s) >= 0) return 'ft';
    if (['in', 'inch', 'inches'].indexOf(s) >= 0) return 'in';
    if (['cm', 'centimeter', 'centimeters'].indexOf(s) >= 0) return 'cm';
    if (['mm', 'millimeter', 'millimeters'].indexOf(s) >= 0) return 'mm';
    return null;
  }

  /** Parse a DZT ArrayBuffer -> { data (row-major Float32Array), nr, nt, meta }. */
  function parseDZT(buf) {
    if (buf.byteLength < 1024) throw new Error('File is too small to be a DZT.');
    var dv = new DataView(buf);
    var meta = {
      rh_tag: dv.getUint16(0, true),
      rh_data: dv.getUint16(2, true),
      rh_nsamp: dv.getUint16(4, true),
      rh_bits: dv.getUint16(6, true),
      rh_zero: dv.getInt16(8, true),
      rhf_sps: dv.getFloat32(10, true),
      rhf_spm: dv.getFloat32(14, true),
      rhf_mpm: dv.getFloat32(18, true),
      rhf_pos: dv.getFloat32(22, true),
      rhf_rng: dv.getFloat32(26, true),
      rh_nchan: dv.getUint16(52, true)
    };
    var nchan = Math.max(meta.rh_nchan, 1);

    var headerBytes;
    if (meta.rh_data === 1024) headerBytes = 1024;
    else if (meta.rh_data < 1024) headerBytes = 1024 * meta.rh_data;
    else headerBytes = 1024 * nchan;
    if (headerBytes < 1024) headerBytes = 1024;

    var bps = meta.rh_bits / 8;
    if ([1, 2, 4].indexOf(bps) < 0) throw new Error('Unsupported sample size: ' + meta.rh_bits + ' bits.');
    var spt = meta.rh_nsamp * nchan;
    if (spt <= EMBEDDED_ROWS) throw new Error('DZT header reports no samples.');
    var nt = Math.floor((buf.byteLength - headerBytes) / (bps * spt));
    if (nt < 1) throw new Error('DZT contains no traces.');

    var body = buf.slice(headerBytes, headerBytes + nt * spt * bps);
    var raw, offset = 0;
    if (bps === 4) raw = new Int32Array(body);
    else if (bps === 2) { raw = new Uint16Array(body); offset = 32768; }
    else { raw = new Uint8Array(body); offset = 128; }

    // Rows recorded before time zero are dropped (negative rhf_pos).
    var nrFull = spt - EMBEDDED_ROWS;
    var prezero = 0;
    var rng = meta.rhf_rng;
    if (rng > 0 && meta.rhf_pos < 0) {
      prezero = Math.round(Math.abs(meta.rhf_pos) / rng * nrFull);
      prezero = Math.max(0, Math.min(prezero, nrFull - 1));
      rng = Math.max(0, rng + meta.rhf_pos);
    }
    var nr = nrFull - prezero;
    var rowOff = EMBEDDED_ROWS + prezero;

    var data = new Float32Array(nr * nt);
    for (var t = 0; t < nt; t++) {
      var src = t * spt + rowOff;
      for (var r = 0; r < nr; r++) data[r * nt + t] = raw[src + r] - offset;
    }
    meta.header_bytes = headerBytes;
    meta.prezero_rows_removed = prezero;
    meta.effective_rhf_rng = rng;
    return { data: data, nr: nr, nt: nt, meta: meta };
  }

  /** Pull the handful of DZX (XML) fields the viewer needs. */
  function parseDZX(text) {
    var out = {};
    var doc;
    try { doc = new DOMParser().parseFromString(text, 'application/xml'); } catch (e) { return out; }
    var all = doc.getElementsByTagName('*');
    function find(tag) {
      for (var i = 0; i < all.length; i++) {
        var name = all[i].localName || all[i].nodeName;
        if (name === tag) return all[i].textContent;
      }
      return null;
    }
    function num(tag, key) {
      var v = parseFloat(find(tag));
      if (isFinite(v)) out[key] = v;
    }
    num('dielectric', 'dielectric');
    num('unitsPerScan', 'units_per_scan');
    num('scanPerMeters', 'scan_per_meters');
    var hu = find('horizontalUnit'); if (hu) out.horizontal_unit = hu;
    var vu = find('verticalUnit'); if (vu) out.vertical_unit = vu;
    return out;
  }

  /** Meters per trace, or null when the file does not say. */
  function metersPerTrace(meta) {
    var hu = unitKey(meta.horizontal_unit) || 'm';
    if (meta.units_per_scan > 0) return meta.units_per_scan * UNIT_M[hu];
    var spm = meta.scan_per_meters > 0 ? meta.scan_per_meters : meta.rhf_spm;
    if (spm > 0) return 1 / spm;
    return null;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseDZT: parseDZT, metersPerTrace: metersPerTrace };
  }
  if (typeof document === 'undefined') return;

  // -------------------------------------------------------------------- state

  var settings = {
    depthGain: 2.0, contrast: 2.0, colormap: 'gray', invert: false,
    unit: 'in', pickMode: true, snap: true, defaultEps: 7.0
  };
  var scans = [];      // {name, key, dzt, dzx, picks, eps, dxM, dtNs, nr, nt, data, undo}
  var current = null;
  var selected = -1;   // index into current.picks
  var view = { t0: 0, t1: 1, r0: 0, r1: 1 };
  var tiles = [];      // [{x0, w, canvas}]
  var plot = { x: 58, y: 30, w: 100, h: 100 };
  var hover = null;
  var el = {};

  function $(id) { return document.getElementById(id); }

  function storeGet(key) {
    try { var v = localStorage.getItem(STORE_PREFIX + key); return v ? JSON.parse(v) : null; }
    catch (e) { return null; }
  }
  function storeSet(key, value) {
    try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }

  function saveScan(s) {
    var ok = storeSet('scan:' + s.key, {
      name: s.name, eps: s.eps, dxM: s.dxM, dtNs: s.dtNs,
      picks: s.picks.map(function (p) { return { trace: p.trace, row: p.row }; })
    });
    if (!ok) setStatus('Could not save picks in this browser (storage blocked or full). Export them before leaving.');
  }

  // ------------------------------------------------------------------- units

  function distUnit(s) { return s && s.dxM ? settings.unit : 'trace'; }
  function distOfTrace(s, trace) { return s.dxM ? trace * s.dxM / UNIT_M[settings.unit] : trace; }
  function timeOfRow(s, row) { return row * s.dtNs; }
  function depthMOfRow(s, row) {
    return C_M_PER_S / Math.sqrt(s.eps) * (timeOfRow(s, row) * 1e-9) / 2;
  }
  function depthOfRow(s, row) { return depthMOfRow(s, row) / UNIT_M[settings.unit]; }
  function fmt(v, unit) { return v.toFixed(UNIT_DECIMALS[unit]); }

  // ---------------------------------------------------------------- file list

  function addFiles(fileList) {
    var dzx = {}, added = 0, i, f, m;
    for (i = 0; i < fileList.length; i++) {
      f = fileList[i];
      m = /^(.*)\.dzx$/i.exec(f.name);
      if (m) dzx[m[1].toLowerCase()] = f;
    }
    for (i = 0; i < fileList.length; i++) {
      f = fileList[i];
      m = /^(.*)\.dzt$/i.exec(f.name);
      if (!m) continue;
      var key = m[1] + '|' + f.size; // GSSI reuses File____001 in every project
      var existing = scans.filter(function (s) { return s.key === key; })[0];
      if (existing) { existing.dzt = f; continue; }
      var saved = storeGet('scan:' + key) || {};
      scans.push({
        name: m[1], key: key, dzt: f, dzx: null,
        picks: (saved.picks || []).map(function (p) { return { trace: p.trace, row: p.row }; }),
        eps: saved.eps || null, dxM: saved.dxM || null, dtNs: saved.dtNs || null,
        data: null, undo: []
      });
      added++;
    }
    scans.forEach(function (s) {
      var x = dzx[s.name.toLowerCase()];
      if (x) s.dzx = x;
    });
    scans.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
    renderScanList();
    if (!added && !Object.keys(dzx).length) setStatus('No .DZT files in that selection.');
    else if (!current && scans.length) selectScan(scans[0]);
  }

  function renderScanList() {
    el.scanList.textContent = '';
    el.empty.hidden = scans.length > 0;
    scans.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'gprv-scan' + (s === current ? ' is-current' : '');
      var name = document.createElement('span');
      name.textContent = s.name;
      var count = document.createElement('span');
      count.className = 'gprv-count';
      count.textContent = s.picks.length ? String(s.picks.length) : '';
      b.appendChild(name); b.appendChild(count);
      b.addEventListener('click', function () { selectScan(s); });
      el.scanList.appendChild(b);
    });
  }

  function selectScan(s) {
    setStatus('Reading ' + s.name + '…');
    var jobs = [s.dzt.arrayBuffer(), s.dzx ? s.dzx.text() : Promise.resolve('')];
    Promise.all(jobs).then(function (res) {
      var parsed = parseDZT(res[0]);
      var meta = parsed.meta;
      var x = res[1] ? parseDZX(res[1]) : {};
      Object.keys(x).forEach(function (k) { meta[k] = x[k]; });

      if (current && current !== s) current.data = null; // one scan in memory
      s.data = parsed.data; s.nr = parsed.nr; s.nt = parsed.nt; s.meta = meta;
      s.dxM = metersPerTrace(meta);
      s.dtNs = meta.effective_rhf_rng / Math.max(s.nr - 1, 1);
      s.fileEps = meta.dielectric > 0 ? meta.dielectric : null;
      if (!s.eps) s.eps = s.fileEps || settings.defaultEps;
      s.picks = s.picks.filter(function (p) { return p.trace < s.nt && p.row < s.nr; });

      current = s; selected = -1; hover = null;
      el.eps.value = s.eps;
      buildImage();
      fitView();
      renderScanList();
      renderPicks();
      el.info.textContent = s.nt + ' traces × ' + s.nr + ' samples · ' +
        meta.effective_rhf_rng.toFixed(1) + ' ns · ' + meta.rh_bits + '-bit' +
        (s.dzx ? '' : ' · no DZX (dielectric assumed)');
      setStatus('');
    }).catch(function (err) {
      setStatus('Could not read ' + s.name + ': ' + err.message);
    });
  }

  // ---------------------------------------------------------------- rendering

  function buildLUT(name) {
    var lut = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var x = i / 255, r, g, b;
      if (name === 'seismic') {
        if (x < 0.5) { r = g = 2 * x; b = 1; } else { r = 1; g = b = 2 * (1 - x); }
      } else if (name === 'hot') {
        r = Math.min(1, 3 * x); g = Math.min(1, Math.max(0, 3 * x - 1)); b = Math.min(1, Math.max(0, 3 * x - 2));
      } else { r = g = b = x; }
      lut[i] = (255 << 24) | ((b * 255) << 16) | ((g * 255) << 8) | (r * 255);
    }
    return lut;
  }

  /** Gain + clamp the scan (as the desktop Display tab does) into image tiles. */
  function buildImage() {
    var s = current;
    if (!s || !s.data) return;
    var data = s.data, nr = s.nr, nt = s.nt, r, t;
    var sign = settings.invert ? -1 : 1;
    var gain = new Float64Array(nr);
    var sum = 0, sq = 0;
    for (r = 0; r < nr; r++) {
      var g = sign * Math.exp(settings.depthGain * (nr > 1 ? r / (nr - 1) : 0));
      gain[r] = g;
      var rs = 0, rq = 0, o = r * nt;
      for (t = 0; t < nt; t++) { var v = data[o + t]; rs += v; rq += v * v; }
      sum += g * rs; sq += g * g * rq;
    }
    var n = nr * nt;
    var mean = sum / n;
    var std = Math.sqrt(Math.max(0, sq / n - mean * mean)) || 1;
    var lo = mean - settings.contrast * std;
    var scale = 255 / (2 * settings.contrast * std);
    var lut = buildLUT(settings.colormap);

    tiles = [];
    for (var x0 = 0; x0 < nt; x0 += TILE_W) {
      var w = Math.min(TILE_W, nt - x0);
      var c = document.createElement('canvas');
      c.width = w; c.height = nr;
      var cx = c.getContext('2d');
      var img = cx.createImageData(w, nr);
      var px = new Uint32Array(img.data.buffer);
      for (r = 0; r < nr; r++) {
        var gr = gain[r], src = r * nt + x0, dst = r * w;
        for (t = 0; t < w; t++) {
          var i = ((data[src + t] * gr - lo) * scale) | 0;
          px[dst + t] = lut[i < 0 ? 0 : i > 255 ? 255 : i];
        }
      }
      cx.putImageData(img, 0, 0);
      tiles.push({ x0: x0, w: w, canvas: c });
    }
    draw();
  }

  function fitView() {
    if (!current) return;
    view = { t0: 0, t1: current.nt, r0: 0, r1: current.nr };
    draw();
  }

  function resize() {
    var rect = el.wrap.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    el.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    el.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    plot.w = Math.max(50, rect.width - plot.x - 14);
    plot.h = Math.max(50, rect.height - plot.y - 12);
    draw();
  }

  function tToX(t) { return plot.x + (t - view.t0) / (view.t1 - view.t0) * plot.w; }
  function rToY(r) { return plot.y + (r - view.r0) / (view.r1 - view.r0) * plot.h; }
  function xToT(x) { return view.t0 + (x - plot.x) / plot.w * (view.t1 - view.t0); }
  function yToR(y) { return view.r0 + (y - plot.y) / plot.h * (view.r1 - view.r0); }

  function niceStep(span, target) {
    var raw = span / target;
    var p = Math.pow(10, Math.floor(Math.log10(raw)));
    var f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }

  function cssVar(name) {
    return getComputedStyle(el.root).getPropertyValue(name).trim();
  }

  function draw() {
    var ctx = el.canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var W = el.canvas.width / dpr, H = el.canvas.height / dpr;
    ctx.fillStyle = cssVar('--gprv-panel');
    ctx.fillRect(0, 0, W, H);
    var s = current;
    if (!s || !s.data) return;

    // image
    ctx.save();
    ctx.beginPath(); ctx.rect(plot.x, plot.y, plot.w, plot.h); ctx.clip();
    ctx.imageSmoothingEnabled = plot.w / (view.t1 - view.t0) < 4;
    var ra = Math.max(0, Math.floor(view.r0)), rb = Math.min(s.nr, Math.ceil(view.r1));
    tiles.forEach(function (tile) {
      var ta = Math.max(tile.x0, Math.floor(view.t0));
      var tb = Math.min(tile.x0 + tile.w, Math.ceil(view.t1));
      if (tb <= ta || rb <= ra) return;
      ctx.drawImage(tile.canvas, ta - tile.x0, ra, tb - ta, rb - ra,
        tToX(ta), rToY(ra), tToX(tb) - tToX(ta), rToY(rb) - rToY(ra));
    });

    // picks
    s.picks.forEach(function (p, i) {
      var x = tToX(p.trace + 0.5), y = rToY(p.row + 0.5);
      if (x < plot.x - 10 || x > plot.x + plot.w + 10) return;
      ctx.beginPath(); ctx.arc(x, y, i === selected ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = i === selected ? '#ffd23f' : '#19d3da';
      ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#102030'; ctx.stroke();
    });

    // crosshair
    if (hover) {
      ctx.strokeStyle = 'rgba(255,210,63,0.75)'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hover.x + 0.5, plot.y); ctx.lineTo(hover.x + 0.5, plot.y + plot.h);
      ctx.moveTo(plot.x, hover.y + 0.5); ctx.lineTo(plot.x + plot.w, hover.y + 0.5);
      ctx.stroke();
    }
    ctx.restore();

    // axes
    var ink = cssVar('--gprv-ink'), muted = cssVar('--gprv-muted');
    ctx.strokeStyle = muted; ctx.lineWidth = 1;
    ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w, plot.h);
    ctx.fillStyle = ink; ctx.font = '11px system-ui, sans-serif';

    var du = distUnit(s);
    var perTrace = distOfTrace(s, 1);
    var d0 = (view.t0 - 0.5) * perTrace, d1 = (view.t1 - 0.5) * perTrace;
    var step = niceStep(d1 - d0, Math.max(2, plot.w / 90));
    var dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    for (var d = Math.ceil(d0 / step) * step; d <= d1 + step * 1e-6; d += step) {
      var x = Math.round(tToX(d / perTrace + 0.5)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, plot.y - 4); ctx.lineTo(x, plot.y); ctx.stroke();
      ctx.fillText(d.toFixed(dec), x, plot.y - 6);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = muted;
    ctx.fillText('Distance (' + du + ')  /  depth (' + settings.unit + ')', 4, 12);

    ctx.fillStyle = ink;
    var perRow = depthOfRow(s, 1);
    var z0 = (view.r0 - 0.5) * perRow, z1 = (view.r1 - 0.5) * perRow;
    var zstep = niceStep(z1 - z0, Math.max(2, plot.h / 45));
    var zdec = Math.max(0, -Math.floor(Math.log10(zstep) + 1e-9));
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var z = Math.ceil(Math.max(z0, 0) / zstep) * zstep; z <= z1 + zstep * 1e-6; z += zstep) {
      var y = Math.round(rToY(z / perRow + 0.5)) + 0.5;
      ctx.beginPath(); ctx.moveTo(plot.x - 4, y); ctx.lineTo(plot.x, y); ctx.stroke();
      ctx.fillText(z.toFixed(zdec), plot.x - 7, y);
    }
  }

  // -------------------------------------------------------------------- picks

  function pushUndo() {
    var s = current;
    s.undo.push(JSON.stringify(s.picks));
    if (s.undo.length > 50) s.undo.shift();
  }

  function commitPicks() {
    var s = current;
    s.picks.sort(function (a, b) { return a.trace - b.trace || a.row - b.row; });
    saveScan(s);
    renderPicks();
    renderScanList();
    draw();
  }

  /** Move a click to the strongest peak close by (a few traces / samples). */
  function snapPick(trace, row) {
    var s = current;
    var ht = s.dxM ? Math.max(1, Math.round(0.00635 / s.dxM)) : 2; // 0.25 in
    var hr = Math.max(2, Math.round(0.15 / s.dtNs));
    var sign = settings.invert ? -1 : 1;
    var best = -Infinity, bt = trace, br = row;
    for (var r = Math.max(0, row - hr); r <= Math.min(s.nr - 1, row + hr); r++) {
      for (var t = Math.max(0, trace - ht); t <= Math.min(s.nt - 1, trace + ht); t++) {
        var v = sign * s.data[r * s.nt + t];
        if (v > best) { best = v; bt = t; br = r; }
      }
    }
    return { trace: bt, row: br };
  }

  function addPick(trace, row) {
    var p = settings.snap ? snapPick(trace, row) : { trace: trace, row: row };
    pushUndo();
    current.picks.push(p);
    commitPicks();
    selected = current.picks.indexOf(p);
    renderPicks(); draw();
  }

  function deleteSelected() {
    if (!current || selected < 0) return;
    pushUndo();
    current.picks.splice(selected, 1);
    selected = -1;
    commitPicks();
  }

  function undo() {
    if (!current || !current.undo.length) return;
    current.picks = JSON.parse(current.undo.pop());
    selected = -1;
    commitPicks();
  }

  function clearPicks() {
    if (!current || !current.picks.length) return;
    pushUndo();
    current.picks = [];
    selected = -1;
    commitPicks();
    setStatus('Picks cleared. Ctrl+Z brings them back.');
  }

  function pickAt(x, y) {
    var best = -1, bd = 9 * 9;
    current.picks.forEach(function (p, i) {
      var dx = tToX(p.trace + 0.5) - x, dy = rToY(p.row + 0.5) - y;
      var d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  function renderPicks() {
    var s = current;
    el.pickBody.textContent = '';
    if (!s) { el.stats.textContent = ''; return; }
    var du = distUnit(s), u = settings.unit;
    el.pickHead.textContent = '';
    ['#', 'Dist (' + du + ')', 'Depth (' + u + ')', 'ns'].forEach(function (h) {
      var th = document.createElement('th'); th.textContent = h; el.pickHead.appendChild(th);
    });
    var depths = [], dists = [];
    s.picks.forEach(function (p, i) {
      var dist = distOfTrace(s, p.trace), depth = depthOfRow(s, p.row);
      dists.push(dist); depths.push(depth);
      var tr = document.createElement('tr');
      if (i === selected) tr.className = 'is-selected';
      [String(i + 1), fmt(dist, du), fmt(depth, u), timeOfRow(s, p.row).toFixed(2)].forEach(function (text) {
        var td = document.createElement('td'); td.textContent = text; tr.appendChild(td);
      });
      tr.addEventListener('click', function () { selected = i; centerOn(p); renderPicks(); });
      el.pickBody.appendChild(tr);
    });
    if (!depths.length) {
      el.stats.textContent = 'No picks yet. Click a hyperbola apex to mark a bar.';
      return;
    }
    var mean = depths.reduce(function (a, b) { return a + b; }, 0) / depths.length;
    var text = depths.length + ' picks · cover ' + fmt(Math.min.apply(null, depths), u) + ' to ' +
      fmt(Math.max.apply(null, depths), u) + ', mean ' + fmt(mean, u) + ' ' + u;
    if (dists.length > 1) {
      text += ' · mean spacing ' + fmt((dists[dists.length - 1] - dists[0]) / (dists.length - 1), du) + ' ' + du;
    }
    el.stats.textContent = text;
  }

  function centerOn(p) {
    var span = view.t1 - view.t0;
    if (p.trace < view.t0 || p.trace > view.t1) {
      view.t0 = p.trace - span / 2; view.t1 = view.t0 + span;
      clampView();
    }
    draw();
  }

  // -------------------------------------------------------------- interaction

  function clampView() {
    var s = current;
    var span = Math.min(Math.max(view.t1 - view.t0, 8), s.nt);
    view.t0 = Math.min(Math.max(view.t0, 0), s.nt - span); view.t1 = view.t0 + span;
    var rspan = Math.min(Math.max(view.r1 - view.r0, 8), s.nr);
    view.r0 = Math.min(Math.max(view.r0, 0), s.nr - rspan); view.r1 = view.r0 + rspan;
  }

  function zoom(factor, cx, cy, vertical) {
    if (!current) return;
    if (vertical) {
      var r = yToR(cy);
      view.r0 = r - (r - view.r0) * factor; view.r1 = r + (view.r1 - r) * factor;
    } else {
      var t = xToT(cx);
      view.t0 = t - (t - view.t0) * factor; view.t1 = t + (view.t1 - t) * factor;
    }
    clampView(); draw();
  }

  function pointerPos(e) {
    var rect = el.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function inPlot(p) {
    return p.x >= plot.x && p.x <= plot.x + plot.w && p.y >= plot.y && p.y <= plot.y + plot.h;
  }

  function bindCanvas() {
    var drag = null;
    el.canvas.addEventListener('pointerdown', function (e) {
      if (!current || !current.data) return;
      var p = pointerPos(e);
      if (!inPlot(p)) return;
      drag = { x: p.x, y: p.y, view: { t0: view.t0, t1: view.t1, r0: view.r0, r1: view.r1 }, moved: false, button: e.button };
      el.canvas.setPointerCapture(e.pointerId);
    });
    el.canvas.addEventListener('pointermove', function (e) {
      if (!current || !current.data) return;
      var p = pointerPos(e);
      if (drag) {
        var dx = p.x - drag.x, dy = p.y - drag.y;
        if (!drag.moved && dx * dx + dy * dy < 16) return;
        drag.moved = true;
        var v = drag.view;
        view.t0 = v.t0 - dx / plot.w * (v.t1 - v.t0); view.t1 = view.t0 + (v.t1 - v.t0);
        view.r0 = v.r0 - dy / plot.h * (v.r1 - v.r0); view.r1 = view.r0 + (v.r1 - v.r0);
        clampView(); hover = null; draw();
        return;
      }
      if (!inPlot(p)) { hover = null; el.readout.textContent = ''; draw(); return; }
      hover = p;
      var s = current;
      var t = Math.min(s.nt - 1, Math.max(0, Math.floor(xToT(p.x))));
      var r = Math.min(s.nr - 1, Math.max(0, Math.floor(yToR(p.y))));
      var du = distUnit(s);
      el.readout.textContent = 'Distance ' + fmt(distOfTrace(s, t), du) + ' ' + du +
        '  ·  Depth ' + fmt(depthOfRow(s, r), settings.unit) + ' ' + settings.unit +
        '  ·  ' + timeOfRow(s, r).toFixed(2) + ' ns  ·  Amplitude ' + Math.round(s.data[r * s.nt + t]);
      draw();
    });
    el.canvas.addEventListener('pointerup', function (e) {
      if (!drag) return;
      var d = drag; drag = null;
      if (d.moved || !current) return;
      var hit = pickAt(d.x, d.y);
      if (d.button === 2) {
        if (hit >= 0) { selected = hit; deleteSelected(); }
        return;
      }
      if (hit >= 0) { selected = hit; renderPicks(); draw(); return; }
      if (!settings.pickMode) { selected = -1; renderPicks(); draw(); return; }
      addPick(Math.min(current.nt - 1, Math.max(0, Math.floor(xToT(d.x)))),
        Math.min(current.nr - 1, Math.max(0, Math.floor(yToR(d.y)))));
    });
    el.canvas.addEventListener('pointercancel', function () { drag = null; });
    el.canvas.addEventListener('pointerleave', function () {
      if (drag) return;
      hover = null; el.readout.textContent = ''; draw();
    });
    el.canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    el.canvas.addEventListener('wheel', function (e) {
      if (!current || !current.data) return;
      e.preventDefault();
      var p = pointerPos(e);
      zoom(Math.exp((e.deltaY > 0 ? 1 : -1) * 0.2), p.x, p.y, e.shiftKey);
    }, { passive: false });
  }

  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (!current) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); e.preventDefault(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { undo(); e.preventDefault(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        var i = scans.indexOf(current) + (e.key === 'ArrowDown' ? 1 : -1);
        if (i >= 0 && i < scans.length) selectScan(scans[i]);
        e.preventDefault();
      }
    });
  }

  // ------------------------------------------------------------------ exports

  function download(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function csvCell(v) {
    v = String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  /** Every pick of every listed scan, in the chosen unit. */
  function exportCSV() {
    var u = settings.unit;
    var rows = [['scan', 'pick', 'distance_' + u, 'depth_' + u, 't0_ns', 'dielectric', 'trace', 'row']];
    scans.forEach(function (s) {
      if (!s.picks.length || !s.dtNs) return;
      s.picks.forEach(function (p, i) {
        rows.push([s.name, i + 1,
          s.dxM ? (p.trace * s.dxM / UNIT_M[u]).toFixed(4) : '',
          depthOfRow(s, p.row).toFixed(4), timeOfRow(s, p.row).toFixed(4), s.eps, p.trace, p.row]);
      });
    });
    if (rows.length === 1) { setStatus('There are no picks to export yet.'); return; }
    download('gpr_picks.csv', rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n', 'text/csv');
  }

  /** Current scan's picks in the desktop app's picks/<base_name>.json layout. */
  function exportJSON() {
    var s = current;
    if (!s || !s.picks.length) { setStatus('There are no picks on this scan to export.'); return; }
    var payload = {
      version: 1, base_name: s.name, params: { source: 'gpr-viewer-web', dielectric: s.eps },
      picks: s.picks.map(function (p) {
        return {
          row: p.row, trace: p.trace, t0_ns: timeOfRow(s, p.row),
          along_in: s.dxM ? p.trace * s.dxM / UNIT_M.in : p.trace,
          source: 'manual', score: null, snr_db: null, eps: s.eps, features: null
        };
      })
    };
    download(s.name + '.json', JSON.stringify(payload, null, 2), 'application/json');
  }

  // --------------------------------------------------------------------- init

  function setStatus(text) { el.status.textContent = text; }

  function saveSettings() { storeSet('settings', settings); }

  function init() {
    el.root = $('gprv');
    if (!el.root) return;
    ['canvas', 'wrap', 'scanList', 'empty', 'info', 'readout', 'status', 'eps', 'pickBody',
      'pickHead', 'stats', 'files', 'folder', 'depthGain', 'contrast', 'colormap', 'invert',
      'unit', 'pickMode', 'snap'].forEach(function (k) { el[k] = $('gprv-' + k); });

    var saved = storeGet('settings');
    if (saved) Object.keys(settings).forEach(function (k) { if (k in saved) settings[k] = saved[k]; });
    el.depthGain.value = settings.depthGain; el.contrast.value = settings.contrast;
    el.colormap.value = settings.colormap; el.invert.checked = settings.invert;
    el.unit.value = settings.unit; el.pickMode.checked = settings.pickMode; el.snap.checked = settings.snap;

    el.files.addEventListener('change', function () { addFiles(el.files.files); el.files.value = ''; });
    el.folder.addEventListener('change', function () { addFiles(el.folder.files); el.folder.value = ''; });
    $('gprv-openFiles').addEventListener('click', function () { el.files.click(); });
    $('gprv-openFolder').addEventListener('click', function () { el.folder.click(); });

    el.root.addEventListener('dragover', function (e) { e.preventDefault(); });
    el.root.addEventListener('drop', function (e) {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });

    var pending = false;
    function rebuild() {
      saveSettings();
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; buildImage(); });
    }
    el.depthGain.addEventListener('input', function () { settings.depthGain = parseFloat(el.depthGain.value); rebuild(); });
    el.contrast.addEventListener('input', function () { settings.contrast = parseFloat(el.contrast.value); rebuild(); });
    el.colormap.addEventListener('change', function () { settings.colormap = el.colormap.value; rebuild(); });
    el.invert.addEventListener('change', function () { settings.invert = el.invert.checked; rebuild(); });
    el.unit.addEventListener('change', function () { settings.unit = el.unit.value; saveSettings(); renderPicks(); draw(); });
    el.pickMode.addEventListener('change', function () { settings.pickMode = el.pickMode.checked; saveSettings(); });
    el.snap.addEventListener('change', function () { settings.snap = el.snap.checked; saveSettings(); });
    el.eps.addEventListener('change', function () {
      var v = parseFloat(el.eps.value);
      if (!current || !(v >= 1 && v <= 81)) { if (current) el.eps.value = current.eps; return; }
      current.eps = v; saveScan(current); renderPicks(); draw();
    });
    $('gprv-epsReset').addEventListener('click', function () {
      if (!current) return;
      current.eps = current.fileEps || settings.defaultEps;
      el.eps.value = current.eps; saveScan(current); renderPicks(); draw();
    });

    $('gprv-fit').addEventListener('click', fitView);
    $('gprv-zoomIn').addEventListener('click', function () { zoom(0.6, plot.x + plot.w / 2, 0, false); });
    $('gprv-zoomOut').addEventListener('click', function () { zoom(1 / 0.6, plot.x + plot.w / 2, 0, false); });
    $('gprv-undo').addEventListener('click', undo);
    $('gprv-delete').addEventListener('click', deleteSelected);
    $('gprv-clear').addEventListener('click', clearPicks);
    $('gprv-csv').addEventListener('click', exportCSV);
    $('gprv-json').addEventListener('click', exportJSON);

    bindCanvas();
    bindKeys();
    if (window.ResizeObserver) new ResizeObserver(resize).observe(el.wrap);
    window.addEventListener('resize', resize);
    resize();
    renderScanList();
    renderPicks();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
