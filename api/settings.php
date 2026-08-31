<?php
/* Ham Radio Web Studio — settings persistence
   GET  → returns data/settings.json (or {} if none yet)
   POST → saves the posted JSON body
   The client also mirrors settings to localStorage, so losing this
   endpoint never loses your station config. */

header('Content-Type: application/json');
header('Cache-Control: no-store');

/* MULTI-OPERATOR SAFETY — read before flipping this switch.
   On a public site every visitor is a different ham. Settings must live
   in each visitor's OWN BROWSER (localStorage), never in one shared
   server file: otherwise the last ham to press Save would set the boot
   callsign for everyone, and the file itself would publish your grid and
   lat/lon to anyone who fetches this endpoint. Server-side persistence
   is therefore OFF by default. Set true ONLY on a private single-
   operator install (your own shack server) where "my settings follow me
   between my machines" is the behaviour you actually want. */
define('HRWS_SINGLE_OP', false);

if (!HRWS_SINGLE_OP) {
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        http_response_code(403);
        echo json_encode(array('enabled' => false,
            'error' => 'server-side settings are disabled on this multi-operator site'));
        exit;
    }
    echo json_encode(array('enabled' => false));
    exit;
}

$file = dirname(__DIR__) . '/data/settings.json';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $raw = file_get_contents('php://input');
    if (strlen($raw) > 20000) {
        http_response_code(413);
        echo json_encode(array('error' => 'settings payload too large'));
        exit;
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        http_response_code(400);
        echo json_encode(array('error' => 'body must be a JSON object'));
        exit;
    }
    $dir = dirname($file);
    if (!is_dir($dir)) { @mkdir($dir, 0775, true); }
    $ok = @file_put_contents($file, json_encode($data, JSON_PRETTY_PRINT));
    if ($ok === false) {
        http_response_code(500);
        echo json_encode(array('error' => 'could not write data/settings.json — check folder permissions'));
        exit;
    }
    echo json_encode(array('ok' => true));
    exit;
}

if (is_readable($file)) {
    readfile($file);
} else {
    echo json_encode(new stdClass());
}
