import os
import psycopg2

ref = "jvxvxdyrfsgtesazqjqo"
conn = psycopg2.connect(
    host=os.getenv("BEANTHENTIC_DB_HOST"),
    port=5432,
    user=f"postgres.{ref}",
    password=os.getenv("BEANTHENTIC_DB_PASS"),
    dbname="postgres",
    connect_timeout=15,
)
cur = conn.cursor()
cur.execute("SELECT COUNT(*) FROM gi_updates WHERE current_phase='admin_submission'")
print("count", cur.fetchone()[0])
cur.execute(
    """
    SELECT gi_update_id, farmer_id, category, title
    FROM gi_updates WHERE current_phase='admin_submission'
    ORDER BY gi_update_id DESC LIMIT 8
    """
)
for r in cur.fetchall():
    print(r)
conn.close()
