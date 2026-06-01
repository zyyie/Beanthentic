<?php
declare(strict_types=1);
/**
 * POST JSON — Admin compose/reply to farmer (shared_messages on XAMPP device).
 * Copy to Beanthentic-App/api/ on the XAMPP PC alongside admin_shared_messages.php.
 */
require_once __DIR__ . '/db.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    http_response_code(204);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_fail('Method not allowed', 405);
}

try {
    $body = read_json_body();
    $senderPhone = trim((string)($body['sender_phone'] ?? ''));
    $senderName = trim((string)($body['sender_name'] ?? 'Administrator'));
    $recipientPhone = beanthentic_normalize_phone((string)($body['recipient_phone'] ?? ''));
    $recipientName = trim((string)($body['recipient_name'] ?? ''));
    $subject = trim((string)($body['subject'] ?? ''));
    $text = trim((string)($body['body'] ?? ''));
    $category = substr(trim((string)($body['category'] ?? 'general')), 0, 30) ?: 'general';
    $farmerId = isset($body['farmer_id']) && $body['farmer_id'] !== '' && $body['farmer_id'] !== null
        ? (int)$body['farmer_id'] : null;

    if ($recipientPhone === '') {
        json_fail('recipient_phone is required.', 400);
    }
    if ($text === '') {
        json_fail('body is required.', 400);
    }
    if ($subject === '') {
        $subject = 'Message';
    }

    $pdo = db_conn();
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS shared_messages (
          message_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          sender_role ENUM(\'admin\',\'farmer\') NOT NULL,
          sender_phone VARCHAR(32) NOT NULL,
          sender_name VARCHAR(255) NULL,
          recipient_role ENUM(\'admin\',\'farmer\') NOT NULL,
          recipient_phone VARCHAR(32) NOT NULL DEFAULT \'\',
          recipient_name VARCHAR(255) NULL,
          subject VARCHAR(300) NOT NULL,
          body TEXT NOT NULL,
          category VARCHAR(30) NOT NULL DEFAULT \'general\',
          farmer_id BIGINT UNSIGNED NULL,
          is_read TINYINT(1) NOT NULL DEFAULT 0,
          is_starred TINYINT(1) NOT NULL DEFAULT 0,
          is_archived TINYINT(1) NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          read_at DATETIME NULL,
          INDEX idx_sm_recipient (recipient_role, recipient_phone, is_read, is_archived),
          INDEX idx_sm_sender (sender_role, sender_phone),
          INDEX idx_sm_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );

    $stmt = $pdo->prepare(
        'INSERT INTO shared_messages
          (sender_role, sender_phone, sender_name, recipient_role, recipient_phone, recipient_name,
           subject, body, category, farmer_id, is_read, is_starred, is_archived)
         VALUES
          (\'admin\', ?, ?, \'farmer\', ?, ?, ?, ?, ?, ?, 0, 0, 0)'
    );
    $stmt->execute([
        $senderPhone,
        $senderName !== '' ? $senderName : 'Administrator',
        $recipientPhone,
        $recipientName,
        $subject,
        $text,
        $category,
        $farmerId,
    ]);
    $mid = (int)$pdo->lastInsertId();

    json_ok([
        'ok' => true,
        'message_id' => $mid,
        'message' => [
            'id' => $mid,
            'sender_role' => 'admin',
            'sender_phone' => $senderPhone,
            'sender_name' => $senderName !== '' ? $senderName : 'Administrator',
            'recipient_role' => 'farmer',
            'recipient_phone' => $recipientPhone,
            'recipient_name' => $recipientName,
            'subject' => $subject,
            'body' => $text,
            'category' => $category,
            'farmer_id' => $farmerId,
        ],
    ]);
} catch (Throwable $e) {
    json_fail('admin_send_message failed: ' . $e->getMessage(), 503);
}
