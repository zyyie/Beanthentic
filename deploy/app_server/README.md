# App server bridges (port 8080)

The Beanthentic mobile app runs `python app.py` on port **8080**. Copying only `.php` files into an `api` folder gives **404** or **raw PHP text** — Flask does not run those files unless you register Python routes.

## Automatic install (recommended)

On the **app server PC** (the machine at `192.168.1.200`), open PowerShell:

```powershell
cd "C:\path\to\LATEST ADMIN\Beanthentic"
python scripts\install_app_server_bridges.py "C:\path\to\Beanthentic-App"
pip install psycopg2-binary pymysql
```

Stop the old server (Ctrl+C), then start again:

```powershell
cd C:\path\to\Beanthentic-App
python app.py
```

Test in a browser:

`http://192.168.1.200:8080/api/admin_farmer_photos.php`

You should see JSON like `{"ok":true,"items":[...]}`. If you still see **Not Found**, `app.py` was not patched or the server was not restarted.

## Manual install

1. Copy `admin_bridges.py` into the **Beanthentic-App** folder (same folder as `app.py`).
2. Open `app.py` and add **before** `if __name__ == "__main__":`:

```python
try:
    from admin_bridges import register_admin_bridges
    register_admin_bridges(app)
except ImportError:
    pass
```

3. `pip install psycopg2-binary pymysql`
4. Restart `python app.py`

After this, the admin dashboard will load farmer photos automatically.
