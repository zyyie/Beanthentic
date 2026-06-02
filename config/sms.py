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
import ssl
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import HTTPSHandler, Request, build_opener, urlopen

logger = logging.getLogger(__name__)

_SETTINGS_PATH = Path(__file__).resolve().parents[1] / "settings.json"
SMS_BUILD_ID = "2026-06-02-otp-v4"

# Used when settings.json fields are blank or stale (e.g. after saving connection form).
_GATEWAY_DEFAULTS: dict[str, str] = {
    "mode": "auto",
    "local_base_url": "http://192.168.100.63:8080",
    "local_username": "sms",
    "local_password": "0_bjRllk",
    "username": "B4U_TR",
    "password": "olg6-_sexnmprd",
    "cloud_device_id": "",
    "cloud_url": "https://api.sms-gate.app/3rdparty/v1/messages",
}

# Old/wrong values sometimes saved via connection-settings form — ignore these.
_STALE_CLOUD_USERS = frozenset({"UHDZQ6"})


def _gw_setting(gw: dict, key: str, *, env_key: str = "", cloud: bool = False) -> str:
    env_val = os.getenv(env_key, "").strip() if env_key else ""
    if env_val:
        return env_val
    val = str(gw.get(key) or "").strip()
    default = str(_GATEWAY_DEFAULTS.get(key) or "").strip()
    if cloud and key == "username" and val in _STALE_CLOUD_USERS:
        return default
    if cloud and key == "password" and (not val or val == "jevgeesniyn_tx"):
        return default
    if key == "local_base_url" and val in ("", "http://192.168.100.5:8080", "http://192.168.0.115:8080"):
        return default or val
    if key == "local_password" and not val:
        return default
    if key == "local_username" and not val:
        return default or "sms"
    if val:
        return val
    return default


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
        "gateway_mode": _gw_setting(gw, "mode", env_key="SMS_GATEWAY_MODE").lower() or "cloud",
        "gateway_local_base_url": _gw_setting(gw, "local_base_url", env_key="SMS_GATEWAY_BASE_URL").rstrip("/"),
        "gateway_local_path": (
            os.getenv("SMS_GATEWAY_LOCAL_PATH", "").strip()
            or str(gw.get("local_path") or "/message").strip()
            or "/message"
        ),
        "gateway_cloud_url": _gw_setting(gw, "cloud_url", env_key="SMS_GATEWAY_CLOUD_URL"),
        "gateway_username": _gw_setting(gw, "username", env_key="SMS_GATEWAY_USERNAME", cloud=True),
        "gateway_password": _gw_setting(gw, "password", env_key="SMS_GATEWAY_PASSWORD", cloud=True),
        "gateway_local_username": _gw_setting(gw, "local_username", env_key="SMS_GATEWAY_LOCAL_USERNAME"),
        "gateway_local_password": _gw_setting(gw, "local_password", env_key="SMS_GATEWAY_LOCAL_PASSWORD"),
        "gateway_sim_number": int(os.getenv("SMS_GATEWAY_SIM_NUMBER", str(gw.get("sim_number") or 1))),
        "gateway_cloud_device_id": _gw_setting(
            gw,
            "cloud_device_id",
            env_key="SMS_GATEWAY_DEVICE_ID",
        ) or _gw_setting(gw, "device_id"),
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


def _normalize_cloud_url(url: str) -> str:
    raw = (url or "").strip().rstrip("/")
    if not raw:
        return "https://api.sms-gate.app/3rdparty/v1/messages"
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    if ":" in raw and not raw.startswith("/"):
        return f"https://{raw}/3rdparty/v1/messages"
    return f"https://{raw}"


def _is_sms_gate_host(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host.endswith("sms-gate.app")


def _is_ssl_verify_error(exc: BaseException) -> bool:
    reason = getattr(exc, "reason", exc)
    if isinstance(reason, ssl.SSLCertVerificationError):
        return True
    text = str(reason).lower()
    return "certificate verify failed" in text or "ssl" in text


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
    ssl_verify: bool = True,
) -> tuple[int, str]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if basic_user is not None and basic_pass is not None:
        token = base64.b64encode(f"{basic_user}:{basic_pass}".encode()).decode("ascii")
        headers["Authorization"] = f"Basic {token}"
    req = Request(url, data=body, method=method, headers=headers)

    def _open(verify: bool):
        parsed = urlparse(url)
        if parsed.scheme == "https":
            # sms-gate.app cert often fails on Windows/Python 3.13+; skip verify for that host.
            if _is_sms_gate_host(url) or not verify:
                ctx = ssl._create_unverified_context()
            else:
                ctx = ssl.create_default_context()
            opener = build_opener(HTTPSHandler(context=ctx))
            with opener.open(req, timeout=timeout) as resp:
                return resp.status, resp.read().decode("utf-8", errors="replace")
        with urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")

    try:
        return _open(ssl_verify)
    except HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")
    except URLError as exc:
        # api.sms-gate.app cert chain fails on some Python/OpenSSL builds (3.13+)
        if ssl_verify and _is_ssl_verify_error(exc) and _is_sms_gate_host(url):
            logger.warning("SMS Gateway cloud SSL verify failed; retrying without verify for %s", url)
            try:
                return _open(False)
            except HTTPError as retry_exc:
                return retry_exc.code, retry_exc.read().decode("utf-8", errors="replace")
        raise


def _gateway_attempts(cfg: dict) -> list[tuple[str, str, str, bool]]:
    """Build (url, username, password, is_local) attempts in priority order."""
    mode = (cfg.get("gateway_mode") or "auto").strip().lower()
    local_base = (cfg.get("gateway_local_base_url") or "").strip().rstrip("/")
    cloud_url = _normalize_cloud_url(cfg.get("gateway_cloud_url") or "")

    cloud_user = (cfg.get("gateway_username") or "").strip()
    cloud_pass = (cfg.get("gateway_password") or "").strip()
    # Never use cloud credentials on the local server — that returns 401 Unauthorized.
    local_user = (cfg.get("gateway_local_username") or "").strip()
    local_pass = (cfg.get("gateway_local_password") or "").strip()

    local_path = (cfg.get("gateway_local_path") or "/message").strip() or "/message"
    local_urls: list[str] = []
    if local_base:
        local_urls.append(f"{local_base}{local_path if local_path.startswith('/') else '/' + local_path}")

    attempts: list[tuple[str, str, str, bool, int]] = []

    def add_local():
        if not local_base or not local_user or not local_pass:
            return
        for url in local_urls:
            attempts.append((url, local_user, local_pass, True, 6))

    def add_cloud():
        if cloud_user and cloud_pass:
            attempts.append((cloud_url, cloud_user, cloud_pass, False, 30))

    if mode == "local":
        add_local()
        add_cloud()
    elif mode == "cloud":
        add_cloud()
        add_local()
    else:
        # auto: local first (same Wi‑Fi, fastest), then cloud
        add_local()
        add_cloud()

    seen: set[str] = set()
    unique: list[tuple[str, str, str, bool, int]] = []
    for item in attempts:
        if item[0] not in seen:
            seen.add(item[0])
            unique.append(item)
    return unique


def _build_gateway_payload(
    message: str,
    to_number: str,
    sim_number: int,
    *,
    device_id: str = "",
    is_cloud: bool = False,
) -> dict:
    payload: dict = {
        "textMessage": {"text": message},
        "phoneNumbers": [to_number],
        "simNumber": sim_number,
    }
    if is_cloud and device_id:
        payload["deviceId"] = device_id
    return payload


def _send_sms_gateway(phone_digits: str, message: str, cfg: dict) -> SmsSendResult:
    attempts = _gateway_attempts(cfg)
    if not attempts:
        return SmsSendResult(
            False,
            "sms_gateway",
            "Set sms_gateway credentials and local_base_url or cloud mode in settings.json.",
        )

    to_number = format_ph_e164(phone_digits)
    sim_number = max(1, min(3, int(cfg.get("gateway_sim_number") or 1)))
    device_id = (cfg.get("gateway_cloud_device_id") or "").strip()

    errors: list[str] = []
    for url, user, password, is_local, timeout in attempts:
        is_cloud = not is_local
        payloads: list[dict] = []
        base = _build_gateway_payload(message, to_number, sim_number, device_id="", is_cloud=False)
        if is_cloud and device_id:
            payloads.append(_build_gateway_payload(message, to_number, sim_number, device_id=device_id, is_cloud=True))
        payloads.append(base)

        for payload in payloads:
            try:
                status, body = _http_json_request(
                    url,
                    payload,
                    basic_user=user,
                    basic_pass=password,
                    timeout=timeout,
                )
                if status in (200, 201, 202):
                    logger.info("SMS sent via %s (%s)", "local" if is_local else "cloud", url)
                    return SmsSendResult(True, "sms_gateway")
                if status == 401:
                    errors.append(f"{'Local' if is_local else 'Cloud'} login failed (401). Check credentials in SMS Gateway app.")
                    break
                if status == 400 and is_cloud and "device" in body.lower() and device_id in payload:
                    errors.append("cloud: device offline — retrying without device id")
                    continue
                errors.append(f"{'local' if is_local else 'cloud'} HTTP {status}: {body[:120]}")
                break
            except HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")[:120] if exc.fp else str(exc.reason)
                if exc.code == 401:
                    errors.append(f"{'Local' if is_local else 'Cloud'} login failed (401).")
                    break
                errors.append(f"{'local' if is_local else 'cloud'} HTTP {exc.code}: {detail}")
                break
            except URLError as exc:
                label = "local phone" if is_local else "cloud"
                errors.append(f"{label}: {exc.reason}")
                break

    detail = "; ".join(errors[-3:]) if errors else "SMS Gateway unreachable."
    hint = "Open SMS Gateway app → tap ONLINE. Phone IP must match local_base_url in settings.json."
    return SmsSendResult(False, "sms_gateway", f"Cannot send SMS. {detail} {hint}")


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
