/**
 * Beanthentic date/time — matches app homepage clock.
 * Messaging timestamps: show exact YYYY-MM-DD HH:mm from API (no UTC +8 shift).
 */
(function (global) {
  'use strict';

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  var MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };

  /** Wall-clock digits from API/DB string (ignores Z and +00:00 suffixes). */
  function extractWallClock(isoStr) {
    var s = String(isoStr || '').trim().replace(/\s+GMT\s*$/i, '').replace(/\s+UTC\s*$/i, '');
    if (!s) return null;
    var m = s.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    return {
      year: +m[1],
      month: +m[2],
      day: +m[3],
      hour: +m[4],
      minute: +m[5],
      second: +(m[6] || 0),
    };
  }

  /** e.g. "Sat, 23 May 2026 03:25:22 GMT" */
  function extractRfcWallClock(isoStr) {
    var s = String(isoStr || '').trim().replace(/\s+GMT\s*$/i, '').replace(/\s+UTC\s*$/i, '');
    var m = s.match(
      /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/i
    );
    if (!m) return null;
    var mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (!mo) return null;
    return {
      year: +m[3],
      month: mo,
      day: +m[1],
      hour: +m[4],
      minute: +m[5],
      second: +(m[6] || 0),
    };
  }

  function extractAnyWallClock(isoStr) {
    if (isoStr instanceof Date && !isNaN(isoStr.getTime())) {
      return {
        year: isoStr.getFullYear(),
        month: isoStr.getMonth() + 1,
        day: isoStr.getDate(),
        hour: isoStr.getHours(),
        minute: isoStr.getMinutes(),
        second: isoStr.getSeconds(),
      };
    }
    return extractWallClock(isoStr) || extractRfcWallClock(isoStr);
  }

  function formatTime12(hour, minute) {
    var ampm = hour >= 12 ? 'PM' : 'AM';
    var h12 = hour % 12 || 12;
    return h12 + ':' + pad2(minute) + ' ' + ampm;
  }

  function formatFromParts(parts) {
    var cal = new Date(parts.year, parts.month - 1, parts.day);
    var dow = cal.toLocaleDateString('en-US', { weekday: 'short' });
    var month = cal.toLocaleDateString('en-US', { month: 'short' });
    return (
      dow +
      ' - ' +
      month +
      ' ' +
      parts.day +
      ', ' +
      parts.year +
      ' · ' +
      formatTime12(parts.hour, parts.minute)
    );
  }

  function formatHomeDateTimeFromDate(d) {
    if (!d || isNaN(d.getTime())) return '';
    var dow = d.toLocaleDateString('en-US', { weekday: 'short' });
    var month = d.toLocaleDateString('en-US', { month: 'short' });
    var day = d.getDate();
    var year = d.getFullYear();
    var time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    return dow + ' - ' + month + ' ' + day + ', ' + year + ' · ' + time;
  }

  /** Display stored time exactly as saved (no timezone conversion, no "GMT"). */
  function formatHomeDateTime(isoStr) {
    var parts = extractAnyWallClock(isoStr);
    if (!parts) return '';
    return formatFromParts(parts);
  }

  function parseAppDateTime(isoStr) {
    var parts = extractAnyWallClock(isoStr);
    if (!parts) return null;
    return new Date(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
  }

  function formatNow() {
    return formatHomeDateTimeFromDate(new Date());
  }

  function deviceSqlDateTime() {
    var n = new Date();
    return (
      n.getFullYear() +
      '-' +
      pad2(n.getMonth() + 1) +
      '-' +
      pad2(n.getDate()) +
      ' ' +
      pad2(n.getHours()) +
      ':' +
      pad2(n.getMinutes()) +
      ':' +
      pad2(n.getSeconds())
    );
  }

  function nowWallParts() {
    var n = new Date();
    return {
      year: n.getFullYear(),
      month: n.getMonth() + 1,
      day: n.getDate(),
      hour: n.getHours(),
      minute: n.getMinutes(),
      second: n.getSeconds(),
    };
  }

  function dayKey(parts) {
    return parts.year * 10000 + parts.month * 100 + parts.day;
  }

  /** Short timestamp under chat bubbles (Messenger-style, wall-clock safe). */
  function formatChatBubbleTime(isoStr) {
    var parts = extractAnyWallClock(isoStr);
    if (!parts) return '';
    var nowP = nowWallParts();
    var msgDay = dayKey(parts);
    var todayDay = dayKey(nowP);
    var timeStr = formatTime12(parts.hour, parts.minute);
    var msgDate = parseAppDateTime(isoStr);
    if (!msgDate) return timeStr;

    var diffMs = new Date().getTime() - msgDate.getTime();
    if (diffMs < 0) diffMs = 0;

    if (msgDay === todayDay) {
      return timeStr;
    }

    var yesterday = new Date(nowP.year, nowP.month - 1, nowP.day - 1);
    var yKey =
      yesterday.getFullYear() * 10000 +
      (yesterday.getMonth() + 1) * 100 +
      yesterday.getDate();
    if (msgDay === yKey) {
      return 'Yesterday ' + timeStr;
    }

    if (diffMs < 7 * 86400000) {
      var cal = new Date(parts.year, parts.month - 1, parts.day);
      var dow = cal.toLocaleDateString('en-US', { weekday: 'short' });
      return dow + ' ' + timeStr;
    }

    var cal = new Date(parts.year, parts.month - 1, parts.day);
    var month = cal.toLocaleDateString('en-US', { month: 'short' });
    if (parts.year === nowP.year) {
      return month + ' ' + parts.day;
    }
    return month + ' ' + parts.day + ', ' + parts.year;
  }

  /** Sidebar / thread list preview (relative when recent). */
  function formatChatListTime(isoStr) {
    var parts = extractAnyWallClock(isoStr);
    if (!parts) return '';
    var msgDate = parseAppDateTime(isoStr);
    if (!msgDate) return formatChatBubbleTime(isoStr);

    var diffMs = new Date().getTime() - msgDate.getTime();
    if (diffMs < 0) diffMs = 0;

    var mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60 && dayKey(parts) === dayKey(nowWallParts())) {
      return mins + 'm';
    }

    var nowP = nowWallParts();
    if (dayKey(parts) === dayKey(nowP)) {
      return formatTime12(parts.hour, parts.minute);
    }

    var yesterday = new Date(nowP.year, nowP.month - 1, nowP.day - 1);
    var yKey =
      yesterday.getFullYear() * 10000 +
      (yesterday.getMonth() + 1) * 100 +
      yesterday.getDate();
    if (dayKey(parts) === yKey) return 'Yesterday';

    if (diffMs < 7 * 86400000) {
      var cal = new Date(parts.year, parts.month - 1, parts.day);
      return cal.toLocaleDateString('en-US', { weekday: 'short' });
    }

    var cal = new Date(parts.year, parts.month - 1, parts.day);
    var month = cal.toLocaleDateString('en-US', { month: 'short' });
    if (parts.year === nowP.year) return month + ' ' + parts.day;
    return month + ' ' + parts.day + ', ' + parts.year;
  }

  function sameWallClockMinute(a, b) {
    var pa = extractAnyWallClock(a);
    var pb = extractAnyWallClock(b);
    if (!pa || !pb) return false;
    return (
      pa.year === pb.year &&
      pa.month === pb.month &&
      pa.day === pb.day &&
      pa.hour === pb.hour &&
      pa.minute === pb.minute
    );
  }

  global.BeanthenticDateTime = {
    extractWallClock: extractWallClock,
    extractAnyWallClock: extractAnyWallClock,
    parseAppDateTime: parseAppDateTime,
    formatHomeDateTime: formatHomeDateTime,
    formatChatBubbleTime: formatChatBubbleTime,
    formatChatListTime: formatChatListTime,
    sameWallClockMinute: sameWallClockMinute,
    formatNow: formatNow,
    deviceSqlDateTime: deviceSqlDateTime,
  };
})(typeof window !== 'undefined' ? window : this);
