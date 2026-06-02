# SMS setup (OTP & password reset)

Beanthentic sends SMS through **SMS Gateway for Android** (local or cloud).

| Flow | What is sent |
|------|----------------|
| **Farmer** forgot password | 6-digit OTP (`/farmer/forgot-password`) |
| **Admin** forgot password | 6-digit OTP (`/forgot-password` → `/verify-reset-otp`) |

Both use the same `sms_gateway` settings in `settings.json`.

## Quick start

1. Install **SMS Gateway for Android**: [GitHub](https://github.com/capcom6/android-sms-gateway) or Play Store
2. Turn **Local Server** ON and note IP, port (often **8080**), username, password
3. In **Connection Settings** (`/connection-settings`) or `settings.json`:
   - Provider: `sms_gateway`
   - Gateway mode: `local`
   - Local base URL: `http://PHONE_IP:8080`
   - Username / password from the app
4. Restart `python web.py`
5. Test: `http://YOUR_PC_IP:5000/farmer/forgot-password`

Phone and PC must be on the **same Wi‑Fi**.

Cloud mode uses `https://api.sms-gate.app/3rdparty/v1/messages` with the same credentials.

## settings.json example

```json
"sms": {
  "enabled": true,
  "provider": "sms_gateway",
  "public_base_url": "http://192.168.100.252:5000",
  "sms_gateway": {
    "mode": "local",
    "local_base_url": "http://192.168.100.5:8080",
    "local_path": "/message",
    "username": "sms",
    "password": "your-app-password",
    "sim_number": 1
  }
}
```

## Environment variables (optional)

| Variable | Purpose |
|----------|---------|
| `SMS_GATEWAY_BASE_URL` | Local gateway URL |
| `SMS_GATEWAY_USERNAME` / `SMS_GATEWAY_PASSWORD` | Basic auth |
| `BEANTHENTIC_PUBLIC_BASE_URL` | Admin reset link host (your PC) |
| `BEANTHENTIC_SMS_PROVIDER` | Force provider (`sms_gateway`, `log`, etc.) |

## Dev mode (no phone)

Set provider to `log` — OTP and reset links print in the terminal and on the success page.

## Other providers

- **Semaphore**: set `SEMAPHORE_API_KEY`
- **Twilio**: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
