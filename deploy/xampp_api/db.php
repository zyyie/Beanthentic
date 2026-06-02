<?php
declare(strict_types=1);
/**
 * Shared PDO connection for Beanthentic-App admin API bridges.
 * Copy to: Beanthentic-App/api/db.php
 */

function db_conn(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }
    $host = getenv('BEANTHENTIC_DB_HOST') ?: '127.0.0.1';
    $port = (int)(getenv('BEANTHENTIC_DB_PORT') ?: 3306);
    $name = getenv('BEANTHENTIC_DB_NAME') ?: 'beanthentic_app';
    $user = getenv('BEANTHENTIC_DB_USER') ?: 'root';
    $pass = getenv('BEANTHENTIC_DB_PASS') ?: '';
    $dsn = "mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4";
    $pdo = new PDO($dsn, $user, $pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    return $pdo;
}

function json_ok(array $data = []): void
{
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(array_merge(['ok' => true], $data), JSON_UNESCAPED_UNICODE);
    exit;
}

function json_fail(string $message, int $code = 400): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => $message, 'detail' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}
