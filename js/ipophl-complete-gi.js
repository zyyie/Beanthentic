/**
 * IPOPHL Complete → GI Updates (XAMPP). Loaded before dashboard.js.
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
      'position:fixed;top:20px;right:20px;background:#145e1e;color:#fff;padding:14px 18px;border-radius:8px;z-index:99999;max-width:380px;line-height:1.4;';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 10000);
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

  function taskIdFromContainer(el) {
    const container = el.closest('[id$="-files"]');
    if (!container || !container.id) return '';
    return container.id.replace(/-files$/, '');
  }

  function collectFileEntriesFromDom() {
    const byUuid = new Map();
    const add = (uuid, taskId) => {
      const id = String(uuid || '').trim();
      if (!id) return;
      const tid = String(taskId || '').trim();
      const prev = byUuid.get(id) || {};
      byUuid.set(id, {
        file_uuid: id,
        task_id: tid && tid.indexOf('phase') === 0 ? tid : prev.task_id || tid,
      });
    };

    document.querySelectorAll('#ipophl-module .file-item[data-file-uuid]').forEach((el) => {
      add(
        el.getAttribute('data-file-uuid') || el.dataset.fileUuid,
        el.getAttribute('data-task-id') || el.dataset.taskId || taskIdFromContainer(el)
      );
    });

    document.querySelectorAll('#ipophl-module [data-file-uuid]').forEach((el) => {
      if (el.classList && el.classList.contains('file-item')) return;
      add(el.getAttribute('data-file-uuid'), taskIdFromContainer(el));
    });

    document.querySelectorAll('#ipophl-module .file-action-btn.ai-analysis').forEach((btn) => {
      const m = (btn.getAttribute('onclick') || '').match(/loadAndShowFullAnalysis\('([^']+)'\)/);
      if (!m) return;
      const item = btn.closest('.file-item');
      add(
        m[1],
        item
          ? item.getAttribute('data-task-id') || item.dataset.taskId || taskIdFromContainer(item)
          : ''
      );
    });

    if (window.dashboardApp && window.dashboardApp.ipophlFiles) {
      Object.keys(window.dashboardApp.ipophlFiles).forEach((taskId) => {
        (window.dashboardApp.ipophlFiles[taskId] || []).forEach((f) => {
          add(f.id || f.file_uuid, taskId);
        });
      });
    }

    return Array.from(byUuid.values());
  }

  async function fetchServerFileEntries() {
    try {
      const res = await fetch(API('/api/ipo-documents?limit=300'), { credentials: 'same-origin' });
      const data = await parseJson(res);
      return (data.items || [])
        .map((d) => ({
          file_uuid: String(d.file_uuid || '').trim(),
          task_id: String(d.task_id || '').trim(),
        }))
        .filter((e) => e.file_uuid);
    } catch (e) {
      console.warn('ipo-documents list failed', e);
      return [];
    }
  }

  function mergeFileEntries(serverEntries, domEntries) {
    const byUuid = new Map();
    serverEntries.forEach((e) => {
      if (e.file_uuid) byUuid.set(e.file_uuid, { ...e });
    });
    domEntries.forEach((e) => {
      if (!e.file_uuid) return;
      const prev = byUuid.get(e.file_uuid) || {};
      const tid =
        e.task_id && e.task_id.indexOf('phase') === 0
          ? e.task_id
          : prev.task_id && prev.task_id.indexOf('phase') === 0
            ? prev.task_id
            : e.task_id || prev.task_id || '';
      byUuid.set(e.file_uuid, { file_uuid: e.file_uuid, task_id: tid });
    });
    return Array.from(byUuid.values());
  }

  async function publishIpophlToGiUpdates() {
    setLoading(true, 'Reading uploaded documents…');

    const serverEntries = await fetchServerFileEntries();
    const domEntries = collectFileEntriesFromDom();
    const fileEntries = mergeFileEntries(serverEntries, domEntries);
    const fileUuids = fileEntries.map((e) => e.file_uuid);

    if (!fileUuids.length) {
      setLoading(false);
      notify(
        'No saved IPOPHL files on this PC. Upload in each IPOPHL section (wait for analysis to finish), then click Complete Registration again. Use the same PC that runs python web.py.'
      );
      return;
    }

    setLoading(true, 'Saving ' + fileUuids.length + ' file(s) to GI Updates…');

    try {
      const res = await fetch(API('/api/ipophl/complete-registration'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_uuids: fileUuids,
          file_entries: fileEntries,
          force_publish: true,
          publish_all_categories: false,
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
      const withFiles = data.categories_with_files != null ? data.categories_with_files : cards;
      notify(
        data.message ||
          'Saved ' +
            cards +
            ' update(s) with ' +
            withFiles +
            ' file attachment(s). On the phone: open GI Updates and pull to refresh (app.py on port 8080).'
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
    window.dashboardApp.sendRegistrationEmail = function () {
      return publishIpophlToGiUpdates();
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
