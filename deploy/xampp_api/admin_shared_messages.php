<?php
/**
 * Beanthentic-App HTTP bridge for admin dashboard Messages (shared_messages).
 * Copy to: Beanthentic-App/api/admin_shared_messages.php on the XAMPP device.
 * Uses local MySQL (127.0.0.1) — same pattern as admin_farmer_data.php.
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

function respond(bool $ok, array $data = []): void
{
    echo json_encode($ok ? array_merge(['ok' => true], $data) : array_merge(['ok' => false, 'error' => $data['error'] ?? 'error'], $data));
    exit;
}

$action = strtolower(trim((string)($_GET['action'] ?? 'list')));
$role = strtolower(trim((string)($_GET['role'] ?? 'admin')));
$phone = trim((string)($_GET['phone'] ?? ''));
$folder = strtolower(trim((string)($_GET['folder'] ?? 'inbox')));
$search = strtolower(trim((string)($_GET['search'] ?? '')));
$category = strtolower(trim((string)($_GET['category'] ?? '')));
$limit = max(1, min(500, (int)($_GET['limit'] ?? 100)));
$threadPhone = trim((string)($_GET['thread_phone'] ?? ''));

$dbName = 'beanthentic_app';
$dbUser = 'root';
$dbPass = '';
$dbHost = '127.0.0.1';
$dbPort = 3306;

$mysqli = @new mysqli($dbHost, $dbUser, $dbPass, $dbName, $dbPort);
if ($mysqli->connect_errno) {
    respond(false, ['error' => 'DB_CONNECT', 'detail' => $mysqli->connect_error]);
}
$mysqli->set_charset('utf8mb4');

$mysqli->query("
CREATE TABLE IF NOT EXISTS shared_messages (
  message_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  sender_role ENUM('admin','farmer') NOT NULL,
  sender_phone VARCHAR(32) NOT NULL,
  sender_name VARCHAR(255) NULL,
  recipient_role ENUM('admin','farmer') NOT NULL,
  recipient_phone VARCHAR(32) NOT NULL DEFAULT '',
  recipient_name VARCHAR(255) NULL,
  subject VARCHAR(300) NOT NULL,
  body TEXT NOT NULL,
  category VARCHAR(30) NOT NULL DEFAULT 'general',
  farmer_id BIGINT UNSIGNED NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  is_starred TINYINT(1) NOT NULL DEFAULT 0,
  is_archived TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at DATETIME NULL,
  INDEX idx_sm_recipient (recipient_role, recipient_phone, is_read, is_archived),
  INDEX idx_sm_sender (sender_role, sender_phone),
  INDEX idx_sm_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
");

function row_to_json(array $row): array
{
    foreach (['created_at', 'read_at'] as $k) {
        if (isset($row[$k]) && $row[$k] !== null) {
            $row[$k] = str_replace(' ', 'T', (string)$row[$k]);
        }
    }
    if (isset($row['sender_role'])) {
        $row['sender_role'] = strtolower((string)$row['sender_role']);
    }
    if (isset($row['recipient_role'])) {
        $row['recipient_role'] = strtolower((string)$row['recipient_role']);
    }
    return $row;
}

if ($action === 'unread_count') {
    if ($role === 'admin') {
        $stmt = $mysqli->prepare("
            SELECT COUNT(*) AS c FROM shared_messages
            WHERE recipient_role='admin'
              AND (recipient_phone='' OR recipient_phone=?)
              AND sender_role='farmer'
              AND is_read=0 AND is_archived=0
              AND LOWER(category) <> 'announcement'
        ");
        $stmt->bind_param('s', $phone);
    } else {
        $stmt = $mysqli->prepare("
            SELECT COUNT(*) AS c FROM shared_messages
            WHERE recipient_role='farmer' AND recipient_phone=?
              AND is_read=0 AND is_archived=0
        ");
        $stmt->bind_param('s', $phone);
    }
    $stmt->execute();
    $res = $stmt->get_result();
    $count = (int)(($res->fetch_assoc()['c'] ?? 0));
    respond(true, ['unread_count' => $count]);
}

if ($action === 'thread') {
    if ($threadPhone === '') {
        respond(false, ['error' => 'thread_phone required']);
    }
  $variants = array_values(array_unique(array_filter([$threadPhone])));
    $ph = implode(',', array_fill(0, count($variants), '?'));
    $types = str_repeat('s', count($variants) * 2);
    $sql = "
        SELECT message_id AS id, sender_phone, sender_name, recipient_phone, recipient_name,
               subject, body, category, farmer_id, is_read, is_starred, is_archived,
               created_at, read_at, sender_role, recipient_role
        FROM shared_messages
        WHERE LOWER(category) <> 'announcement'
          AND (
            (sender_role='farmer' AND sender_phone IN ($ph))
            OR (recipient_role='farmer' AND recipient_phone IN ($ph))
          )
        ORDER BY created_at ASC, message_id ASC
        LIMIT 500
    ";
    $stmt = $mysqli->prepare($sql);
    $bind = array_merge($variants, $variants);
    $stmt->bind_param($types, ...$bind);
    $stmt->execute();
    $res = $stmt->get_result();
    $items = [];
    while ($row = $res->fetch_assoc()) {
        $items[] = row_to_json($row);
    }
    respond(true, ['items' => $items]);
}

// action=list (default)
$where = [];
$args = [];
$types = '';

if ($folder === 'inbox') {
    if ($role === 'admin') {
        $where[] = "recipient_role='admin' AND (recipient_phone='' OR recipient_phone=?) AND is_archived=0";
        $args[] = $phone;
        $types .= 's';
    } else {
        $where[] = "recipient_role='farmer' AND recipient_phone=? AND is_archived=0";
        $args[] = $phone;
        $types .= 's';
    }
} elseif ($folder === 'sent') {
    $where[] = 'sender_role=? AND sender_phone=?';
    array_push($args, $role, $phone);
    $types .= 'ss';
} elseif ($folder === 'starred') {
    if ($role === 'admin') {
        $where[] = "((recipient_role='admin' AND (recipient_phone='' OR recipient_phone=?)) OR (sender_role='admin' AND sender_phone=?)) AND is_starred=1";
        array_push($args, $phone, $phone);
        $types .= 'ss';
    } else {
        $where[] = "((recipient_role='farmer' AND recipient_phone=?) OR (sender_role='farmer' AND sender_phone=?)) AND is_starred=1";
        array_push($args, $phone, $phone);
        $types .= 'ss';
    }
} elseif ($folder === 'archived') {
    if ($role === 'admin') {
        $where[] = "recipient_role='admin' AND (recipient_phone='' OR recipient_phone=?) AND is_archived=1";
        $args[] = $phone;
        $types .= 's';
    } else {
        $where[] = "recipient_role='farmer' AND recipient_phone=? AND is_archived=1";
        $args[] = $phone;
        $types .= 's';
    }
} elseif ($folder === 'all') {
    if ($role === 'admin') {
        $where[] = "((recipient_role='admin' AND (recipient_phone='' OR recipient_phone=?)) OR (sender_role='admin' AND sender_phone=?) OR sender_role='farmer')";
        array_push($args, $phone, $phone);
        $types .= 'ss';
    } else {
        $where[] = "((recipient_role='farmer' AND recipient_phone=?) OR (sender_role='farmer' AND sender_phone=?))";
        array_push($args, $phone, $phone);
        $types .= 'ss';
    }
} else {
    if ($role === 'admin') {
        $where[] = "recipient_role='admin' AND (recipient_phone='' OR recipient_phone=?) AND is_archived=0";
        $args[] = $phone;
        $types .= 's';
    } else {
        $where[] = "recipient_role='farmer' AND recipient_phone=? AND is_archived=0";
        $args[] = $phone;
        $types .= 's';
    }
}

if ($category !== '') {
    $where[] = 'category=?';
    $args[] = $category;
    $types .= 's';
}

$sql = "
    SELECT message_id AS id, sender_phone, sender_name, recipient_phone, recipient_name,
           subject, body, category, farmer_id, is_read, is_starred, is_archived,
           created_at, read_at, sender_role, recipient_role
    FROM shared_messages
    WHERE " . implode(' AND ', $where) . "
    ORDER BY created_at DESC, message_id DESC
    LIMIT ?
";
$args[] = $limit;
$types .= 'i';

$stmt = $mysqli->prepare($sql);
$stmt->bind_param($types, ...$args);
$stmt->execute();
$res = $stmt->get_result();
$items = [];
while ($row = $res->fetch_assoc()) {
    $items[] = row_to_json($row);
}

if ($search !== '') {
    $items = array_values(array_filter($items, static function ($m) use ($search) {
        return strpos(strtolower((string)($m['subject'] ?? '')), $search) !== false
            || strpos(strtolower((string)($m['body'] ?? '')), $search) !== false
            || strpos(strtolower((string)($m['sender_name'] ?? '')), $search) !== false
            || strpos(strtolower((string)($m['recipient_name'] ?? '')), $search) !== false;
    }));
}

$unread = 0;
if ($role === 'admin') {
    $ustmt = $mysqli->prepare("
        SELECT COUNT(*) AS c FROM shared_messages
        WHERE recipient_role='admin'
          AND (recipient_phone='' OR recipient_phone=?)
          AND sender_role='farmer'
          AND is_read=0 AND is_archived=0
          AND LOWER(category) <> 'announcement'
    ");
    $ustmt->bind_param('s', $phone);
} else {
    $ustmt = $mysqli->prepare("
        SELECT COUNT(*) AS c FROM shared_messages
        WHERE recipient_role='farmer' AND recipient_phone=?
          AND is_read=0 AND is_archived=0
    ");
    $ustmt->bind_param('s', $phone);
}
$ustmt->execute();
$ures = $ustmt->get_result();
$unread = (int)(($ures->fetch_assoc()['c'] ?? 0));

respond(true, ['items' => $items, 'unread_count' => $unread]);
