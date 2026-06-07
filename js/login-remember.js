/**
 * Remember admin phone on this device (localStorage + bt_saved_login cookie).
 * Passwords are never stored.
 */
(function () {
  const PHONE_KEY = "beanthentic_remember_phone";
  const COOKIE_NAME = "bt_saved_login";

  function readCookie(name) {
    const escaped = name.replace(/[.$?*|{}()[\]\\/+^]/g, "\\$&");
    const match = document.cookie.match(new RegExp("(?:^|; )" + escaped + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : "";
  }

  function normalizePhone(value) {
    return String(value || "").replace(/\D/g, "").slice(-10);
  }

  function phoneFromCookie() {
    try {
      const raw = readCookie(COOKIE_NAME);
      if (!raw) return "";
      const data = JSON.parse(raw);
      return normalizePhone(data && data.phone);
    } catch (_e) {
      return "";
    }
  }

  function initLoginRemember() {
    const phoneInput = document.getElementById("phone");
    const remember = document.getElementById("remember");
    const form = document.getElementById("login-form");
    if (!phoneInput || !form) return;

    const serverPhone = normalizePhone(phoneInput.value);
    if (!serverPhone) {
      const stored = normalizePhone(localStorage.getItem(PHONE_KEY) || "");
      const cookiePhone = phoneFromCookie();
      phoneInput.value = stored || cookiePhone || "";
    }

    form.addEventListener("submit", function () {
      const digits = normalizePhone(phoneInput.value);
      if (remember && remember.checked && digits.length === 10) {
        localStorage.setItem(PHONE_KEY, digits);
      } else {
        localStorage.removeItem(PHONE_KEY);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initLoginRemember);
  } else {
    initLoginRemember();
  }
})();
