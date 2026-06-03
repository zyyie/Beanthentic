<?php
declare(strict_types=1);
/**
 * Serve GI files for mobile previews (CORS-safe).
 * GET ?path=/uploads/gi_contributions/file.pdf
 * GET ?name=12._GI_Registration_Certificate.pdf  (fallback when path in DB is stale)
 */
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    http_response_code(204);
    exit;
}

$uploadDir = dirname(__DIR__) . '/uploads/gi_contributions';
if (!is_dir($uploadDir)) {
    mkdir($uploadDir, 0755, true);
}

function gi_resolve_upload_file(string $uploadDir, string $path, string $name): ?string
{
    $path = trim($path);
    if ($path !== '' && $path[0] !== '/') {
        $path = '/' . $path;
    }
    if ($path !== '' && strpos($path, '/uploads/gi_contributions/') === 0) {
        $fname = basename($path);
        if ($fname !== '' && strpos($fname, '..') === false) {
            $full = $uploadDir . '/' . $fname;
            if (is_file($full)) {
                return $full;
            }
        }
    }

    $name = trim($name);
    if ($name === '') {
        return null;
    }
    $safe = basename(preg_replace('/[^a-zA-Z0-9._-]+/', '_', $name) ?: $name);
    if ($safe === '' || strpos($safe, '..') !== false) {
        return null;
    }

    $direct = $uploadDir . '/' . $safe;
    if (is_file($direct)) {
        return $direct;
    }

    $needle = strtolower($safe);
    $best = null;
    foreach (glob($uploadDir . '/*') ?: [] as $candidate) {
        if (!is_file($candidate)) {
            continue;
        }
        $base = strtolower(basename($candidate));
        if ($base === $needle) {
            return $candidate;
        }
        if (str_ends_with($base, $needle) || str_contains($base, $needle)) {
            $best = $candidate;
        }
    }
    return $best;
}

$path = trim((string)($_GET['path'] ?? ''));
$name = trim((string)($_GET['name'] ?? ''));
$full = gi_resolve_upload_file($uploadDir, $path, $name);

if (!$full || !is_file($full)) {
    http_response_code(404);
    header('Access-Control-Allow-Origin: *');
    header('Content-Type: text/plain; charset=utf-8');
    exit('Not found');
}

$fname = basename($full);
$ext = strtolower(pathinfo($fname, PATHINFO_EXTENSION));
$types = [
    'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'doc' => 'application/msword',
    'pdf' => 'application/pdf',
    'jpg' => 'image/jpeg',
    'jpeg' => 'image/jpeg',
    'png' => 'image/png',
    'gif' => 'image/gif',
    'webp' => 'image/webp',
];
$mime = $types[$ext] ?? 'application/octet-stream';

header('Access-Control-Allow-Origin: *');
header('Content-Type: ' . $mime);
header('Cache-Control: private, max-age=300');
header('Content-Length: ' . (string)filesize($full));
readfile($full);
