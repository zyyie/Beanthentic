<?php
declare(strict_types=1);
/**
 * Farmer list for admin GI publish (broadcast targets).
 * Copy to: Beanthentic-App/api/admin_farmer_data.php
 * Served by python app.py or XAMPP on the app device (:8080).
 */
require_once __DIR__ . '/db.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    http_response_code(204);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    json_fail('Method not allowed.', 405);
}

try {
    $pdo = db_conn();
    $stmt = $pdo->query(
        'SELECT f.farmer_id, u.user_id, u.username, u.phone_number
         FROM farmers f
         LEFT JOIN users u ON u.user_id = f.user_id
         WHERE f.farmer_id IS NOT NULL
         ORDER BY f.farmer_id ASC'
    );
    $items = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    json_ok(['items' => $items, 'count' => count($items)]);
} catch (Throwable $e) {
    json_fail('admin_farmer_data failed: ' . $e->getMessage(), 503);
}
