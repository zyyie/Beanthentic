"""
Map farm_information.ownership_status (and wizard values) to dashboard X columns.
"""


def resolve_ownership_status(
    mysql_raw,
    *,
    first_name: str = "",
    last_name: str = "",
    phone: str = "",
    email: str = "",
    sqlite_by_name: dict | None = None,
    sqlite_by_phone: dict | None = None,
    sqlite_by_email: dict | None = None,
    row_flags: dict | None = None,
) -> str:
    """Pick best ownership string: MySQL value first, then boolean flags, then SQLite fallback."""
    raw = str(mysql_raw or "").strip()
    if raw:
        return raw

    flags = row_flags if isinstance(row_flags, dict) else {}
    if flags.get("is_landowner") in (True, 1, "1"):
        return "landowner"
    if flags.get("is_cloa_holder") in (True, 1, "1"):
        return "cloa_holder"
    if flags.get("is_leaseholder") in (True, 1, "1"):
        return "list_holder"
    if flags.get("is_seasonal_farm_worker") in (True, 1, "1"):
        return "sessional_farm_worker"
    if flags.get("is_others") in (True, 1, "1"):
        return "others"

    fn = str(first_name or "").strip().lower()
    ln = str(last_name or "").strip().lower()
    if fn and ln and sqlite_by_name:
        hit = sqlite_by_name.get(f"{fn}|{ln}")
        if hit:
            return str(hit).strip()

    em = str(email or "").strip().lower()
    if em and sqlite_by_email:
        hit = sqlite_by_email.get(em)
        if hit:
            return str(hit).strip()

    ph = str(phone or "").strip()
    if ph and sqlite_by_phone:
        for key in _phone_lookup_keys(ph):
            hit = sqlite_by_phone.get(key)
            if hit:
                return str(hit).strip()
    return ""


def _phone_lookup_keys(raw: str) -> list[str]:
    import re

    digits = re.sub(r"\D+", "", raw or "")
    keys = {str(raw).strip().lower(), digits}
    if digits.startswith("63") and len(digits) >= 12:
        keys.add("0" + digits[2:])
    if digits.startswith("0") and len(digits) >= 11:
        keys.add("+63" + digits[1:])
    if len(digits) == 10 and digits.startswith("9"):
        keys.add("0" + digits)
        keys.add("+63" + digits)
    return [k for k in keys if k]


def ownership_columns(raw) -> dict[str, str]:
    """
    Return LANDOWNER/CLOA/LEASE/SEASONAL/OTHERS flags ('X' or '') for the farm table.
    Also includes legacy OWNER_OPERATOR/LESSOR/LESSEE/SHAREHOLDER keys used by imports.
    """
    s = str(raw or "").strip().lower()
    cols = {k: "" for k in ("LANDOWNER", "CLOA", "LEASE", "SEASONAL", "OTHERS")}

    def mark(key: str) -> None:
        cols[key] = "X"

    wizard = {
        "landowner": "LANDOWNER",
        "cloa_holder": "CLOA",
        "cloa holder": "CLOA",
        "list_holder": "LEASE",
        "list holder": "LEASE",
        "sessional_farm_worker": "SEASONAL",
        "sessional farm worker": "SEASONAL",
        "others": "OTHERS",
    }
    if s in wizard:
        mark(wizard[s])
        return _with_legacy(cols)

    letter = {"a": "LANDOWNER", "b": "CLOA", "c": "LEASE", "d": "SEASONAL", "e": "OTHERS"}
    if s in letter:
        mark(letter[s])
        return _with_legacy(cols)

    enum = {
        "owner": "LANDOWNER",
        "owned": "LANDOWNER",
        "tenant": "SEASONAL",
        "lessee": "LEASE",
        "co-owner": "CLOA",
        "co_owner": "CLOA",
        "coowner": "CLOA",
        "other": "OTHERS",
        "usufruct": "OTHERS",
    }
    if s in enum:
        mark(enum[s])
        return _with_legacy(cols)

    if "landowner" in s:
        mark("LANDOWNER")
    elif "cloa" in s:
        mark("CLOA")
    elif "lease" in s or "list" in s or "lessee" in s:
        mark("LEASE")
    elif "seasonal" in s or "sessional" in s:
        mark("SEASONAL")
    elif s:
        mark("OTHERS")

    return _with_legacy(cols)


def _with_legacy(cols: dict[str, str]) -> dict[str, str]:
    return {
        **cols,
        "OWNER_OPERATOR": cols["LANDOWNER"],
        "LESSOR": cols["CLOA"],
        "LESSEE": cols["LEASE"],
        "SHAREHOLDER": cols["SEASONAL"],
    }
