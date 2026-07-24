import os, json, importlib.util
from pathlib import Path
R = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("e", R / "beanthentic_env.py")
e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e)
e.load_dotenv(R / ".env")
import psycopg2
ref = e.supabase_project_ref()
conn = psycopg2.connect(
    host=os.getenv("BEANTHENTIC_DB_HOST"), port=5432,
    user=f"postgres.{ref}", password=os.getenv("BEANTHENTIC_DB_PASS"), dbname="postgres",
)
cur = conn.cursor()
cur.execute(
    """
    SELECT gi_farmer_contribution_id, title, content,
           attachments_json, images, gi_document, created_at
    FROM gi_farmers_contribution
    ORDER BY created_at DESC LIMIT 5
    """
)
for r in cur.fetchall():
    print("---")
    print("id", r[0], "title", (r[1] or "")[:60])
    print("attachments_json", (r[3] or "NULL")[:200])
    print("images", (r[4] or "NULL")[:200])
    print("gi_document", r[5])
conn.close()
