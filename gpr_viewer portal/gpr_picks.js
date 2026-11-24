/* GPR Viewer (web) - reads GSSI DZT/DZX in the browser, shows the radargram,
 * and lets the user pick rebar. Scan files are never uploaded: they are read
 * locally. On the staff portal (data-api set on #gprv) the work is kept in
 * projects: picks, dielectric, scan positions and the display / analysis
 * settings are saved to the database under a project number and opened again
 * from there.
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

  /** Header fields and layout of a DZT, from its first 1024 bytes and its total
   *  size: { meta, headerBytes, bps, spt, nt, nr, rowOff }. Reading only this
   *  much gives a scan's trace count and spacing without loading its samples. */
  function dztLayout(dv, byteLength) {
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
    var nt = Math.floor((byteLength - headerBytes) / (bps * spt));
    if (nt < 1) throw new Error('DZT contains no traces.');

    // Rows recorded before time zero are dropped (negative rhf_pos).
    var nrFull = spt - EMBEDDED_ROWS;
    var prezero = 0;
    var rng = meta.rhf_rng;
    if (rng > 0 && meta.rhf_pos < 0) {
      prezero = Math.round(Math.abs(meta.rhf_pos) / rng * nrFull);
      prezero = Math.max(0, Math.min(prezero, nrFull - 1));
      rng = Math.max(0, rng + meta.rhf_pos);
    }
    meta.header_bytes = headerBytes;
    meta.prezero_rows_removed = prezero;
    meta.effective_rhf_rng = rng;
    return { meta: meta, headerBytes: headerBytes, bps: bps, spt: spt, nt: nt, nr: nrFull - prezero, rowOff: EMBEDDED_ROWS + prezero };
  }

  /** Parse a DZT ArrayBuffer -> { data (row-major Float32Array), nr, nt, meta }. */
  function parseDZT(buf) {
    if (buf.byteLength < 1024) throw new Error('File is too small to be a DZT.');
    var L = dztLayout(new DataView(buf), buf.byteLength);
    var nt = L.nt, nr = L.nr, spt = L.spt, rowOff = L.rowOff;

    var body = buf.slice(L.headerBytes, L.headerBytes + nt * spt * L.bps);
    var raw, offset = 0;
    if (L.bps === 4) raw = new Int32Array(body);
    else if (L.bps === 2) { raw = new Uint16Array(body); offset = 32768; }
    else { raw = new Uint8Array(body); offset = 128; }

    var data = new Float32Array(nr * nt);
    for (var t = 0; t < nt; t++) {
      var src = t * spt + rowOff;
      for (var r = 0; r < nr; r++) data[r * nt + t] = raw[src + r] - offset;
    }
    return { data: data, nr: nr, nt: nt, meta: L.meta };
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

  // ----------------------------------------------------------------- analysis
  // Ported from processing/rebar_features.py: per-trace DC removal, running-
  // median background across traces, Hilbert envelope along time, the window
  // energy reading (20*log10 of envelope RMS) and the tapered spectrum.

  var BG_HALF_TRACES = 150;
  var MOMENT_BAND_GHZ = [0.3, 5.0];
  var MAX_ANALYSIS_CELLS = 3e6; // longer scans are analysed on every n-th trace

  /** In-place radix-2 FFT (length must be a power of two). */
  function fft(re, im, inverse) {
    var n = re.length, i, j = 0, k, len, t;
    for (i = 1; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (len = 2; len <= n; len <<= 1) {
      var ang = 2 * Math.PI / len * (inverse ? 1 : -1);
      var half = len >> 1;
      for (k = 0; k < half; k++) {
        var wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        for (i = k; i < n; i += len) {
          var b = i + half;
          var xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[i] - xr; im[b] = im[i] - xi; re[i] += xr; im[i] += xi;
        }
      }
    }
    if (inverse) for (i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  /** DFT of any length N (Bluestein), in place: f(re, im, inverse). */
  function makeDFT(N) {
    if ((N & (N - 1)) === 0) return fft;
    var M = 1, n;
    while (M < 2 * N - 1) M <<= 1;
    var wr = new Float64Array(N), wi = new Float64Array(N);
    var Br = new Float64Array(M), Bi = new Float64Array(M);
    for (n = 0; n < N; n++) {
      var a = Math.PI * ((n * n) % (2 * N)) / N;
      wr[n] = Math.cos(a); wi[n] = -Math.sin(a);
      Br[n] = wr[n]; Bi[n] = -wi[n];
      if (n) { Br[M - n] = wr[n]; Bi[M - n] = -wi[n]; }
    }
    fft(Br, Bi, false);
    var ar = new Float64Array(M), ai = new Float64Array(M);
    function forward(re, im) {
      var i, t;
      ar.fill(0); ai.fill(0);
      for (i = 0; i < N; i++) {
        ar[i] = re[i] * wr[i] - im[i] * wi[i];
        ai[i] = re[i] * wi[i] + im[i] * wr[i];
      }
      fft(ar, ai, false);
      for (i = 0; i < M; i++) {
        t = ar[i] * Br[i] - ai[i] * Bi[i];
        ai[i] = ar[i] * Bi[i] + ai[i] * Br[i]; ar[i] = t;
      }
      fft(ar, ai, true);
      for (i = 0; i < N; i++) {
        re[i] = ar[i] * wr[i] - ai[i] * wi[i];
        im[i] = ar[i] * wi[i] + ai[i] * wr[i];
      }
    }
    return function (re, im, inverse) {
      var i;
      if (!inverse) { forward(re, im); return; }
      for (i = 0; i < N; i++) im[i] = -im[i];
      forward(re, im);
      for (i = 0; i < N; i++) { re[i] /= N; im[i] = -im[i] / N; }
    };
  }

  /** Running median, window 2h+1, edges repeated (scipy mode="nearest"). */
  function slidingMedian(x, h, out) {
    var n = x.length, w = 2 * h + 1, i, j, k;
    var win = new Float64Array(w);
    for (k = -h; k <= h; k++) win[k + h] = x[k < 0 ? 0 : k >= n ? n - 1 : k];
    win.sort();
    out[0] = win[h];
    for (i = 1; i < n; i++) {
      var rem = x[i - 1 - h < 0 ? 0 : i - 1 - h];
      var add = x[i + h >= n ? n - 1 : i + h];
      if (rem !== add) {
        var lo = 0, hi = w - 1;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (win[mid] < rem) lo = mid + 1; else hi = mid; }
        j = lo;
        if (add > rem) { while (j + 1 < w && win[j + 1] < add) { win[j] = win[j + 1]; j++; } }
        else { while (j > 0 && win[j - 1] > add) { win[j] = win[j - 1]; j--; } }
        win[j] = add;
      }
      out[i] = win[h];
    }
  }

  /** Scan-level arrays for the analysis panel (desktop: prepare_scan).
   *  sig = DC- and background-removed signal, envSq = its squared envelope,
   *  both row-major over nt2 = every `step`-th trace. */
  function prepareAnalysis(data, nr, nt, maxCells) {
    var step = Math.max(1, Math.ceil(nr * nt / (maxCells || MAX_ANALYSIS_CELLS)));
    var nt2 = Math.ceil(nt / step), r, j;
    var sig = new Float32Array(nr * nt2);
    for (j = 0; j < nt2; j++) {
      var col = j * step, mean = 0;
      for (r = 0; r < nr; r++) mean += data[r * nt + col];
      mean /= nr;
      for (r = 0; r < nr; r++) sig[r * nt2 + j] = data[r * nt + col] - mean;
    }
    var hw = Math.max(1, Math.round(BG_HALF_TRACES / step));
    var row = new Float64Array(nt2), med = new Float64Array(nt2);
    for (r = 0; r < nr; r++) {
      var o = r * nt2;
      for (j = 0; j < nt2; j++) row[j] = sig[o + j];
      slidingMedian(row, hw, med);
      for (j = 0; j < nt2; j++) sig[o + j] = row[j] - med[j];
    }
    var envSq = new Float32Array(nr * nt2);
    var dft = makeDFT(nr), re = new Float64Array(nr), im = new Float64Array(nr);
    for (j = 0; j < nt2; j++) {
      for (r = 0; r < nr; r++) { re[r] = sig[r * nt2 + j]; im[r] = 0; }
      dft(re, im, false);
      for (r = 1; r < nr; r++) { // analytic signal: double positive, drop negative
        if (2 * r < nr) { re[r] *= 2; im[r] *= 2; }
        else if (2 * r > nr) { re[r] = 0; im[r] = 0; }
      }
      dft(re, im, true);
      for (r = 0; r < nr; r++) envSq[r * nt2 + j] = re[r] * re[r] + im[r] * im[r];
    }
    return { nr: nr, nt2: nt2, step: step, sig: sig, envSq: envSq };
  }

  /** Mean over +/- half neighbours (clipped at the ends) of num/den. */
  function smoothRatio(num, den, half) {
    var n = num.length, out = new Float64Array(n), i;
    var cn = new Float64Array(n + 1), cd = new Float64Array(n + 1);
    for (i = 0; i < n; i++) { cn[i + 1] = cn[i] + num[i]; cd[i + 1] = cd[i] + (den ? den[i] : 1); }
    for (i = 0; i < n; i++) {
      var a = Math.max(0, i - half), b = Math.min(n - 1, i + half) + 1;
      var d = cd[b] - cd[a];
      out[i] = d > 0 ? (cn[b] - cn[a]) / d : NaN;
    }
    return out;
  }

  /** Envelope RMS in dB over rows r0..r1 and +/- half traces, per trace. */
  function bandEnergyDb(A, r0, r1, half) {
    var ms = new Float64Array(A.nt2), r, j;
    for (r = r0; r <= r1; r++) {
      var o = r * A.nt2;
      for (j = 0; j < A.nt2; j++) ms[j] += A.envSq[o + j];
    }
    var sm = smoothRatio(ms, null, half);
    for (j = 0; j < A.nt2; j++) {
      var v = sm[j] / (r1 - r0 + 1);
      sm[j] = v > 0 ? 10 * Math.log10(v) : NaN;
    }
    return sm;
  }

  function tukey(n, alpha) {
    var w = new Float64Array(n).fill(1);
    if (n <= 3) return w;
    var width = alpha * (n - 1) / 2;
    for (var i = 0; i < width; i++) {
      w[i] = w[n - 1 - i] = 0.5 * (1 + Math.cos(Math.PI * (i / width - 1)));
    }
    return w;
  }

  /** Power spectrum (nfft/2+1 bins) of rows r0..r1 of one analysed trace. */
  function tracePower(A, j, r0, r1, nfft, taper, re, im, out) {
    var n = r1 - r0 + 1, i, mean = 0;
    for (i = 0; i < n; i++) mean += A.sig[(r0 + i) * A.nt2 + j];
    mean /= n;
    re.fill(0); im.fill(0);
    for (i = 0; i < n; i++) re[i] = (A.sig[(r0 + i) * A.nt2 + j] - mean) * taper[i];
    fft(re, im, false);
    for (i = 0; i <= nfft / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i];
  }

  function fftSize(n, min) { var m = min; while (m < n) m <<= 1; return m; }

  /** Power-weighted centroid, bandwidth and peak frequency (GHz) in a band. */
  function spectralMoments(power, dfGhz, fLo, fHi) {
    var tot = 0, sf = 0, peak = -1, peakF = NaN, i, f;
    for (i = 0; i < power.length; i++) {
      f = i * dfGhz;
      if (f < fLo || f > fHi) continue;
      tot += power[i]; sf += f * power[i];
      if (power[i] > peak) { peak = power[i]; peakF = f; }
    }
    if (!(tot > 0)) return { centroid: NaN, bandwidth: NaN, peak: NaN };
    var c = sf / tot, v = 0;
    for (i = 0; i < power.length; i++) {
      f = i * dfGhz;
      if (f >= fLo && f <= fHi) v += (f - c) * (f - c) * power[i];
    }
    return { centroid: c, bandwidth: Math.sqrt(Math.max(v / tot, 0)), peak: peakF };
  }

  /** Spectral centroid (GHz) of the band per trace, pooled over +/- half. */
  function centroidProfile(A, r0, r1, half, dtNs) {
    var n = r1 - r0 + 1, nfft = fftSize(n, 512), df = 1 / (nfft * dtNs);
    var taper = tukey(n, 0.5), re = new Float64Array(nfft), im = new Float64Array(nfft);
    var p = new Float64Array(nfft / 2 + 1);
    var num = new Float64Array(A.nt2), den = new Float64Array(A.nt2);
    for (var j = 0; j < A.nt2; j++) {
      tracePower(A, j, r0, r1, nfft, taper, re, im, p);
      for (var i = 0; i < p.length; i++) {
        var f = i * df;
        if (f >= MOMENT_BAND_GHZ[0] && f <= MOMENT_BAND_GHZ[1]) { num[j] += f * p[i]; den[j] += p[i]; }
      }
    }
    return smoothRatio(num, den, half);
  }

  /** Mean power spectrum of the band over traces j-half..j+half. */
  function bandSpectrum(A, j, r0, r1, half, dtNs) {
    var n = r1 - r0 + 1, nfft = fftSize(n, 2048);
    var taper = tukey(n, 0.5), re = new Float64Array(nfft), im = new Float64Array(nfft);
    var p = new Float64Array(nfft / 2 + 1), sum = new Float64Array(nfft / 2 + 1);
    var a = Math.max(0, j - half), b = Math.min(A.nt2 - 1, j + half);
    for (var k = a; k <= b; k++) {
      tracePower(A, k, r0, r1, nfft, taper, re, im, p);
      for (var i = 0; i < p.length; i++) sum[i] += p[i] / (b - a + 1);
    }
    return { power: sum, dfGhz: 1 / (nfft * dtNs) };
  }

  // ---------------------------------------------------------- scan positions
  // Same CSV the desktop merge setup imports: Origin X, Origin Y, Direction and
  // an optional scan column (name or number). Without a scan column, rows are
  // paired with the scans in list order.

  var DIR_UNIT = { '+X': [1, 0], '-X': [-1, 0], '+Y': [0, 1], '-Y': [0, -1] };
  var POS_ALIASES = {
    x: ['originx', 'origin_x', 'origin x', 'ox', 'o_x', 'orgx', 'org_x', 'startx', 'start_x', 'start x', 'x'],
    y: ['originy', 'origin_y', 'origin y', 'oy', 'o_y', 'orgy', 'org_y', 'starty', 'start_y', 'start y', 'y'],
    dir: ['direction', 'dir', 'd', 'orientation', 'orient'],
    scan: ['file num', 'file_num', 'filenum', 'file number', 'file_number', 'file', 'scan', 'scan num',
      'scan_num', 'scannum', 'scan number', 'scan_number', 'base name', 'base_name', 'basename', 'name',
      'num', 'number', 'id']
  };

  function parseCSV(text) {
    var rows = [], row = [], cell = '', quoted = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (quoted) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function normHeader(t) { return String(t).trim().toLowerCase().replace(/-/g, '_'); }

  function findColumn(headers, aliases) {
    var i, j;
    for (j = 0; j < aliases.length; j++) {
      i = headers.indexOf(normHeader(aliases[j]));
      if (i >= 0) return i;
    }
    var compact = headers.map(function (h) { return h.replace(/[_ ]/g, ''); });
    for (j = 0; j < aliases.length; j++) {
      i = compact.indexOf(normHeader(aliases[j]).replace(/[_ ]/g, ''));
      if (i >= 0) return i;
    }
    return -1;
  }

  function normDirection(t) {
    var v = String(t).trim().toUpperCase().replace(/[ _]/g, '').replace('\u2212', '-');
    if (['+X', 'X', 'POSX', 'POSITIVEX', 'PLUSX'].indexOf(v) >= 0) return '+X';
    if (['-X', 'NEGX', 'NEGATIVEX', 'MINUSX'].indexOf(v) >= 0) return '-X';
    if (['+Y', 'Y', 'POSY', 'POSITIVEY', 'PLUSY'].indexOf(v) >= 0) return '+Y';
    if (['-Y', 'NEGY', 'NEGATIVEY', 'MINUSY'].indexOf(v) >= 0) return '-Y';
    return null;
  }

  /** CSV text -> { records: [{x, y, dir, scanId, row}], hasScan }. Throws on a bad file. */
  function readPositions(text) {
    var rows = parseCSV(String(text).replace(/^\uFEFF/, ''));
    if (!rows.length) throw new Error('The CSV is empty.');
    var headers = rows[0].map(normHeader);
    var ix = findColumn(headers, POS_ALIASES.x), iy = findColumn(headers, POS_ALIASES.y);
    var idir = findColumn(headers, POS_ALIASES.dir), iscan = findColumn(headers, POS_ALIASES.scan);
    var missing = [];
    if (ix < 0) missing.push('Origin X');
    if (iy < 0) missing.push('Origin Y');
    if (idir < 0) missing.push('Direction');
    if (missing.length) {
      throw new Error('The CSV has no column for ' + missing.join(', ') +
        '. It needs Origin X, Origin Y and Direction, plus Scan to match rows by name or number.');
    }
    var records = [];
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row.some(function (c) { return c.trim() !== ''; })) continue;
      var dir = normDirection(row[idir] || '');
      if (!dir) throw new Error('Row ' + (r + 1) + ': direction "' + (row[idir] || '').trim() + '" should be +X, -X, +Y or -Y.');
      var x = Number((row[ix] || '').trim() || NaN), y = Number((row[iy] || '').trim() || NaN);
      if (!isFinite(x) || !isFinite(y)) throw new Error('Row ' + (r + 1) + ': the origin is not a number.');
      records.push({ x: x, y: y, dir: dir, scanId: iscan >= 0 ? (row[iscan] || '').trim() : '', row: r + 1 });
    }
    return { records: records, hasScan: iscan >= 0 };
  }

  function scanNumber(name) {
    var m = /(\d+)\s*$/.exec(String(name).trim());
    return m ? parseInt(m[1], 10) : null;
  }

  /** Pair position records with scan names -> { pairs: [[name, record]], unmatchedRows, unplaced }. */
  function matchPositions(pos, names) {
    var pairs = [], unmatchedRows = [], used = {};
    if (!pos.hasScan) {
      pos.records.forEach(function (rec, i) {
        if (i < names.length) { pairs.push([names[i], rec]); used[names[i]] = true; }
        else unmatchedRows.push(rec.row);
      });
    } else {
      var byName = {}, byNumber = {};
      names.forEach(function (n) {
        byName[n.toLowerCase()] = n;
        var k = scanNumber(n);
        if (k !== null && !(k in byNumber)) byNumber[k] = n;
      });
      pos.records.forEach(function (rec) {
        var id = rec.scanId, name = byName[id.toLowerCase()];
        if (!name && id) {
          var asNum = Number(id);
          var k = isFinite(asNum) && Math.floor(asNum) === asNum ? asNum : scanNumber(id);
          if (k !== null) name = byNumber[k];
        }
        if (name) { pairs.push([name, rec]); used[name] = true; }
        else unmatchedRows.push(rec.row);
      });
    }
    return {
      pairs: pairs, unmatchedRows: unmatchedRows,
      unplaced: names.filter(function (n) { return !used[n]; })
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      readPositions: readPositions, matchPositions: matchPositions,
      parseDZT: parseDZT, metersPerTrace: metersPerTrace, prepareAnalysis: prepareAnalysis,
      bandEnergyDb: bandEnergyDb, centroidProfile: centroidProfile, bandSpectrum: bandSpectrum,
      spectralMoments: spectralMoments, dztLayout: dztLayout,
      v3Basis: v3Basis, v3Proj: v3Proj, v3AutoZ: v3AutoZ, v3DepthBox: v3DepthBox
    };
  }
  if (typeof document === 'undefined') return;

  // -------------------------------------------------------------------- state

  var settings = {
    depthGain: 2.0, contrast: 2.0, colormap: 'gray', invert: false,
    unit: 'in', pickMode: true, snap: true, defaultEps: 7.0, job: '',
    analysis: true, profile: 'energy', smoothM: 0.0254, bandNs: null,
    zScale: null, v3Drops: true, v3Grid: true, v3Radar: false // 3D tab; zScale null = automatic
  };
  var scans = [];      // {name, key, dzt, dzx, picks, eps, dxM, dtNs, nr, nt, data, undo}
  var current = null;
  var selected = -1;   // index into current.picks
  var view = { t0: 0, t1: 1, r0: 0, r1: 1 };
  var tiles = [];      // [{x0, w, canvas}]
  var plot = { x: 58, y: 30, w: 100, h: 100 };
  var hover = null;    // {x, y} in canvas px; y is null over the analysis panel
  var prof = null;     // {values, label, unit, dec, minSpan} along the analysed traces
  var lastTrace = null;
  var specKey = '';
  var tab = 'scan';
  var mapView = { cx: 0, cy: 0, scale: 100, fit: true }; // metres at centre, px per metre
  var mplot = { x: 58, y: 10, w: 100, h: 100 };
  var mapGeo = { lines: [], pts: [] };
  var mapHover = null;
  var pendingPick = null; // {key, index}: pick to select once its scan has loaded
  var api = null;         // portal save endpoint (data-api on #gprv); null when standalone
  var job = '';           // number of the open project ('' = none: browser only)
  var pushTimers = {};
  var pushQuiet = {};     // scan key -> the waiting save is bookkeeping only
  var settingsTimer = null;
  var refreshControls = function () {}; // set in init: show `settings` in the controls
  var JOB_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
  var PROJECT_KEYS = ['unit', 'depthGain', 'contrast', 'colormap', 'invert', 'analysis', 'profile', 'smoothM', 'bandNs'];
  var loadSeq = 0;        // only the most recent scan load is shown
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

  function scanRecord(s) {
    return {
      name: s.name, eps: s.eps, dxM: s.dxM, dtNs: s.dtNs, nt: s.nt || null, place: s.place || null,
      updated: s.updated || 0,
      picks: s.picks.map(function (p) { return { trace: p.trace, row: p.row }; })
    };
  }

  /** Browser copy of a scan, kept apart per project so projects never mix. */
  function localKey(key) { return 'scan:' + (job ? job + '|' : '') + key; }

  function hasWork(s) { return s.picks.length > 0 || !!s.place; }

  /** Keep a scan's picks. `edited` false = bookkeeping only (trace count, spacing):
   *  the record keeps its timestamp so it cannot overwrite a newer save on the portal. */
  function saveScan(s, edited) {
    if (edited !== false) s.updated = Date.now();
    var ok = storeSet(localKey(s.key), scanRecord(s));
    if (!ok && !(api && job)) setStatus('Could not save picks in this browser (storage blocked or full). Export them before leaving.');
    if (s.updated) queuePush(s, edited === false);
  }

  // ----------------------------------------------------------------- projects
  // A project (project number) holds everything done in the viewer: each scan's
  // picks, dielectric and position, plus the display and analysis settings.
  // Changes are saved to the portal as they are made, and by the Save button.
  // A scan belongs to the project once it has picks or a position. The scan
  // files themselves never leave the computer: a project opened without them
  // lists its scans, maps and exports their picks, and shows a radargram again
  // when the matching .DZT is opened.

  function setSync(text) { if (el.sync) el.sync.textContent = text; }
  function clock() { return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function apiCall(method, query, body) {
    return fetch(api + (query || ''), {
      method: method, credentials: 'same-origin', keepalive: !!body,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { /* a login page or PHP error, not JSON */ }
        if (!j) throw new Error(r.status === 200 ? 'the portal session may have expired' : 'server error ' + r.status);
        if (!j.ok && !j.stale) throw new Error(j.error || 'server error');
        return j;
      });
    });
  }

  /** `quiet`: bookkeeping save, says nothing unless it fails. */
  function queuePush(s, quiet) {
    if (!api || !job) return;
    if (!hasWork(s) && !s.onPortal) return; // nothing to keep, nothing to remove
    if (pushTimers[s.key]) { clearTimeout(pushTimers[s.key]); quiet = quiet && pushQuiet[s.key]; } // an edit already waiting stays loud
    pushQuiet[s.key] = !!quiet;
    pushTimers[s.key] = setTimeout(function () {
      delete pushTimers[s.key];
      pushScan(s, pushQuiet[s.key]);
    }, 700);
  }

  /** Save one scan to the open project. Resolves true when the portal has it. */
  function pushScan(s, quiet) {
    var sentJob = job, wasOnPortal = !!s.onPortal;
    if (!quiet) setSync('Saving…');
    return apiCall('POST', '', { job: sentJob, key: s.key, record: scanRecord(s) }).then(function (j) {
      if (sentJob !== job) return true;
      if (j.stale && j.record) {
        applyRecord(s, j.record);
        refreshLists();
        setSync(s.name + ': loaded a newer save' + (j.saved_by ? ' by ' + j.saved_by : '') + ' from the portal.');
        return true;
      }
      s.onPortal = !j.removed;
      if (!quiet) setSync('Project ' + sentJob + ': all changes saved at ' + clock());
      if (s.onPortal !== wasOnPortal) listProjects();
      return true;
    }).catch(function (err) {
      if (sentJob === job) setSync('Not saved to the portal (' + err.message + '). The work is kept in this browser; press Save to try again.');
      return false;
    });
  }

  function projectSettings() {
    var o = {};
    PROJECT_KEYS.forEach(function (k) { o[k] = settings[k]; });
    return o;
  }

  function pushSettings() {
    if (!api || !job) return Promise.resolve(true);
    return apiCall('POST', '', { job: job, settings: projectSettings(), updated: Date.now() })
      .then(function () { return true; }).catch(function () { return false; });
  }

  /** Take saved project settings (checked value by value) and show them. */
  function applySettings(o) {
    if (!o || typeof o !== 'object') return;
    function num(k, lo, hi) { if (typeof o[k] === 'number' && o[k] >= lo && o[k] <= hi) settings[k] = o[k]; }
    num('depthGain', 0, 6); num('contrast', 0.3, 6); num('smoothM', 0, 10);
    if (Object.prototype.hasOwnProperty.call(UNIT_M, o.unit)) settings.unit = o.unit;
    if (['gray', 'seismic', 'hot'].indexOf(o.colormap) >= 0) settings.colormap = o.colormap;
    if (['energy', 'centroid'].indexOf(o.profile) >= 0) settings.profile = o.profile;
    ['invert', 'analysis'].forEach(function (k) { if (typeof o[k] === 'boolean') settings[k] = o[k]; });
    if (o.bandNs === null) settings.bandNs = null;
    else if (Array.isArray(o.bandNs) && o.bandNs.length === 2 && isFinite(o.bandNs[0]) && isFinite(o.bandNs[1])) {
      settings.bandNs = [Number(o.bandNs[0]), Number(o.bandNs[1])];
    }
    storeSet('settings', settings);
    refreshControls();
  }

  /** Send everything still waiting to be saved. Always resolves. */
  function flushPending() {
    var jobs = [];
    Object.keys(pushTimers).forEach(function (k) {
      clearTimeout(pushTimers[k]); delete pushTimers[k];
      var s = scans.filter(function (x) { return x.key === k; })[0];
      if (s) jobs.push(pushScan(s));
    });
    if (settingsTimer) { clearTimeout(settingsTimer); settingsTimer = null; jobs.push(pushSettings()); }
    return Promise.all(jobs);
  }

  function fillScan(s, rec) {
    s.picks = (rec.picks || []).map(function (p) { return { trace: p.trace, row: p.row }; });
    if (s.data) s.picks = s.picks.filter(function (p) { return p.trace < s.nt && p.row < s.nr; });
    if (rec.eps) s.eps = rec.eps;
    s.place = rec.place || null;
    if (!s.dxM) s.dxM = rec.dxM || null;
    if (!s.dtNs) s.dtNs = rec.dtNs || null;
    if (!s.nt) s.nt = rec.nt || null;
    s.updated = rec.updated || 0;
    s.undo = [];
  }

  /** Replace a scan's picks, dielectric and position with a saved record. */
  function applyRecord(s, rec) {
    fillScan(s, rec);
    storeSet(localKey(s.key), scanRecord(s));
    if (s === current) {
      selected = -1;
      el.eps.value = s.eps;
      renderPicks(); updateBandText(); draw();
    }
  }

  function refreshLists() {
    renderScanList();
    if (tab === 'map') { renderPlaceTable(); drawMap(); }
    v3Refresh();
    ensureScanInfo();
  }

  function sortScans() {
    scans.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
  }

  /** Empty the viewer: no scans, no image. */
  function resetSession() {
    scans = []; current = null; selected = -1; tiles = []; prof = null; hover = null;
    lastTrace = null; pendingPick = null; specKey = ''; loadSeq++;
    mapView.fit = true; mapHover = null; v3.fit = true;
    el.info.textContent = ''; el.readout.textContent = ''; el.eps.value = '';
    el.mapStatus.textContent = '';
    setStatus('');
    renderScanList(); renderPicks(); updateBandText(); draw();
    if (tab === 'map') { renderPlaceTable(); drawMap(); }
    v3Refresh();
  }

  /** Open a project from the portal ('' closes the open one).
   *  Scans opened before any project was chosen come along into the project;
   *  switching from one project to another starts from a clean list. */
  function openProject(next) {
    if (!api) return;
    next = String(next || '').trim();
    if (next && !JOB_RE.test(next)) {
      setSync('Project number: letters, numbers, spaces, dots and dashes only (40 at most).');
      return;
    }
    var from = job;
    return flushPending().then(function () {
      if (!next) {
        job = ''; settings.job = ''; el.job.value = ''; storeSet('settings', settings);
        resetSession();
        setSync('No project open. Enter a project number to save your work to the portal.');
        return;
      }
      setSync('Opening project ' + next + '…');
      return apiCall('GET', '?job=' + encodeURIComponent(next)).then(function (j) {
        var keep = from === '' || from === next;
        job = next; settings.job = next; el.job.value = next; storeSet('settings', settings);
        if (!keep) resetSession();

        var remote = j.scans || {}, seen = {}, carried = 0;
        scans.forEach(function (s) {
          var rec = remote[s.key];
          seen[s.key] = true;
          s.onPortal = !!rec;
          if (rec && (rec.updated || 0) > (s.updated || 0)) applyRecord(s, rec);
          else if (hasWork(s) && (!rec || (s.updated || 0) > (rec.updated || 0))) {
            if (!s.updated) s.updated = Date.now();
            storeSet(localKey(s.key), scanRecord(s));
            queuePush(s); carried++;
          }
        });
        // saved scans whose files are not open on this computer
        var missing = 0, picks = 0;
        Object.keys(remote).forEach(function (key) {
          if (seen[key]) return;
          var rec = remote[key], local = storeGet(localKey(key));
          var s = {
            name: rec.name || key.split('|')[0], key: key, dzt: null, dzx: null, picks: [],
            eps: null, dxM: null, dtNs: null, nt: null, place: null, updated: 0,
            data: null, undo: [], onPortal: true
          };
          scans.push(s);
          if (local && (local.updated || 0) > (rec.updated || 0)) { fillScan(s, local); queuePush(s); }
          else applyRecord(s, rec);
          missing++;
        });
        sortScans();
        scans.forEach(function (s) { picks += s.picks.length; });
        if (j.settings) applySettings(j.settings);
        mapView.fit = true; v3.fit = true;
        refreshLists(); renderPicks(); draw();

        var saved = Object.keys(remote).length, msg;
        if (!saved) msg = 'Project ' + next + ' is new. It is saved as soon as a scan has picks or a position.';
        else {
          msg = 'Project ' + next + ' opened: ' + plural(saved, 'saved scan') + ', ' + plural(picks, 'pick') + '.';
          if (missing) msg += ' Open the .DZT files to see the radargrams; the Map tab and exports work without them.';
        }
        if (carried) msg += ' Saving ' + plural(carried, 'scan') + ' from this session…';
        setSync(msg);
        listProjects();
      }).catch(function (err) {
        el.job.value = job;
        setSync('Could not open project ' + next + ' (' + err.message + '). Nothing was changed.');
      });
    });
  }

  /** Save button: write every scan with work, and the settings, now. */
  function saveProject() {
    if (!api) return;
    var typed = el.job.value.trim();
    if (!job) {
      if (!typed) { setSync('Enter a project number first, then Save.'); el.job.focus(); return; }
      openProject(typed); // brings the open scans into the project and saves them
      return;
    }
    el.job.value = job;
    Object.keys(pushTimers).forEach(function (k) { clearTimeout(pushTimers[k]); delete pushTimers[k]; });
    if (settingsTimer) { clearTimeout(settingsTimer); settingsTimer = null; }
    var list = scans.filter(function (s) { return hasWork(s) || s.onPortal; }), sent = job, picks = 0;
    list.forEach(function (s) {
      if (!s.updated) { s.updated = Date.now(); storeSet(localKey(s.key), scanRecord(s)); }
      picks += s.picks.length;
    });
    Promise.all(list.map(pushScan).concat([pushSettings()])).then(function (res) {
      if (sent !== job) return;
      if (res.every(Boolean)) {
        var kept = list.filter(hasWork).length;
        setSync('Project ' + sent + ' saved at ' + clock() + ': ' + plural(kept, 'scan') + ', ' + plural(picks, 'pick') + '.');
      }
      listProjects();
    });
  }

  /** Fill the "Saved projects" list from the portal. */
  function listProjects() {
    if (!api || !el.jobList) return;
    apiCall('GET', '?list=1').then(function (j) {
      var list = j.projects || [];
      el.jobList.textContent = '';
      var first = document.createElement('option');
      first.value = '';
      first.textContent = list.length ? 'Saved projects (' + list.length + ')…' : 'No saved projects yet';
      el.jobList.appendChild(first);
      list.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.job;
        o.textContent = p.job + '  ·  ' + plural(p.scans, 'scan') + ', ' + plural(p.picks, 'pick') + '  ·  ' + p.saved;
        el.jobList.appendChild(o);
      });
    }).catch(function () { /* the list is a convenience; opening by number still works */ });
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
    var dzx = {}, added = 0, attached = 0, mismatched = [], i, f, m;
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
      if (existing) { if (!existing.dzt) attached++; existing.dzt = f; existing.infoTried = false; continue; }
      var lower = m[1].toLowerCase();
      if (scans.some(function (s) { return !s.dzt && s.onPortal && s.name.toLowerCase() === lower; })) mismatched.push(m[1]);
      var saved = storeGet(localKey(key)) || {};
      var fresh = {
        name: m[1], key: key, dzt: f, dzx: null,
        picks: (saved.picks || []).map(function (p) { return { trace: p.trace, row: p.row }; }),
        eps: saved.eps || null, dxM: saved.dxM || null, dtNs: saved.dtNs || null,
        nt: saved.nt || null, place: saved.place || null, updated: saved.updated || 0,
        data: null, undo: [], onPortal: false
      };
      scans.push(fresh);
      if (hasWork(fresh) && fresh.updated) queuePush(fresh); // kept in this browser but never reached the portal
      added++;
    }
    scans.forEach(function (s) {
      var x = dzx[s.name.toLowerCase()];
      if (x) { s.dzx = x; s.infoTried = false; }
    });
    sortScans();
    renderScanList();
    if (tab === 'map') { renderPlaceTable(); drawMap(); }
    v3Refresh();
    ensureScanInfo();
    if (!added && !attached && !Object.keys(dzx).length) setStatus('No .DZT files in that selection.');
    else if (!current || !current.data) {
      var first = scans.filter(function (s) { return s.dzt; })[0];
      if (first) selectScan(first);
    }
    if (mismatched.length) {
      setSync(mismatched.slice(0, 3).join(', ') + (mismatched.length > 3 ? ', …' : '') +
        ': a scan with this name is saved in the project, but the file opened here is a different size, so it is listed separately and the saved picks were not put on it.');
    }
  }

  /** "Open folder…": the folder's scans take the place of the list instead of
   *  joining it, so two projects are never listed (or saved) together.
   *  - No project open: the list is emptied, then the folder is added.
   *  - A project open and the folder holds some of its saved scans (or the
   *    project has nothing saved yet): the project's scans stay, scans left
   *    over from an earlier folder with no work on them go.
   *  - A project open and the folder holds none of its saved scans: it is
   *    another project's folder. The open project is closed first (its work is
   *    saved), so picks made next cannot land under the wrong project number. */
  function openFolder(files) {
    var keys = {}, count = 0, i, m;
    for (i = 0; i < files.length; i++) {
      m = /^(.*)\.dzt$/i.exec(files[i].name);
      if (m) { keys[m[1] + '|' + files[i].size] = true; count++; }
    }
    if (!count) { setStatus('No .DZT files in that folder. The open scans were left as they are.'); return; }
    if (!(api && job)) { resetSession(); addFiles(files); return; }

    var kept = scans.filter(function (s) { return hasWork(s) || s.onPortal; });
    if (kept.length && !kept.some(function (s) { return keys[s.key]; })) {
      var closed = job;
      openProject('').then(function () {
        addFiles(files);
        setSync('Project ' + closed + ' was closed, because this folder has none of its saved scans. ' +
          'Enter the project number for these scans to save them to the portal. ' +
          'If they do belong to ' + closed + ', open it again and they are added to it.');
      });
      return;
    }
    resetSession();
    kept.forEach(function (s) { s.data = null; s.A = null; });
    scans = kept;
    addFiles(files);
  }

  function renderScanList() {
    el.scanList.textContent = '';
    el.empty.hidden = scans.length > 0;
    scans.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'gprv-scan' + (s === current ? ' is-current' : '') + (s.dzt ? '' : ' is-missing');
      if (!s.dzt) b.title = 'Saved in this project. Open ' + s.name + '.DZT to see the radargram.';
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
    if (!s.dzt) {
      setStatus(s.name + ' is saved in this project, but its file is not open here. Use "Open scans…" and choose ' + s.name + '.DZT to view it.');
      return;
    }
    setStatus('Reading ' + s.name + '…');
    var seq = ++loadSeq;
    var jobs = [s.dzt.arrayBuffer(), s.dzx ? s.dzx.text() : Promise.resolve('')];
    Promise.all(jobs).then(function (res) {
      if (seq !== loadSeq) return; // another scan was chosen while this one was loading
      var parsed = parseDZT(res[0]);
      var meta = parsed.meta;
      var x = res[1] ? parseDZX(res[1]) : {};
      Object.keys(x).forEach(function (k) { meta[k] = x[k]; });

      if (current && current !== s) { current.data = null; current.A = null; } // one scan in memory
      s.data = parsed.data; s.nr = parsed.nr; s.nt = parsed.nt; s.meta = meta;
      s.dxM = metersPerTrace(meta);
      s.dtNs = meta.effective_rhf_rng / Math.max(s.nr - 1, 1);
      s.fileEps = meta.dielectric > 0 ? meta.dielectric : null;
      if (!s.eps) s.eps = s.fileEps || settings.defaultEps;
      s.picks = s.picks.filter(function (p) { return p.trace < s.nt && p.row < s.nr; });

      current = s; selected = -1; hover = null; prof = null; lastTrace = null; s.A = null;
      el.eps.value = s.eps;
      buildImage();
      fitView();
      if (pendingPick && pendingPick.key === s.key) selected = Math.min(pendingPick.index, s.picks.length - 1);
      pendingPick = null;
      saveScan(s, false); // keeps trace count and spacing for the map
      renderScanList();
      renderPicks();
      el.info.textContent = s.nt + ' traces × ' + s.nr + ' samples · ' +
        meta.effective_rhf_rng.toFixed(1) + ' ns · ' + meta.rh_bits + '-bit' +
        (s.dzx ? '' : ' · no DZX (dielectric assumed)');
      setStatus('');
      scheduleAnalysis();
      v3Refresh();
    }).catch(function (err) {
      if (seq !== loadSeq) return;
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
    [el.canvas, el.acanvas, el.spec].forEach(function (c) {
      var r = c.parentNode.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
    });
    specKey = '';
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
    if (!s || !s.data) { drawAnalysis(); return; }

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

    // analysis band
    if (settings.analysis) {
      var band = bandRows();
      ctx.setLineDash([6, 4]); ctx.strokeStyle = '#ff9f1c'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      [rToY(band[0]), rToY(band[1] + 1)].forEach(function (by) {
        ctx.moveTo(plot.x, by); ctx.lineTo(plot.x + plot.w, by);
      });
      ctx.stroke(); ctx.setLineDash([]);
    }

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
      if (hover.y !== null) { ctx.moveTo(plot.x, hover.y + 0.5); ctx.lineTo(plot.x + plot.w, hover.y + 0.5); }
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
    drawAnalysis();
  }

  // ----------------------------------------------------------- analysis panel

  /** Rows (inclusive) of the analysis band on the current scan. */
  function bandRows() {
    var s = current, r0, r1;
    if (settings.bandNs) {
      r0 = Math.round(settings.bandNs[0] / s.dtNs); r1 = Math.round(settings.bandNs[1] / s.dtNs);
    } else { r0 = Math.round(s.nr * 0.2); r1 = Math.round(s.nr * 0.6); }
    r0 = Math.max(0, Math.min(r0, s.nr - 4));
    r1 = Math.max(r0 + 3, Math.min(r1, s.nr - 1));
    return [r0, r1];
  }

  function bandEdgeAt(y) {
    var b = bandRows();
    if (Math.abs(y - rToY(b[0])) < 6) return 'top';
    if (Math.abs(y - rToY(b[1] + 1)) < 6) return 'bottom';
    return null;
  }

  /** Averaging half-width in analysed traces. */
  function smoothHalf() {
    var s = current;
    if (!s.dxM) return 2;
    return Math.min(400, Math.round(settings.smoothM / (s.dxM * s.A.step)));
  }

  function niceCeil(x) {
    var p = Math.pow(10, Math.floor(Math.log10(x))), f = x / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  function scheduleAnalysis() {
    var s = current;
    if (!settings.analysis || !s || !s.data) return;
    if (s.A) { updateProfile(); return; }
    setStatus('Computing analysis…');
    setTimeout(function () {
      if (current !== s || !s.data || !settings.analysis) return;
      if (!s.A) {
        s.A = prepareAnalysis(s.data, s.nr, s.nt);
        // frequency axis of the spectrum plot: from the scan's own content
        var nyq = 0.5 / s.dtNs;
        var sp = bandSpectrum(s.A, s.A.nt2 >> 1, 0, s.nr - 1, 32, s.dtNs);
        var c = spectralMoments(sp.power, sp.dfGhz, 0, nyq).centroid;
        s.A.fmax = Math.min(nyq, c > 0 ? niceCeil(2.5 * c) : nyq);
      }
      setStatus('');
      updateProfile();
    }, 20);
  }

  function updateBandText() {
    var s = current;
    if (!s || !s.data) { el.bandText.textContent = ''; return; }
    var b = bandRows(), u = settings.unit;
    el.bandText.textContent = 'Band ' + fmt(depthOfRow(s, b[0]), u) + ' to ' + fmt(depthOfRow(s, b[1]), u) + ' ' + u +
      ' (' + timeOfRow(s, b[0]).toFixed(2) + ' to ' + timeOfRow(s, b[1]).toFixed(2) +
      ' ns). Drag the dashed lines on the scan to move it.';
  }

  function updateProfile() {
    var s = current;
    updateBandText();
    if (!s || !s.A || !settings.analysis) { draw(); return; }
    var b = bandRows(), half = smoothHalf(), v;
    if (settings.profile === 'centroid') {
      v = centroidProfile(s.A, b[0], b[1], half, s.dtNs);
      prof = { values: v, label: 'Spectral centroid of the band (GHz)', unit: 'GHz', dec: 2, minSpan: 0.1 };
    } else {
      v = bandEnergyDb(s.A, b[0], b[1], half);
      var finite = Array.prototype.filter.call(v, isFinite).sort(function (a, c) { return a - c; });
      var med = finite.length ? finite[finite.length >> 1] : 0;
      for (var j = 0; j < v.length; j++) v[j] -= med;
      prof = { values: v, label: 'Band energy (dB relative to the scan median)', unit: 'dB', dec: 1, minSpan: 2 };
    }
    specKey = '';
    draw();
  }

  var profilePending = false;
  function requestProfile() {
    if (profilePending) return;
    profilePending = true;
    requestAnimationFrame(function () { profilePending = false; updateProfile(); });
  }

  function drawAnalysis() {
    if (!settings.analysis) return;
    var ctx = el.acanvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var W = el.acanvas.width / dpr, H = el.acanvas.height / dpr;
    ctx.fillStyle = cssVar('--gprv-panel');
    ctx.fillRect(0, 0, W, H);
    var s = current;
    if (!s || !s.data) { drawSpectrum(); return; }
    var ink = cssVar('--gprv-ink'), muted = cssVar('--gprv-muted'), line = cssVar('--gprv-line');
    var a = { y: 10, h: Math.max(20, H - 20) };
    ctx.font = '11px system-ui, sans-serif';
    if (!prof || !s.A) {
      ctx.strokeStyle = muted; ctx.lineWidth = 1;
      ctx.strokeRect(plot.x + 0.5, a.y + 0.5, plot.w, a.h);
      ctx.fillStyle = muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('Computing…', plot.x + 8, a.y + 6);
      drawSpectrum();
      return;
    }
    var step = s.A.step, v = prof.values, j;
    var ja = Math.max(0, Math.floor(view.t0 / step)), jb = Math.min(s.A.nt2 - 1, Math.ceil(view.t1 / step));
    var lo = Infinity, hi = -Infinity;
    for (j = ja; j <= jb; j++) if (isFinite(v[j])) { if (v[j] < lo) lo = v[j]; if (v[j] > hi) hi = v[j]; }
    if (lo <= hi) {
      var span = Math.max(hi - lo, prof.minSpan), mid = (hi + lo) / 2;
      lo = mid - span * 0.58; hi = mid + span * 0.58;
      var yOf = function (val) { return a.y + (hi - val) / (hi - lo) * a.h; };

      var ystep = niceStep(hi - lo, Math.max(2, a.h / 34));
      var ydec = Math.max(0, -Math.floor(Math.log10(ystep) + 1e-9));
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.lineWidth = 1;
      for (var t = Math.ceil(lo / ystep) * ystep; t <= hi; t += ystep) {
        var ty = Math.round(yOf(t)) + 0.5;
        ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(plot.x, ty); ctx.lineTo(plot.x + plot.w, ty); ctx.stroke();
        ctx.fillStyle = ink; ctx.fillText(t.toFixed(ydec), plot.x - 7, ty);
      }

      ctx.save();
      ctx.beginPath(); ctx.rect(plot.x, a.y, plot.w, a.h); ctx.clip();
      ctx.strokeStyle = cssVar('--gprv-accent'); ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
      ctx.beginPath();
      var pen = false;
      for (j = ja; j <= jb; j++) {
        if (!isFinite(v[j])) { pen = false; continue; }
        var x = tToX(j * step + 0.5), y = yOf(v[j]);
        if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        pen = true;
      }
      ctx.stroke();
      s.picks.forEach(function (p, i) {
        var pj = Math.min(s.A.nt2 - 1, Math.round(p.trace / step));
        if (!isFinite(v[pj])) return;
        ctx.beginPath(); ctx.arc(tToX(p.trace + 0.5), yOf(v[pj]), i === selected ? 5 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = i === selected ? '#ffd23f' : '#19d3da'; ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = '#102030'; ctx.stroke();
      });
      if (hover) {
        ctx.strokeStyle = 'rgba(200,140,0,0.9)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(hover.x + 0.5, a.y); ctx.lineTo(hover.x + 0.5, a.y + a.h); ctx.stroke();
      }
      ctx.restore();
    }
    ctx.strokeStyle = muted; ctx.lineWidth = 1;
    ctx.strokeRect(plot.x + 0.5, a.y + 0.5, plot.w, a.h);
    ctx.fillStyle = muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(prof.label, plot.x + 8, a.y + 6);
    drawSpectrum();
  }

  /** Spectrum of the band at the cursor, else the selected pick, else the last spot. */
  function drawSpectrum() {
    if (!settings.analysis) return;
    var s = current;
    var ctx = el.spec.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    var W = el.spec.width / dpr, H = el.spec.height / dpr;
    if (!s || !s.A) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = cssVar('--gprv-panel'); ctx.fillRect(0, 0, W, H);
      el.specText.textContent = ''; specKey = '';
      return;
    }
    var trace, where;
    if (hover) { trace = Math.floor(xToT(hover.x)); where = 'cursor'; lastTrace = trace; }
    else if (selected >= 0) { trace = s.picks[selected].trace; where = 'pick ' + (selected + 1); }
    else { trace = lastTrace === null ? Math.floor((view.t0 + view.t1) / 2) : lastTrace; where = ''; }
    trace = Math.max(0, Math.min(s.nt - 1, trace));
    var j = Math.min(s.A.nt2 - 1, Math.round(trace / s.A.step));
    var b = bandRows(), half = Math.min(25, smoothHalf());
    var key = [s.key, j, b[0], b[1], half, settings.unit, where].join('|');
    if (key === specKey) return;
    specKey = key;

    var sp = bandSpectrum(s.A, j, b[0], b[1], half, s.dtNs);
    var nyq = 0.5 / s.dtNs, fmax = s.A.fmax;
    var m = spectralMoments(sp.power, sp.dfGhz, MOMENT_BAND_GHZ[0], Math.min(MOMENT_BAND_GHZ[1], nyq));
    var nb = Math.min(sp.power.length - 1, Math.floor(fmax / sp.dfGhz)), i, peak = 0;
    for (i = 0; i <= nb; i++) if (sp.power[i] > peak) peak = sp.power[i];

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = cssVar('--gprv-panel'); ctx.fillRect(0, 0, W, H);
    var px = 8, py = 6, pw = W - 16, ph = H - 26;
    var accent = cssVar('--gprv-accent'), muted = cssVar('--gprv-muted'), ink = cssVar('--gprv-ink');
    var fx = function (f) { return px + f / fmax * pw; };
    if (peak > 0) {
      ctx.beginPath(); ctx.moveTo(px, py + ph);
      for (i = 0; i <= nb; i++) ctx.lineTo(fx(i * sp.dfGhz), py + ph - Math.sqrt(sp.power[i] / peak) * ph);
      ctx.lineTo(fx(nb * sp.dfGhz), py + ph); ctx.closePath();
      ctx.globalAlpha = 0.18; ctx.fillStyle = accent; ctx.fill(); ctx.globalAlpha = 1;
      ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.stroke();
    }
    if (isFinite(m.centroid) && m.centroid <= fmax) {
      ctx.setLineDash([4, 3]); ctx.strokeStyle = '#c47a00'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(fx(m.centroid), py); ctx.lineTo(fx(m.centroid), py + ph); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = muted; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, py + ph + 0.5); ctx.lineTo(px + pw, py + ph + 0.5); ctx.stroke();
    ctx.fillStyle = ink; ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'top';
    var fstep = niceStep(fmax, 4), fdec = Math.max(0, -Math.floor(Math.log10(fstep) + 1e-9));
    for (var f = 0; f <= fmax + fstep * 1e-6; f += fstep) {
      var last = f + fstep > fmax + fstep * 1e-6;
      ctx.textAlign = f === 0 ? 'left' : last ? 'right' : 'center';
      ctx.fillText(f.toFixed(fdec) + (last ? ' GHz' : ''), fx(f), py + ph + 4);
    }
    var du = distUnit(s);
    el.specText.textContent = 'Spectrum at ' + fmt(distOfTrace(s, trace), du) + ' ' + du + (where ? ' (' + where + ')' : '') +
      (isFinite(m.centroid) ? ': centroid ' + m.centroid.toFixed(2) + ' GHz, peak ' + m.peak.toFixed(2) +
        ' GHz, bandwidth ' + m.bandwidth.toFixed(2) + ' GHz' : ': no signal in the band');
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
      drag = { x: p.x, y: p.y, view: { t0: view.t0, t1: view.t1, r0: view.r0, r1: view.r1 }, moved: false, button: e.button,
        band: settings.analysis && e.button === 0 ? bandEdgeAt(p.y) : null };
      el.canvas.setPointerCapture(e.pointerId);
    });
    el.canvas.addEventListener('pointermove', function (e) {
      if (!current || !current.data) return;
      var p = pointerPos(e);
      if (drag && drag.band) {
        var b = bandRows(), br = Math.round(yToR(p.y));
        if (drag.band === 'top') b[0] = Math.max(0, Math.min(br, b[1] - 3));
        else b[1] = Math.min(current.nr - 1, Math.max(br - 1, b[0] + 3));
        settings.bandNs = [b[0] * current.dtNs, b[1] * current.dtNs];
        drag.moved = true; hover = null;
        requestProfile();
        return;
      }
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
      if (!inPlot(p)) { hover = null; el.readout.textContent = ''; el.canvas.style.cursor = ''; draw(); return; }
      el.canvas.style.cursor = settings.analysis && bandEdgeAt(p.y) ? 'ns-resize' : '';
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
      if (d.band) { saveSettings(); return; }
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

  function bindProfile() {
    function pos(e) {
      var rect = el.acanvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }
    el.acanvas.addEventListener('pointermove', function (e) {
      var s = current;
      if (!s || !s.data) return;
      var p = pos(e);
      if (p.x < plot.x || p.x > plot.x + plot.w) { hover = null; el.readout.textContent = ''; draw(); return; }
      hover = { x: p.x, y: null };
      var t = Math.min(s.nt - 1, Math.max(0, Math.floor(xToT(p.x))));
      var du = distUnit(s), text = 'Distance ' + fmt(distOfTrace(s, t), du) + ' ' + du;
      if (prof && s.A) {
        var val = prof.values[Math.min(s.A.nt2 - 1, Math.round(t / s.A.step))];
        if (isFinite(val)) text += '  ·  ' + val.toFixed(prof.dec) + ' ' + prof.unit;
      }
      el.readout.textContent = text;
      draw();
    });
    el.acanvas.addEventListener('pointerleave', function () { hover = null; el.readout.textContent = ''; draw(); });
    el.acanvas.addEventListener('wheel', function (e) {
      if (!current || !current.data) return;
      e.preventDefault();
      zoom(Math.exp((e.deltaY > 0 ? 1 : -1) * 0.2), pos(e).x, 0, false);
    }, { passive: false });
  }

  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      if (api && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (!current || tab !== 'scan') return;
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
    var rows = [['scan', 'pick', 'distance_' + u, 'depth_' + u, 't0_ns', 'dielectric', 'trace', 'row',
      'map_x_' + u, 'map_y_' + u]];
    scans.forEach(function (s) {
      if (!s.picks.length || !s.dtNs) return;
      s.picks.forEach(function (p, i) {
        rows.push([s.name, i + 1,
          s.dxM ? (p.trace * s.dxM / UNIT_M[u]).toFixed(4) : '',
          depthOfRow(s, p.row).toFixed(4), timeOfRow(s, p.row).toFixed(4), s.eps, p.trace, p.row,
          s.place && s.dxM ? ((s.place.xM + p.trace * s.dxM * DIR_UNIT[s.place.dir][0]) / UNIT_M[u]).toFixed(4) : '',
          s.place && s.dxM ? ((s.place.yM + p.trace * s.dxM * DIR_UNIT[s.place.dir][1]) / UNIT_M[u]).toFixed(4) : '']);
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

  // ------------------------------------------------------------------ map tab

  // Sequential ramp, light = shallow cover, dark = deep.
  var RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6',
    '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'].map(function (h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  });
  function rampColor(t) {
    t = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
    var i = Math.min(RAMP.length - 2, Math.floor(t)), f = t - i, a = RAMP[i], b = RAMP[i + 1];
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * f) + ',' + Math.round(a[1] + (b[1] - a[1]) * f) + ',' +
      Math.round(a[2] + (b[2] - a[2]) * f) + ')';
  }

  function setTab(t) {
    tab = t;
    el.scanView.hidden = t !== 'scan';
    el.mapView.hidden = t !== 'map';
    if (el.view3d) el.view3d.hidden = t !== '3d';
    el.tabScan.classList.toggle('is-current', t === 'scan');
    el.tabMap.classList.toggle('is-current', t === 'map');
    if (el.tab3d) el.tab3d.classList.toggle('is-current', t === '3d');
    if (t === 'map') { renderPlaceTable(); resizeMap(); ensureScanInfo(); }
    else if (t === '3d') { v3.hover = null; v3.hoverLine = null; v3Resize(true); ensureScanInfo(); }
    else resize();
  }

  /** Go to a pick on the Scan tab (from the map or the 3D view). */
  function openPick(s, index) {
    pendingPick = { key: s.key, index: index };
    setTab('scan');
    selectScan(s);
  }

  /** Readout line for a pick on the map or in 3D. */
  function pickText(p) {
    var U = UNIT_M[settings.unit], u = settings.unit;
    return p.s.name + ', pick ' + (p.i + 1) + '  ·  X ' + fmt(p.x / U, u) + '  ·  Y ' + fmt(p.y / U, u) +
      '  ·  Cover ' + fmt(p.cover / U, u) + ' ' + u;
  }

  /** The cover colour key, top-left corner at (lx, ly). `dom` = [min, max] cover in metres. */
  function drawCoverLegend(ctx, lx, ly, dom, colors) {
    var lw = 130, U = UNIT_M[settings.unit], u = settings.unit;
    ctx.fillStyle = colors.panel; ctx.strokeStyle = colors.line; ctx.lineWidth = 1;
    ctx.fillRect(lx - 8, ly - 4, lw + 16, 46); ctx.strokeRect(lx - 7.5, ly - 3.5, lw + 15, 45);
    ctx.fillStyle = colors.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('Cover (' + u + ')', lx, ly);
    for (var i = 0; i < lw; i++) { ctx.fillStyle = rampColor(i / (lw - 1)); ctx.fillRect(lx + i, ly + 15, 1.5, 9); }
    ctx.fillStyle = colors.ink;
    ctx.fillText(fmt(dom[0] / U, u), lx, ly + 27);
    ctx.textAlign = 'right'; ctx.fillText(fmt(dom[1] / U, u), lx + 130, ly + 27);
  }

  /** Scan lines and picks in map coordinates (metres). */
  function buildMapGeo() {
    var lines = [], pts = [];
    scans.forEach(function (s) {
      if (!s.place) return;
      var u = DIR_UNIT[s.place.dir];
      var len = s.dxM && s.nt ? s.nt * s.dxM : 0;
      lines.push({ s: s, x0: s.place.xM, y0: s.place.yM, x1: s.place.xM + len * u[0], y1: s.place.yM + len * u[1], u: u, len: len });
      if (!s.dxM || !s.dtNs || !s.eps) return;
      s.picks.forEach(function (p, i) {
        var d = p.trace * s.dxM;
        pts.push({ s: s, i: i, x: s.place.xM + d * u[0], y: s.place.yM + d * u[1], cover: depthMOfRow(s, p.row), u: u });
      });
    });
    mapGeo = { lines: lines, pts: pts };
  }

  function fitMap() {
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    function grow(x, y) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    mapGeo.lines.forEach(function (l) { grow(l.x0, l.y0); grow(l.x1, l.y1); });
    if (x0 > x1) { mapView.cx = 0; mapView.cy = 0; mapView.scale = mplot.w / 10; return; }
    var w = Math.max(x1 - x0, 0.5), h = Math.max(y1 - y0, 0.5);
    mapView.cx = (x0 + x1) / 2; mapView.cy = (y0 + y1) / 2;
    mapView.scale = Math.min(mplot.w / w, mplot.h / h) * 0.86;
  }

  function mx(x) { return mplot.x + mplot.w / 2 + (x - mapView.cx) * mapView.scale; }
  function my(y) { return mplot.y + mplot.h / 2 - (y - mapView.cy) * mapView.scale; }

  function resizeMap() {
    var rect = el.mapWrap.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    el.mapCanvas.width = Math.max(1, Math.round(rect.width * dpr));
    el.mapCanvas.height = Math.max(1, Math.round(rect.height * dpr));
    mplot.w = Math.max(50, rect.width - mplot.x - 14);
    mplot.h = Math.max(50, rect.height - mplot.y - 30);
    drawMap();
  }

  function coverDomain() {
    var lo = Infinity, hi = -Infinity;
    mapGeo.pts.forEach(function (p) { if (p.cover < lo) lo = p.cover; if (p.cover > hi) hi = p.cover; });
    if (lo > hi) return null;
    if (hi - lo < 1e-6) { lo -= 0.005; hi += 0.005; }
    return [lo, hi];
  }

  function drawMap() {
    if (tab !== 'map') return;
    buildMapGeo();
    if (mapView.fit) fitMap();
    var ctx = el.mapCanvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var W = el.mapCanvas.width / dpr, H = el.mapCanvas.height / dpr;
    var panel = cssVar('--gprv-panel'), ink = cssVar('--gprv-ink'), muted = cssVar('--gprv-muted'), line = cssVar('--gprv-line');
    ctx.fillStyle = panel; ctx.fillRect(0, 0, W, H);
    ctx.font = '11px system-ui, sans-serif';
    var U = UNIT_M[settings.unit], u = settings.unit;

    // grid and axes, in the display unit
    var halfW = mplot.w / 2 / mapView.scale / U, halfH = mplot.h / 2 / mapView.scale / U;
    var cxu = mapView.cx / U, cyu = mapView.cy / U;
    var step = niceStep(2 * halfW, Math.max(2, mplot.w / 90));
    var dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9)), v, pos;
    ctx.lineWidth = 1;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (v = Math.ceil((cxu - halfW) / step) * step; v <= cxu + halfW; v += step) {
      pos = Math.round(mx(v * U)) + 0.5;
      ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(pos, mplot.y); ctx.lineTo(pos, mplot.y + mplot.h); ctx.stroke();
      ctx.fillStyle = ink; ctx.fillText(v.toFixed(dec), pos, mplot.y + mplot.h + 5);
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (v = Math.ceil((cyu - halfH) / step) * step; v <= cyu + halfH; v += step) {
      pos = Math.round(my(v * U)) + 0.5;
      ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(mplot.x, pos); ctx.lineTo(mplot.x + mplot.w, pos); ctx.stroke();
      ctx.fillStyle = ink; ctx.fillText(v.toFixed(dec), mplot.x - 7, pos);
    }
    ctx.strokeStyle = muted; ctx.strokeRect(mplot.x + 0.5, mplot.y + 0.5, mplot.w, mplot.h);
    ctx.fillStyle = muted; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText('X and Y in ' + u, W - 14, mplot.y + mplot.h + 17);

    ctx.save();
    ctx.beginPath(); ctx.rect(mplot.x, mplot.y, mplot.w, mplot.h); ctx.clip();

    if (!mapGeo.lines.length) {
      ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '13px system-ui, sans-serif';
      ctx.fillText(scans.length ? 'Give a scan a start position, or import a positions CSV, to see its picks here.'
        : 'Open scans on the Scan tab first.', mplot.x + mplot.w / 2, mplot.y + mplot.h / 2);
    }

    // scan lines: origin dot, line, arrowhead, name
    mapGeo.lines.forEach(function (l) {
      var ax = mx(l.x0), ay = my(l.y0), bx = mx(l.x1), by = my(l.y1);
      var sx = l.u[0], sy = -l.u[1]; // screen direction (y is up on the map)
      ctx.strokeStyle = muted; ctx.fillStyle = muted; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.beginPath(); ctx.arc(ax, ay, 2.5, 0, Math.PI * 2); ctx.fill();
      if (l.len > 0) {
        ctx.beginPath();
        ctx.moveTo(bx + sx * 7, by + sy * 7);
        ctx.lineTo(bx - sy * 3.5, by + sx * 3.5); ctx.lineTo(bx + sy * 3.5, by - sx * 3.5);
        ctx.closePath(); ctx.fill();
      }
      if (l.len * mapView.scale > 70 || mapGeo.lines.length <= 12) {
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = sx < 0 ? 'right' : 'left'; ctx.textBaseline = sy ? 'middle' : 'bottom';
        ctx.fillText(l.s.name, ax + (sy ? 6 : sx * 4), ay - (sy ? sy * -4 : 4));
      }
    });

    // picks: a short bar across the scan line, coloured by cover
    var dom = coverDomain();
    ctx.lineCap = 'round';
    [[5, null], [3, 1]].forEach(function (pass) {
      mapGeo.pts.forEach(function (p) {
        var x = mx(p.x), y = my(p.y), nx = p.u[1] * 7, ny = p.u[0] * 7;
        ctx.lineWidth = pass[0];
        ctx.strokeStyle = pass[1] ? rampColor((p.cover - dom[0]) / (dom[1] - dom[0])) : 'rgba(16,32,48,0.55)';
        ctx.beginPath(); ctx.moveTo(x - nx, y - ny); ctx.lineTo(x + nx, y + ny); ctx.stroke();
      });
    });
    if (mapHover) {
      ctx.lineWidth = 2; ctx.strokeStyle = '#c47a00';
      ctx.beginPath(); ctx.arc(mx(mapHover.x), my(mapHover.y), 10, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();

    // legend
    if (dom) drawCoverLegend(ctx, mplot.x + mplot.w - 142, mplot.y + 10, dom, { panel: panel, line: line, muted: muted, ink: ink });

    var placed = mapGeo.lines.length;
    el.mapSummary.textContent = scans.length
      ? placed + ' of ' + scans.length + ' scans placed · ' + mapGeo.pts.length + ' picks on the map' : '';
  }

  function mapPickAt(x, y) {
    var best = null, bd = 12 * 12;
    mapGeo.pts.forEach(function (p) {
      var dx = mx(p.x) - x, dy = my(p.y) - y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = p; }
    });
    return best;
  }

  function bindMap() {
    var drag = null;
    function pos(e) {
      var rect = el.mapCanvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }
    el.mapCanvas.addEventListener('pointerdown', function (e) {
      var p = pos(e);
      drag = { x: p.x, y: p.y, cx: mapView.cx, cy: mapView.cy, moved: false };
      el.mapCanvas.setPointerCapture(e.pointerId);
    });
    el.mapCanvas.addEventListener('pointermove', function (e) {
      var p = pos(e), U = UNIT_M[settings.unit], u = settings.unit;
      if (drag) {
        var dx = p.x - drag.x, dy = p.y - drag.y;
        if (!drag.moved && dx * dx + dy * dy < 16) return;
        drag.moved = true; mapView.fit = false; mapHover = null;
        mapView.cx = drag.cx - dx / mapView.scale; mapView.cy = drag.cy + dy / mapView.scale;
        drawMap();
        return;
      }
      mapHover = mapPickAt(p.x, p.y);
      if (mapHover) {
        el.mapReadout.textContent = pickText(mapHover);
      } else {
        el.mapReadout.textContent = 'X ' + fmt((mapView.cx + (p.x - mplot.x - mplot.w / 2) / mapView.scale) / U, u) +
          '  ·  Y ' + fmt((mapView.cy - (p.y - mplot.y - mplot.h / 2) / mapView.scale) / U, u) + ' ' + u;
      }
      el.mapCanvas.style.cursor = mapHover ? 'pointer' : '';
      drawMap();
    });
    el.mapCanvas.addEventListener('pointerup', function (e) {
      var d = drag; drag = null;
      if (!d || d.moved) return;
      var hit = mapPickAt(d.x, d.y);
      if (!hit) return;
      mapHover = null;
      openPick(hit.s, hit.i);
    });
    el.mapCanvas.addEventListener('pointercancel', function () { drag = null; });
    el.mapCanvas.addEventListener('pointerleave', function () {
      if (drag) return;
      mapHover = null; el.mapReadout.textContent = ''; drawMap();
    });
    el.mapCanvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = pos(e), f = Math.exp((e.deltaY > 0 ? -1 : 1) * 0.2);
      var wx = mapView.cx + (p.x - mplot.x - mplot.w / 2) / mapView.scale;
      var wy = mapView.cy - (p.y - mplot.y - mplot.h / 2) / mapView.scale;
      mapView.scale = Math.max(0.5, Math.min(mapView.scale * f, 20000));
      mapView.cx = wx - (p.x - mplot.x - mplot.w / 2) / mapView.scale;
      mapView.cy = wy + (p.y - mplot.y - mplot.h / 2) / mapView.scale;
      mapView.fit = false;
      drawMap();
    }, { passive: false });
  }

  /** One editable row per scan: start X, start Y, direction. */
  function renderPlaceTable() {
    var U = UNIT_M[settings.unit];
    el.posUnit.textContent = settings.unit;
    el.placeBody.textContent = '';
    scans.forEach(function (s) {
      var tr = document.createElement('tr');
      function cell(child) {
        var td = document.createElement('td');
        if (typeof child === 'string') td.textContent = child; else td.appendChild(child);
        tr.appendChild(td);
        return td;
      }
      function coord(key, label) {
        var input = document.createElement('input');
        input.type = 'number'; input.step = 'any';
        input.setAttribute('aria-label', label + ' for ' + s.name);
        input.value = s.place ? +(s.place[key] / U).toFixed(4) : '';
        return input;
      }
      cell(s.name).className = 'gprv-name';
      var ix = coord('xM', 'Start X'), iy = coord('yM', 'Start Y');
      var sel = document.createElement('select');
      sel.setAttribute('aria-label', 'Direction for ' + s.name);
      ['+X', '-X', '+Y', '-Y'].forEach(function (d) {
        var o = document.createElement('option');
        o.value = d; o.textContent = d.replace('-', '\u2212');
        sel.appendChild(o);
      });
      sel.value = s.place ? s.place.dir : '+X';
      function commit() {
        var x = parseFloat(ix.value), y = parseFloat(iy.value);
        // a scan is placed once both coordinates are filled in; clearing both removes it
        if (isFinite(x) && isFinite(y)) s.place = { xM: x * UNIT_M[settings.unit], yM: y * UNIT_M[settings.unit], dir: sel.value };
        else if (ix.value === '' && iy.value === '') s.place = null;
        else return;
        saveScan(s);
        drawMap();
        ensureScanInfo();
      }
      [ix, iy, sel].forEach(function (c) { c.addEventListener('change', commit); });
      cell(ix); cell(iy); cell(sel); cell(s.picks.length ? String(s.picks.length) : '');
      el.placeBody.appendChild(tr);
    });
  }

  function importPositions(text) {
    var names = scans.map(function (s) { return s.name; });
    var pos, m;
    try { pos = readPositions(text); } catch (err) { el.mapStatus.textContent = err.message; return; }
    m = matchPositions(pos, names);
    var U = UNIT_M[settings.unit], byName = {};
    scans.forEach(function (s) { if (!(s.name in byName)) byName[s.name] = s; });
    m.pairs.forEach(function (pair) {
      var s = byName[pair[0]], rec = pair[1];
      s.place = { xM: rec.x * U, yM: rec.y * U, dir: rec.dir };
      saveScan(s);
    });
    var msg = 'Placed ' + m.pairs.length + ' scan' + (m.pairs.length === 1 ? '' : 's') + ' (values read as ' + settings.unit + ').';
    if (!pos.hasScan) msg += ' The CSV has no scan column, so rows were paired with the scans in list order.';
    if (m.unmatchedRows.length) {
      msg += ' ' + m.unmatchedRows.length + ' row' + (m.unmatchedRows.length === 1 ? '' : 's') +
        ' matched no open scan (row ' + m.unmatchedRows.slice(0, 8).join(', ') + (m.unmatchedRows.length > 8 ? ', …' : '') + ').';
    }
    if (m.unplaced.length) msg += ' ' + m.unplaced.length + ' open scan' + (m.unplaced.length === 1 ? ' has' : 's have') + ' no row.';
    el.mapStatus.textContent = msg;
    mapView.fit = true; v3.fit = true;
    renderPlaceTable();
    drawMap();
    ensureScanInfo();
  }

  function exportPositions() {
    var U = UNIT_M[settings.unit];
    var rows = [['Scan', 'Origin X', 'Origin Y', 'Direction']];
    scans.forEach(function (s) {
      if (s.place) rows.push([s.name, +(s.place.xM / U).toFixed(4), +(s.place.yM / U).toFixed(4), s.place.dir]);
    });
    if (rows.length === 1) { el.mapStatus.textContent = 'No scan has a position yet.'; return; }
    download('gpr_scan_positions.csv', rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n', 'text/csv');
  }

  // ------------------------------------------------------------------- 3D tab
  // A rotatable view of the picks, each at its map position and cover depth.
  // It is drawn on an ordinary 2D canvas with an orthographic camera: no WebGL
  // and no library. The camera is two angles. Azimuth turns the view around
  // the vertical, elevation tilts it; elevation 90 looks straight down and
  // matches the Map tab (X right, Y up). Depth is always drawn downward.
  //
  // The section stands on its own: it takes the scene from buildMapGeo() and
  // the rest of the file reaches it only through v3Refresh() and v3Resize().

  /** Camera axes for an azimuth and elevation in degrees: R points screen
   *  right, U screen up, V toward the viewer. */
  function v3Basis(azDeg, elDeg) {
    var a = azDeg * Math.PI / 180, e = elDeg * Math.PI / 180;
    var ca = Math.cos(a), sa = Math.sin(a), ce = Math.cos(e), se = Math.sin(e);
    return { R: [ca, sa, 0], U: [-sa * se, ca * se, ce], V: [sa * ce, -ca * ce, se] };
  }

  /** World point (metres, z up) -> { x, y } on screen, and d = how far toward the viewer. */
  function v3Proj(cam, x, y, z) {
    var dx = x - cam.cx, dy = y - cam.cy, dz = z - cam.cz, B = cam.B;
    return {
      x: cam.ox + cam.scale * (dx * B.R[0] + dy * B.R[1]),
      y: cam.oy - cam.scale * (dx * B.U[0] + dy * B.U[1] + dz * B.U[2]),
      d: dx * B.V[0] + dy * B.V[1] + dz * B.V[2]
    };
  }

  /** Automatic depth exaggeration: the largest round factor that keeps the
   *  depth box under about 30 % of the plan size, and never more than 10. */
  function v3AutoZ(planM, depthM) {
    var steps = [1, 2, 3, 5, 8, 10], target = 0.3 * planM / depthM, z = 1;
    for (var i = 0; i < steps.length; i++) if (steps[i] <= target) z = steps[i];
    return z;
  }

  /** Depth of the box and its tick step for a deepest cover `coverU`, all in
   *  the display unit: a whole number of ticks that clears the picks. */
  function v3DepthBox(coverU) {
    var raw = coverU * 1.15, step = niceStep(raw, 5);
    return { depth: Math.ceil(raw / step - 1e-9) * step, step: step };
  }

  var V3_HOME = { az: -35, el: 28 };
  var V3_Z_STEPS = [1, 2, 3, 5, 8, 10, 15, 20];
  var v3 = {
    az: V3_HOME.az, el: V3_HOME.el, cx: 0, cy: 0, cz: 0, scale: 100, fit: true,
    w: 100, h: 100,        // canvas size in CSS px
    geo: null,             // scene, rebuilt by v3Refresh
    hits: [], segs: [],    // screen positions of picks and scan lines from the last frame
    hover: null, hoverLine: null, lastMs: 0
  };
  var v3Pending = false, infoBusy = false;

  /** Trace count, spacing and time step from a scan's header alone, so the map
   *  and 3D views know how long a scan is before it has ever been displayed. */
  function loadScanInfo(s) {
    s.infoTried = true;
    return Promise.all([s.dzt.slice(0, 1024).arrayBuffer(), s.dzx ? s.dzx.text() : Promise.resolve('')]).then(function (res) {
      if (res[0].byteLength < 1024) return;
      var L = dztLayout(new DataView(res[0]), s.dzt.size), meta = L.meta;
      var x = res[1] ? parseDZX(res[1]) : {};
      Object.keys(x).forEach(function (k) { meta[k] = x[k]; });
      if (!s.nt) s.nt = L.nt;
      if (!s.dxM) s.dxM = metersPerTrace(meta);
      if (!s.dtNs) s.dtNs = meta.effective_rhf_rng / Math.max(L.nr - 1, 1);
      // only a dielectric the file states: a default set here would stop a DZX added later from being used
      if (!s.eps && meta.dielectric > 0) s.eps = meta.dielectric;
    }).catch(function () { /* unreadable header: the scan stays a dot until it is opened */ });
  }

  /** Read the headers of placed scans whose length is not known yet, then redraw. */
  function ensureScanInfo() {
    if (infoBusy || tab === 'scan') return;
    var todo = scans.filter(function (s) { return s.dzt && s.place && !s.infoTried && !(s.nt && s.dxM && s.dtNs); });
    if (!todo.length) return;
    infoBusy = true;
    todo.reduce(function (chain, s) { return chain.then(function () { return loadScanInfo(s); }); }, Promise.resolve())
      .then(function () {
        infoBusy = false;
        if (tab === 'map') drawMap();
        v3Refresh();
        ensureScanInfo(); // scans placed while these were being read
      });
  }

  function v3Zs() { return settings.zScale || (v3.geo ? v3.geo.autoZ : 1); }

  function v3Cam() {
    return { B: v3Basis(v3.az, v3.el), cx: v3.cx, cy: v3.cy, cz: v3.cz, scale: v3.scale, ox: v3.w / 2, oy: v3.h / 2 - 10 };
  }

  /** Build the scene: scan lines, picks with their colours, the box around them. */
  function v3BuildGeo() {
    buildMapGeo();
    var lines = mapGeo.lines, pts = mapGeo.pts, U = UNIT_M[settings.unit];
    if (!lines.length) { v3.geo = null; return; }
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    lines.forEach(function (l) {
      x0 = Math.min(x0, l.x0, l.x1); x1 = Math.max(x1, l.x0, l.x1);
      y0 = Math.min(y0, l.y0, l.y1); y1 = Math.max(y1, l.y0, l.y1);
    });
    // a single scan, or scans all in one line, still get a box with some width
    var size = Math.max(x1 - x0, y1 - y0, 0.3), minSide = 0.15 * size, mid;
    if (x1 - x0 < minSide) { mid = (x0 + x1) / 2; x0 = mid - minSide / 2; x1 = mid + minSide / 2; }
    if (y1 - y0 < minSide) { mid = (y0 + y1) / 2; y0 = mid - minSide / 2; y1 = mid + minSide / 2; }
    var pad = 0.04 * size;
    x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;

    // depth of the box from the 98th percentile cover, so one stray pick does not flatten the view
    var covers = pts.map(function (p) { return p.cover; }).sort(function (a, b) { return a - b; });
    var deep = covers.length ? covers[Math.ceil(0.98 * (covers.length - 1))] : 0.127;
    var box = v3DepthBox(Math.max(deep, 0.005) / U);

    var dom = coverDomain();
    pts.forEach(function (p) { p.color = dom ? rampColor((p.cover - dom[0]) / (dom[1] - dom[0])) : '#3987e5'; });

    // pick sticks: about 4 in long, shorter where the scan lines are close together
    function medianGap(vals) {
      var gaps = [], i;
      vals.sort(function (a, b) { return a - b; });
      for (i = 1; i < vals.length; i++) if (vals[i] - vals[i - 1] > 1e-4) gaps.push(vals[i] - vals[i - 1]);
      gaps.sort(function (a, b) { return a - b; });
      return gaps.length ? gaps[gaps.length >> 1] : Infinity;
    }
    var gap = Math.min(
      medianGap(lines.filter(function (l) { return l.u[1] === 0; }).map(function (l) { return l.y0; })),
      medianGap(lines.filter(function (l) { return l.u[0] === 0; }).map(function (l) { return l.x0; })));

    v3.geo = {
      lines: lines, pts: pts, x0: x0, x1: x1, y0: y0, y1: y1, dom: dom,
      D: box.depth * U, depthU: box.depth, stepU: box.step,
      autoZ: v3AutoZ(Math.max(x1 - x0, y1 - y0), box.depth * U),
      halfM: Math.min(0.05, 0.4 * gap)
    };
  }

  /** Centre the box and scale it to fill the canvas at the current angle. */
  function v3FitBox() {
    var g = v3.geo, zs = v3Zs(), B = v3Basis(v3.az, v3.el);
    var hx = (g.x1 - g.x0) / 2, hy = (g.y1 - g.y0) / 2, hz = g.D * zs / 2;
    v3.cx = (g.x0 + g.x1) / 2; v3.cy = (g.y0 + g.y1) / 2; v3.cz = -hz;
    var extR = 2 * (Math.abs(B.R[0]) * hx + Math.abs(B.R[1]) * hy);
    var extU = 2 * (Math.abs(B.U[0]) * hx + Math.abs(B.U[1]) * hy + Math.abs(B.U[2]) * hz);
    // room is left around the box for the depth, X and Y labels
    v3.scale = Math.max(1, Math.min((v3.w - 170) / Math.max(extR, 1e-6), (v3.h - 130) / Math.max(extU, 1e-6)));
  }

  /** The current scan's radargram, hung under its scan line. Under an
   *  orthographic camera a vertical plane is an exact affine image transform. */
  function v3DrawCurtain(ctx, cam, s, zs, D, dpr) {
    var u = DIR_UNIT[s.place.dir], B = cam.B;
    var k = depthMOfRow(s, 1); // metres of depth per sample row
    if (!(k > 0)) return;
    var rows = Math.min(s.nr, Math.ceil(D / k + 0.5));
    // image pixel (t, r) covers distance (t - 0.5) * dxM and depth (r - 0.5) * k, as on the Scan tab
    var a = v3Proj(cam, s.place.xM - 0.5 * s.dxM * u[0], s.place.yM - 0.5 * s.dxM * u[1], 0.5 * k * zs);
    var ex = cam.scale * s.dxM * (u[0] * B.R[0] + u[1] * B.R[1]);
    var ey = -cam.scale * s.dxM * (u[0] * B.U[0] + u[1] * B.U[1]);
    var fy = cam.scale * k * zs * B.U[2];
    if (Math.sqrt(ex * ex + ey * ey) * s.nt < 2 || fy * rows < 2) return; // seen edge-on
    ctx.save();
    ctx.setTransform(dpr * ex, dpr * ey, 0, dpr * fy, dpr * a.x, dpr * a.y);
    ctx.beginPath(); ctx.rect(0, 0, s.nt, Math.min(rows, D / k + 0.5)); ctx.clip();
    ctx.globalAlpha = 0.85; ctx.imageSmoothingEnabled = true;
    tiles.forEach(function (tile) { ctx.drawImage(tile.canvas, 0, 0, tile.w, rows, tile.x0, 0, tile.w, rows); });
    ctx.restore();
  }

  function v3Draw() {
    if (tab !== '3d' || !el.v3Canvas) return;
    var started = performance.now();
    var ctx = el.v3Canvas.getContext('2d'), dpr = el.v3Canvas.width / v3.w;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var W = v3.w, H = v3.h, g = v3.geo, k, i;
    var col = { panel: cssVar('--gprv-panel'), ink: cssVar('--gprv-ink'), muted: cssVar('--gprv-muted'),
      line: cssVar('--gprv-line'), accent: cssVar('--gprv-accent') };
    ctx.fillStyle = col.panel; ctx.fillRect(0, 0, W, H);
    v3.hits = []; v3.segs = [];
    if (!g) {
      ctx.fillStyle = col.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '13px system-ui, sans-serif';
      ctx.fillText(scans.length ? 'Give the scans a start position on the Map tab to see their picks here.'
        : 'Open scans on the Scan tab first.', W / 2, H / 2);
      return;
    }
    if (v3.fit) v3FitBox();
    var cam = v3Cam(), B = cam.B, zs = v3Zs(), Dz = g.D * zs, U = UNIT_M[settings.unit], u = settings.unit;
    function P(x, y, z) { return v3Proj(cam, x, y, z); }
    function seg(a, b) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    ctx.font = '11px system-ui, sans-serif';

    // the two walls facing away from the viewer; "near" is the opposite side
    var xf = B.V[0] > 1e-9 ? g.x0 : g.x1, xn = xf === g.x0 ? g.x1 : g.x0;
    var yf = B.V[1] > 1e-9 ? g.y0 : g.y1, yn = yf === g.y0 ? g.y1 : g.y0;
    var boxH = cam.scale * Dz * B.U[2]; // height of the depth box on screen

    // back walls: a line at each depth tick, so depth can be read off behind the picks
    if (settings.v3Grid) {
      ctx.strokeStyle = col.line; ctx.lineWidth = 1;
      ctx.beginPath();
      for (k = 0; k * g.stepU <= g.depthU + 1e-9; k++) {
        var zk = -k * g.stepU * U * zs;
        seg(P(xf, g.y0, zk), P(xf, g.y1, zk));
        seg(P(g.x0, yf, zk), P(g.x1, yf, zk));
      }
      [[xf, yf], [xf, yn], [xn, yf]].forEach(function (c) { seg(P(c[0], c[1], 0), P(c[0], c[1], -Dz)); });
      seg(P(g.x0, yn, -Dz), P(g.x1, yn, -Dz));
      seg(P(xn, g.y0, -Dz), P(xn, g.y1, -Dz));
      ctx.stroke();
    }

    // the scanned surface
    var corners = [P(g.x0, g.y0, 0), P(g.x1, g.y0, 0), P(g.x1, g.y1, 0), P(g.x0, g.y1, 0)];
    ctx.beginPath();
    corners.forEach(function (c, n) { if (n) ctx.lineTo(c.x, c.y); else ctx.moveTo(c.x, c.y); });
    ctx.closePath();
    ctx.globalAlpha = 0.06; ctx.fillStyle = col.accent; ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = col.muted; ctx.lineWidth = 1; ctx.stroke();

    // picks, far ones first
    var items = g.pts.map(function (p) {
      var z = -p.cover * zs;
      return { p: p, z: z, c: P(p.x, p.y, z) };
    });
    items.sort(function (a, b) { return a.c.d - b.c.d; });

    function drawDrops(list) { // a line from each pick up to the surface
      if (!settings.v3Drops) return;
      ctx.strokeStyle = col.muted; ctx.globalAlpha = 0.45; ctx.lineWidth = 1; ctx.lineCap = 'butt';
      ctx.beginPath();
      list.forEach(function (it) { ctx.moveTo(it.c.x, it.c.y); ctx.lineTo(it.c.x, it.c.y + cam.scale * it.z * B.U[2]); });
      ctx.stroke(); ctx.globalAlpha = 1; ctx.lineCap = 'round';
    }

    var half = Math.max(g.halfM, 5 / cam.scale);
    ctx.lineCap = 'round';
    function drawItem(it) {
      var p = it.p, hx = p.u[1] * half, hy = p.u[0] * half; // a short bar across the scan line
      var a = P(p.x - hx, p.y - hy, it.z), b = P(p.x + hx, p.y + hy, it.z);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(16,32,48,0.55)'; ctx.stroke();
      ctx.lineWidth = 3; ctx.strokeStyle = p.color; ctx.stroke();
      if (Math.abs(b.x - a.x) + Math.abs(b.y - a.y) < 7) { // seen end-on: a dot keeps it visible
        ctx.beginPath(); ctx.arc(it.c.x, it.c.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = p.color; ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(16,32,48,0.55)'; ctx.stroke();
      }
      v3.hits.push({ p: p, x: it.c.x, y: it.c.y, d: it.c.d });
    }
    var cur = settings.v3Radar && current && current.data && current.place && current.dxM && tiles.length ? current : null;
    if (cur) {
      // one vertical plane: draw what is behind it, then the radargram, then what is in front
      var cu = DIR_UNIT[cur.place.dir], nx = -cu[1], ny = cu[0], facing = B.V[0] * nx + B.V[1] * ny;
      var behind = function (p) {
        return p.s !== cur && ((p.x - cur.place.xM) * nx + (p.y - cur.place.yM) * ny) * facing < 0;
      };
      var back = items.filter(function (it) { return behind(it.p); });
      var front = items.filter(function (it) { return !behind(it.p); });
      drawDrops(back); back.forEach(drawItem);
      v3DrawCurtain(ctx, cam, cur, zs, g.D, dpr);
      drawDrops(front); front.forEach(drawItem);
    } else { drawDrops(items); items.forEach(drawItem); }
    ctx.lineCap = 'butt';

    // scan lines on the surface
    var many = g.lines.length > 12, names = [];
    g.lines.forEach(function (l) {
      var a = P(l.x0, l.y0, 0), b = P(l.x1, l.y1, 0);
      var strong = l.s === current || l === v3.hoverLine || (v3.hover && v3.hover.s === l.s);
      var color = l.s === current ? col.accent : col.muted;
      ctx.strokeStyle = ctx.fillStyle = color;
      ctx.globalAlpha = strong ? 1 : 0.7; ctx.lineWidth = strong ? 2 : 1;
      ctx.beginPath(); seg(a, b); ctx.stroke();
      ctx.beginPath(); ctx.arc(a.x, a.y, 2.5, 0, Math.PI * 2); ctx.fill();
      var dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy);
      if (len > 12) { dx /= len; dy /= len; } else { dx = 1; dy = 0; }
      if (len > 12 && (!many || strong)) {
        ctx.beginPath();
        ctx.moveTo(b.x + dx * 7, b.y + dy * 7);
        ctx.lineTo(b.x - dy * 3.5, b.y + dx * 3.5); ctx.lineTo(b.x + dy * 3.5, b.y - dx * 3.5);
        ctx.closePath(); ctx.fill();
      }
      if (!many || strong) names.push({ text: l.s.name, strong: strong, color: color, x: a.x, y: a.y, dx: dx, dy: dy });
      v3.segs.push({ l: l, ax: a.x, ay: a.y, bx: b.x, by: b.y });
    });
    // names sit just above the start of each line; one that would land on another is left out
    // (the current and hovered scans go first, so theirs always show)
    var taken = [];
    names.sort(function (a, b) { return (b.strong ? 1 : 0) - (a.strong ? 1 : 0); });
    names.forEach(function (n) {
      var w = ctx.measureText(n.text).width, steep = Math.abs(n.dx) < 0.35;
      var x = steep ? n.x + 7 : n.x + n.dx * 8 - (n.dx < 0 ? w : 0), y = steep ? n.y + n.dy * 14 + 4 : n.y - 5;
      var box = { x0: x - 3, x1: x + w + 3, y0: y - 12, y1: y + 2 };
      if (taken.some(function (t) { return box.x0 < t.x1 && box.x1 > t.x0 && box.y0 < t.y1 && box.y1 > t.y0; })) return;
      taken.push(box);
      ctx.globalAlpha = n.strong ? 1 : 0.8; ctx.fillStyle = n.color; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(n.text, x, y);
    });
    ctx.globalAlpha = 1; ctx.lineWidth = 1;

    if (settings.v3Grid) {
      // depth scale on the left-hand upright of the box, in true units
      if (boxH >= 40) {
        var e1 = P(xf, yn, 0), e2 = P(xn, yf, 0);
        var ex = e1.x <= e2.x ? xf : xn, ey = e1.x <= e2.x ? yn : yf;
        var every = Math.max(1, Math.ceil(14 / (boxH * g.stepU / g.depthU)));
        var zdec = Math.max(0, -Math.floor(Math.log10(g.stepU) + 1e-9));
        ctx.strokeStyle = col.muted; ctx.fillStyle = col.ink; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.beginPath();
        for (k = 0; k * g.stepU <= g.depthU + 1e-9; k += every) {
          var q = P(ex, ey, -k * g.stepU * U * zs);
          ctx.moveTo(q.x - 4, q.y); ctx.lineTo(q.x, q.y);
          ctx.fillText((k * g.stepU).toFixed(zdec), q.x - 7, q.y);
        }
        ctx.stroke();
        var top = P(ex, ey, 0);
        ctx.fillStyle = col.muted; ctx.textBaseline = 'bottom';
        var title = 'Depth (' + u + ')' + (zs !== 1 ? ', drawn ×' + zs : '');
        ctx.fillText(title, Math.max(top.x - 7, ctx.measureText(title).width + 6), top.y - 9); // kept on the canvas
      }
      // X and Y along the near bottom edges, where the labels fall outside the box
      [true, false].forEach(function (alongX) {
        var a = alongX ? P(g.x0, yn, -Dz) : P(xn, g.y0, -Dz), b = alongX ? P(g.x1, yn, -Dz) : P(xn, g.y1, -Dz);
        var len = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
        if (len < 60) return; // this edge is seen end-on
        var sgn = alongX ? (yn > yf ? 1 : -1) : (xn > xf ? 1 : -1);
        var ox = sgn * (alongX ? B.R[1] : B.R[0]), oy = -sgn * (alongX ? B.U[1] : B.U[0]) + 0.8 * B.U[2];
        var on = Math.sqrt(ox * ox + oy * oy) || 1;
        ox /= on; oy /= on;
        // when zoomed in, only the stretch of the edge that is on the canvas gets ticks
        var t0 = 0, t1 = 1, ddx = b.x - a.x, ddy = b.y - a.y;
        [[-ddx, a.x + 40], [ddx, W + 40 - a.x], [-ddy, a.y + 40], [ddy, H + 40 - a.y]].forEach(function (c) {
          if (c[0] === 0) { if (c[1] < 0) t1 = -1; return; }
          var t = c[1] / c[0];
          if (c[0] < 0) { if (t > t0) t0 = t; } else if (t < t1) t1 = t;
        });
        if (t1 <= t0) return; // none of it is in view
        var e0 = (alongX ? g.x0 : g.y0) / U, e1 = (alongX ? g.x1 : g.y1) / U;
        var lo = e0 + (e1 - e0) * t0, hi = e0 + (e1 - e0) * t1;
        var step = niceStep(hi - lo, Math.max(2, len * (t1 - t0) / 70)), dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
        var wide = 0;
        ctx.strokeStyle = col.muted; ctx.fillStyle = col.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.beginPath();
        for (var v = Math.ceil(lo / step - 1e-9) * step, n = 0; v <= hi + step * 1e-6 && n < 60; v += step, n++) {
          var q = alongX ? P(v * U, yn, -Dz) : P(xn, v * U, -Dz);
          ctx.moveTo(q.x, q.y); ctx.lineTo(q.x + ox * 4, q.y + oy * 4);
          ctx.fillText(v.toFixed(dec), q.x + ox * 16, q.y + oy * 13);
          wide = Math.max(wide, ctx.measureText(v.toFixed(dec)).width);
        }
        ctx.stroke();
        var m = alongX ? P((lo + hi) / 2 * U, yn, -Dz) : P(xn, (lo + hi) / 2 * U, -Dz);
        ctx.fillStyle = col.muted;
        // the title clears the widest number
        ctx.fillText((alongX ? 'X' : 'Y') + ' (' + u + ')', m.x + ox * (26 + wide), m.y + oy * 30);
      });
    }

    if (g.dom) drawCoverLegend(ctx, W - 150, 14, g.dom, col);

    if (v3.hover) {
      for (i = 0; i < v3.hits.length; i++) {
        if (v3.hits[i].p !== v3.hover) continue;
        ctx.lineWidth = 2; ctx.strokeStyle = '#c47a00';
        ctx.beginPath(); ctx.arc(v3.hits[i].x, v3.hits[i].y, 10, 0, Math.PI * 2); ctx.stroke();
        break;
      }
    }
    v3.lastMs = performance.now() - started;
  }

  function v3Request() {
    if (v3Pending) return;
    v3Pending = true;
    requestAnimationFrame(function () { v3Pending = false; v3Draw(); });
  }

  /** Rebuild the scene from the scans and redraw. Does nothing off the 3D tab. */
  function v3Refresh() {
    if (tab !== '3d' || !el.v3Canvas) return;
    var had = !!v3.geo;
    v3BuildGeo();
    if (!had) v3.fit = true; // the first scene is always fitted
    v3.hover = null; v3.hoverLine = null;
    var g = v3.geo, total = 0;
    scans.forEach(function (s) { total += s.picks.length; });
    var shown = g ? g.pts.length : 0;
    var text = scans.length ? (g ? g.lines.length : 0) + ' of ' + scans.length + ' scans placed · ' + shown + ' picks shown' : '';
    if (total > shown) text += ' · ' + (total - shown) + ' not shown (their scans have no position yet)';
    el.v3Summary.textContent = text;
    if (el.v3Z.options.length) el.v3Z.options[0].textContent = 'Auto' + (g ? ' (×' + g.autoZ + ')' : '');
    v3Request();
  }

  /** Size the canvas to its box. `rebuild` true (on entering the tab) also rebuilds the scene. */
  function v3Resize(rebuild) {
    if (tab !== '3d' || !el.v3Canvas) return;
    var rect = el.v3Wrap.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (rect.width < 2 || rect.height < 2) return; // the tab is hidden
    var w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
    var same = el.v3Canvas.width === w && el.v3Canvas.height === h;
    if (!same) { el.v3Canvas.width = w; el.v3Canvas.height = h; } // setting the size clears the canvas
    v3.w = rect.width; v3.h = rect.height;
    if (rebuild === true) v3Refresh();
    if (rebuild === true || !same) v3Draw(); // at once, so no blank frame while a window edge is dragged
  }

  /** Pick under the cursor: the nearest within 12 px; of two about equally near, the one in front. */
  function v3PickAt(x, y) {
    var dmin = 12.0001, best = null;
    function dist(h) { return Math.sqrt((h.x - x) * (h.x - x) + (h.y - y) * (h.y - y)); }
    v3.hits.forEach(function (h) { var d = dist(h); if (d < dmin) dmin = d; });
    v3.hits.forEach(function (h) {
      if (dist(h) <= Math.min(12, dmin + 3) && (!best || h.d > best.d)) best = h;
    });
    return best;
  }

  /** Scan line within 6 px of the cursor. */
  function v3LineAt(x, y) {
    var best = null, bd = 6;
    v3.segs.forEach(function (s) {
      var dx = s.bx - s.ax, dy = s.by - s.ay, L2 = dx * dx + dy * dy;
      var t = L2 > 0 ? Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / L2)) : 0;
      var px = s.ax + t * dx - x, py = s.ay + t * dy - y, d = Math.sqrt(px * px + py * py);
      if (d < bd) { bd = d; best = s.l; }
    });
    return best;
  }

  function bind3d() {
    var c = el.v3Canvas, drag = null;
    function pos(e) {
      var rect = c.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }
    function setHover(pick, line, text) {
      var changed = pick !== v3.hover || line !== v3.hoverLine;
      v3.hover = pick; v3.hoverLine = line;
      el.v3Readout.textContent = text;
      c.style.cursor = pick || line ? 'pointer' : '';
      if (changed) v3Request(); // not on every mouse move
    }
    function keep() { storeSet('settings', settings); } // these are per-browser, not project settings

    c.addEventListener('pointerdown', function (e) {
      if (!v3.geo) return;
      if (e.button === 1) e.preventDefault(); // no auto-scroll on a middle-drag
      var p = pos(e);
      drag = { x: p.x, y: p.y, az: v3.az, el: v3.el, cx: v3.cx, cy: v3.cy, cz: v3.cz, moved: false,
        pan: e.shiftKey || e.button !== 0, button: e.button };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', function (e) {
      var p = pos(e);
      if (drag) {
        var dx = p.x - drag.x, dy = p.y - drag.y;
        if (!drag.moved && dx * dx + dy * dy < 16) return;
        drag.moved = true;
        setHover(null, null, '');
        c.classList.add('is-dragging');
        if (drag.pan) {
          var B = v3Basis(v3.az, v3.el), k = 1 / v3.scale;
          v3.fit = false;
          v3.cx = drag.cx - dx * k * B.R[0] + dy * k * B.U[0];
          v3.cy = drag.cy - dx * k * B.R[1] + dy * k * B.U[1];
          v3.cz = drag.cz + dy * k * B.U[2];
        } else {
          v3.az = drag.az - dx * 0.4;
          v3.el = Math.max(0, Math.min(90, drag.el + dy * 0.4)); // never from under the slab
        }
        v3Request();
        return;
      }
      if (!v3.geo) return;
      var hit = v3PickAt(p.x, p.y), line = hit ? null : v3LineAt(p.x, p.y);
      setHover(hit ? hit.p : null, line, hit ? pickText(hit.p)
        : line ? line.s.name + '  ·  ' + plural(line.s.picks.length, 'pick') +
          (line.s === current ? '  ·  the current scan' : line.s.dzt ? '  ·  click to make it the current scan' : '')
        : '');
    });
    c.addEventListener('pointerup', function () {
      var d = drag;
      drag = null; c.classList.remove('is-dragging');
      if (!d || d.moved || d.button !== 0) return;
      var hit = v3PickAt(d.x, d.y);
      if (hit) { v3.hover = null; openPick(hit.p.s, hit.p.i); return; }
      var line = v3LineAt(d.x, d.y);
      if (!line || line.s === current) return;
      if (!line.s.dzt) { el.v3Readout.textContent = line.s.name + ' is saved in this project, but its file is not open here.'; return; }
      selectScan(line.s); // stays on this tab; the view redraws when the scan has loaded
    });
    c.addEventListener('pointercancel', function () { drag = null; c.classList.remove('is-dragging'); });
    c.addEventListener('pointerleave', function () { if (!drag) setHover(null, null, ''); });
    c.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    c.addEventListener('wheel', function (e) {
      if (!v3.geo) return;
      e.preventDefault();
      var p = pos(e), cam = v3Cam(), B = cam.B;
      var turn = Math.max(-100, Math.min(100, e.deltaMode ? e.deltaY * 100 : e.deltaY)); // one mouse notch is about 100
      var s0 = v3.scale, s1 = Math.max(2, Math.min(s0 * Math.exp(-turn * 0.002), 200000));
      // keep the point under the cursor where it is
      var px = p.x - cam.ox, py = cam.oy - p.y, kx = px / s0 - px / s1, ky = py / s0 - py / s1;
      v3.cx += kx * B.R[0] + ky * B.U[0]; v3.cy += kx * B.R[1] + ky * B.U[1]; v3.cz += ky * B.U[2];
      v3.scale = s1; v3.fit = false;
      v3Request();
    }, { passive: false });

    function view(az, elev) { v3.az = az; v3.el = elev; v3.fit = true; v3Request(); }
    el.tab3d.addEventListener('click', function () { setTab('3d'); });
    $('gprv-v3Reset').addEventListener('click', function () { view(V3_HOME.az, V3_HOME.el); });
    $('gprv-v3Fit').addEventListener('click', function () { v3.fit = true; v3Request(); });
    $('gprv-v3Top').addEventListener('click', function () { view(0, 90); });
    $('gprv-v3Front').addEventListener('click', function () { view(0, 0); });
    $('gprv-v3Side').addEventListener('click', function () { view(90, 0); });

    [''].concat(V3_Z_STEPS).forEach(function (z) {
      var o = document.createElement('option');
      o.value = z; o.textContent = z === '' ? 'Auto' : '×' + z;
      el.v3Z.appendChild(o);
    });
    el.v3Z.value = V3_Z_STEPS.indexOf(settings.zScale) >= 0 ? String(settings.zScale) : '';
    if (el.v3Z.value === '') settings.zScale = null;
    el.v3Z.addEventListener('change', function () {
      settings.zScale = el.v3Z.value ? Number(el.v3Z.value) : null;
      keep(); v3Request();
    });
    [['v3Drops', 'v3Drops'], ['v3Grid', 'v3Grid'], ['v3Radar', 'v3Radar']].forEach(function (pair) {
      var box = el[pair[0]], key = pair[1];
      box.checked = !!settings[key];
      box.addEventListener('change', function () {
        settings[key] = box.checked;
        keep();
        if (key === 'v3Radar' && box.checked && !(current && current.data && current.place)) {
          el.v3Readout.textContent = 'To see a radargram here, click a scan line, or open a placed scan on the Scan tab.';
        }
        v3Request();
      });
    });
    $('gprv-v3Png').addEventListener('click', function () {
      v3.hover = null; v3.hoverLine = null; v3Draw();
      c.toBlob(function (blob) { if (blob) download((job ? job + '_' : '') + 'gpr_3d_view.png', blob, 'image/png'); });
    });

    // for the automated tests only: add ?gprvtest to the address
    if (/[?&]gprvtest\b/.test(window.location.search)) {
      window.gprvTest = {
        v3: function () {
          return {
            az: v3.az, el: v3.el, scale: v3.scale, fit: v3.fit, zs: v3Zs(), lastMs: v3.lastMs,
            box: v3.geo ? { x0: v3.geo.x0, x1: v3.geo.x1, y0: v3.geo.y0, y1: v3.geo.y1, D: v3.geo.D, depthU: v3.geo.depthU } : null,
            hits: v3.hits.map(function (h) { return { scan: h.p.s.name, pick: h.p.i, x: h.x, y: h.y, cover: h.p.cover }; }),
            lines: v3.segs.map(function (s) { return { scan: s.l.s.name, ax: s.ax, ay: s.ay, bx: s.bx, by: s.by }; })
          };
        }
      };
    }
  }

  // --------------------------------------------------------------------- init

  function setStatus(text) { el.status.textContent = text; }

  function saveSettings() {
    storeSet('settings', settings);
    if (api && job) {
      clearTimeout(settingsTimer);
      settingsTimer = setTimeout(function () { settingsTimer = null; pushSettings(); }, 1500);
    }
  }

  function init() {
    el.root = $('gprv');
    if (!el.root) return;
    ['canvas', 'wrap', 'scanList', 'empty', 'info', 'readout', 'status', 'eps', 'pickBody',
      'pickHead', 'stats', 'files', 'folder', 'depthGain', 'contrast', 'colormap', 'invert',
      'unit', 'pickMode', 'snap', 'awrap', 'acanvas', 'apanel', 'spec', 'specText', 'bandText',
      'analysis', 'profile', 'smooth', 'smoothUnit', 'scanView', 'mapView', 'tabScan', 'tabMap',
      'placeBody', 'mapCanvas', 'mapWrap', 'mapReadout', 'mapSummary', 'mapStatus', 'posFile', 'posUnit',
      'job', 'proj', 'jobList', 'sync', 'tab3d', 'view3d', 'v3Wrap', 'v3Canvas', 'v3Readout', 'v3Summary', 'v3Z',
      'v3Drops', 'v3Grid', 'v3Radar'].forEach(function (k) { el[k] = $('gprv-' + k); });

    var saved = storeGet('settings');
    if (saved) Object.keys(settings).forEach(function (k) { if (k in saved) settings[k] = saved[k]; });

    api = el.root.getAttribute('data-api') || null;
    if (api && el.job) {
      el.proj.hidden = false;
      el.job.value = String(settings.job || '').slice(0, 40);
      el.job.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); openProject(el.job.value); }
      });
      $('gprv-jobOpen').addEventListener('click', function () {
        if (!el.job.value.trim()) { setSync('Enter a project number, or choose one under Saved projects.'); el.job.focus(); return; }
        openProject(el.job.value);
      });
      $('gprv-jobSave').addEventListener('click', saveProject);
      $('gprv-jobClose').addEventListener('click', function () { openProject(''); });
      el.jobList.addEventListener('change', function () {
        var v = el.jobList.value;
        el.jobList.value = '';
        if (v) openProject(v);
      });
      window.addEventListener('pagehide', flushPending);
      listProjects();
      if (el.job.value) openProject(el.job.value); // carry on with the last project
      else setSync('No project open. Enter a project number to save your work to the portal.');
    } else api = null;
    el.depthGain.value = settings.depthGain; el.contrast.value = settings.contrast;
    el.colormap.value = settings.colormap; el.invert.checked = settings.invert;
    el.unit.value = settings.unit; el.pickMode.checked = settings.pickMode; el.snap.checked = settings.snap;

    el.files.addEventListener('change', function () { addFiles(el.files.files); el.files.value = ''; });
    el.folder.addEventListener('change', function () {
      var files = Array.prototype.slice.call(el.folder.files); // a copy: clearing the input empties its list
      el.folder.value = '';
      openFolder(files);
    });
    $('gprv-openFiles').addEventListener('click', function () { el.files.click(); });
    $('gprv-openFolder').addEventListener('click', function () { el.folder.click(); });

    // on the whole page, so a file dropped on the portal header is not opened by the browser
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) {
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
    el.unit.addEventListener('change', function () {
      settings.unit = el.unit.value; saveSettings(); showSmooth(); renderPicks(); updateBandText(); draw();
    });

    el.tabScan.addEventListener('click', function () { setTab('scan'); });
    el.tabMap.addEventListener('click', function () { setTab('map'); });
    $('gprv-mapFit').addEventListener('click', function () { mapView.fit = true; drawMap(); });
    $('gprv-posImport').addEventListener('click', function () { el.posFile.click(); });
    $('gprv-posExport').addEventListener('click', exportPositions);
    el.posFile.addEventListener('change', function () {
      var f = el.posFile.files[0];
      el.posFile.value = '';
      if (f) f.text().then(importPositions);
    });
    bindMap();
    if (el.tab3d && el.view3d && el.v3Canvas) bind3d();

    function showSmooth() {
      el.smooth.value = +(settings.smoothM / UNIT_M[settings.unit]).toFixed(3);
      el.smoothUnit.textContent = settings.unit;
    }
    function showAnalysis() {
      el.awrap.hidden = !settings.analysis;
      el.apanel.hidden = !settings.analysis;
      resize();
      scheduleAnalysis();
    }
    el.analysis.checked = settings.analysis; el.profile.value = settings.profile;
    showSmooth();
    el.analysis.addEventListener('change', function () { settings.analysis = el.analysis.checked; saveSettings(); showAnalysis(); });
    el.profile.addEventListener('change', function () { settings.profile = el.profile.value; saveSettings(); updateProfile(); });
    el.smooth.addEventListener('change', function () {
      var v = parseFloat(el.smooth.value);
      if (!(v >= 0)) { showSmooth(); return; }
      settings.smoothM = v * UNIT_M[settings.unit]; saveSettings(); updateProfile();
    });
    el.pickMode.addEventListener('change', function () { settings.pickMode = el.pickMode.checked; saveSettings(); });
    el.snap.addEventListener('change', function () { settings.snap = el.snap.checked; saveSettings(); });
    el.eps.addEventListener('change', function () {
      var v = parseFloat(el.eps.value);
      if (!current || !(v >= 1 && v <= 81)) { if (current) el.eps.value = current.eps; return; }
      current.eps = v; saveScan(current); renderPicks(); updateBandText(); draw();
    });
    $('gprv-epsReset').addEventListener('click', function () {
      if (!current) return;
      current.eps = current.fileEps || settings.defaultEps;
      el.eps.value = current.eps; saveScan(current); renderPicks(); updateBandText(); draw();
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
    bindProfile();
    bindKeys();
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(resize);
      ro.observe(el.wrap); ro.observe(el.awrap);
      new ResizeObserver(resizeMap).observe(el.mapWrap);
      if (el.v3Wrap) new ResizeObserver(v3Resize).observe(el.v3Wrap);
    }
    window.addEventListener('resize', resize);
    refreshControls = function () {
      el.depthGain.value = settings.depthGain; el.contrast.value = settings.contrast;
      el.colormap.value = settings.colormap; el.invert.checked = settings.invert;
      el.unit.value = settings.unit; el.analysis.checked = settings.analysis; el.profile.value = settings.profile;
      showSmooth(); showAnalysis(); buildImage(); renderPicks(); updateBandText();
      if (tab === 'map') { renderPlaceTable(); drawMap(); }
      v3Refresh();
    };
    showAnalysis();
    renderScanList();
    renderPicks();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
