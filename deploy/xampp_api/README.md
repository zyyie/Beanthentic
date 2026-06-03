# XAMPP API bridges (copy to Beanthentic-App)

Copy each PHP file to **`Beanthentic-App/api/`** on the PC running XAMPP and `python app.py` on port **8080**.

| File | Purpose |
|------|---------|
| `db.php` | Shared PDO connection for GI bridges |
| `gi_updates_lib.php` | Multipart file collect/save (`files[]` — all attachments kept) |
| `admin_shared_messages.php` | Messages / `shared_messages` (read) |
| `admin_send_message.php` | Admin → farmer message send |
| `admin_gi_send.php` | GI broadcast multipart upload |
| `admin_farmer_data.php` | Farmer list for GI broadcast (required for connection preflight) |
| `admin_gi_sync_files.php` | Copy attachments to app server for MySQL-only admin path |
| `gi_attachment.php` | CORS-safe attachment fetch for mobile PDF/DOCX previews |
| `admin_ipophl_documents.php` | IPOPHL ML metadata / `document_analysis` |

Ensure `settings.json` on the admin web has:

- `app_server_base`: `http://<XAMPP-LAN-IP>:8080`
- `app_db_host`: LAN IP of the XAMPP PC (optional if HTTP bridges are deployed)

After copying, verify in a browser:

`http://<XAMPP-LAN-IP>:8080/api/admin_ipophl_documents.php?action=list&limit=5`

Expected: `{"ok":true,"items":[...],...}`
