/**
 * IPOPHL Complete Registration — upload files + publish to app GI Updates (one step).
 * Same pattern as admin_gi_send / gi-contributions-send on the app server.
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
      'position:fixed;top:20px;right:20px;background:#145e1e;color:#fff;padding:14px 18px;border-radius:8px;z-index:99999;max-width:400px;line-height:1.45;';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 12000);
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
        (label || 'Uploading to GI Updates…') +
        '</span>';
    } else {
      btn.disabled = false;
      btn.classList.remove('is-loading');
      btn.removeAttribute('aria-busy');
      btn.textContent = btn.dataset.defaultLabel;
    }
  }

  function collectExistingUuids() {
    const uuids = new Set();
    const add = (id) => {
      const u = String(id || '').trim();
      if (u && !u.startsWith('pending-')) uuids.add(u);
    };
    document.querySelectorAll('#ipophl-module .file-item[data-file-uuid]').forEach((el) => {
      add(el.getAttribute('data-file-uuid') || el.dataset.fileUuid);
    });
    if (window.dashboardApp?.ipophlFiles) {
      Object.values(window.dashboardApp.ipophlFiles).forEach((list) => {
        (list || []).forEach((f) => add(f.id || f.file_uuid));
      });
    }
    return Array.from(uuids);
  }

  async function publishIpophlToGiUpdates() {
    const pending =
      window.ipophlAnalyzer && typeof window.ipophlAnalyzer.collectPendingUploads === 'function'
        ? window.ipophlAnalyzer.collectPendingUploads()
        : [];
    const existingUuids = collectExistingUuids();

    if (!pending.length && !existingUuids.length) {
      notify(
        'Pumili muna ng file sa Phase 5 (o ibang phase), tapos click Complete Registration. Doon ia-upload sa database at lalabas sa GI Updates sa app.'
      );
      return;
    }

    setLoading(
      true,
      pending.length
        ? `Uploading ${pending.length} file(s) and saving to GI Updates…`
        : 'Publishing to GI Updates…'
    );

    const form = new FormData();
    pending.forEach(({ file, task_id }) => {
      form.append('files', file);
      form.append('task_ids', task_id);
    });
    if (existingUuids.length) {
      form.append('file_uuids_json', JSON.stringify(existingUuids));
    }
    form.append('publish_all_categories', 'true');
    form.append('force_publish', 'true');

    try {
      const res = await fetch(API('/api/ipophl/complete-registration'), {
        method: 'POST',
        credentials: 'same-origin',
        body: form,
      });
      const data = await parseJson(res).catch(() => ({}));
      if (res.status === 401) {
        throw new Error('Session expired. Log in again.');
      }
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || data.message || data.detail || 'Save failed (HTTP ' + res.status + ')');
      }

      if (window.ipophlAnalyzer?.clearPendingAfterPublish) {
        window.ipophlAnalyzer.clearPendingAfterPublish();
      }
      if (window.ipophlAnalyzer?.loadExistingDocuments) {
        await window.ipophlAnalyzer.loadExistingDocuments();
      }

      notify(
        data.message ||
          'Done! Files are in the database. Sa phone: buksan GI Updates at i-refresh (app.py :8080).'
      );

      if (window.dashboardApp?.switchModule) {
        await window.dashboardApp.switchModule('register');
      }
      if (window.dashboardApp?.loadContributionsFromApi) {
        await window.dashboardApp.loadContributionsFromApi();
      }
    } catch (err) {
      console.error('GI publish failed:', err);
      let msg = err.message || 'Could not save to GI Updates.';
      if (msg === 'Failed to fetch') {
        msg = 'Cannot reach web.py. Restart python web.py on this PC, then Ctrl+Shift+R.';
      }
      notify(msg);
    } finally {
      setLoading(false);
    }
  }

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
    window.dashboardApp.sendRegistrationEmail = publishIpophlToGiUpdates;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', patchDashboardApp);
  } else {
    patchDashboardApp();
  }
  window.addEventListener('load', patchDashboardApp);
  window.publishIpophlToGiUpdates = publishIpophlToGiUpdates;
})();
