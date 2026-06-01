"""Philippine mobile number normalization (matches Beanthentic-App db.php / beanthentic_mysql_api.py)."""

from __future__ import annotations

import re


def normalize_phone(raw: str) -> str:
    """Normalize PH mobile to E.164 +639XXXXXXXXX when possible."""
    s = (raw or "").strip()
    if not s or "@" in s:
        return ""
    digits = re.sub(r"\D+", "", s)
    if not digits:
        return ""
    if digits[0] == "0":
        digits = digits[1:]
    if len(digits) >= 2 and digits[:2] == "63":
        digits = digits[2:]
    if len(digits) == 10 and digits[0] == "9":
        return "+63" + digits
    return s


def phone_variants(raw: str) -> list[str]:
    """All common PH formats for one number (+63, 09…, 639…)."""
    out: list[str] = []
    seen: set[str] = set()

    def add(val: str) -> None:
        v = (val or "").strip()
        if not v or v in seen:
            return
        seen.add(v)
        out.append(v)

    add(normalize_phone(raw))
    digits = re.sub(r"\D+", "", raw or "")
    if not digits:
        return out
    add(digits)
    if digits.startswith("0") and len(digits) >= 11:
        add("+63" + digits[1:])
        add(digits[1:])
    if digits.startswith("63") and len(digits) >= 12:
        add("+63" + digits[2:])
        add("0" + digits[2:])
        add(digits[2:])
    if len(digits) == 10 and digits.startswith("9"):
        add("+63" + digits)
        add("0" + digits)
        add("63" + digits)
    return out
