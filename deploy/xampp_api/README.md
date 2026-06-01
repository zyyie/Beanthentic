# XAMPP API bridges (copy to Beanthentic-App)

Copy each PHP file to **`Beanthentic-App/api/`** on the PC running XAMPP and `python app.py` on port **8080**.

| File | Purpose |
|------|---------|
| `admin_shared_messages.php` | Messages / `shared_messages` (read) |
| `admin_send_message.php` | Admin → farmer message send |
| `admin_gi_send.php` | GI broadcast multipart upload |
| `admin_ipophl_documents.php` | IPOPHL ML metadata / `document_analysis` |

Ensure `settings.json` on the admin web has:

- `app_server_base`: `http://<XAMPP-LAN-IP>:8080`
- `app_db_host`: LAN IP of the XAMPP PC (optional if HTTP bridges are deployed)

After copying, verify in a browser:

`http://<XAMPP-LAN-IP>:8080/api/admin_ipophl_documents.php?action=list&limit=5`

Expected: `{"ok":true,"items":[...],...}`
