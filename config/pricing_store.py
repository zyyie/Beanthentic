"""Coffee pricelist, farmer self-sale flag, and price application storage."""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

import beanthentic_env
from config.production_fields import GCB_CLASSIFICATIONS, ROASTED_CLASSIFICATIONS, VARIETIES
from config.supabase_client import get_client, is_configured

VALID_VARIETIES = frozenset(VARIETIES)
VALID_BEAN_TYPES = frozenset({"gcb", "roasted"})
VALID_STATUSES = frozenset({"pending", "approved", "rejected"})

_DEFAULT_GCB_PRICES = {"liberica": 180.0, "excelsa": 170.0, "robusta": 150.0}
_DEFAULT_ROASTED_PRICES = {"liberica": 220.0, "excelsa": 210.0, "robusta": 190.0}


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_variety(value: str | None) -> str:
    v = (value or "").strip().lower()
    if v not in VALID_VARIETIES:
        raise ValueError(f"Invalid variety: {value!r}")
    return v


def _normalize_bean_type(value: str | None) -> str:
    v = (value or "gcb").strip().lower()
    aliases = {
        "green_coffee_beans": "gcb",
        "green coffee beans": "gcb",
        "green": "gcb",
        "roast": "roasted",
        "roasted_beans": "roasted",
        "roasted coffee beans": "roasted",
    }
    v = aliases.get(v, v)
    if v not in VALID_BEAN_TYPES:
        raise ValueError(f"Invalid bean_type: {value!r}")
    return v


def _normalize_classification(value: str | None) -> str:
    return (value or "").strip().lower()


def _pick(payload: dict, *keys: str) -> Any:
    for key in keys:
        if key in payload and payload.get(key) not in (None, ""):
            return payload.get(key)
    return None


def _row_to_pricelist(row: dict) -> dict:
    return {
        "price_id": int(row.get("price_id") or 0),
        "variety": str(row.get("variety") or ""),
        "bean_type": str(row.get("bean_type") or "gcb"),
        "classification": str(row.get("classification") or ""),
        "price_per_kg": float(row.get("price_per_kg") or 0),
        "currency": str(row.get("currency") or "PHP"),
        "notes": str(row.get("notes") or ""),
        "is_active": bool(row.get("is_active", True)),
        "updated_at": row.get("updated_at"),
        "created_at": row.get("created_at"),
    }


def _row_to_application(row: dict) -> dict:
    return {
        "application_id": int(row.get("application_id") or 0),
        "farmer_id": int(row.get("farmer_id") or 0),
        "variety": str(row.get("variety") or ""),
        "bean_type": str(row.get("bean_type") or "gcb"),
        "classification": str(row.get("classification") or ""),
        "quantity_kg": float(row.get("quantity_kg") or 0),
        "sale_channel": str(row.get("sale_channel") or "self_sale"),
        "requested_price_per_kg": (
            float(row["requested_price_per_kg"])
            if row.get("requested_price_per_kg") is not None
            else None
        ),
        "reference_price_per_kg": (
            float(row["reference_price_per_kg"])
            if row.get("reference_price_per_kg") is not None
            else None
        ),
        "status": str(row.get("status") or "pending"),
        "farmer_notes": str(row.get("farmer_notes") or ""),
        "admin_notes": str(row.get("admin_notes") or ""),
        "reviewed_at": row.get("reviewed_at"),
        "submitted_at": row.get("submitted_at"),
    }


def _table_columns(cur, table: str) -> set[str]:
    if beanthentic_env.is_postgresql():
        cur.execute(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = CURRENT_SCHEMA() AND table_name = %s
            """,
            (table,),
        )
    else:
        cur.execute(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = %s
            """,
            (table,),
        )
    rows = cur.fetchall()
    out: set[str] = set()
    for row in rows:
        out.add(row["column_name"] if isinstance(row, dict) else row[0])
    return out


def ensure_pricing_schema(conn) -> None:
    """Create pricing tables/columns when missing (PostgreSQL or legacy MySQL)."""
    is_pg = beanthentic_env.is_postgresql()
    with conn.cursor() as cur:
        farmer_cols = _table_columns(cur, "farmers")
        if "self_sale_enabled" not in farmer_cols:
            if is_pg:
                cur.execute(
                    "ALTER TABLE farmers ADD COLUMN IF NOT EXISTS self_sale_enabled BOOLEAN NOT NULL DEFAULT FALSE"
                )
            else:
                cur.execute(
                    "ALTER TABLE farmers ADD COLUMN self_sale_enabled TINYINT(1) NOT NULL DEFAULT 0"
                )

        if is_pg:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS coffee_pricelist (
                  price_id SERIAL PRIMARY KEY,
                  variety VARCHAR(32) NOT NULL,
                  bean_type VARCHAR(32) NOT NULL DEFAULT 'gcb',
                  classification VARCHAR(64) NOT NULL DEFAULT '',
                  price_per_kg NUMERIC(10, 2) NOT NULL,
                  currency VARCHAR(8) NOT NULL DEFAULT 'PHP',
                  notes TEXT,
                  is_active BOOLEAN NOT NULL DEFAULT TRUE,
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  UNIQUE (variety, bean_type, classification)
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS farmer_price_application (
                  application_id SERIAL PRIMARY KEY,
                  farmer_id INT NOT NULL REFERENCES farmers (farmer_id) ON DELETE CASCADE,
                  variety VARCHAR(32) NOT NULL,
                  bean_type VARCHAR(32) NOT NULL DEFAULT 'gcb',
                  classification VARCHAR(64) NOT NULL DEFAULT '',
                  quantity_kg NUMERIC(10, 2) NOT NULL,
                  sale_channel VARCHAR(32) NOT NULL DEFAULT 'self_sale',
                  requested_price_per_kg NUMERIC(10, 2),
                  reference_price_per_kg NUMERIC(10, 2),
                  status VARCHAR(32) NOT NULL DEFAULT 'pending',
                  farmer_notes TEXT,
                  admin_notes TEXT,
                  reviewed_at TIMESTAMPTZ,
                  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
        else:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS coffee_pricelist (
                  price_id INT AUTO_INCREMENT PRIMARY KEY,
                  variety VARCHAR(32) NOT NULL,
                  bean_type VARCHAR(32) NOT NULL DEFAULT 'gcb',
                  classification VARCHAR(64) NOT NULL DEFAULT '',
                  price_per_kg DECIMAL(10, 2) NOT NULL,
                  currency VARCHAR(8) NOT NULL DEFAULT 'PHP',
                  notes TEXT,
                  is_active TINYINT(1) NOT NULL DEFAULT 1,
                  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  UNIQUE KEY uq_pricelist (variety, bean_type, classification)
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS farmer_price_application (
                  application_id INT AUTO_INCREMENT PRIMARY KEY,
                  farmer_id INT NOT NULL,
                  variety VARCHAR(32) NOT NULL,
                  bean_type VARCHAR(32) NOT NULL DEFAULT 'gcb',
                  classification VARCHAR(64) NOT NULL DEFAULT '',
                  quantity_kg DECIMAL(10, 2) NOT NULL,
                  sale_channel VARCHAR(32) NOT NULL DEFAULT 'self_sale',
                  requested_price_per_kg DECIMAL(10, 2) NULL,
                  reference_price_per_kg DECIMAL(10, 2) NULL,
                  status VARCHAR(32) NOT NULL DEFAULT 'pending',
                  farmer_notes TEXT,
                  admin_notes TEXT,
                  reviewed_at DATETIME NULL,
                  submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  INDEX idx_fpa_farmer (farmer_id),
                  INDEX idx_fpa_status (status, submitted_at)
                )
                """
            )
    conn.commit()
    seed_default_pricelist(conn)


def seed_default_pricelist(conn) -> None:
    """Ensure exactly one active official price row per coffee variety."""
    with conn.cursor() as cur:
        for variety in VARIETIES:
            cur.execute(
                """
                SELECT price_id FROM coffee_pricelist
                WHERE variety = %s AND is_active = TRUE
                ORDER BY
                  CASE WHEN COALESCE(classification, '') = '' THEN 0 ELSE 1 END,
                  CASE WHEN bean_type = 'gcb' THEN 0 ELSE 1 END,
                  price_id ASC
                """,
                (variety,),
            )
            rows = cur.fetchall() or []
            if not rows:
                cur.execute(
                    """
                    INSERT INTO coffee_pricelist (variety, bean_type, classification, price_per_kg, notes)
                    VALUES (%s, 'gcb', '', %s, %s)
                    """,
                    (
                        variety,
                        _DEFAULT_GCB_PRICES[variety],
                        "Official drop-off reference price",
                    ),
                )
                continue
            for r in rows[1:]:
                pid = int(r["price_id"] if isinstance(r, dict) else r[0])
                cur.execute(
                    "UPDATE coffee_pricelist SET is_active = FALSE WHERE price_id = %s",
                    (pid,),
                )
    conn.commit()


def _seed_default_pricelist_rest_if_empty() -> None:
    """REST fallback: one active official row per variety only."""
    if not is_configured():
        return
    try:
        client = get_client()
        existing = (
            client.table("coffee_pricelist")
            .select("price_id,variety,bean_type,classification,is_active")
            .execute()
        )
        rows = [r for r in (existing.data or []) if isinstance(r, dict)]
        by_variety: dict[str, list[dict]] = {v: [] for v in VARIETIES}
        for r in rows:
            v = str(r.get("variety") or "").strip().lower()
            if v in by_variety and bool(r.get("is_active", True)):
                by_variety[v].append(r)

        # Already canonical (exactly one active row per variety) — skip writes.
        if all(len(by_variety[v]) == 1 for v in VARIETIES):
            return

        to_insert: list[dict[str, Any]] = []
        for variety in VARIETIES:
            active = by_variety.get(variety) or []
            if not active:
                to_insert.append(
                    {
                        "variety": variety,
                        "bean_type": "gcb",
                        "classification": "",
                        "price_per_kg": _DEFAULT_GCB_PRICES[variety],
                        "currency": "PHP",
                        "notes": "Official drop-off reference price",
                        "is_active": True,
                        "updated_at": _utc_now_iso(),
                        "created_at": _utc_now_iso(),
                    }
                )
                continue
            active_sorted = sorted(
                active,
                key=lambda r: (
                    0 if not str(r.get("classification") or "").strip() else 1,
                    0 if str(r.get("bean_type") or "") == "gcb" else 1,
                    int(r.get("price_id") or 0),
                ),
            )
            for extra in active_sorted[1:]:
                pid = int(extra.get("price_id") or 0)
                if pid > 0:
                    client.table("coffee_pricelist").update(
                        {"is_active": False, "updated_at": _utc_now_iso()}
                    ).eq("price_id", pid).execute()

        if to_insert:
            client.table("coffee_pricelist").insert(to_insert).execute()
    except Exception as exc:
        print(f"[Beanthentic] pricelist seed skipped: {exc}")
        return


def list_pricelist(*, active_only: bool = True) -> list[dict]:
    if not is_configured():
        return []
    try:
        _seed_default_pricelist_rest_if_empty()
    except Exception:
        pass
    client = get_client()
    last_exc: Exception | None = None
    resp = None
    for attempt in range(3):
        try:
            q = client.table("coffee_pricelist").select("*").order("variety").order("bean_type")
            if active_only:
                q = q.eq("is_active", True)
            resp = q.execute()
            last_exc = None
            break
        except Exception as exc:
            last_exc = exc
            # Transient httpx / socket errors (e.g. errno 35 on macOS).
            if attempt < 2:
                time.sleep(0.25 * (attempt + 1))
                continue
            raise
    if last_exc is not None:
        raise last_exc
    rows = [_row_to_pricelist(r) for r in (resp.data or []) if isinstance(r, dict)]
    # Official admin list should expose one row per variety.
    if active_only:
        by_variety: dict[str, dict] = {}
        for row in sorted(rows, key=lambda r: (r["variety"], r["bean_type"], r["classification"])):
            v = row["variety"]
            if v not in by_variety:
                by_variety[v] = row
        rows = [by_variety[v] for v in VARIETIES if v in by_variety]
    else:
        rows.sort(key=lambda r: (r["variety"], r["bean_type"], r["classification"]))
    return rows


def _lookup_reference_price(
    variety: str,
    bean_type: str,
    classification: str,
) -> float | None:
    items = list_pricelist(active_only=True)
    cls = _normalize_classification(classification)
    exact = next(
        (
            i
            for i in items
            if i["variety"] == variety
            and i["bean_type"] == bean_type
            and i["classification"] == cls
        ),
        None,
    )
    if exact:
        return exact["price_per_kg"]
    fallback = next(
        (
            i
            for i in items
            if i["variety"] == variety and i["bean_type"] == bean_type and not i["classification"]
        ),
        None,
    )
    if fallback:
        return fallback["price_per_kg"]
    any_variety = next((i for i in items if i["variety"] == variety), None)
    return any_variety["price_per_kg"] if any_variety else None


def upsert_pricelist(data: dict) -> dict:
    variety = _normalize_variety(data.get("variety"))
    bean_type = _normalize_bean_type(data.get("bean_type"))
    classification = _normalize_classification(data.get("classification"))
    price = float(data.get("price_per_kg") or 0)
    if price <= 0:
        raise ValueError("price_per_kg must be greater than zero.")

    payload = {
        "variety": variety,
        "bean_type": bean_type,
        "classification": classification,
        "price_per_kg": price,
        "currency": str(data.get("currency") or "PHP").strip() or "PHP",
        "notes": str(data.get("notes") or "").strip(),
        "is_active": bool(data.get("is_active", True)),
        "updated_at": _utc_now_iso(),
    }
    client = get_client()
    price_id = int(data.get("price_id") or 0)
    if price_id < 1:
        raise ValueError("Official pricelist rows cannot be added. Edit an existing variety row.")

    # Keep variety locked to the existing row (no swapping varieties / duplicates).
    current = (
        client.table("coffee_pricelist")
        .select("price_id,variety")
        .eq("price_id", price_id)
        .limit(1)
        .execute()
    )
    current_rows = current.data or []
    if not current_rows:
        raise ValueError("Pricelist row not found.")
    locked_variety = str(current_rows[0].get("variety") or "").strip().lower()
    if locked_variety and locked_variety != variety:
        raise ValueError("Variety cannot be changed. Edit classification/price on this row only.")
    payload["variety"] = locked_variety or variety

    clash = (
        client.table("coffee_pricelist")
        .select("price_id")
        .eq("variety", payload["variety"])
        .eq("classification", classification)
        .eq("is_active", True)
        .neq("price_id", price_id)
        .limit(1)
        .execute()
    )
    if clash.data:
        raise ValueError(
            f"A pricelist row for {payload['variety']} with this classification already exists. "
            "Edit that row instead of duplicating."
        )

    resp = client.table("coffee_pricelist").update(payload).eq("price_id", price_id).execute()
    row = (resp.data or [{}])[0] if resp.data else {**payload, "price_id": price_id}
    return _row_to_pricelist(row if isinstance(row, dict) else payload)


def deactivate_pricelist(price_id: int) -> bool:
    client = get_client()
    resp = (
        client.table("coffee_pricelist")
        .update({"is_active": False, "updated_at": _utc_now_iso()})
        .eq("price_id", price_id)
        .execute()
    )
    return bool(resp.data)


def set_farmer_self_sale(farmer_id: int, enabled: bool) -> bool:
    client = get_client()
    resp = (
        client.table("farmers")
        .update({"self_sale_enabled": bool(enabled)})
        .eq("farmer_id", farmer_id)
        .execute()
    )
    return bool(resp.data)


def get_farmer_self_sale(farmer_id: int) -> bool:
    client = get_client()
    resp = (
        client.table("farmers")
        .select("self_sale_enabled")
        .eq("farmer_id", farmer_id)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    if not rows:
        return False
    return bool(rows[0].get("self_sale_enabled"))


def list_price_applications(
    *,
    farmer_id: int | None = None,
    status: str | None = None,
    limit: int = 200,
) -> list[dict]:
    client = get_client()
    q = (
        client.table("farmer_price_application")
        .select("*")
        .order("submitted_at", desc=True)
        .limit(max(1, min(limit, 500)))
    )
    if farmer_id and farmer_id > 0:
        q = q.eq("farmer_id", farmer_id)
    if status:
        st = status.strip().lower()
        if st in VALID_STATUSES:
            q = q.eq("status", st)
    resp = q.execute()
    return [_row_to_application(r) for r in (resp.data or []) if isinstance(r, dict)]


def submit_price_application(data: dict) -> dict:
    farmer_id = int(_pick(data, "farmer_id", "farmer_no", "id") or 0)
    if farmer_id < 1:
        raise ValueError("farmer_id is required.")
    if not get_farmer_self_sale(farmer_id):
        raise ValueError("Self-sale is not enabled for this farmer. Contact the admin.")

    variety = _normalize_variety(_pick(data, "variety", "coffee_variety"))
    bean_type = _normalize_bean_type(_pick(data, "bean_type", "type", "coffee_type"))
    classification = _normalize_classification(_pick(data, "classification", "bean_classification", "class"))
    qty = float(_pick(data, "quantity_kg", "qty_kg", "quantity", "amount_kg") or 0)
    if qty <= 0:
        raise ValueError("quantity_kg must be greater than zero.")

    requested = _pick(data, "requested_price_per_kg", "requested_price", "price_per_kg", "ask_price_per_kg")
    requested_price = float(requested) if requested is not None and str(requested).strip() != "" else None
    if requested_price is not None and requested_price <= 0:
        raise ValueError("requested_price_per_kg must be greater than zero when provided.")

    reference = _lookup_reference_price(variety, bean_type, classification)
    sale_channel = str(_pick(data, "sale_channel", "channel") or "self_sale").strip().lower() or "self_sale"
    farmer_notes = str(_pick(data, "farmer_notes", "notes", "message") or "").strip()
    payload = {
        "farmer_id": farmer_id,
        "variety": variety,
        "bean_type": bean_type,
        "classification": classification,
        "quantity_kg": qty,
        "sale_channel": sale_channel,
        "requested_price_per_kg": requested_price,
        "reference_price_per_kg": reference,
        "status": "pending",
        "farmer_notes": farmer_notes,
        "submitted_at": _utc_now_iso(),
    }
    client = get_client()
    resp = client.table("farmer_price_application").insert(payload).execute()
    row = (resp.data or [{}])[0]
    return _row_to_application(row if isinstance(row, dict) else payload)


def review_price_application(application_id: int, *, status: str, admin_notes: str = "") -> dict | None:
    st = (status or "").strip().lower()
    if st not in {"approved", "rejected"}:
        raise ValueError("status must be approved or rejected.")
    client = get_client()
    payload = {
        "status": st,
        "admin_notes": str(admin_notes or "").strip(),
        "reviewed_at": _utc_now_iso(),
    }
    resp = (
        client.table("farmer_price_application")
        .update(payload)
        .eq("application_id", application_id)
        .execute()
    )
    rows = resp.data or []
    if not rows:
        return None
    return _row_to_application(rows[0] if isinstance(rows[0], dict) else payload)


def classification_options() -> dict[str, list[str]]:
    return {
        "gcb": list(GCB_CLASSIFICATIONS),
        "roasted": list(ROASTED_CLASSIFICATIONS),
        "varieties": list(VARIETIES),
        "bean_types": list(VALID_BEAN_TYPES),
    }
