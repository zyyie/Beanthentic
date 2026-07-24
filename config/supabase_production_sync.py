"""
Sync production_information detail fields (GCB / roasted qty + classification).

Backfills legacy *_qty_kg into *_gcb_qty_kg when detail columns are empty.
Upserts classification codes from normalized app/admin payloads.
"""

from __future__ import annotations

import json
from typing import Any

from config.production_fields import (
    GCB_CLASSIFICATION_LABELS,
    PRODUCTION_DETAIL_JSON_COLUMN,
    ROASTED_CLASSIFICATION_LABELS,
    VARIETIES,
    _normalize_classification_key,
    expand_production_detail_into_row,
    gcb_classification_raw,
    gcb_qty_for_variety,
    harvest_qty_for_variety,
    merge_app_production_payload,
    production_detail_payload,
    roasted_classification_raw,
    roasted_qty_for_variety,
)


def _num(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def production_detail_update_fields(row: dict) -> dict[str, Any]:
    """Build production_information UPDATE fields from a merged farmer row."""
    merged = expand_production_detail_into_row(row)
    out: dict[str, Any] = {}
    for v in VARIETIES:
        gcb_qty = gcb_qty_for_variety(merged, v)
        roasted_qty = roasted_qty_for_variety(merged, v)
        harvest_qty = harvest_qty_for_variety(merged, v)
        gcb_code = _normalize_classification_key(
            gcb_classification_raw(merged, v), GCB_CLASSIFICATION_LABELS
        )
        roasted_code = _normalize_classification_key(
            roasted_classification_raw(merged, v), ROASTED_CLASSIFICATION_LABELS
        )

        if gcb_qty > 0:
            out[f"{v}_gcb_qty_kg"] = gcb_qty
        if roasted_qty > 0:
            out[f"{v}_roasted_qty_kg"] = roasted_qty
        if harvest_qty > 0:
            out[f"{v}_harvest_qty_kg"] = harvest_qty
        if gcb_code:
            out[f"{v}_gcb_classification"] = gcb_code
        if roasted_code:
            out[f"{v}_roasted_classification"] = roasted_code

    detail = production_detail_payload(merged)
    if detail.get("varieties"):
        out[PRODUCTION_DETAIL_JSON_COLUMN] = json.dumps(detail)
    return out


def backfill_production_detail_from_legacy(conn) -> int:
    """
    Copy legacy variety qty into detail columns when detail qty is zero.
    Returns number of rows updated.
    """
    import beanthentic_env

    postgres = beanthentic_env.is_postgresql()
    cur = conn.cursor()
    if postgres:
        sql = """
        UPDATE production_information
        SET
          liberica_gcb_qty_kg = CASE
            WHEN COALESCE(liberica_gcb_qty_kg, 0) = 0 AND COALESCE(liberica_qty_kg, 0) > 0
            THEN liberica_qty_kg ELSE liberica_gcb_qty_kg END,
          excelsa_gcb_qty_kg = CASE
            WHEN COALESCE(excelsa_gcb_qty_kg, 0) = 0 AND COALESCE(excelsa_qty_kg, 0) > 0
            THEN excelsa_qty_kg ELSE excelsa_gcb_qty_kg END,
          robusta_gcb_qty_kg = CASE
            WHEN COALESCE(robusta_gcb_qty_kg, 0) = 0 AND COALESCE(robusta_qty_kg, 0) > 0
            THEN robusta_qty_kg ELSE robusta_gcb_qty_kg END,
          liberica_roasted_qty_kg = CASE
            WHEN COALESCE(liberica_roasted_qty_kg, 0) = 0 AND COALESCE(liberica_qty_kg, 0) > 0
            THEN ROUND((liberica_qty_kg * 0.78)::numeric, 2) ELSE liberica_roasted_qty_kg END,
          excelsa_roasted_qty_kg = CASE
            WHEN COALESCE(excelsa_roasted_qty_kg, 0) = 0 AND COALESCE(excelsa_qty_kg, 0) > 0
            THEN ROUND((excelsa_qty_kg * 0.78)::numeric, 2) ELSE excelsa_roasted_qty_kg END,
          robusta_roasted_qty_kg = CASE
            WHEN COALESCE(robusta_roasted_qty_kg, 0) = 0 AND COALESCE(robusta_qty_kg, 0) > 0
            THEN ROUND((robusta_qty_kg * 0.78)::numeric, 2) ELSE robusta_roasted_qty_kg END
        WHERE
          (COALESCE(liberica_gcb_qty_kg, 0) = 0 AND COALESCE(liberica_qty_kg, 0) > 0)
          OR (COALESCE(excelsa_gcb_qty_kg, 0) = 0 AND COALESCE(excelsa_qty_kg, 0) > 0)
          OR (COALESCE(robusta_gcb_qty_kg, 0) = 0 AND COALESCE(robusta_qty_kg, 0) > 0)
          OR (COALESCE(liberica_roasted_qty_kg, 0) = 0 AND COALESCE(liberica_qty_kg, 0) > 0)
          OR (COALESCE(excelsa_roasted_qty_kg, 0) = 0 AND COALESCE(excelsa_qty_kg, 0) > 0)
          OR (COALESCE(robusta_roasted_qty_kg, 0) = 0 AND COALESCE(robusta_qty_kg, 0) > 0)
        """
    else:
        sql = """
        UPDATE production_information
        SET
          liberica_gcb_qty_kg = IF(
            COALESCE(liberica_gcb_qty_kg, 0) = 0 AND COALESCE(liberica_qty_kg, 0) > 0,
            liberica_qty_kg, liberica_gcb_qty_kg),
          excelsa_gcb_qty_kg = IF(
            COALESCE(excelsa_gcb_qty_kg, 0) = 0 AND COALESCE(excelsa_qty_kg, 0) > 0,
            excelsa_qty_kg, excelsa_gcb_qty_kg),
          robusta_gcb_qty_kg = IF(
            COALESCE(robusta_gcb_qty_kg, 0) = 0 AND COALESCE(robusta_qty_kg, 0) > 0,
            robusta_qty_kg, robusta_gcb_qty_kg),
          liberica_roasted_qty_kg = IF(
            COALESCE(liberica_roasted_qty_kg, 0) = 0 AND COALESCE(liberica_qty_kg, 0) > 0,
            ROUND(liberica_qty_kg * 0.78, 2), liberica_roasted_qty_kg),
          excelsa_roasted_qty_kg = IF(
            COALESCE(excelsa_roasted_qty_kg, 0) = 0 AND COALESCE(excelsa_qty_kg, 0) > 0,
            ROUND(excelsa_qty_kg * 0.78, 2), excelsa_roasted_qty_kg),
          robusta_roasted_qty_kg = IF(
            COALESCE(robusta_roasted_qty_kg, 0) = 0 AND COALESCE(robusta_qty_kg, 0) > 0,
            ROUND(robusta_qty_kg * 0.78, 2), robusta_roasted_qty_kg)
        WHERE
          (COALESCE(liberica_gcb_qty_kg, 0) = 0 AND COALESCE(liberica_qty_kg, 0) > 0)
          OR (COALESCE(excelsa_gcb_qty_kg, 0) = 0 AND COALESCE(excelsa_qty_kg, 0) > 0)
          OR (COALESCE(robusta_gcb_qty_kg, 0) = 0 AND COALESCE(robusta_qty_kg, 0) > 0)
          OR (COALESCE(liberica_roasted_qty_kg, 0) = 0 AND COALESCE(liberica_qty_kg, 0) > 0)
          OR (COALESCE(excelsa_roasted_qty_kg, 0) = 0 AND COALESCE(excelsa_qty_kg, 0) > 0)
          OR (COALESCE(robusta_roasted_qty_kg, 0) = 0 AND COALESCE(robusta_qty_kg, 0) > 0)
        """
    cur.execute(sql)
    updated = int(getattr(cur, "rowcount", 0) or 0)
    try:
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
    try:
        cur.close()
    except Exception:
        pass
    return updated


def backfill_production_classifications_from_detail(conn) -> int:
    """
    Flatten production_detail JSON into *_gcb_classification / *_roasted_classification.
    Returns number of rows updated.
    """
    import beanthentic_env

    if not beanthentic_env.is_postgresql():
        return 0

    cur = conn.cursor()
    cur.execute(
        f"""
        SELECT production_info_id, farmer_id, {PRODUCTION_DETAIL_JSON_COLUMN}
        FROM production_information
        WHERE {PRODUCTION_DETAIL_JSON_COLUMN} IS NOT NULL
        """
    )
    rows = cur.fetchall() or []
    updated = 0
    for row in rows:
        if hasattr(row, "get"):
            prod_id = row.get("production_info_id")
            detail_raw = row.get(PRODUCTION_DETAIL_JSON_COLUMN)
        else:
            prod_id, _, detail_raw = row[0], row[1], row[2]
        merged = expand_production_detail_into_row({PRODUCTION_DETAIL_JSON_COLUMN: detail_raw})
        fields = production_detail_update_fields(merged)
        class_fields = {
            k: v
            for k, v in fields.items()
            if k.endswith("_classification") or k == PRODUCTION_DETAIL_JSON_COLUMN
        }
        if not class_fields:
            continue
        set_clause = ", ".join(f"{col} = %s" for col in class_fields)
        values = list(class_fields.values()) + [prod_id]
        cur.execute(
            f"UPDATE production_information SET {set_clause} WHERE production_info_id = %s",
            values,
        )
        updated += 1

    try:
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        updated = 0
    try:
        cur.close()
    except Exception:
        pass
    return updated


def upsert_production_detail(conn, farmer_id: int, payload: dict) -> bool:
    """Upsert detail fields for the latest production_information row of a farmer."""
    fid = int(farmer_id or 0)
    if fid < 1 or not isinstance(payload, dict):
        return False

    cur = conn.cursor()
    cur.execute(
        """
        SELECT production_info_id, production_year
        FROM production_information
        WHERE farmer_id = %s
        ORDER BY production_year DESC NULLS LAST, production_info_id DESC
        LIMIT 1
        """,
        (fid,),
    )
    row = cur.fetchone()
    if not row:
        return False

    prod_id = row["production_info_id"] if hasattr(row, "get") else row[0]
    merged = merge_app_production_payload({"farmer_id": fid}, payload)
    fields = production_detail_update_fields(merged)
    if not fields:
        return False

    set_clause = ", ".join(f"{col} = %s" for col in fields)
    values = list(fields.values()) + [prod_id]
    cur.execute(
        f"UPDATE production_information SET {set_clause} WHERE production_info_id = %s",
        values,
    )
    try:
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        return False
    try:
        cur.close()
    except Exception:
        pass
    return True


def sync_production_bean_classifications(conn) -> int:
    """
    Sync classifications and quantities from production_bean_classifications table
    into the corresponding fields of production_information.
    """
    import beanthentic_env
    from config.production_fields import (
        _normalize_classification_key,
        GCB_CLASSIFICATION_LABELS,
        ROASTED_CLASSIFICATION_LABELS,
        _table_exists,
    )

    cur = conn.cursor()
    postgres = beanthentic_env.is_postgresql()
    if not _table_exists(cur, "production_bean_classifications", postgres=postgres):
        cur.close()
        return 0

    cur.execute("""
        SELECT production_info_id, variety, bean_type, classification, quantity
        FROM production_bean_classifications
    """)
    rows = cur.fetchall() or []
    updated = 0
    for row in rows:
        if hasattr(row, "get"):
            prod_id = row.get("production_info_id")
            variety = row.get("variety")
            bean_type = row.get("bean_type")
            classification = row.get("classification")
            quantity = row.get("quantity")
        else:
            prod_id, variety, bean_type, classification, quantity = row[0], row[1], row[2], row[3], row[4]

        if not prod_id or not variety:
            continue

        v = str(variety).strip().lower()
        b_type = str(bean_type or "").strip().lower()
        qty = float(quantity or 0)

        if v not in ("liberica", "robusta", "excelsa"):
            continue

        gcb_code = _normalize_classification_key(classification, GCB_CLASSIFICATION_LABELS)
        roasted_code = _normalize_classification_key(classification, ROASTED_CLASSIFICATION_LABELS)

        is_gcb_type = b_type in (
            "gcb",
            "green_coffee_beans",
            "green coffee beans",
            "green",
        )
        is_roasted_type = b_type in ("roasted", "roast", "roasted_beans", "roasted coffee beans")
        is_harvest_type = b_type in ("harvest", "fresh", "cherry", "harvest_qty")

        # Fallback for ambiguous/missing bean_type from app payloads:
        # infer section based on classification vocabulary.
        if not is_gcb_type and not is_roasted_type and not is_harvest_type:
            is_gcb_type = bool(gcb_code)
            is_roasted_type = bool(roasted_code)

        if is_gcb_type:
            code = gcb_code
            cur.execute(f"""
                UPDATE production_information
                SET {v}_gcb_classification = %s, {v}_gcb_qty_kg = %s
                WHERE production_info_id = %s
            """, (code, qty, prod_id))
            updated += 1
        elif is_roasted_type:
            code = roasted_code
            cur.execute(f"""
                UPDATE production_information
                SET {v}_roasted_classification = %s, {v}_roasted_qty_kg = %s
                WHERE production_info_id = %s
            """, (code, qty, prod_id))
            updated += 1
        elif is_harvest_type:
            cur.execute(f"""
                UPDATE production_information
                SET {v}_harvest_qty_kg = %s
                WHERE production_info_id = %s
            """, (qty, prod_id))
            updated += 1

    if updated > 0:
        try:
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            updated = 0

    cur.close()
    return updated

