<?php
declare(strict_types=1);
/**
 * Farmer profile photo from beanthentic_app (users / personal_information / farmers).
 * Copy to: Beanthentic-App/api/admin_farmer_profile_photo.php
 *
 * GET ?farmer_id=123
 */
require_once __DIR__ . '/db.php';

$farmerId = max(0, (int)($_GET['farmer_id'] ?? 0));
if ($farmerId < 1) {
    http_response_code(400);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => 'farmer_id required']);
    exit;
}

$candidates = [
    'users' => ['profile_photo_data', 'profile_photo', 'profile_picture', 'photo', 'photo_path', 'avatar', 'image_url', 'profile_image'],
    'personal_information' => ['profile_photo_data', 'profile_photo', 'profile_picture', 'photo', 'photo_path', 'avatar', 'profile_image'],
    'farmers' => ['profile_photo_data', 'profile_photo', 'profile_picture', 'photo', 'photo_path'],
];

function table_columns(PDO $pdo, string $table): array
{
    $stmt = $pdo->query('SHOW COLUMNS FROM `' . str_replace('`', '``', $table) . '`');
    $cols = [];
    while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
        $cols[strtolower((string)$row['Field'])] = strtolower((string)($row['Type'] ?? ''));
    }
    return $cols;
}

function pick_column(array $cols, array $want): ?string
{
    foreach ($want as $name) {
        if (isset($cols[$name])) {
            return $name;
        }
    }
    return null;
}

function mime_from_path(string $path): string
{
    $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    return match ($ext) {
        'png' => 'image/png',
        'gif' => 'image/gif',
        'webp' => 'image/webp',
        default => 'image/jpeg',
    };
}

function resolve_app_file(string $raw): ?string
{
    $raw = trim($raw);
    if ($raw === '') {
        return null;
    }
    if (preg_match('#^https?://#i', $raw)) {
        return null;
    }
    $root = dirname(__DIR__);
    $path = $raw;
    if ($path[0] === '/') {
        $full = $root . $path;
        if (is_file($full)) {
            return $full;
        }
    }
    $full = $root . '/' . ltrim($path, '/');
    if (is_file($full)) {
        return $full;
    }
    $base = basename($path);
    if ($base === '' || str_contains($base, '..')) {
        return null;
    }
    foreach (['uploads/farmers', 'uploads/profiles', 'uploads/profile_photos', 'uploads', 'static/uploads'] as $dir) {
        $try = $root . '/' . $dir . '/' . $base;
        if (is_file($try)) {
            return $try;
        }
    }
    return null;
}

try {
    $pdo = db_conn();
    foreach ($candidates as $table => $want) {
        $cols = table_columns($pdo, $table);
        $col = pick_column($cols, $want);
        if (!$col) {
            continue;
        }
        $type = $cols[$col] ?? '';
        if ($table === 'users') {
            $sql = "SELECT u.`$col` AS photo_value
                    FROM farmers f
                    LEFT JOIN users u ON u.user_id = f.user_id
                    WHERE f.farmer_id = ? LIMIT 1";
        } elseif ($table === 'personal_information') {
            $sql = "SELECT pi.`$col` AS photo_value
                    FROM farmers f
                    LEFT JOIN personal_information pi ON pi.farmer_id = f.farmer_id
                    WHERE f.farmer_id = ? LIMIT 1";
        } else {
            $sql = "SELECT f.`$col` AS photo_value FROM farmers f WHERE f.farmer_id = ? LIMIT 1";
        }
        $stmt = $pdo->prepare($sql);
        $stmt->execute([$farmerId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row || !isset($row['photo_value']) || $row['photo_value'] === null || $row['photo_value'] === '') {
            continue;
        }
        $value = $row['photo_value'];
        if (str_contains($type, 'blob') || str_contains($type, 'binary')) {
            header('Content-Type: image/jpeg');
            header('Cache-Control: public, max-age=3600');
            echo $value;
            exit;
        }
        $text = trim((string)$value);
        if ($text === '') {
            continue;
        }
        if (preg_match('#^https?://#i', $text)) {
            header('Location: ' . $text, true, 302);
            exit;
        }
        if (preg_match('#^data:image/([^;]+);base64,#i', $text, $m)) {
            $raw = base64_decode(substr($text, strpos($text, ',') + 1), true);
            if ($raw !== false && $raw !== '') {
                header('Content-Type: image/' . strtolower($m[1]));
                header('Cache-Control: public, max-age=3600');
                echo $raw;
                exit;
            }
        }
        $file = resolve_app_file($text);
        if ($file) {
            header('Content-Type: ' . mime_from_path($file));
            header('Cache-Control: public, max-age=3600');
            readfile($file);
            exit;
        }
    }
    http_response_code(404);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => 'no_photo']);
} catch (Throwable $e) {
    http_response_code(503);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
}
