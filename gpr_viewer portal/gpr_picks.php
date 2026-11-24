<?php
/**
 * GPR Scan Viewer - saved projects (Echem Staff Portal)
 *
 * GET  api/gpr_picks.php?list=1
 *      -> { ok, projects: [ { job, scans, picks, saved } ] }            newest first
 * GET  api/gpr_picks.php?job=26-08204
 *      -> { ok, job, scans: { <scan_key>: record + saved_by }, settings }   open a project
 * POST api/gpr_picks.php   JSON { job, key, record }                    save one scan
 *      -> { ok }  |  { ok, removed:true } when the scan has no picks or position left
 *      |  { ok:false, stale:true, record, saved_by } when the portal holds a newer save
 * POST api/gpr_picks.php   JSON { job, settings, updated }              save the project's settings
 *      -> { ok }
 *
 * Tables (created on first use): gpr_scans, one row per project number and scan,
 * and gpr_projects, one row per project number for the display / analysis settings.
 * Only picks and settings are stored; the .DZT files stay on the user's computer.
 */
require_once '../check_auth.php';
require_once '../config.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

function gpr_out($data, $code = 200) {
    http_response_code($code);
    echo json_encode($data);
    exit;
}

function gpr_num($v, $min, $max) {
    if (!is_int($v) && !is_float($v)) return null;
    return ($v >= $min && $v <= $max) ? $v : null;
}

/** Rebuild the record from known fields only, so nothing else reaches the database. */
function gpr_clean_record($r) {
    if (!is_array($r)) return null;
    $picks = [];
    $in = (isset($r['picks']) && is_array($r['picks'])) ? $r['picks'] : [];
    if (count($in) > 5000) return null;
    foreach ($in as $p) {
        if (!is_array($p) || !isset($p['trace'], $p['row']) || !is_numeric($p['trace']) || !is_numeric($p['row'])) return null;
        $t = (int)$p['trace'];
        $w = (int)$p['row'];
        if ($t < 0 || $w < 0) return null;
        $picks[] = ['trace' => $t, 'row' => $w];
    }
    $place = null;
    if (isset($r['place']) && is_array($r['place'])) {
        $x = gpr_num($r['place']['xM'] ?? null, -1e6, 1e6);
        $y = gpr_num($r['place']['yM'] ?? null, -1e6, 1e6);
        $d = $r['place']['dir'] ?? '';
        if ($x !== null && $y !== null && in_array($d, ['+X', '-X', '+Y', '-Y'], true)) {
            $place = ['xM' => $x, 'yM' => $y, 'dir' => $d];
        }
    }
    $updated = gpr_num($r['updated'] ?? null, 1, 9e15);
    if ($updated === null) return null;
    return [
        'name'    => substr(trim((string)($r['name'] ?? '')), 0, 150),
        'eps'     => gpr_num($r['eps'] ?? null, 1, 81),
        'dxM'     => gpr_num($r['dxM'] ?? null, 1e-6, 10),
        'dtNs'    => gpr_num($r['dtNs'] ?? null, 1e-6, 1000),
        'nt'      => gpr_num($r['nt'] ?? null, 1, 1e8),
        'place'   => $place,
        'updated' => (int)$updated,
        'picks'   => $picks,
    ];
}

/** Display and analysis settings: known keys with sane values only. */
function gpr_clean_settings($s) {
    if (!is_array($s)) return null;
    $out = [];
    foreach (['depthGain' => [0, 6], 'contrast' => [0.3, 6], 'smoothM' => [0, 10]] as $k => $range) {
        $v = gpr_num($s[$k] ?? null, $range[0], $range[1]);
        if ($v !== null) $out[$k] = $v;
    }
    foreach (['unit' => ['in', 'ft', 'mm', 'cm', 'm'], 'colormap' => ['gray', 'seismic', 'hot'], 'profile' => ['energy', 'centroid']] as $k => $allowed) {
        if (isset($s[$k]) && in_array($s[$k], $allowed, true)) $out[$k] = $s[$k];
    }
    foreach (['invert', 'analysis'] as $k) {
        if (isset($s[$k]) && is_bool($s[$k])) $out[$k] = $s[$k];
    }
    $out['bandNs'] = null;
    if (isset($s['bandNs']) && is_array($s['bandNs']) && count($s['bandNs']) === 2) {
        $a = gpr_num($s['bandNs'][0] ?? null, 0, 1000);
        $b = gpr_num($s['bandNs'][1] ?? null, 0, 1000);
        if ($a !== null && $b !== null) $out['bandNs'] = [$a, $b];
    }
    return $out;
}

$JOB_RE = '/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/';

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT); // database errors become exceptions
try {
    $conn = getDBConnection();

    $conn->query("CREATE TABLE IF NOT EXISTS gpr_scans (
        id INT AUTO_INCREMENT PRIMARY KEY,
        job_no VARCHAR(40) NOT NULL,
        scan_key VARCHAR(150) NOT NULL,
        scan_name VARCHAR(150) NOT NULL,
        pick_count INT NOT NULL DEFAULT 0,
        record_json MEDIUMTEXT NOT NULL,
        updated_ms BIGINT NOT NULL DEFAULT 0,
        saved_by VARCHAR(100) DEFAULT NULL,
        saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_job_scan (job_no, scan_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $conn->query("CREATE TABLE IF NOT EXISTS gpr_projects (
        job_no VARCHAR(40) NOT NULL PRIMARY KEY,
        settings_json TEXT NOT NULL,
        updated_ms BIGINT NOT NULL DEFAULT 0,
        saved_by VARCHAR(100) DEFAULT NULL,
        saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $method = $_SERVER['REQUEST_METHOD'];
    $by = substr((string)($_SESSION['full_name'] ?? ''), 0, 100);

    // ---- list of saved projects
    if ($method === 'GET' && isset($_GET['list'])) {
        $res = $conn->query("SELECT job_no, COUNT(*) AS scans, COALESCE(SUM(pick_count), 0) AS picks,
                DATE_FORMAT(MAX(saved_at), '%b %e, %Y') AS saved
            FROM gpr_scans GROUP BY job_no ORDER BY MAX(saved_at) DESC LIMIT 300");
        $projects = [];
        while ($row = $res->fetch_assoc()) {
            $projects[] = ['job' => $row['job_no'], 'scans' => (int)$row['scans'], 'picks' => (int)$row['picks'], 'saved' => $row['saved']];
        }
        gpr_out(['ok' => true, 'projects' => $projects]);
    }

    // ---- open a project
    if ($method === 'GET') {
        $job = trim($_GET['job'] ?? '');
        if (!preg_match($JOB_RE, $job)) gpr_out(['ok' => false, 'error' => 'invalid project number'], 400);

        $stmt = $conn->prepare('SELECT scan_key, record_json, saved_by FROM gpr_scans WHERE job_no = ?');
        $stmt->bind_param('s', $job);
        $stmt->execute();
        $stmt->bind_result($key, $json, $savedBy);
        $scans = [];
        while ($stmt->fetch()) {
            $rec = json_decode($json, true);
            if (!is_array($rec)) continue;
            $rec['saved_by'] = $savedBy;
            $scans[$key] = $rec;
        }
        $stmt->close();

        $settings = null;
        $stmt = $conn->prepare('SELECT settings_json FROM gpr_projects WHERE job_no = ?');
        $stmt->bind_param('s', $job);
        $stmt->execute();
        $stmt->bind_result($sjson);
        if ($stmt->fetch()) {
            $decoded = json_decode($sjson, true);
            if (is_array($decoded)) $settings = $decoded;
        }
        $stmt->close();

        // (object) so an empty result is {} in JSON, not []
        gpr_out(['ok' => true, 'job' => $job, 'scans' => (object)$scans, 'settings' => $settings]);
    }

    if ($method === 'POST') {
        $body = json_decode(file_get_contents('php://input'), true);
        if (!is_array($body)) gpr_out(['ok' => false, 'error' => 'invalid request'], 400);
        $job = trim((string)($body['job'] ?? ''));
        if (!preg_match($JOB_RE, $job)) gpr_out(['ok' => false, 'error' => 'invalid project number'], 400);

        // ---- save the project's settings
        if (isset($body['settings'])) {
            $settings = gpr_clean_settings($body['settings']);
            if ($settings === null) gpr_out(['ok' => false, 'error' => 'invalid settings'], 400);
            $json = json_encode($settings);
            $ms = (int)(gpr_num($body['updated'] ?? null, 1, 9e15) ?? 0);
            $stmt = $conn->prepare('INSERT INTO gpr_projects (job_no, settings_json, updated_ms, saved_by) VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE settings_json = VALUES(settings_json), updated_ms = VALUES(updated_ms), saved_by = VALUES(saved_by)');
            $stmt->bind_param('ssis', $job, $json, $ms, $by);
            $stmt->execute();
            $stmt->close();
            gpr_out(['ok' => true]);
        }

        // ---- save one scan
        $key = (string)($body['key'] ?? '');
        if ($key === '' || strlen($key) > 150) gpr_out(['ok' => false, 'error' => 'invalid scan'], 400);
        $rec = gpr_clean_record($body['record'] ?? null);
        if ($rec === null) gpr_out(['ok' => false, 'error' => 'invalid picks'], 400);
        if ($rec['name'] === '') $rec['name'] = substr($key, 0, 150);

        // Keep the newer edit: an older copy from another browser must not overwrite it.
        $stmt = $conn->prepare('SELECT record_json, updated_ms, saved_by FROM gpr_scans WHERE job_no = ? AND scan_key = ?');
        $stmt->bind_param('ss', $job, $key);
        $stmt->execute();
        $stmt->bind_result($oldJson, $oldMs, $oldBy);
        $found = $stmt->fetch();
        $stmt->close();
        if ($found && (int)$oldMs > $rec['updated']) {
            $old = json_decode($oldJson, true);
            if (is_array($old)) gpr_out(['ok' => false, 'stale' => true, 'record' => $old, 'saved_by' => $oldBy]);
        }

        // A scan with no picks and no position is not part of the project.
        if (!$rec['picks'] && !$rec['place']) {
            $stmt = $conn->prepare('DELETE FROM gpr_scans WHERE job_no = ? AND scan_key = ?');
            $stmt->bind_param('ss', $job, $key);
            $stmt->execute();
            $stmt->close();
            gpr_out(['ok' => true, 'removed' => true]);
        }

        $json = json_encode($rec);
        $count = count($rec['picks']);
        $ms = $rec['updated'];
        $stmt = $conn->prepare('INSERT INTO gpr_scans (job_no, scan_key, scan_name, pick_count, record_json, updated_ms, saved_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE scan_name = VALUES(scan_name), pick_count = VALUES(pick_count),
                record_json = VALUES(record_json), updated_ms = VALUES(updated_ms), saved_by = VALUES(saved_by)');
        $stmt->bind_param('sssisis', $job, $key, $rec['name'], $count, $json, $ms, $by);
        $stmt->execute();
        $stmt->close();
        gpr_out(['ok' => true, 'picks' => $count]);
    }

    gpr_out(['ok' => false, 'error' => 'method not allowed'], 405);
} catch (mysqli_sql_exception $e) {
    gpr_out(['ok' => false, 'error' => 'database error'], 500);
}
