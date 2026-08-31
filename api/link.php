<?php
/* Ham Radio Web Studio — Online Link signaling relay
   ---------------------------------------------------
   Lets two studios find each other and trade the little WebRTC
   handshake blobs (offer / answer / ICE candidates). The AUDIO
   itself never touches this server — once the handshake is done
   the browsers stream Opus to each other directly, so this runs
   happily on the cheapest shared PHP host.

   Flow:
     A: POST ?action=create              -> {room, peer:"a", token}
        A shows the friend a URL like  https://…/?join=ROOM
     B: POST ?action=join&room=R        -> {peer:"b", token}
     both: POST ?action=send&room&peer&token   body = JSON payload
           GET  ?action=poll&room&peer&token&cursor=N
     either: POST ?action=leave&room&peer&token

   Storage: one JSON file per room in data/rooms/, flock-guarded.
   Rooms are garbage-collected after ~6 h idle. Nothing sensitive
   lives here (data/ is already "Require all denied" over HTTP). */

header('Content-Type: application/json');
header('Cache-Control: no-store');

define('HRWS_ROOMS', dirname(__DIR__) . '/data/rooms');
define('HRWS_ROOM_TTL', 6 * 3600);        // idle rooms die after 6 h
define('HRWS_MSG_MAX', 65536);            // one signal payload cap (SDP ≈ 10–20 kB)
define('HRWS_MSGS_KEEP', 250);            // hard cap on queued messages

if (!is_dir(HRWS_ROOMS)) { @mkdir(HRWS_ROOMS, 0775, true); }

function hrws_fail($code, $msg) {
    http_response_code($code);
    echo json_encode(array('error' => $msg));
    exit;
}

function hrws_room_path($room) {
    if (!preg_match('/^[A-Z0-9]{4,10}$/', $room)) hrws_fail(400, 'bad room code');
    return HRWS_ROOMS . '/' . $room . '.json';
}

/* Locked read-modify-write. $fn gets the decoded room (or null when the
   file doesn't exist) and returns the array to store, or false to keep
   the file untouched. Returns whatever the room looked like AFTER $fn. */
function hrws_with_room($room, $mustExist, $fn) {
    $path = hrws_room_path($room);
    if ($mustExist && !file_exists($path)) hrws_fail(404, 'no such link — it may have expired');
    $fp = fopen($path, 'c+');
    if (!$fp) hrws_fail(500, 'cannot open room storage — check data/ permissions');
    if (!flock($fp, LOCK_EX)) { fclose($fp); hrws_fail(500, 'room lock failed'); }
    $raw = stream_get_contents($fp);
    $data = ($raw !== false && $raw !== '') ? json_decode($raw, true) : null;
    if (!is_array($data)) $data = null;
    if ($mustExist && $data === null) { flock($fp, LOCK_UN); fclose($fp); hrws_fail(404, 'link record is corrupt or gone'); }

    $out = $fn($data);
    if ($out !== false && is_array($out)) {
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, json_encode($out));
        fflush($fp);
        $data = $out;
    }
    flock($fp, LOCK_UN);
    fclose($fp);
    return $data;
}

/* Opportunistic GC — called on create so busy servers stay tidy. */
function hrws_gc() {
    $now = time();
    foreach (glob(HRWS_ROOMS . '/*.json') as $f) {
        $m = @filemtime($f);
        if ($m !== false && ($now - $m) > HRWS_ROOM_TTL) @unlink($f);
    }
}

function hrws_auth(&$room, $peer, $token) {
    if ($peer !== 'a' && $peer !== 'b') hrws_fail(400, 'peer must be "a" or "b"');
    if (!isset($room['peers'][$peer])) hrws_fail(403, 'not a member of this link');
    if (!is_string($token) || !hash_equals($room['peers'][$peer]['token'], $token)) {
        hrws_fail(403, 'bad token');
    }
    $room['peers'][$peer]['seen'] = time();
}

/* Trim delivered / stale messages so the file never balloons. */
function hrws_prune(&$room) {
    $curA = isset($room['peers']['a']['cursor']) ? $room['peers']['a']['cursor'] : 0;
    $curB = isset($room['peers']['b']['cursor']) ? $room['peers']['b']['cursor'] : 0;
    $minCur = min($curA, $curB);
    $now = time();
    $keep = array();
    foreach ($room['msgs'] as $m) {
        if ($m['n'] <= $minCur) continue;             // both sides have it
        if (($now - $m['ts']) > 600) continue;        // stale handshake junk
        $keep[] = $m;
    }
    if (count($keep) > HRWS_MSGS_KEEP) {
        $keep = array_slice($keep, -HRWS_MSGS_KEEP);
    }
    $room['msgs'] = array_values($keep);
}

$action = isset($_REQUEST['action']) ? $_REQUEST['action'] : '';
$roomId = isset($_REQUEST['room']) ? strtoupper(trim($_REQUEST['room'])) : '';
$peer   = isset($_REQUEST['peer']) ? $_REQUEST['peer'] : '';
$token  = isset($_REQUEST['token']) ? $_REQUEST['token'] : '';

switch ($action) {

/* ---------------- create ---------------- */
case 'create': {
    hrws_gc();
    // unambiguous alphabet — codes get read over the phone / shouted
    // across the room, so no 0/O, 1/I/L pairs.
    $alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    $code = '';
    for ($try = 0; $try < 25; $try++) {
        $code = '';
        for ($i = 0; $i < 6; $i++) $code .= $alpha[random_int(0, strlen($alpha) - 1)];
        if (!file_exists(hrws_room_path($code))) break;
    }
    $tok = bin2hex(random_bytes(12));
    hrws_with_room($code, false, function ($ignored) use ($tok) {
        return array(
            'created' => time(),
            'peers' => array('a' => array('token' => $tok, 'seen' => time(), 'cursor' => 0)),
            'msgs' => array(),
            'next' => 1
        );
    });
    echo json_encode(array('ok' => true, 'room' => $code, 'peer' => 'a', 'token' => $tok));
    break;
}

/* ---------------- join ---------------- */
case 'join': {
    $tok = bin2hex(random_bytes(12));
    hrws_with_room($roomId, true, function ($room) use ($tok) {
        $now = time();
        if (isset($room['peers']['b']) && ($now - $room['peers']['b']['seen']) < 40) {
            hrws_fail(409, 'someone is already connected on that link');
        }
        // fresh join (or replacing a stale/reloaded guest)
        $room['peers']['b'] = array('token' => $tok, 'seen' => $now, 'cursor' => 0);
        $room['msgs'][] = array('n' => $room['next']++, 'from' => 'b', 'ts' => $now,
                                'data' => array('type' => 'join'));
        return $room;
    });
    echo json_encode(array('ok' => true, 'room' => $roomId, 'peer' => 'b', 'token' => $tok));
    break;
}

/* ---------------- send ---------------- */
case 'send': {
    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) < 2) hrws_fail(400, 'empty payload');
    if (strlen($raw) > HRWS_MSG_MAX) hrws_fail(413, 'signal payload too large');
    $payload = json_decode($raw, true);
    if (!is_array($payload)) hrws_fail(400, 'payload must be a JSON object');

    hrws_with_room($roomId, true, function ($room) use ($peer, $token, $payload) {
        hrws_auth($room, $peer, $token);
        $room['msgs'][] = array('n' => $room['next']++, 'from' => $peer,
                                'ts' => time(), 'data' => $payload);
        hrws_prune($room);
        return $room;
    });
    echo json_encode(array('ok' => true));
    break;
}

/* ---------------- poll ---------------- */
case 'poll': {
    $cursor = isset($_REQUEST['cursor']) ? intval($_REQUEST['cursor']) : 0;
    $mine = array();
    $room = hrws_with_room($roomId, true, function ($room) use ($peer, $token, $cursor, &$mine) {
        hrws_auth($room, $peer, $token);
        $room['peers'][$peer]['cursor'] = max($cursor,
            isset($room['peers'][$peer]['cursor']) ? $room['peers'][$peer]['cursor'] : 0);
        foreach ($room['msgs'] as $m) {
            if ($m['n'] > $cursor && $m['from'] !== $peer) $mine[] = $m;
        }
        hrws_prune($room);
        return $room;
    });
    $newCursor = $cursor;
    foreach ($mine as $m) if ($m['n'] > $newCursor) $newCursor = $m['n'];
    $now = time();
    $presence = array();
    foreach (array('a', 'b') as $p) {
        $presence[$p] = isset($room['peers'][$p]) ? ($now - $room['peers'][$p]['seen']) : null;
    }
    echo json_encode(array('ok' => true, 'msgs' => $mine, 'cursor' => $newCursor,
                           'peers' => $presence));
    break;
}

/* ---------------- leave ---------------- */
case 'leave': {
    hrws_with_room($roomId, true, function ($room) use ($peer, $token) {
        hrws_auth($room, $peer, $token);
        $room['msgs'][] = array('n' => $room['next']++, 'from' => $peer,
                                'ts' => time(), 'data' => array('type' => 'bye'));
        unset($room['peers'][$peer]);
        return $room;
    });
    echo json_encode(array('ok' => true));
    break;
}

/* ---------------- info (pre-join sanity check) ---------------- */
case 'info': {
    $path = hrws_room_path($roomId);
    if (!file_exists($path)) { echo json_encode(array('ok' => false, 'exists' => false)); break; }
    $room = hrws_with_room($roomId, true, function ($r) { return false; });
    $now = time();
    $busy = isset($room['peers']['b']) && ($now - $room['peers']['b']['seen']) < 40;
    echo json_encode(array('ok' => true, 'exists' => true, 'busy' => $busy,
                           'age' => $now - $room['created']));
    break;
}

default:
    hrws_fail(400, 'unknown action — use create / join / send / poll / leave / info');
}
