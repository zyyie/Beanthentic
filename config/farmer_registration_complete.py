"""
Detect when a Beanthentic-App farmer has finished the registration wizard (not just signup/login).
"""

from __future__ import annotations

import re

_PHONE_RE = re.compile(r"^\+?63\s*9\d{9}$|^09\d{9}$|^\d{10,12}$")


def _field(row: dict, *keys: str) -> str:
    for key in keys:
        val = row.get(key)
        if val is not None and str(val).strip():
            return str(val).strip()
    return ""


def looks_like_phone(value: str) -> bool:
    s = re.sub(r"[\s\-()]", "", str(value or "").strip())
    if not s:
        return False
    if _PHONE_RE.match(s):
        return True
    digits = re.sub(r"\D", "", s)
    return len(digits) >= 10 and digits.startswith(("09", "639", "63"))


def farmer_first_name(row: dict) -> str:
    return _field(row, "first_name", "FIRST NAME", "firstName")


def farmer_last_name(row: dict) -> str:
    return _field(row, "last_name", "LAST NAME", "lastName")


def farmer_display_name(row: dict, *, farmer_id: int | None = None) -> str:
    """Human-readable name for notifications — never a phone number."""
    first = farmer_first_name(row)
    last = farmer_last_name(row)
    full = f"{first} {last}".strip()
    if full and not looks_like_phone(full) and not looks_like_phone(first):
        return full

    legal = _field(row, "NAME OF FARMER", "name", "display_name")
    if legal and not looks_like_phone(legal):
        return legal

    fid = farmer_id if farmer_id is not None else int(row.get("farmer_id") or row.get("NO.") or 0)
    return f"Farmer #{fid}" if fid else "Farmer"


def filter_completed_registration_rows(rows: list[dict]) -> list[dict]:
    """Keep only farmers who finished the app registration wizard."""
    return [r for r in rows if is_farmer_registration_complete(r)]


def is_farmer_registration_complete(row: dict) -> bool:
    """
    True when the farmer finished the app registration flow (profile + farm details),
    not when only a user/phone account exists.
    """
    first = farmer_first_name(row)
    last = farmer_last_name(row)
    if not first or not last:
        return False
    if looks_like_phone(first) or looks_like_phone(last):
        return False
    full = f"{first} {last}".strip()
    if looks_like_phone(full):
        return False

    barangay = _field(
        row,
        "barangay",
        "ADDRESS (BARANGAY)",
        "address_barangay",
        "BARANGAY",
        "municipality",
        "MUNICIPALITY",
        "province",
        "PROVINCE",
        "house_no",
        "HOUSE NO.",
        "street",
        "STREET",
    )

    row_address = _field(
        row,
        "barangay",
        "ADDRESS (BARANGAY)",
        "address_barangay",
        "BARANGAY",
        "municipality",
        "MUNICIPALITY",
        "province",
        "PROVINCE",
        "house_no",
        "HOUSE NO.",
        "street",
        "STREET",
    )

    # Accept modern app addresses as a valid completion signal even when the old
    # legacy fields are not present in the merged farmer row.
    has_address = bool(row_address)

    farm_ha = row.get("farm_size_ha")
    if farm_ha is None:
        for key in (
            "TOTAL AREA PLANTED (HA.)",
            "Total Area Planted (HA.)",
            "total_area_ha",
            "farm_area_ha",
        ):
            if row.get(key) is not None:
                farm_ha = row.get(key)
                break
    try:
        has_farm_area = float(farm_ha or 0) > 0
    except (TypeError, ValueError):
        has_farm_area = False

    trees = row.get("TOTAL TREES")
    if trees is None:
        for key in ("total_trees", "total_bearing_trees", "TOTAL BEARING", "bearing_trees"):
            if row.get(key) is not None:
                trees = row.get(key)
                break
    try:
        has_trees = int(float(trees or 0)) > 0
    except (TypeError, ValueError):
        has_trees = False

    return bool(has_address or barangay or has_farm_area or has_trees)
