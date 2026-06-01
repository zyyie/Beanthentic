/**
 * IPOPHL Complete → GI Updates (XAMPP). Loaded before dashboard.js so cached old
 * dashboard code cannot run email-only completeRegistration.
 */
(function () {
  'use strict';

  const API = typeof window.beanthenticApiUrl === 'function' ? window.beanthenticApiUrl : (p) => p;

  function parseJson(res) {
    if (typeof window.beanthenticParseJsonResponse === 'function') {
      return window.beanthenticParseJsonResponse(res);
    }
    return res.json();
  }

  function notify(msg) {
    if (window.dashboardApp && typeof window.dashboardApp.showIpophlNotification === 'function') {
      window.dashboardApp.showIpophlNotification(msg);
      return;
    }
    const el = document.createElement('div');
    el.className = 'ipophl-notification';
    el.textContent = msg;
    el.style.cssText =
      'position:fixed;top:20px;right:20px;background:#145e1e;color:#fff;padding:14px 18px;border-radius:8px;z-index:99999;max-width:360px;line-height:1.4;';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 8000);
  }

  function setLoading(isLoading, label) {
    const btn = document.querySelector('#ipophl-module .complete-btn');
    if (!btn) return;
    if (!btn.dataset.defaultLabel) {
      btn.dataset.defaultLabel = (btn.textContent || 'Complete Registration').trim();
    }
    if (isLoading) {
      btn.disabled = true;
      btn.classList.add('is-loading');
      btn.setAttribute('aria-busy', 'true');
      btn.innerHTML =
        '<span class="complete-btn-spinner" aria-hidden="true"></span>' +
        '<span class="complete-btn-label">' +
        (label || 'Saving to GI Updates…') +
        '</span>';
    } else {
      btn.disabled = false;
      btn.classList.remove('is-loading');
      btn.removeAttribute('aria-busy');
      btn.textContent = btn.dataset.defaultLabel;
    }
  }

  function collectFileUuidsFromDom() {
    const uuids = [];
    const seen = new Set();
    const add = (id) => {
      const u = String(id || '').trim();
      if (u && !seen.has(u)) {
        seen.add(u);
        uuids.push(u);
      }
    };
    document.querySelectorAll('#ipophl-module [data-file-uuid]').forEach((el) => {
      add(el.getAttribute('data-file-uuid') || el.dataset.fileUuid);
    });
    document.querySelectorAll('#ipophl-module .file-action-btn.ai-analysis').forEach((btn) => {
      const m = (btn.getAttribute('onclick') || '').match(/loadAndShowFullAnalysis\('([^']+)'\)/);
      if (m) add(m[1]);
    });
    if (window.dashboardApp && window.dashboardApp.ipophlFiles) {
      Object.keys(window.dashboardApp.ipophlFiles).forEach((taskId) => {
        (window.dashboardApp.ipophlFiles[taskId] || []).forEach((f) => {
          add(f.id || f.file_uuid);
        });
      });
    }
    return uuids;
  }

  async function fetchServerUuids() {
    try {
      const res = await fetch(API('/api/ipo-documents?limit=300'), { credentials: 'same-origin' });
      const data = await parseJson(res);
      return (data.items || [])
        .map((d) => String(d.file_uuid || '').trim())
        .filter(Boolean);
    } catch (e) {
      console.warn('ipo-documents list failed', e);
      return [];
    }
  }

  async function publishIpophlToGiUpdates() {
    setLoading(true, 'Saving to GI Updates (database)…');

    const merged = new Set();
    (await fetchServerUuids()).forEach((u) => merged.add(u));
    collectFileUuidsFromDom().forEach((u) => merged.add(u));

    const fileUuids = Array.from(merged);
    const fileEntries = fileUuids.map((id) => ({ file_uuid: id, task_id: 'ipophl-other' }));

    try {
      const res = await fetch(API('/api/ipophl/complete-registration'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_uuids: fileUuids,
          file_entries: fileEntries,
          force_publish: true,
        }),
      });
      const data = await parseJson(res).catch(() => ({}));
      if (res.status === 401) {
        throw new Error('Session expired. Log in again.');
      }
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || data.message || data.detail || 'Save failed (HTTP ' + res.status + ')');
      }
      const cards = data.cards_published || 0;
      const totalCats = data.categories_total || 13;
      const withFiles = data.categories_with_files != null ? data.categories_with_files : '';
      notify(
        data.message ||
          'Saved ' +
            cards +
            ' GI Update cards (' +
            totalCats +
            ' IPOPHL categories' +
            (withFiles !== '' ? ', ' + withFiles + ' with file(s)' : '') +
            '). Open GI Updates on the mobile app.'
      );
      if (window.dashboardApp) {
        if (typeof window.dashboardApp.switchModule === 'function') {
          await window.dashboardApp.switchModule('register');
        }
        if (typeof window.dashboardApp.loadContributionsFromApi === 'function') {
          await window.dashboardApp.loadContributionsFromApi();
        }
      }
    } catch (err) {
      console.error('GI publish failed:', err);
      let msg = err.message || 'Could not save to GI Updates.';
      if (msg === 'Failed to fetch') {
        msg = 'Cannot reach web.py. Restart python web.py on this PC, then Ctrl+F5.';
      }
      notify(msg);
    } finally {
      setLoading(false);
    }
  }

  // Capture phase — runs before any old dashboard.js bubble handlers.
  document.addEventListener(
    'click',
    function (e) {
      const btn = e.target.closest(
        '[data-action="ipophl-complete-registration"], #ipophl-module .complete-btn'
      );
      if (!btn) return;
      const root = document.getElementById('ipophl-module');
      if (!root || !root.contains(btn)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (btn.disabled || btn.classList.contains('is-loading')) return;
      publishIpophlToGiUpdates();
    },
    true
  );

  function patchDashboardApp() {
    if (!window.dashboardApp) return;
    window.dashboardApp.completeRegistration = publishIpophlToGiUpdates;
    window.dashboardApp.sendRegistrationEmail = function () {
      console.warn('sendRegistrationEmail disabled — use GI Updates publish instead.');
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', patchDashboardApp);
  } else {
    patchDashboardApp();
  }
  window.addEventListener('load', patchDashboardApp);
  window.publishIpophlToGiUpdates = publishIpophlToGiUpdates;
})();
