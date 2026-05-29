"""Map dashboard / API farmer rows to ML feature columns."""

from __future__ import annotations

from typing import Any, Callable


def _get(row: dict, keys: list[str], default: Any = "") -> Any:
    for key in keys:
        if key in row and row[key] not in (None, ""):
            return row[key]
    return default


def _yes_no(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if raw in ("yes", "y", "true", "1"):
        return "Yes"
    if raw in ("no", "n", "false", "0"):
        return "No"
    return "No"


def _dominant_species(row: dict) -> str:
    species = [
        ("Liberica", _num(row, ["LIBERICA BEARING", "Liberica_Bearing"]) + _num(row, ["LIBERICA NON-BEARING", "Liberica_Non-bearing"])),
        ("Robusta", _num(row, ["ROBUSTA BEARING", "Robusta_Bearing"]) + _num(row, ["ROBUSTA NON-BEARING", "Robusta_Non-bearing"])),
        ("Excelsa", _num(row, ["EXCELSA BEARING", "Excelsa_Bearing"]) + _num(row, ["EXCELSA NON-BEARING", "Excelsa_Non-bearing"])),
    ]
    species.sort(key=lambda x: x[1], reverse=True)
    return species[0][0] if species[0][1] > 0 else "Robusta"


def _num(row: dict, keys: list[str]) -> float:
    try:
        return float(_get(row, keys, 0) or 0)
    except (TypeError, ValueError):
        return 0.0


def _ownership(row: dict) -> str:
    own = str(_get(row, ["STATUS OF OWNERSHIP", "status_of_ownership"], "") or "").strip()
    if not own:
        if _get(row, ["OWNED", "owned"]) in (1, "1", True):
            return "Owned"
        if _get(row, ["SHARED", "shared"]) in (1, "1", True):
            return "Shared"
        if _get(row, ["LEASED", "leased"]) in (1, "1", True):
            return "Leased"
        return "Owned"
    low = own.lower()
    if "own" in low:
        return "Owned"
    if "lease" in low:
        return "Leased"
    if "share" in low:
        return "Shared"
    return own[:32] if own else "Owned"


def farmer_row_to_ml_features(row: dict) -> dict:
    """Build a feature dict aligned with beanthentic_synthetic_dataset CSV columns."""
    bearing = _num(row, ["TOTAL BEARING", "TOTAL_BEARING"]) or (
        _num(row, ["LIBERICA BEARING"]) + _num(row, ["ROBUSTA BEARING"]) + _num(row, ["EXCELSA BEARING"])
    )
    non_bearing = _num(row, ["TOTAL NON-BEARING", "TOTAL_Non-bearing", "Total_Non-bearing"]) or (
        _num(row, ["LIBERICA NON-BEARING"]) + _num(row, ["ROBUSTA NON-BEARING"]) + _num(row, ["EXCELSA NON-BEARING"])
    )
    annual_yield = (
        _num(row, ["LIBERICA PRODUCTION", "Liberica_Production"])
        + _num(row, ["ROBUSTA PRODUCTION", "Robusta_Production"])
        + _num(row, ["EXCELSA PRODUCTION", "Excelsa_Production"])
    )
    ncfrs = str(_get(row, ["NCFRS", "ncfrs"], "") or "").strip()
    rsbsa = _yes_no(_get(row, ["RSBSA Registered (Yes/No)", "REGISTERED (YES/NO)", "registered"], "No"))

    return {
        "barangay": str(_get(row, ["ADDRESS (BARANGAY)", "Address (Barangay)", "address", "barangay"], "Unknown") or "Unknown")[:64],
        "elevation_masl": 400.0,
        "soil_pH": 6.2,
        "annual_rainfall_mm": 2200.0,
        "mean_temperature_C": 23.0,
        "coffee_species": _dominant_species(row),
        "planting_system": "Agroforestry",
        "farm_ownership": _ownership(row),
        "rsbsa_registered": rsbsa,
        "years_in_farming": max(1, min(40, int(bearing / 50) if bearing else 5)),
        "bearing_trees": int(bearing),
        "non_bearing_trees": int(non_bearing),
        "annual_yield_kg": max(0.0, annual_yield),
        "processing_method": "Natural",
        "moisture_content_pct": 12.0,
        "defect_count_per_300g": 5,
        "selective_picking_practiced": "Yes" if bearing >= 300 else "No",
        "farm_records_maintained": "Yes" if ncfrs else "No",
        "sales_records_maintained": "Yes" if annual_yield > 0 else "No",
        "cooperative_member": _yes_no(_get(row, ["FA OFFICER / MEMBER"], "")),
        "geographic_compliance": "Yes",
        "traditional_method_compliance": "Yes",
        "quality_linkage_documented": "Yes" if ncfrs and rsbsa == "Yes" else "No",
    }


def batch_farmer_rows(rows: list[dict]) -> list[dict]:
    return [farmer_row_to_ml_features(r) for r in rows]
