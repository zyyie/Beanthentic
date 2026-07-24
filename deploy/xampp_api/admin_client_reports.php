<?php
declare(strict_types=1);
/**
 * Client misconduct reports for admin Client Report tab.
 * Copy to: Beanthentic-App/api/admin_client_reports.php
 */
require_once __DIR__ . '/db.php';

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-HTTP-Method-Override');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
$override = strtoupper(trim((string)($_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE'] ?? '')));
if ($method === 'POST' && $override === 'PATCH') {
    $method = 'PATCH';
}

$pdo = db_conn();
$driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);

if ($driver === 'pgsql') {
    // PostgreSQL version
    $pdo->exec("
    CREATE TABLE IF NOT EXISTS client_misconduct_report (
      report_id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reporter_name VARCHAR(255) NOT NULL,
      reporter_contact VARCHAR(255) NOT NULL DEFAULT '',
      reason_category VARCHAR(255) NOT NULL,
      reason_detail VARCHAR(255) NOT NULL DEFAULT '',
      allegation TEXT NOT NULL,
      chat_json TEXT NULL,
      farmer_id BIGINT NULL,
      farmer_no VARCHAR(50) NULL,
      farmer_name VARCHAR(255) NOT NULL DEFAULT '',
      status VARCHAR(40) NOT NULL DEFAULT 'under review'
    )
    ");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_cmr_status ON client_misconduct_report(status)");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_cmr_created ON client_misconduct_report(created_at)");
} else {
    // MySQL version
    $pdo->exec("
    CREATE TABLE IF NOT EXISTS client_misconduct_report (
      report_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reporter_name VARCHAR(255) NOT NULL,
      reporter_contact VARCHAR(255) NOT NULL DEFAULT '',
      reason_category VARCHAR(255) NOT NULL,
      reason_detail VARCHAR(255) NOT NULL DEFAULT '',
      allegation TEXT NOT NULL,
      chat_json TEXT NULL,
      farmer_id BIGINT UNSIGNED NULL,
      farmer_no VARCHAR(50) NULL,
      farmer_name VARCHAR(255) NOT NULL DEFAULT '',
      status VARCHAR(40) NOT NULL DEFAULT 'under review',
      INDEX idx_cmr_status (status),
      INDEX idx_cmr_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
}

if ($method === 'PATCH') {
    $raw = file_get_contents('php://input') ?: '{}';
    $body = json_decode($raw, true);
    if (!is_array($body)) {
        json_fail('Invalid JSON body');
    }
    $reportId = (int)($body['report_id'] ?? 0);
    $status = strtolower(str_replace('_', ' ', trim((string)($body['status'] ?? ''))));
    if ($reportId < 1 || $status === '') {
        json_fail('report_id and status required');
    }
    $stmt = $pdo->prepare('UPDATE client_misconduct_report SET status = ? WHERE report_id = ?');
    $stmt->execute([$status, $reportId]);
    if ($stmt->rowCount() < 1) {
        json_fail('Report not found', 404);
    }
    $stmt = $pdo->prepare('SELECT * FROM client_misconduct_report WHERE report_id = ? LIMIT 1');
    $stmt->execute([$reportId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    json_ok(['item' => $row, 'updated' => 1]);
}

if ($method !== 'GET') {
    json_fail('Method not allowed', 405);
}

$limit = max(1, min(1000, (int)($_GET['limit'] ?? 500)));
$status = strtolower(str_replace('_', ' ', trim((string)($_GET['status'] ?? ''))));
$q = strtolower(trim((string)($_GET['q'] ?? '')));

$sql = 'SELECT * FROM client_misconduct_report WHERE 1=1';
$params = [];
if ($status !== '') {
    $sql .= ' AND LOWER(REPLACE(status, \'_\', \' \')) = ?';
    $params[] = $status;
}
$sql .= ' ORDER BY created_at DESC, report_id DESC LIMIT ?';
$params[] = $limit;

$stmt = $pdo->prepare($sql);
$stmt->execute($params);
$items = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

if ($q !== '') {
    $items = array_values(array_filter($items, static function ($row) use ($q) {
        $hay = strtolower(implode(' ', [
            (string)($row['reporter_name'] ?? ''),
            (string)($row['reporter_contact'] ?? ''),
            (string)($row['farmer_name'] ?? ''),
            (string)($row['reason_category'] ?? ''),
            (string)($row['reason_detail'] ?? ''),
            (string)($row['allegation'] ?? ''),
        ]));
        return strpos($hay, $q) !== false;
    }));
}

json_ok(['items' => $items, 'count' => count($items)]);
