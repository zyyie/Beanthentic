<?php
declare(strict_types=1);
/**
 * GI Updates helpers for admin HTTP bridges (multipart uploads).
 * Copy to: Beanthentic-App/api/gi_updates_lib.php
 */

const GI_ALLOWED_EXTENSIONS = ['pdf', 'doc', 'docx', 'txt', 'md', 'csv', 'jpg', 'jpeg', 'png', 'gif', 'webp'];
const GI_MAX_FILE_BYTES = 15728640; // 15 MB

function gi_request_base(): string
{
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = (string)($_SERVER['HTTP_HOST'] ?? '127.0.0.1:8080');
    return rtrim($scheme . '://' . $host, '/');
}

/**
 * Collect every uploaded file from multipart POST.
 * Supports files[], files, file[], file — PHP only keeps the last file when
 * multiple parts use name="files" without [].
 */
function gi_collect_uploaded_files(): array
{
    $out = [];
    foreach (['files', 'file'] as $key) {
        if (!isset($_FILES[$key]) || !is_array($_FILES[$key])) {
            continue;
        }
        $bundle = $_FILES[$key];
        if (is_array($bundle['name'] ?? null)) {
            $count = count($bundle['name']);
            for ($i = 0; $i < $count; $i++) {
                $err = (int)($bundle['error'][$i] ?? UPLOAD_ERR_NO_FILE);
                $tmp = (string)($bundle['tmp_name'][$i] ?? '');
                if ($err !== UPLOAD_ERR_OK || $tmp === '' || !is_uploaded_file($tmp)) {
                    continue;
                }
                $out[] = [
                    'name' => (string)($bundle['name'][$i] ?? 'file'),
                    'type' => (string)($bundle['type'][$i] ?? 'application/octet-stream'),
                    'tmp_name' => $tmp,
                    'error' => $err,
                    'size' => (int)($bundle['size'][$i] ?? 0),
                ];
            }
            continue;
        }
        $err = (int)($bundle['error'] ?? UPLOAD_ERR_NO_FILE);
        $tmp = (string)($bundle['tmp_name'] ?? '');
        if ($err === UPLOAD_ERR_OK && $tmp !== '' && is_uploaded_file($tmp)) {
            $out[] = [
                'name' => (string)($bundle['name'] ?? 'file'),
                'type' => (string)($bundle['type'] ?? 'application/octet-stream'),
                'tmp_name' => $tmp,
                'error' => $err,
                'size' => (int)($bundle['size'] ?? 0),
            ];
        }
    }
    return $out;
}

function gi_allowed_extension(string $filename): bool
{
    $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
    return $ext !== '' && in_array($ext, GI_ALLOWED_EXTENSIONS, true);
}

function gi_display_filename(string $original, string $storedName): string
{
    $orig = trim($original);
    $generic = ['uploaded.docx', 'uploaded.pdf', 'uploaded.doc', 'file', 'document'];
    if ($orig !== '' && !in_array(strtolower($orig), $generic, true)) {
        return $orig;
    }
    return $storedName;
}

function gi_save_upload_files(int $farmerId, int $giUpdateId, array $files): array
{
    $base = gi_request_base();
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
        if (!gi_allowed_extension($orig)) {
            continue;
        }
        $size = (int)($f['size'] ?? 0);
        if ($size <= 0 || $size > GI_MAX_FILE_BYTES) {
            continue;
        }
        $ext = strtolower(pathinfo($orig, PATHINFO_EXTENSION)) ?: 'bin';
        $stored = 'gi_' . $farmerId . '_' . $giUpdateId . '_' . bin2hex(random_bytes(6)) . '.' . $ext;
        $dest = $uploadDir . '/' . $stored;
        if (!move_uploaded_file($f['tmp_name'], $dest)) {
            continue;
        }
        $display = gi_display_filename($orig, $stored);
        $rel = '/uploads/gi_contributions/' . $stored;
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
    return $attachments;
}

function gi_ensure_updates_table(PDO $pdo): void
{
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS gi_updates (
          gi_update_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          farmer_id BIGINT UNSIGNED NULL,
          current_phase VARCHAR(64) NOT NULL DEFAULT 'farmer_submission',
          title VARCHAR(255) NOT NULL DEFAULT '',
          content TEXT NOT NULL,
          preview TEXT NULL,
          category VARCHAR(64) NOT NULL DEFAULT 'general',
          sender_name VARCHAR(255) NOT NULL DEFAULT '',
          attachments_json TEXT NULL,
          upload_status VARCHAR(32) NOT NULL DEFAULT 'pending',
          is_starred TINYINT(1) NOT NULL DEFAULT 0,
          is_read_admin TINYINT(1) NOT NULL DEFAULT 0,
          is_read_farmer TINYINT(1) NOT NULL DEFAULT 0,
          progress_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NULL,
          INDEX idx_gi_phase (current_phase),
          INDEX idx_gi_created (created_at),
          INDEX idx_gi_farmer (farmer_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
}
