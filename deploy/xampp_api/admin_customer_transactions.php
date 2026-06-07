<?php
declare(strict_types=1);
/**
 * Approved/sent customer_transaction rows for admin Transactions tab.
 * Copy to: Beanthentic-App/api/admin_customer_transactions.php
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

$limit = max(1, min(800, (int)($_GET['limit'] ?? 500)));
$farmerId = (int)($_GET['farmer_id'] ?? 0);

try {
    $pdo = db_conn();
    $sql = "
        SELECT
          ct.customer_transaction_id,
          ct.farmer_id,
          ct.buyer_name,
          ct.product,
          ct.quantity,
          ct.amount,
          ct.payment_amount,
          ct.payment_method,
          ct.reference_no,
          ct.transaction_date,
          f.farm_code,
          u.username,
          u.phone_number,
          pi.first_name,
          pi.last_name,
          (
            SELECT th.status
            FROM transaction_history th
            WHERE th.customer_transaction_id = ct.customer_transaction_id
            ORDER BY th.transaction_history_id DESC
            LIMIT 1
          ) AS current_status,
          (
            SELECT th.created_at
            FROM transaction_history th
            WHERE th.customer_transaction_id = ct.customer_transaction_id
              AND th.status = 'approved'
            ORDER BY th.transaction_history_id ASC
            LIMIT 1
          ) AS approved_at
        FROM customer_transaction ct
        LEFT JOIN farmers f ON f.farmer_id = ct.farmer_id
        LEFT JOIN users u ON u.user_id = f.user_id
        LEFT JOIN personal_information pi ON pi.farmer_id = f.farmer_id
        WHERE (
          SELECT th.status
          FROM transaction_history th
          WHERE th.customer_transaction_id = ct.customer_transaction_id
          ORDER BY th.transaction_history_id DESC
          LIMIT 1
        ) IN ('approved', 'sent_to_client')
    ";
  $params = [];
    if ($farmerId > 0) {
        $sql .= ' AND ct.farmer_id = ?';
        $params[] = $farmerId;
    }
    $sql .= ' ORDER BY COALESCE(approved_at, ct.transaction_date) DESC, ct.customer_transaction_id DESC LIMIT ?';
    $params[] = $limit;

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $items = [];
    foreach ($rows as $r) {
        $fn = trim((string)($r['first_name'] ?? ''));
        $ln = trim((string)($r['last_name'] ?? ''));
        $name = trim($fn . ' ' . $ln);
        if ($name === '') {
            $name = trim((string)($r['username'] ?? '')) ?: trim((string)($r['phone_number'] ?? '')) ?: 'Farmer';
        }
        $fid = (int)($r['farmer_id'] ?? 0);
        $farmCode = trim((string)($r['farm_code'] ?? ''));
        $qty = abs((float)($r['quantity'] ?? 0));
        $product = strtolower(trim((string)($r['product'] ?? '')));
        $variety = in_array($product, ['liberica', 'excelsa', 'robusta'], true) ? $product : $product;
        $status = strtolower(trim((string)($r['current_status'] ?? 'approved')));
        $amount = (float)($r['amount'] ?? 0);
        $pay = (float)($r['payment_amount'] ?? 0);
        $tid = (int)($r['customer_transaction_id'] ?? 0);
        $at = $r['approved_at'] ?? $r['transaction_date'] ?? '';
        $items[] = [
            'id' => $tid,
            'customer_transaction_id' => $tid,
            'farmer_id' => $fid,
            'farmer_no' => $farmCode !== '' ? $farmCode : (string)$fid,
            'farmer_name' => $name,
            'recorded_at' => $at ? str_replace(' ', 'T', (string)$at) : '',
            'variety' => $variety,
            'product' => ucfirst($variety),
            'qty' => $qty,
            'unit' => 'KG',
            'delta_kg' => $qty,
            'amount' => $amount,
            'total' => $amount,
            'payment_amount' => $pay,
            'payment_method' => trim((string)($r['payment_method'] ?? '')) ?: 'Cash',
            'change' => max(0.0, $pay - $amount),
            'reference_no' => trim((string)($r['reference_no'] ?? '')),
            'ref' => trim((string)($r['reference_no'] ?? '')),
            'buyer_name' => trim((string)($r['buyer_name'] ?? '')),
            'notes' => '',
            'recorded_by_phone' => '',
            'status' => $status,
            'sent_to_client' => $status === 'sent_to_client',
        ];
    }
    json_ok(['items' => $items, 'count' => count($items)]);
} catch (Throwable $e) {
    json_fail('admin_customer_transactions failed: ' . $e->getMessage(), 503);
}
