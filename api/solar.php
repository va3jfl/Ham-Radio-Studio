<?php
/* Ham Radio Web Studio — solar & geomagnetic data proxy
   Aggregates several free NOAA SWPC feeds into one JSON blob and
   caches each upstream file on disk so a busy shack never hammers
   NOAA. Stale cache is served if the network is down — better an
   hour-old Kp than none at Field Day. */

header('Content-Type: application/json');
header('Cache-Control: no-store');

define('HRWS_CACHE', dirname(__DIR__) . '/data/cache');
if (!is_dir(HRWS_CACHE)) { @mkdir(HRWS_CACHE, 0775, true); }

function hrws_fetch_cached($url, $ttl) {
    $key = HRWS_CACHE . '/' . md5($url) . '.json';
    if (is_readable($key) && (time() - filemtime($key)) < $ttl) {
        return file_get_contents($key);
    }
    $body = false;
    $ctx = stream_context_create(array('http' => array(
        'timeout' => 8,
        'user_agent' => 'HamRadioWebStudio/1.0 (+self-hosted dashboard)'
    )));
    $body = @file_get_contents($url, false, $ctx);
    if ($body === false && function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, array(
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 8,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_USERAGENT => 'HamRadioWebStudio/1.0 (+self-hosted dashboard)'
        ));
        $body = curl_exec($ch);
        curl_close($ch);
    }
    if ($body !== false && $body !== null && $body !== '') {
        @file_put_contents($key, $body);
        return $body;
    }
    // network failed — serve stale cache if we have one
    if (is_readable($key)) { return file_get_contents($key); }
    return null;
}

function hrws_json($url, $ttl) {
    $b = hrws_fetch_cached($url, $ttl);
    if ($b === null) return null;
    $j = json_decode($b, true);
    return is_array($j) ? $j : null;
}

if (defined('HRWS_SELFTEST')) { return; }   // harness loads functions only

$out = array('source' => 'NOAA SWPC', 'updated' => gmdate('c'));

/* Tolerant tabular reader: SWPC feeds oscillate between two shapes —
   array-of-objects, and array-of-arrays with a header row. Normalise
   both into a list of assoc rows keyed by lowercased column name. */
function hrws_tab($j) {
    if (!is_array($j) || !count($j)) return array();
    $first = reset($j);
    if (is_array($first) && array_keys($first) !== range(0, count($first) - 1)) {
        $rows = array();
        foreach ($j as $r) {
            if (!is_array($r)) continue;
            $row = array();
            foreach ($r as $k => $v) { $row[strtolower((string)$k)] = $v; }
            $rows[] = $row;
        }
        return $rows;
    }
    if (is_array($first)) {                       // header row + data rows
        $hdr = array();
        foreach ($first as $h) { $hdr[] = strtolower(trim((string)$h)); }
        $rows = array();
        $n = count($j);
        for ($i = 1; $i < $n; $i++) {
            if (!is_array($j[$i])) continue;
            $row = array();
            foreach ($hdr as $ci => $name) {
                $row[$name] = isset($j[$i][$ci]) ? $j[$i][$ci] : null;
            }
            $rows[] = $row;
        }
        return $rows;
    }
    return array();
}

/* Last row whose $col parses as a finite number (feeds have null gaps). */
function hrws_last_num($rows, $col, $lo = null, $hi = null) {
    for ($i = count($rows) - 1; $i >= 0; $i--) {
        if (isset($rows[$i][$col]) && $rows[$i][$col] !== null
            && $rows[$i][$col] !== '' && is_numeric($rows[$i][$col])) {
            $v = floatval($rows[$i][$col]);
            /* NOAA occasionally publishes numeric sentinels (-99999,
               -999.9) during instrument gaps — a range window keeps
               them off the dashboard */
            if ($lo !== null && $v < $lo) continue;
            if ($hi !== null && $v > $hi) continue;
            return array($v, isset($rows[$i]['time_tag']) ? $rows[$i]['time_tag'] : null);
        }
    }
    return array(null, null);
}

/* Real-time solar-wind reader with a widening window: the 2-hour
   product is freshest, but DSCOVR gaps (common during the very storms
   you care about) can blank it entirely — the 1-day product then still
   holds the last real sample, which beats a dash. */
function hrws_sw_value($product, $cols, $lo, $hi) {
    foreach (array('2-hour' => 600, '1-day' => 900) as $span => $ttl) {
        $rows = hrws_tab(hrws_json(
            'https://services.swpc.noaa.gov/products/solar-wind/' . $product . '-' . $span . '.json', $ttl));
        if (!$rows) continue;
        foreach ((array)$cols as $c) {
            list($v, $t) = hrws_last_num($rows, $c, $lo, $hi);
            if ($v !== null) return array($v, $t, $rows);
        }
    }
    return array(null, null, null);
}

/* 10.7 cm solar flux — daily values for the last 30 days */
$flux = hrws_tab(hrws_json('https://services.swpc.noaa.gov/products/10cm-flux-30-day.json', 3600));
if ($flux) {
    list($v, $t) = hrws_last_num($flux, 'flux');
    if ($v === null) {                            // column name drifted?
        foreach (array_keys(end($flux)) as $k) {
            if (strpos($k, 'flux') !== false) { list($v, $t) = hrws_last_num($flux, $k); break; }
        }
    }
    if ($v !== null) { $out['sfi'] = $v; $out['sfi_time'] = $t; }
}

/* Planetary K index — now array-of-objects with Kp + a_running */
$kp = hrws_tab(hrws_json('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', 900));
if ($kp) {
    list($v, $t) = hrws_last_num($kp, 'kp');
    if ($v !== null) { $out['kp'] = $v; $out['kp_time'] = $t; }
    list($a, $ignored) = hrws_last_num($kp, 'a_running');
    if ($a !== null) { $out['a_est'] = $a; }
    $vals = array();
    foreach ($kp as $r) {
        if (isset($r['kp']) && is_numeric($r['kp'])) { $vals[] = floatval($r['kp']); }
    }
    if ($vals) { $out['kp_history'] = array_slice($vals, -8); }
}

/* Solar wind plasma + IMF — DSCOVR summary files are gone; use the
   tabular real-time products (header-row arrays, string values, gaps) */
list($v, $t, $plasma) = hrws_sw_value('plasma', array('speed'), 100, 3500);
if ($v !== null) {
    $out['wind_speed'] = $v; $out['wind_time'] = $t;
    list($dn, $ignored) = hrws_last_num($plasma, 'density', 0, 500);
    if ($dn !== null) { $out['wind_density'] = $dn; }
}

list($v, $t, $mag) = hrws_sw_value('mag', array('bz_gsm', 'bz'), -500, 500);
if ($v !== null) {
    $out['bz'] = $v; $out['bz_time'] = $t;
    list($bt, $ignored) = hrws_last_num($mag, 'bt', 0, 500);
    if ($bt !== null) { $out['bt'] = $bt; }
}

/* Latest X-ray flare */
$xr = hrws_json('https://services.swpc.noaa.gov/json/goes/primary/xray-flares-latest.json', 1800);
if (is_array($xr)) {
    $rec = isset($xr[0]) && is_array($xr[0]) ? $xr[0] : $xr;
    if (isset($rec['max_class'])) {
        $out['xray_class'] = $rec['max_class'];
        if (isset($rec['max_time'])) { $out['xray_time'] = $rec['max_time']; }
    }
}

/* Monthly sunspot number + monthly F10.7 (SFI fallback) */
$ssn = hrws_json('https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json', 21600);
if (is_array($ssn) && count($ssn)) {
    $last = end($ssn);
    if (is_array($last) && isset($last['ssn'])) {
        $out['ssn'] = floatval($last['ssn']);
        if (isset($last['time-tag'])) { $out['ssn_month'] = $last['time-tag']; }
        if (!isset($out['sfi']) && isset($last['f10.7']) && is_numeric($last['f10.7'])
            && floatval($last['f10.7']) > 0) {
            $out['sfi'] = floatval($last['f10.7']);
            $out['sfi_src'] = 'monthly mean';
        }
    }
}

echo json_encode($out);
