<?php
declare(strict_types=1);
/**
 * Shared PDO connection for Beanthentic-App admin API bridges.
 * Supports both MySQL and PostgreSQL/Supabase.
 * Copy to: Beanthentic-App/api/db.php
 */

function db_conn(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }
    
    // First check for full database URL (for Supabase)
    $db_url = getenv('BEANTHENTIC_DB_URL');
    if ($db_url) {
        $pdo = new PDO($db_url, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        return $pdo;
    }
    
    // Fall back to individual parameters
    $db_type = getenv('BEANTHENTIC_DB_TYPE') ?: 'postgresql';
    $host = getenv('BEANTHENTIC_DB_HOST') ?: '127.0.0.1';
    $port = (int)(getenv('BEANTHENTIC_DB_PORT') ?: ($db_type === 'postgresql' ? 5432 : 3306));
    $name = getenv('BEANTHENTIC_DB_NAME') ?: ($db_type === 'postgresql' ? 'postgres' : 'beanthentic_app');
    $user = getenv('BEANTHENTIC_DB_USER') ?: ($db_type === 'postgresql' ? 'postgres' : 'root');
    $pass = getenv('BEANTHENTIC_DB_PASS') ?: '';
    
    if ($db_type === 'postgresql') {
        $dsn = "pgsql:host={$host};port={$port};dbname={$name};user={$user};password={$pass}";
    } else {
        $dsn = "mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4";
    }
    
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
