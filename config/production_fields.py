"""
Production detail fields for production_information (harvest, GCB, roasted).

Matches the farmer mobile app UI:
  - Production for harvest: quantity per variety
  - Production: GCB (classification + qty) and Roasted (classification + qty)
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

VARIETIES = ("liberica", "robusta", "excelsa")

GCB_CLASSIFICATIONS = ("small_beans", "medium_beans", "large_beans")
ROASTED_CLASSIFICATIONS = ("ground_beans", "whole_beans")

GCB_CLASSIFICATION_LABELS = {
    "small_beans": "Small Beans",
    "medium_beans": "Medium Beans",
    "large_beans": "Large Beans",
}

ROASTED_CLASSIFICATION_LABELS = {
    "ground_beans": "Ground Beans",
    "whole_beans": "Whole Beans",
}

# (column_name, postgres_ddl, mysql_ddl)
PRODUCTION_DETAIL_COLUMNS: list[tuple[str, str, str]] = []
for _v in VARIETIES:
    PRODUCTION_DETAIL_COLUMNS.append(
        (
            f"{_v}_harvest_qty_kg",
            "NUMERIC(10,2) DEFAULT 0",
            "DECIMAL(10,2) DEFAULT 0",
        )
    )
    PRODUCTION_DETAIL_COLUMNS.append(
        (
            f"{_v}_gcb_classification",
            "VARCHAR(32) DEFAULT NULL",
            "VARCHAR(32) DEFAULT NULL",
        )
    )
    PRODUCTION_DETAIL_COLUMNS.append(
        (
            f"{_v}_gcb_qty_kg",
            "NUMERIC(10,2) DEFAULT 0",
            "DECIMAL(10,2) DEFAULT 0",
        )
    )
    PRODUCTION_DETAIL_COLUMNS.append(
        (
            f"{_v}_roasted_classification",
            "VARCHAR(32) DEFAULT NULL",
            "VARCHAR(32) DEFAULT NULL",
        )
    )
    PRODUCTION_DETAIL_COLUMNS.append(
        (
            f"{_v}_roasted_qty_kg",
            "NUMERIC(10,2) DEFAULT 0",
            "DECIMAL(10,2) DEFAULT 0",
        )
    )

PRODUCTION_DETAIL_JSON_COLUMN = "production_detail"

CURRENT_APP_SCHEMA_COLUMNS: dict[str, list[tuple[str, str, str]]] = {
    "farm_information": [
        ("province", "VARCHAR(80) DEFAULT 'Batangas'", "VARCHAR(80) DEFAULT 'Batangas'"),
        ("municipality", "VARCHAR(80) DEFAULT 'Lipa City'", "VARCHAR(80) DEFAULT 'Lipa City'"),
        ("house_no", "VARCHAR(120) DEFAULT NULL", "VARCHAR(120) DEFAULT NULL"),
        ("street", "VARCHAR(160) DEFAULT NULL", "VARCHAR(160) DEFAULT NULL"),
        ("farm_latitude", "NUMERIC(10,8) DEFAULT NULL", "DECIMAL(10,8) DEFAULT NULL"),
        ("farm_longitude", "NUMERIC(10,8) DEFAULT NULL", "DECIMAL(10,8) DEFAULT NULL"),
        ("farm_location_notes", "TEXT DEFAULT NULL", "TEXT DEFAULT NULL"),
        ("terms_accepted", "BOOLEAN NOT NULL DEFAULT FALSE", "TINYINT(1) NOT NULL DEFAULT 0"),
        ("terms_accepted_at", "TIMESTAMPTZ NULL", "DATETIME NULL"),
        ("coffee_varieties", "TEXT DEFAULT NULL", "TEXT DEFAULT NULL"),
        ("coffee_distribution", "VARCHAR(40) DEFAULT NULL", "VARCHAR(40) DEFAULT NULL"),
    ],
    "personal_information": [
        ("province", "VARCHAR(80) DEFAULT 'Batangas'", "VARCHAR(80) DEFAULT 'Batangas'"),
        ("municipality", "VARCHAR(80) DEFAULT 'Lipa City'", "VARCHAR(80) DEFAULT 'Lipa City'"),
        ("house_no", "VARCHAR(120) DEFAULT NULL", "VARCHAR(120) DEFAULT NULL"),
        ("street", "VARCHAR(160) DEFAULT NULL", "VARCHAR(160) DEFAULT NULL"),
    ],
}

PRODUCTION_DETAIL_SELECT_SQL = ", ".join(
    [f"prod.{name}" for name, _, _ in PRODUCTION_DETAIL_COLUMNS]
    + [f"prod.{PRODUCTION_DETAIL_JSON_COLUMN}"]
)


def _table_exists(cur, table: str, *, postgres: bool) -> bool:
    if postgres:
        cur.execute(
            """
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = %s
            LIMIT 1
            """,
            (table,),
        )
    else:
        cur.execute(
            """
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = DATABASE() AND table_name = %s
            LIMIT 1
            """,
            (table,),
        )
    return bool(cur.fetchone())


def _column_exists(cur, table: str, column: str, *, postgres: bool) -> bool:
    if postgres:
        cur.execute(
            """
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = %s AND column_name = %s
            LIMIT 1
            """,
            (table, column),
        )
    else:
        cur.execute(
            """
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = %s AND column_name = %s
            LIMIT 1
            """,
            (table, column),
        )
    return bool(cur.fetchone())


def ensure_production_detail_columns(conn) -> list[str]:
    """Add harvest / GCB / roasted detail columns to production_information."""
    import beanthentic_env

    postgres = beanthentic_env.is_postgresql()
    added: list[str] = []
    cur = conn.cursor()
    if not _table_exists(cur, "production_information", postgres=postgres):
        try:
            cur.close()
        except Exception:
            pass
        return added

    for col_name, pg_ddl, mysql_ddl in PRODUCTION_DETAIL_COLUMNS:
        if _column_exists(cur, "production_information", col_name, postgres=postgres):
            continue
        ddl = pg_ddl if postgres else mysql_ddl
        try:
            cur.execute(f"ALTER TABLE production_information ADD COLUMN {col_name} {ddl}")
            added.append(col_name)
        except Exception:
            pass

    json_ddl = "JSONB DEFAULT NULL" if postgres else "JSON DEFAULT NULL"
    if not _column_exists(cur, "production_information", PRODUCTION_DETAIL_JSON_COLUMN, postgres=postgres):
        try:
            cur.execute(
                f"ALTER TABLE production_information ADD COLUMN {PRODUCTION_DETAIL_JSON_COLUMN} {json_ddl}"
            )
            added.append(PRODUCTION_DETAIL_JSON_COLUMN)
        except Exception:
            pass

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
    return added


def ensure_current_app_schema_columns(conn) -> list[str]:
    """Add current app registration / address fields required by the dashboard forms."""
    import beanthentic_env

    postgres = beanthentic_env.is_postgresql()
    added: list[str] = []
    cur = conn.cursor()
    try:
        for table_name, columns in CURRENT_APP_SCHEMA_COLUMNS.items():
            if not _table_exists(cur, table_name, postgres=postgres):
                continue
            for col_name, pg_ddl, mysql_ddl in columns:
                if _column_exists(cur, table_name, col_name, postgres=postgres):
                    continue
                ddl = pg_ddl if postgres else mysql_ddl
                try:
                    cur.execute(f"ALTER TABLE {table_name} ADD COLUMN {col_name} {ddl}")
                    added.append(f"{table_name}.{col_name}")
                except Exception:
                    pass
        try:
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
    finally:
        try:
            cur.close()
        except Exception:
            pass
    return added


def _num(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


GCB_INT_CODES = {
    "0": "small_beans",
    "1": "medium_beans",
    "2": "large_beans",
    0: "small_beans",
    1: "medium_beans",
    2: "large_beans",
}

ROASTED_INT_CODES = {
    "0": "ground_beans",
    "1": "whole_beans",
    0: "ground_beans",
    1: "whole_beans",
}


def _coerce_classification_value(value: Any, *, kind: str) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return ""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        code_map = GCB_INT_CODES if kind == "gcb" else ROASTED_INT_CODES
        mapped = code_map.get(int(value))
        if mapped:
            return mapped
    text = str(value).strip()
    return text


def _normalize_classification_key(value: str | None, labels: dict[str, str]) -> str:
    key = (value or "").strip().lower().replace("-", "_").replace(" ", "_")
    if not key:
        return ""
    if key in labels:
        return key
    for code, label in labels.items():
        if key == label.lower().replace(" ", "_"):
            return code
    return key


def parse_production_detail_value(value: Any) -> dict | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            return None
    return None


def expand_production_detail_into_row(row: dict) -> dict:
    """Merge stored production_detail JSON (DB or app payload) into flat row keys."""
    out = dict(row)
    detail = parse_production_detail_value(out.get(PRODUCTION_DETAIL_JSON_COLUMN))
    if not detail:
        detail = parse_production_detail_value(out.get("production_detail"))
    if detail:
        out["production_detail"] = detail
        varieties = detail.get("varieties")
        if isinstance(varieties, dict):
            for variety, block in varieties.items():
                v = str(variety or "").strip().lower()
                if v not in VARIETIES or not isinstance(block, dict):
                    continue
                harvest_qty = block.get("harvest_qty_kg")
                harvest_unit = block.get("harvest_unit")
                harvest_block = block.get("harvest")
                if isinstance(harvest_block, dict):
                    if harvest_qty in (None, ""):
                        harvest_qty = harvest_block.get("qty_kg")
                    if harvest_qty in (None, ""):
                        harvest_qty = harvest_block.get("quantity_kg")
                    if harvest_qty in (None, ""):
                        harvest_qty = harvest_block.get("quantity")
                    if harvest_unit in (None, ""):
                        harvest_unit = (
                            harvest_block.get("unit")
                            or harvest_block.get("unit_label")
                            or harvest_block.get("uom")
                        )
                if harvest_qty is not None and harvest_qty != "":
                    out[f"{v}_harvest_qty_kg"] = harvest_qty
                if harvest_unit is not None and str(harvest_unit).strip():
                    out[f"{v}_harvest_unit"] = str(harvest_unit).strip()
                allocation = block.get("allocation")
                if isinstance(allocation, dict):
                    sell_qty = allocation.get("sell_qty_kg")
                    if sell_qty in (None, ""):
                        sell_qty = allocation.get("sell_kg")
                    if sell_qty in (None, ""):
                        sell_qty = allocation.get("sell")
                    dropoff_qty = allocation.get("dropoff_qty_kg")
                    if dropoff_qty in (None, ""):
                        dropoff_qty = allocation.get("dropoff_kg")
                    if dropoff_qty in (None, ""):
                        dropoff_qty = allocation.get("dropoff")
                    if dropoff_qty in (None, ""):
                        dropoff_qty = allocation.get("drop_off")
                    if sell_qty not in (None, ""):
                        out[f"{v}_sell_qty_kg"] = sell_qty
                    if dropoff_qty not in (None, ""):
                        out[f"{v}_dropoff_qty_kg"] = dropoff_qty
                for section, keys in (("gcb", ("qty_kg", "classification", "classification_label")), ("roasted", ("qty_kg", "classification", "classification_label"))):
                    part = block.get(section)
                    if not isinstance(part, dict):
                        continue
                    for key in keys:
                        val = part.get(key)
                        if val is None or val == "":
                            continue
                        if key == "qty_kg":
                            out[f"{v}_{section}_qty_kg"] = val
                        elif key in ("classification", "classification_label"):
                            out[f"{v}_{section}_classification"] = _coerce_classification_value(val, kind=section)
                    unit_val = part.get("unit") or part.get("unit_label") or part.get("uom")
                    if unit_val is not None and str(unit_val).strip():
                        out[f"{v}_{section}_unit"] = str(unit_val).strip()
    return out


def merge_app_production_payload(row: dict, payload: dict) -> dict:
    """Normalize mobile app / admin payloads into one farmer row."""
    merged = dict(row)
    if not isinstance(payload, dict):
        return merged
    merged.update(payload)
    detail = payload.get("production_detail")
    if isinstance(detail, dict):
        merged["production_detail"] = detail
    return expand_production_detail_into_row(merged)


def _label(classification: str | None, labels: dict[str, str]) -> str:
    key = _normalize_classification_key(classification, labels)
    if key in labels:
        return labels[key]
    return (classification or "").strip()


def gcb_classification_label(value: str | None) -> str:
    return _label(value, GCB_CLASSIFICATION_LABELS)


def roasted_classification_label(value: str | None) -> str:
    return _label(value, ROASTED_CLASSIFICATION_LABELS)


def _first_non_empty(row: dict, keys: tuple[str, ...], *, kind: str = "gcb") -> str:
    for key in keys:
        val = row.get(key)
        if val is None:
            continue
        text = _coerce_classification_value(val, kind=kind)
        if text:
            return text
    return ""


def _nested_classification(row: dict, variety: str, kind: str) -> str:
    detail = row.get("production_detail")
    if not isinstance(detail, dict):
        return ""
    varieties = detail.get("varieties")
    if not isinstance(varieties, dict):
        return ""
    block = varieties.get((variety or "").strip().lower())
    if not isinstance(block, dict):
        return ""
    section = block.get(kind)
    if not isinstance(section, dict):
        return ""
    return _first_non_empty(
        section,
        ("classification_label", "classification", "type", "class", "label"),
        kind=kind,
    )


def gcb_classification_raw(row: dict, variety: str) -> str:
    row = expand_production_detail_into_row(row)
    v = (variety or "").strip().lower()
    cap = v.upper()
    camel = "".join(part.capitalize() for part in v.split("_"))
    return _first_non_empty(
        row,
        (
            f"{v}_gcb_classification",
            f"{v}_gcb_classification_code",
            f"{v}_gcb_class",
            f"{v}_gcb_type",
            f"{cap} GCB CLASSIFICATION",
            f"{cap} GCB CLASS",
            f"{cap} GCB TYPE",
            f"{camel}GcbClassification",
            f"{camel}GcbClass",
            f"{camel}GcbType",
        ),
        kind="gcb",
    ) or _nested_classification(row, v, "gcb")


def roasted_classification_raw(row: dict, variety: str) -> str:
    row = expand_production_detail_into_row(row)
    v = (variety or "").strip().lower()
    cap = v.upper()
    camel = "".join(part.capitalize() for part in v.split("_"))
    return _first_non_empty(
        row,
        (
            f"{v}_roasted_classification",
            f"{v}_roasted_classification_code",
            f"{v}_roasted_class",
            f"{v}_roasted_type",
            f"{cap} ROASTED CLASSIFICATION",
            f"{cap} ROASTED CLASS",
            f"{cap} ROASTED TYPE",
            f"{camel}RoastedClassification",
            f"{camel}RoastedClass",
            f"{camel}RoastedType",
        ),
        kind="roasted",
    ) or _nested_classification(row, v, "roasted")


def gcb_qty_for_variety(row: dict, variety: str) -> float:
    v = (variety or "").strip().lower()
    detail = _num(row.get(f"{v}_gcb_qty_kg"))
    if detail > 0:
        return detail
    legacy = _num(row.get(f"{v}_qty_kg"))
    return legacy


def roasted_qty_for_variety(row: dict, variety: str, *, roasted_factor: float = 0.78) -> float:
    v = (variety or "").strip().lower()
    detail = _num(row.get(f"{v}_roasted_qty_kg"))
    if detail > 0:
        return detail
    return gcb_qty_for_variety(row, v) * roasted_factor


def harvest_qty_for_variety(row: dict, variety: str) -> float:
    v = (variety or "").strip().lower()
    val = _num(row.get(f"{v}_harvest_qty_kg"))
    if val > 0:
        return val
    # Fallback: calculate from GCB quantity
    gcb_qty = gcb_qty_for_variety(row, v)
    if gcb_qty > 0:
        # Standard conversion factors:
        # Liberica/Excelsa: 10% recovery (cherry = 10 * GCB)
        # Robusta: 20% recovery (cherry = 5 * GCB)
        factor = 5.0 if v == "robusta" else 10.0
        return round(gcb_qty * factor, 2)
    return 0.0


def production_row_extensions(row: dict) -> dict[str, Any]:
    """Flatten production_information fields for admin API / dashboard keys."""
    out: dict[str, Any] = {}
    for v in VARIETIES:
        cap = v.upper()
        gcb_qty = gcb_qty_for_variety(row, v)
        roasted_qty = roasted_qty_for_variety(row, v)
        harvest_qty = harvest_qty_for_variety(row, v)
        gcb_class_raw = gcb_classification_raw(row, v)
        roasted_class_raw = roasted_classification_raw(row, v)
        gcb_class_label = gcb_classification_label(gcb_class_raw)
        roasted_class_label = roasted_classification_label(roasted_class_raw)
        harvest_unit = str(
            row.get(f"{v}_harvest_unit")
            or row.get(f"{cap} HARVEST UNIT")
            or ""
        ).strip()
        gcb_unit = str(
            row.get(f"{v}_gcb_unit")
            or row.get(f"{cap} GCB UNIT")
            or "kg"
        ).strip()
        roasted_unit = str(
            row.get(f"{v}_roasted_unit")
            or row.get(f"{cap} ROASTED UNIT")
            or "kg"
        ).strip()

        out[f"{v}_harvest_qty_kg"] = harvest_qty
        out[f"{v}_harvest_unit"] = harvest_unit
        out[f"{v}_gcb_qty_kg"] = gcb_qty
        out[f"{v}_gcb_unit"] = gcb_unit
        out[f"{v}_gcb_classification"] = gcb_class_label
        out[f"{v}_gcb_classification_code"] = _normalize_classification_key(
            gcb_class_raw, GCB_CLASSIFICATION_LABELS
        )
        out[f"{v}_roasted_qty_kg"] = roasted_qty
        out[f"{v}_roasted_unit"] = roasted_unit
        out[f"{v}_roasted_classification"] = roasted_class_label
        out[f"{v}_roasted_classification_code"] = _normalize_classification_key(
            roasted_class_raw, ROASTED_CLASSIFICATION_LABELS
        )

        out[f"{cap} HARVEST QTY"] = harvest_qty
        out[f"{cap} HARVEST UNIT"] = harvest_unit
        out[f"{cap} GCB QTY"] = gcb_qty
        out[f"{cap} GCB UNIT"] = gcb_unit
        out[f"{cap} GCB CLASSIFICATION"] = gcb_class_label
        out[f"{cap} ROASTED QTY"] = roasted_qty
        out[f"{cap} ROASTED UNIT"] = roasted_unit
        out[f"{cap} ROASTED CLASSIFICATION"] = roasted_class_label

        # Legacy production columns (FI totals for yields tab)
        out[f"{cap} PRODUCTION"] = gcb_qty
        out[f"{v}_qty_kg"] = gcb_qty

    return out


def production_detail_payload(row: dict) -> dict:
    """Structured JSON for farmer profile / client consumers."""
    existing_detail = parse_production_detail_value(
        row.get(PRODUCTION_DETAIL_JSON_COLUMN) or row.get("production_detail")
    )
    existing_varieties = (
        existing_detail.get("varieties")
        if isinstance(existing_detail, dict) and isinstance(existing_detail.get("varieties"), dict)
        else {}
    )
    varieties: dict[str, dict] = {}
    for v in VARIETIES:
        existing_block = existing_varieties.get(v) if isinstance(existing_varieties, dict) else {}
        existing_alloc = (
            existing_block.get("allocation")
            if isinstance(existing_block, dict) and isinstance(existing_block.get("allocation"), dict)
            else {}
        )
        gcb_class_raw = gcb_classification_raw(row, v)
        roasted_class_raw = roasted_classification_raw(row, v)
        sell_qty = _num(
            row.get(f"{v}_sell_qty_kg")
            or row.get(f"{v}_sell_kg")
            or row.get(f"{v.upper()} SELL QTY")
            or existing_alloc.get("sell_qty_kg")
            or existing_alloc.get("sell_kg")
            or existing_alloc.get("sell")
        )
        dropoff_qty = _num(
            row.get(f"{v}_dropoff_qty_kg")
            or row.get(f"{v}_dropoff_kg")
            or row.get(f"{v.upper()} DROPOFF QTY")
            or existing_alloc.get("dropoff_qty_kg")
            or existing_alloc.get("dropoff_kg")
            or existing_alloc.get("dropoff")
            or existing_alloc.get("drop_off")
        )
        allocation = {
            "sell_qty_kg": sell_qty,
            "dropoff_qty_kg": dropoff_qty,
        }
        varieties[v] = {
            "harvest_qty_kg": harvest_qty_for_variety(row, v),
            "harvest_unit": str(
                row.get(f"{v}_harvest_unit")
                or row.get(f"{v.upper()} HARVEST UNIT")
                or ""
            ).strip(),
            "gcb": {
                "qty_kg": gcb_qty_for_variety(row, v),
                "unit": str(
                    row.get(f"{v}_gcb_unit")
                    or row.get(f"{v.upper()} GCB UNIT")
                    or "kg"
                ).strip(),
                "classification": _normalize_classification_key(gcb_class_raw, GCB_CLASSIFICATION_LABELS),
                "classification_label": gcb_classification_label(gcb_class_raw),
            },
            "roasted": {
                "qty_kg": roasted_qty_for_variety(row, v),
                "unit": str(
                    row.get(f"{v}_roasted_unit")
                    or row.get(f"{v.upper()} ROASTED UNIT")
                    or "kg"
                ).strip(),
                "classification": _normalize_classification_key(roasted_class_raw, ROASTED_CLASSIFICATION_LABELS),
                "classification_label": roasted_classification_label(roasted_class_raw),
            },
            "allocation": allocation,
        }
    return {"varieties": varieties}
