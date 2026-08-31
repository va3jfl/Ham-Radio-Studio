<?php
/* Ham Radio Web Studio — module discovery
   Scans modules/<id>/manifest.json and returns the list as JSON.
   Drop a new folder with a manifest into modules/ and it shows up
   in the sidebar on the next reload — that's the whole plugin API. */

header('Content-Type: application/json');
header('Cache-Control: no-store');

$base = dirname(__DIR__) . '/modules';
$out = array();

foreach (glob($base . '/*/manifest.json') as $file) {
    $dir = basename(dirname($file));
    // folder name is the module id — keep it strictly filename-safe
    if (!preg_match('/^[A-Za-z0-9_-]+$/', $dir)) continue;

    $m = json_decode(file_get_contents($file), true);
    if (!is_array($m)) continue;

    $m['id'] = $dir;
    if (empty($m['entry']) || !preg_match('/^[A-Za-z0-9_.-]+\.js$/', $m['entry'])) {
        $m['entry'] = 'module.js';
    }
    $out[] = $m;
}

// stable order: manifest "order" key first, then name
usort($out, function ($a, $b) {
    $ao = isset($a['order']) ? intval($a['order']) : 99;
    $bo = isset($b['order']) ? intval($b['order']) : 99;
    if ($ao !== $bo) return $ao - $bo;
    $an = isset($a['name']) ? $a['name'] : $a['id'];
    $bn = isset($b['name']) ? $b['name'] : $b['id'];
    return strcmp($an, $bn);
});

echo json_encode($out);
