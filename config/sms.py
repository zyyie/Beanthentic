"""
SMS delivery for Beanthentic (password reset OTP and alerts).

Providers:
  - sms_gateway — SMS Gateway for Android (capcom6), local /message or cloud API
  - semaphore   — https://semaphore.co (Philippines)
  - twilio      — https://twilio.com
  - log         — console (local dev)

Android setup: phone on same Wi‑Fi as the PC running Beanthentic; enable Local Server
in SMS Gateway and use the phone LAN IP in settings.json.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

_SETTINGS_PATH = Path(__file__).resolve().parents[1] / "settings.json"


@dataclass
class SmsSendResult:
    ok: bool
    provider: str
    error: str | None = None
    dev_message: str | None = None


def _read_settings() -> dict:
    try:
        raw = json.loads(_SETTINGS_PATH.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _nested(block: dict, key: str) -> dict:
    val = block.get(key)
    return val if isinstance(val, dict) else {}


def sms_config() -> dict:
    settings = _read_settings()
    block = _nested(settings, "sms")
    gw = _nested(block, "sms_gateway")

    provider = (
        os.getenv("BEANTHENTIC_SMS_PROVIDER", "").strip().lower()
        or str(block.get("provider") or "sms_gateway").strip().lower()
    )
    if provider in ("sms_forwarder", "forwarder"):
        provider = "sms_gateway"
    enabled_raw = os.getenv("BEANTHENTIC_SMS_ENABLED", "").strip().lower()
    if enabled_raw in ("0", "false", "no", "off"):
        enabled = False
    elif enabled_raw in ("1", "true", "yes", "on"):
        enabled = True
    else:
        enabled = bool(block.get("enabled", True))

    return {
        "enabled": enabled,
        "provider": provider or "auto",
        "sender_name": (
            os.getenv("BEANTHENTIC_SMS_SENDER", "").strip()
            or str(block.get("sender_name") or "Beanthentic").strip()[:11]
        ),
        "public_base_url": (
            os.getenv("BEANTHENTIC_PUBLIC_BASE_URL", "").strip().rstrip("/")
            or str(block.get("public_base_url") or "").strip().rstrip("/")
        ),
        # SMS Gateway for Android
        "gateway_mode": (
            os.getenv("SMS_GATEWAY_MODE", "").strip().lower()
            or str(gw.get("mode") or "local").strip().lower()
        ),
        "gateway_local_base_url": (
            os.getenv("SMS_GATEWAY_BASE_URL", "").strip().rstrip("/")
            or str(gw.get("local_base_url") or "").strip().rstrip("/")
        ),
        "gateway_local_path": (
            os.getenv("SMS_GATEWAY_LOCAL_PATH", "").strip()
            or str(gw.get("local_path") or "/message").strip()
            or "/message"
        ),
        "gateway_cloud_url": (
            os.getenv("SMS_GATEWAY_CLOUD_URL", "").strip().rstrip("/")
            or str(gw.get("cloud_url") or "https://api.sms-gate.app/3rdparty/v1/messages").strip()
        ),
        "gateway_username": (
            os.getenv("SMS_GATEWAY_USERNAME", "").strip()
            or str(gw.get("username") or "").strip()
        ),
        "gateway_password": (
            os.getenv("SMS_GATEWAY_PASSWORD", "").strip()
            or str(gw.get("password") or "").strip()
        ),
        "gateway_sim_number": int(os.getenv("SMS_GATEWAY_SIM_NUMBER", str(gw.get("sim_number") or 1))),
        # Cloud SMS APIs
        "semaphore_api_key": os.getenv("SEMAPHORE_API_KEY", "").strip(),
        "twilio_account_sid": os.getenv("TWILIO_ACCOUNT_SID", "").strip(),
        "twilio_auth_token": os.getenv("TWILIO_AUTH_TOKEN", "").strip(),
        "twilio_from_number": os.getenv("TWILIO_FROM_NUMBER", "").strip(),
    }


def _resolve_provider(cfg: dict) -> str:
    explicit = (cfg.get("provider") or "sms_gateway").strip().lower()
    if explicit in ("sms_forwarder", "forwarder"):
        explicit = "sms_gateway"
    if explicit not in ("auto", ""):
        return explicit
    if cfg.get("gateway_local_base_url") or (
        cfg.get("gateway_username") and cfg.get("gateway_password")
    ):
        return "sms_gateway"
    if cfg.get("semaphore_api_key"):
        return "semaphore"
    if cfg.get("twilio_account_sid") and cfg.get("twilio_auth_token"):
        return "twilio"
    return "log"


def format_ph_semaphore_number(phone_digits: str) -> str:
    digits = "".join(ch for ch in str(phone_digits or "") if ch.isdigit())
    if digits.startswith("63") and len(digits) == 12:
        return digits
    if digits.startswith("0") and len(digits) == 11:
        digits = digits[1:]
    if len(digits) == 10 and digits.startswith("9"):
        return "63" + digits
    return digits


def format_ph_e164(phone_digits: str) -> str:
    msisdn = format_ph_semaphore_number(phone_digits)
    if msisdn.startswith("63"):
        return "+" + msisdn
    return "+63" + msisdn[-10:] if len(msisdn) >= 10 else "+63" + msisdn


def build_reset_url(token: str, *, request_base_url: str | None = None) -> str:
    cfg = sms_config()
    base = (cfg.get("public_base_url") or "").strip().rstrip("/")
    if not base and request_base_url:
        base = str(request_base_url).strip().rstrip("/")
    path = f"/reset-password/{token}"
    return f"{base}{path}" if base else path


def _password_reset_message(reset_url: str) -> str:
    return (
        "Beanthentic password reset.\n"
        f"Open this link within 30 minutes:\n{reset_url}\n"
        "If you did not request this, ignore this message."
    )


def _http_json_request(
    url: str,
    payload: dict,
    *,
    method: str = "POST",
    basic_user: str | None = None,
    basic_pass: str | None = None,
    timeout: int = 25,
) -> tuple[int, str]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if basic_user is not None and basic_pass is not None:
        token = base64.b64encode(f"{basic_user}:{basic_pass}".encode()).decode("ascii")
        headers["Authorization"] = f"Basic {token}"
    req = Request(url, data=body, method=method, headers=headers)
    with urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read().decode("utf-8", errors="replace")


def _send_sms_gateway(phone_digits: str, message: str, cfg: dict) -> SmsSendResult:
    user = cfg.get("gateway_username") or ""
    password = cfg.get("gateway_password") or ""
    if not user or not password:
        return SmsSendResult(
            False,
            "sms_gateway",
            "Set sms_gateway.username and sms_gateway.password (from the SMS Gateway app).",
        )

    to_number = format_ph_e164(phone_digits)
    sim_number = max(1, min(3, int(cfg.get("gateway_sim_number") or 1)))
    payload = {
        "textMessage": {"text": message},
        "phoneNumbers": [to_number],
        "simNumber": sim_number,
    }

    mode = (cfg.get("gateway_mode") or "local").strip().lower()
    local_base = (cfg.get("gateway_local_base_url") or "").strip().rstrip("/")
    if mode == "cloud":
        url = cfg.get("gateway_cloud_url") or "https://api.sms-gate.app/3rdparty/v1/messages"
    else:
        if not local_base:
            return SmsSendResult(
                False,
                "sms_gateway",
                "Set sms_gateway.local_base_url (e.g. http://192.168.1.20:8080).",
            )
        path = cfg.get("gateway_local_path") or "/message"
        url = f"{local_base}{path if path.startswith('/') else '/' + path}"

    try:
        status, body = _http_json_request(url, payload, basic_user=user, basic_pass=password)
        if status < 400:
            return SmsSendResult(True, "sms_gateway")
        if status == 404 and mode != "cloud" and local_base:
            alt = f"{local_base}/3rdparty/v1/messages"
            status2, body2 = _http_json_request(
                alt, payload, basic_user=user, basic_pass=password
            )
            if status2 < 400:
                return SmsSendResult(True, "sms_gateway")
            body = body2
            status = status2
        return SmsSendResult(False, "sms_gateway", f"SMS Gateway HTTP {status}: {body[:180]}")
    except URLError as exc:
        hint = "Enable Local Server in SMS Gateway app and use the phone LAN IP."
        return SmsSendResult(False, "sms_gateway", f"Cannot reach SMS Gateway: {exc.reason}. {hint}")


def _send_semaphore(number: str, message: str, cfg: dict) -> SmsSendResult:
    api_key = cfg.get("semaphore_api_key") or ""
    if not api_key:
        return SmsSendResult(False, "semaphore", "SEMAPHORE_API_KEY is not set.")

    payload = urlencode(
        {
            "apikey": api_key,
            "number": number,
            "message": message,
            "sendername": cfg.get("sender_name") or "Beanthentic",
        }
    ).encode("utf-8")
    req = Request(
        "https://api.semaphore.co/api/v4/messages",
        data=payload,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        if '"status":"Failed"' in body or '"status": "Failed"' in body:
            return SmsSendResult(False, "semaphore", "Semaphore rejected the message.")
        return SmsSendResult(True, "semaphore")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:200]
        return SmsSendResult(False, "semaphore", f"Semaphore HTTP {exc.code}: {detail}")
    except URLError as exc:
        return SmsSendResult(False, "semaphore", f"Could not reach Semaphore: {exc.reason}")


def _send_twilio(to_e164: str, message: str, cfg: dict) -> SmsSendResult:
    sid = cfg.get("twilio_account_sid") or ""
    token = cfg.get("twilio_auth_token") or ""
    from_num = cfg.get("twilio_from_number") or ""
    if not sid or not token or not from_num:
        return SmsSendResult(
            False,
            "twilio",
            "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER.",
        )

    payload = urlencode({"To": to_e164, "From": from_num, "Body": message}).encode("utf-8")
    auth = base64.b64encode(f"{sid}:{token}".encode()).decode("ascii")
    req = Request(
        f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    try:
        with urlopen(req, timeout=20) as resp:
            if resp.status >= 400:
                return SmsSendResult(False, "twilio", f"Twilio HTTP {resp.status}")
        return SmsSendResult(True, "twilio")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:200]
        return SmsSendResult(False, "twilio", f"Twilio HTTP {exc.code}: {detail}")
    except URLError as exc:
        return SmsSendResult(False, "twilio", f"Could not reach Twilio: {exc.reason}")


def _send_log(number: str, message: str) -> SmsSendResult:
    line = f"[SMS:log] To {number}: {message}"
    logger.warning(line)
    print(line)
    return SmsSendResult(True, "log", dev_message=message)


def send_sms(phone_digits: str, message: str) -> SmsSendResult:
    cfg = sms_config()
    if not cfg.get("enabled"):
        return SmsSendResult(False, "disabled", "SMS is disabled in settings.")

    provider = _resolve_provider(cfg)
    if provider == "sms_gateway":
        return _send_sms_gateway(phone_digits, message, cfg)
    if provider == "semaphore":
        return _send_semaphore(format_ph_semaphore_number(phone_digits), message, cfg)
    if provider == "twilio":
        return _send_twilio(format_ph_e164(phone_digits), message, cfg)
    if provider == "log":
        return _send_log(format_ph_e164(phone_digits), message)

    return SmsSendResult(False, provider, f"Unknown SMS provider: {provider}")


def send_otp_sms(phone_digits: str, otp_code: str) -> SmsSendResult:
    """Send a 6-digit verification code via SMS Gateway."""
    code = (otp_code or "").strip()
    if len(code) != 6 or not code.isdigit():
        return SmsSendResult(False, "config", "Invalid OTP code.")
    message = (
        f"Beanthentic verification code: {code}\n"
        "Valid for 10 minutes. Do not share this code."
    )
    result = send_sms(phone_digits, message)
    if result.provider == "log" and result.ok:
        result.dev_message = code
    return result


def send_password_reset_sms(phone_digits: str, reset_url: str) -> SmsSendResult:
    if not reset_url.startswith("http"):
        return SmsSendResult(
            False,
            "config",
            "Set public_base_url in settings so reset links work in SMS.",
        )
    message = _password_reset_message(reset_url)
    result = send_sms(phone_digits, message)
    if result.provider == "log" and result.ok:
        result.dev_message = reset_url
    return result
