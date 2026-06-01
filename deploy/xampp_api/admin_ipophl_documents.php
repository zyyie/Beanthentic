<?php
/**
 * Beanthentic-App HTTP bridge for admin IPOPHL / document_analysis (ML metadata).
 * Copy to: Beanthentic-App/api/admin_ipophl_documents.php on the XAMPP device.
 * Uses local MySQL (127.0.0.1) — same pattern as admin_farmer_data.php.
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

function respond(bool $ok, array $data = []): void
{
    echo json_encode($ok ? array_merge(['ok' => true], $data) : array_merge(['ok' => false, 'error' => $data['error'] ?? 'error'], $data));
    exit;
}

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
$action = strtolower(trim((string)($_GET['action'] ?? 'list')));
$fileUuid = trim((string)($_GET['file_uuid'] ?? ''));
$phase = trim((string)($_GET['phase'] ?? ''));
$taskId = trim((string)($_GET['task_id'] ?? ''));
$limit = max(1, min(500, (int)($_GET['limit'] ?? 200)));

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
CREATE TABLE IF NOT EXISTS document_analysis (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  file_uuid VARCHAR(36) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  file_type VARCHAR(50) NOT NULL,
  file_size INT NOT NULL DEFAULT 0,
  ai_score INT NOT NULL DEFAULT 0,
  ai_status VARCHAR(20) NOT NULL DEFAULT 'Not Ready',
  detected_features TEXT NULL,
  missing_requirements TEXT NULL,
  analysis_method VARCHAR(50) NOT NULL DEFAULT 'rule_based',
  text_length INT NOT NULL DEFAULT 0,
  shap_analysis TEXT NULL,
  upload_timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  analysis_timestamp DATETIME NULL,
  ipophl_phase VARCHAR(50) NULL,
  task_id VARCHAR(100) NULL,
  UNIQUE KEY uq_document_file_uuid (file_uuid),
  KEY idx_document_task (task_id),
  KEY idx_document_phase (ipophl_phase),
  KEY idx_document_upload (upload_timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
");

function doc_list_item(array $row): array
{
    $ts = isset($row['upload_timestamp']) ? str_replace(' ', 'T', (string)$row['upload_timestamp']) : null;
    return [
        'file_uuid' => (string)($row['file_uuid'] ?? ''),
        'filename' => (string)($row['original_filename'] ?? ''),
        'file_type' => (string)($row['file_type'] ?? ''),
        'file_size' => (int)($row['file_size'] ?? 0),
        'upload_timestamp' => $ts,
        'ai_score' => (int)($row['ai_score'] ?? 0),
        'ai_status' => (string)($row['ai_status'] ?? 'Not Ready'),
        'ipophl_phase' => (string)($row['ipophl_phase'] ?? ''),
        'task_id' => (string)($row['task_id'] ?? ''),
    ];
}

function doc_full(array $row): array
{
    $detected = $row['detected_features'] ?? '[]';
    $missing = $row['missing_requirements'] ?? '[]';
    if (is_string($detected)) {
        $detectedList = json_decode($detected, true);
        $detected = is_array($detectedList) ? $detectedList : [];
    }
    if (is_string($missing)) {
        $missingList = json_decode($missing, true);
        $missing = is_array($missingList) ? $missingList : [];
    }
    $analysisTs = $row['analysis_timestamp'] ?? null;
    if ($analysisTs !== null && $analysisTs !== '') {
        $analysisTs = str_replace(' ', 'T', (string)$analysisTs);
    } else {
        $analysisTs = null;
    }
    return [
        'file_uuid' => (string)($row['file_uuid'] ?? ''),
        'filename' => (string)($row['original_filename'] ?? ''),
        'original_filename' => (string)($row['original_filename'] ?? ''),
        'file_path' => (string)($row['file_path'] ?? ''),
        'file_type' => (string)($row['file_type'] ?? ''),
        'file_size' => (int)($row['file_size'] ?? 0),
        'upload_timestamp' => isset($row['upload_timestamp']) ? str_replace(' ', 'T', (string)$row['upload_timestamp']) : null,
        'ipophl_phase' => (string)($row['ipophl_phase'] ?? ''),
        'task_id' => (string)($row['task_id'] ?? ''),
        'analysis' => [
            'readiness_score' => (int)($row['ai_score'] ?? 0),
            'status' => (string)($row['ai_status'] ?? 'Not Ready'),
            'detected_features' => $detected,
            'missing_requirements' => $missing,
            'analysis_method' => (string)($row['analysis_method'] ?? 'rule_based'),
            'text_length' => (int)($row['text_length'] ?? 0),
            'shap_analysis' => (string)($row['shap_analysis'] ?? ''),
            'analysis_timestamp' => $analysisTs,
        ],
    ];
}

if ($action === 'upsert' && $method === 'POST') {
    $raw = file_get_contents('php://input') ?: '';
    $body = json_decode($raw, true);
    if (!is_array($body)) {
        respond(false, ['error' => 'INVALID_JSON']);
    }
    $uuid = trim((string)($body['file_uuid'] ?? ''));
    if ($uuid === '' || !preg_match('/^[0-9a-fA-F-]{36}$/', $uuid)) {
        respond(false, ['error' => 'INVALID_UUID']);
    }
    $originalFilename = substr(trim((string)($body['original_filename'] ?? 'document')), 0, 255);
    $filePath = substr(trim((string)($body['file_path'] ?? '')), 0, 500);
    $fileType = substr(trim((string)($body['file_type'] ?? '')), 0, 50);
    $fileSize = (int)($body['file_size'] ?? 0);
    $aiScore = (int)($body['ai_score'] ?? 0);
    $aiStatus = substr(trim((string)($body['ai_status'] ?? 'Not Ready')), 0, 20);
    $analysisMethod = substr(trim((string)($body['analysis_method'] ?? 'rule_based')), 0, 50);
    $textLength = (int)($body['text_length'] ?? 0);
    $shap = (string)($body['shap_analysis'] ?? '');
    $ipophlPhase = substr(trim((string)($body['ipophl_phase'] ?? '')), 0, 50);
    $taskIdVal = substr(trim((string)($body['task_id'] ?? '')), 0, 100);

    $detected = $body['detected_features'] ?? [];
    $missing = $body['missing_requirements'] ?? [];
    if (is_string($detected)) {
        $detectedJson = $detected;
    } else {
        $detectedJson = json_encode(is_array($detected) ? $detected : [], JSON_UNESCAPED_UNICODE);
    }
    if (is_string($missing)) {
        $missingJson = $missing;
    } else {
        $missingJson = json_encode(is_array($missing) ? $missing : [], JSON_UNESCAPED_UNICODE);
    }

    $analysisTs = trim((string)($body['analysis_timestamp'] ?? ''));
    if ($analysisTs === '') {
        $analysisTs = gmdate('Y-m-d H:i:s');
    } else {
        $analysisTs = str_replace('T', ' ', substr($analysisTs, 0, 19));
    }

    $stmt = $mysqli->prepare("
        INSERT INTO document_analysis (
          file_uuid, original_filename, file_path, file_type, file_size,
          ai_score, ai_status, detected_features, missing_requirements,
          analysis_method, text_length, shap_analysis,
          upload_timestamp, analysis_timestamp, ipophl_phase, task_id
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          COALESCE(NULLIF(?, ''), NOW()), ?, ?, ?
        )
        ON DUPLICATE KEY UPDATE
          original_filename = VALUES(original_filename),
          file_path = VALUES(file_path),
          file_type = VALUES(file_type),
          file_size = VALUES(file_size),
          ai_score = VALUES(ai_score),
          ai_status = VALUES(ai_status),
          detected_features = VALUES(detected_features),
          missing_requirements = VALUES(missing_requirements),
          analysis_method = VALUES(analysis_method),
          text_length = VALUES(text_length),
          shap_analysis = VALUES(shap_analysis),
          analysis_timestamp = VALUES(analysis_timestamp),
          ipophl_phase = VALUES(ipophl_phase),
          task_id = VALUES(task_id)
    ");
    if (!$stmt) {
        respond(false, ['error' => 'PREPARE_FAILED', 'detail' => $mysqli->error]);
    }
    $uploadTs = trim((string)($body['upload_timestamp'] ?? ''));
    $uploadTs = $uploadTs !== '' ? str_replace('T', ' ', substr($uploadTs, 0, 19)) : '';
    $stmt->bind_param(
        'ssssiiissssissss',
        $uuid,
        $originalFilename,
        $filePath,
        $fileType,
        $fileSize,
        $aiScore,
        $aiStatus,
        $detectedJson,
        $missingJson,
        $analysisMethod,
        $textLength,
        $shap,
        $uploadTs,
        $analysisTs,
        $ipophlPhase,
        $taskIdVal
    );
    if (!$stmt->execute()) {
        respond(false, ['error' => 'UPSERT_FAILED', 'detail' => $stmt->error]);
    }
    $stmt->close();
    respond(true, ['file_uuid' => $uuid]);
}

if ($action === 'delete') {
    if ($fileUuid === '' || !preg_match('/^[0-9a-fA-F-]{36}$/', $fileUuid)) {
        respond(false, ['error' => 'INVALID_UUID']);
    }
    $stmt = $mysqli->prepare('DELETE FROM document_analysis WHERE file_uuid = ? LIMIT 1');
    if (!$stmt) {
        respond(false, ['error' => 'PREPARE_FAILED']);
    }
    $stmt->bind_param('s', $fileUuid);
    $stmt->execute();
    $affected = $stmt->affected_rows;
    $stmt->close();
    if ($affected < 1) {
        respond(false, ['error' => 'NOT_FOUND']);
    }
    respond(true, ['deleted' => true]);
}

if ($action === 'get') {
    if ($fileUuid === '' || !preg_match('/^[0-9a-fA-F-]{36}$/', $fileUuid)) {
        respond(false, ['error' => 'INVALID_UUID']);
    }
    $stmt = $mysqli->prepare('SELECT * FROM document_analysis WHERE file_uuid = ? LIMIT 1');
    if (!$stmt) {
        respond(false, ['error' => 'PREPARE_FAILED']);
    }
    $stmt->bind_param('s', $fileUuid);
    $stmt->execute();
    $res = $stmt->get_result();
    $row = $res ? $res->fetch_assoc() : null;
    $stmt->close();
    if (!$row) {
        respond(false, ['error' => 'NOT_FOUND']);
    }
    respond(true, ['document' => doc_full($row)]);
}

if ($action === 'list') {
    $where = [];
    $types = '';
    $args = [];
    if ($phase !== '') {
        $where[] = 'ipophl_phase = ?';
        $types .= 's';
        $args[] = $phase;
    }
    if ($taskId !== '') {
        $where[] = 'task_id = ?';
        $types .= 's';
        $args[] = $taskId;
    }
    $sql = 'SELECT * FROM document_analysis';
    if ($where) {
        $sql .= ' WHERE ' . implode(' AND ', $where);
    }
    $sql .= ' ORDER BY upload_timestamp DESC LIMIT ?';
    $types .= 'i';
    $args[] = $limit;

    $stmt = $mysqli->prepare($sql);
    if (!$stmt) {
        respond(false, ['error' => 'PREPARE_FAILED', 'detail' => $mysqli->error]);
    }
    if ($types !== '') {
        $stmt->bind_param($types, ...$args);
    }
    $stmt->execute();
    $res = $stmt->get_result();
    $items = [];
    while ($row = $res->fetch_assoc()) {
        $items[] = doc_list_item($row);
    }
    $stmt->close();
    respond(true, ['items' => $items, 'count' => count($items)]);
}

respond(false, ['error' => 'UNKNOWN_ACTION']);
