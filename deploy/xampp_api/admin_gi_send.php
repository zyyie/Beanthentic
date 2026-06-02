<?php
declare(strict_types=1);
/**
 * Admin GI broadcast — send GI update + attachments to all farmers (mobile app).
 * POST multipart: send_to_all=1, title, content, category, files[]
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
    $pdo = db_conn();
    gi_ensure_updates_table($pdo);

    $sendToAll = in_array(strtolower(trim((string)($_POST['send_to_all'] ?? $_POST['broadcast'] ?? ''))), ['1', 'true', 'yes', 'all', 'on'], true);
    $title = trim((string)($_POST['title'] ?? $_POST['subject'] ?? 'GI Update from Admin'));
    $content = trim((string)($_POST['content'] ?? $_POST['message'] ?? ''));
    $category = strtolower(trim((string)($_POST['category'] ?? 'general'))) ?: 'general';
    $senderName = trim((string)($_POST['sender_name'] ?? 'Administrator')) ?: 'Administrator';

    if ($content === '') {
        json_fail('Message content is required.', 400);
    }

    $preAttachments = [];
    $rawAtt = trim((string)($_POST['attachments_json'] ?? ''));
    if ($rawAtt !== '') {
        $decoded = json_decode($rawAtt, true);
        if (is_array($decoded)) {
            foreach ($decoded as $row) {
                if (is_array($row)) {
                    $preAttachments[] = $row;
                }
            }
        }
    }

    $farmerId = (int)($_POST['farmer_id'] ?? 0);
    if ($sendToAll) {
        $farmerId = 0;
    }

    $files = gi_collect_uploaded_files();

    $listFarmerIds = static function () use ($pdo): array {
        $stmt = $pdo->query('SELECT farmer_id FROM farmers WHERE farmer_id IS NOT NULL ORDER BY farmer_id ASC');
        $ids = [];
        foreach ($stmt->fetchAll() ?: [] as $row) {
            $fid = (int)($row['farmer_id'] ?? 0);
            if ($fid > 0) {
                $ids[] = $fid;
            }
        }
        return $ids;
    };

    $insertRow = static function (int $fid, array $attachments) use ($pdo, $title, $content, $category, $senderName): int {
        $ins = $pdo->prepare(
            "INSERT INTO gi_updates
               (farmer_id, title, content, upload_status, is_read_admin, category,
                sender_name, attachments_json, current_phase, progress_percent)
             VALUES (?, ?, ?, 'approved', 1, ?, ?, ?, 'admin_submission', 0)"
        );
        $attJson = count($attachments) > 0 ? json_encode($attachments, JSON_UNESCAPED_UNICODE) : null;
        $ins->execute([$fid, mb_substr($title, 0, 150), $content, mb_substr($category, 0, 30), $senderName, $attJson]);
        return (int)$pdo->lastInsertId();
    };

    if ($sendToAll || $farmerId <= 0) {
        $farmerIds = $listFarmerIds();
        if (count($farmerIds) === 0) {
            json_fail('No farmers found in the database.', 400);
        }
        $created = [];
        $attachments = $preAttachments;
        foreach ($farmerIds as $fid) {
            $gid = $insertRow($fid, []);
            if (count($attachments) === 0 && count($files) > 0) {
                $attachments = gi_save_upload_files($fid, $gid, $files);
                if (count($attachments) > 0) {
                    $upd = $pdo->prepare('UPDATE gi_updates SET attachments_json = ? WHERE gi_update_id = ?');
                    $upd->execute([json_encode($attachments, JSON_UNESCAPED_UNICODE), $gid]);
                }
            } elseif (count($attachments) > 0) {
                $upd = $pdo->prepare('UPDATE gi_updates SET attachments_json = ? WHERE gi_update_id = ?');
                $upd->execute([json_encode($attachments, JSON_UNESCAPED_UNICODE), $gid]);
            }
            $created[] = $gid;
        }
        json_ok([
            'broadcast' => true,
            'sent_count' => count($created),
            'gi_update_ids' => $created,
            'attachments' => $attachments,
        ]);
    }

    $gid = $insertRow($farmerId, []);
    $attachments = $preAttachments;
    if (count($attachments) === 0 && count($files) > 0) {
        $attachments = gi_save_upload_files($farmerId, $gid, $files);
    }
    if (count($attachments) > 0) {
        $upd = $pdo->prepare('UPDATE gi_updates SET attachments_json = ? WHERE gi_update_id = ?');
        $upd->execute([json_encode($attachments, JSON_UNESCAPED_UNICODE), $gid]);
    }
    json_ok(['gi_update_id' => $gid, 'attachments' => $attachments]);
} catch (Throwable $e) {
    json_fail('admin_gi_send failed: ' . $e->getMessage(), 503);
}
