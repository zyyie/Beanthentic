<?php
declare(strict_types=1);
/**
 * Store GI attachment files on the app server (no gi_updates rows).
 * POST multipart: files[] — used when admin publishes IPOPHL via MySQL from another PC.
 */
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/gi_updates_lib.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    http_response_code(204);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_fail('Method not allowed.', 405);
}

try {
    $files = gi_collect_uploaded_files();
    if (count($files) === 0) {
        json_fail('No files provided.', 400);
    }

    $base = function_exists('gi_request_base') ? gi_request_base() : '';
    $uploadDir = __DIR__ . '/../uploads/gi_contributions';
    if (!is_dir($uploadDir)) {
        mkdir($uploadDir, 0755, true);
    }

    $attachments = [];
    foreach ($files as $f) {
        if (!is_array($f) || empty($f['tmp_name']) || !is_uploaded_file($f['tmp_name'])) {
            continue;
        }
        $orig = trim((string)($f['name'] ?? 'file'));
        $ext = strtolower(pathinfo($orig, PATHINFO_EXTENSION));
        if ($ext === '') {
            $ext = 'bin';
        }
        $safe = preg_replace('/[^a-zA-Z0-9._-]+/', '_', $orig) ?: ('file.' . $ext);
        $fname = $safe;
        if (!preg_match('/\.[a-z0-9]{2,5}$/i', $fname)) {
            $fname .= '.' . $ext;
        }
        $dest = $uploadDir . '/' . $fname;
        if (is_file($dest)) {
            $stem = pathinfo($fname, PATHINFO_FILENAME);
            $fname = $stem . '_' . bin2hex(random_bytes(3)) . '.' . $ext;
            $dest = $uploadDir . '/' . $fname;
        }
        if (!move_uploaded_file($f['tmp_name'], $dest)) {
            continue;
        }
        $rel = '/uploads/gi_contributions/' . $fname;
        $display = gi_display_filename($orig, $fname);
        $attachments[] = [
            'name' => $display,
            'filename' => $display,
            'path' => $rel,
            'url' => rtrim($base, '/') . $rel,
            'mime' => (string)($f['type'] ?? 'application/octet-stream'),
            'type' => (string)($f['type'] ?? 'application/octet-stream'),
            'size' => (int)filesize($dest),
        ];
    }

    if (count($attachments) === 0) {
        json_fail('No valid files saved.', 400);
    }

    json_ok(['attachments' => $attachments, 'count' => count($attachments)]);
} catch (Throwable $e) {
    json_fail('admin_gi_sync_files failed: ' . $e->getMessage(), 503);
}
