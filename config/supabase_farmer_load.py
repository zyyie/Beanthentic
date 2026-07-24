"""
Load Beanthentic farmer rows via Supabase REST (anon key).

Used when the project is active on Supabase but the Postgres pooler is unavailable
(e.g. paused project recovery, auth circuit breaker, or missing BEANTHENTIC_DB_PASS).
"""

from __future__ import annotations

from typing import Any

from config.production_fields import (
    PRODUCTION_DETAIL_JSON_COLUMN,
    expand_production_detail_into_row,
)
from config.supabase_client import get_client

_CHUNK = 100


def _chunks(values: list, size: int = _CHUNK):
    for i in range(0, len(values), size):
        yield values[i : i + size]


def _fetch_by_ids(table: str, key: str, ids: list[Any]) -> dict[Any, dict]:
    if not ids:
        return {}
    client = get_client()
    out: dict[Any, dict] = {}
    for batch in _chunks(list(dict.fromkeys(ids))):
        resp = client.table(table).select("*").in_(key, batch).execute()
        for row in resp.data or []:
            if not isinstance(row, dict):
                continue
            rid = row.get(key)
            if rid is not None:
                out[rid] = row
    return out


def _latest_by_farmer(table: str, year_col: str, farmer_ids: list[int]) -> dict[int, dict]:
    if not farmer_ids:
        return {}
    client = get_client()
    rows: list[dict] = []
    for batch in _chunks(list(dict.fromkeys(farmer_ids))):
        resp = (
            client.table(table)
            .select("*")
            .in_("farmer_id", batch)
            .order(year_col, desc=True)
            .execute()
        )
        rows.extend(row for row in (resp.data or []) if isinstance(row, dict))

    best: dict[int, dict] = {}
    for row in rows:
        fid = int(row.get("farmer_id") or 0)
        if fid < 1:
            continue
        year = row.get(year_col)
        prev = best.get(fid)
        if not prev or (year or 0) > (prev.get(year_col) or 0):
            best[fid] = row
    return best


def _merge_farmer_row(
    farmer: dict,
    user: dict | None,
    personal: dict | None,
    farm: dict | None,
    affiliation: dict | None,
    trees: dict | None,
    production: dict | None,
) -> dict:
    pi = personal or {}
    fi = farm or {}
    ai = affiliation or {}
    tc = trees or {}
    prod = production or {}
    u = user or {}

    row: dict = {
        "farmer_id": farmer.get("farmer_id"),
        "user_id": farmer.get("user_id") or u.get("user_id"),
        "username": u.get("username"),
        "phone_number": u.get("phone_number"),
        "registered_at": u.get("created_at"),
        "user_email": u.get("email"),
        "status": farmer.get("status"),
        "first_name": pi.get("first_name") or farmer.get("first_name"),
        "last_name": pi.get("last_name") or farmer.get("last_name"),
        "contact_number": pi.get("contact_number"),
        "birthday": pi.get("birthday") or farmer.get("birthday"),
        "barangay": pi.get("barangay") or fi.get("barangay") or farmer.get("address_barangay"),
        "ownership_status": fi.get("ownership_status"),
        "farm_size_ha": fi.get("farm_size_ha") or fi.get("total_area_planted_ha"),
        "coffee_varieties": (
            fi.get("coffee_varieties")
            or fi.get("coffee_variety")
            or fi.get("varieties_produced")
            or fi.get("coffee_varieties_produced")
        ),
        "coffee_distribution": (
            fi.get("coffee_distribution")
            or fi.get("distribution_option")
            or fi.get("distribution_method")
            or fi.get("delivery_method")
        ),
        "federation_assoc": ai.get("federation_assoc") or ai.get("fa_officer_member"),
        "ncfrs": ai.get("ncfrs"),
        "rsbsa_registered": ai.get("rsbsa_registered"),
        "rsbsa_number": ai.get("rsbsa_number"),
        "rsbsa_status": ai.get("rsbsa_status"),
        "robusta_bearing": tc.get("robusta_bearing"),
        "robusta_non_bearing": tc.get("robusta_non_bearing"),
        "liberica_bearing": tc.get("liberica_bearing"),
        "liberica_non_bearing": tc.get("liberica_non_bearing"),
        "excelsa_bearing": tc.get("excelsa_bearing"),
        "excelsa_non_bearing": tc.get("excelsa_non_bearing"),
        "robusta_qty_kg": prod.get("robusta_qty_kg"),
        "liberica_qty_kg": prod.get("liberica_qty_kg"),
        "excelsa_qty_kg": prod.get("excelsa_qty_kg"),
        **{
            key: prod.get(key)
            for key in (
                "liberica_harvest_qty_kg",
                "liberica_harvest_unit",
                "robusta_harvest_qty_kg",
                "robusta_harvest_unit",
                "excelsa_harvest_qty_kg",
                "excelsa_harvest_unit",
                "liberica_gcb_classification",
                "liberica_gcb_qty_kg",
                "liberica_gcb_unit",
                "robusta_gcb_classification",
                "robusta_gcb_qty_kg",
                "robusta_gcb_unit",
                "excelsa_gcb_classification",
                "excelsa_gcb_qty_kg",
                "excelsa_gcb_unit",
                "liberica_roasted_classification",
                "liberica_roasted_qty_kg",
                "liberica_roasted_unit",
                "robusta_roasted_classification",
                "robusta_roasted_qty_kg",
                "robusta_roasted_unit",
                "excelsa_roasted_classification",
                "excelsa_roasted_qty_kg",
                "excelsa_roasted_unit",
                PRODUCTION_DETAIL_JSON_COLUMN,
            )
        },
        "is_suspended": farmer.get("is_suspended"),
        "suspended_until": farmer.get("suspended_until"),
        "suspension_reason": farmer.get("suspension_reason"),
        "warning_count": farmer.get("warning_count"),
        "last_warning_at": farmer.get("last_warning_at"),
        "last_warning_reason": farmer.get("last_warning_reason"),
        "self_sale_enabled": farmer.get("self_sale_enabled"),
        "profile_photo_data": farmer.get("profile_photo"),
        "profile_photo": farmer.get("profile_photo"),
    }

    for flag in (
        "is_landowner",
        "is_cloa_holder",
        "is_leaseholder",
        "is_seasonal_farm_worker",
        "is_others",
    ):
        if flag in fi:
            row[flag] = fi.get(flag)

    return expand_production_detail_into_row(row)


def fetch_farmer_rows_via_rest(limit: int = 2000) -> list[dict]:
    limit = max(1, min(int(limit or 2000), 5000))
    client = get_client()
    farmers = (
        client.table("farmers")
        .select("*")
        .order("farmer_id")
        .limit(limit)
        .execute()
        .data
        or []
    )
    if not farmers:
        return []

    farmer_ids = [int(f["farmer_id"]) for f in farmers if f.get("farmer_id")]
    user_ids = [int(f["user_id"]) for f in farmers if f.get("user_id")]

    users_by_id = _fetch_by_ids("users", "user_id", user_ids)
    personal_by_fid = _fetch_by_ids("personal_information", "farmer_id", farmer_ids)
    farm_by_fid = _fetch_by_ids("farm_information", "farmer_id", farmer_ids)
    affiliation_by_fid = _fetch_by_ids("affiliation_information", "farmer_id", farmer_ids)
    trees_by_fid = _latest_by_farmer("tree_counts", "record_year", farmer_ids)
    prod_by_fid = _latest_by_farmer("production_information", "production_year", farmer_ids)

    rows: list[dict] = []
    for farmer in farmers:
        fid = farmer.get("farmer_id")
        uid = farmer.get("user_id")
        rows.append(
            _merge_farmer_row(
                farmer,
                users_by_id.get(uid),
                personal_by_fid.get(fid),
                farm_by_fid.get(fid),
                affiliation_by_fid.get(fid),
                trees_by_fid.get(int(fid or 0)),
                prod_by_fid.get(int(fid or 0)),
            )
        )
    return rows
