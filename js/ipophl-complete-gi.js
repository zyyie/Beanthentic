/**
 * IPOPHL Complete Registration — visible loading + upload to XAMPP gi_updates (GI Updates).
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

  function statusEl() {
    return document.getElementById('ipophl-complete-status');
  }

  function setStatus(html, kind) {
    const el = statusEl();
    if (!el) return;
    el.hidden = false;
    el.className = 'ipophl-complete-status' + (kind ? ' is-' + kind : '');
    el.innerHTML = html;
  }

  function clearStatus() {
    const el = statusEl();
    if (!el) return;
    el.hidden = true;
    el.className = 'ipophl-complete-status';
    el.innerHTML = '';
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
        (label || 'Sending to XAMPP / GI Updates…') +
        '</span>';
    } else {
      btn.disabled = false;
      btn.classList.remove('is-loading');
      btn.removeAttribute('aria-busy');
      btn.textContent = btn.dataset.defaultLabel;
    }
  }

  function busyStatus(title, steps) {
    const stepHtml = (steps || [])
      .map(
        (s) =>
          '<div class="status-step"><i class="fa-solid ' +
          (s.done ? 'fa-check' : s.active ? 'fa-spinner fa-spin' : 'fa-circle') +
          '"></i><span>' +
          s.text +
          '</span></div>'
      )
      .join('');
    setStatus('<strong>' + title + '</strong>' + stepHtml, 'busy');
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

  function collectFileEntries() {
    const byUuid = new Map();

    const add = (fileUuid, taskId) => {
      const id = String(fileUuid || '').trim();
      if (!id || id.startsWith('pending-')) return;
      const tid = String(taskId || '').trim();
      const prev = byUuid.get(id);
      byUuid.set(id, {
        file_uuid: id,
        task_id: tid || prev?.task_id || 'ipophl-other',
      });
    };

    if (window.dashboardApp?.collectIpophlPublishEntries) {
      window.dashboardApp.collectIpophlPublishEntries().forEach((e) => add(e.file_uuid, e.task_id));
    } else if (window.dashboardApp?.ipophlFiles) {
      Object.keys(window.dashboardApp.ipophlFiles).forEach((taskId) => {
        (window.dashboardApp.ipophlFiles[taskId] || []).forEach((f) =>
          add(f.id || f.file_uuid, taskId)
        );
      });
    }

    document.querySelectorAll('#ipophl-module .file-upload-zone[data-service]').forEach((zone) => {
      const zoneTaskId = zone.dataset.service;
      if (!zoneTaskId) return;
      const container = document.getElementById(zoneTaskId + '-files');
      if (!container) return;
      container.querySelectorAll('.file-item').forEach((el) => {
        const id = (el.dataset && el.dataset.fileUuid) || el.getAttribute('data-file-uuid');
        if (!id) return;
        add(
          id,
          (el.dataset && el.dataset.taskId) || el.getAttribute('data-task-id') || zoneTaskId
        );
      });
    });

    return Array.from(byUuid.values());
  }

  async function fetchServerFileEntries() {
    try {
      const res = await fetch(API('/api/ipo-documents?limit=300'), { credentials: 'same-origin' });
      const data = await parseJson(res).catch(() => ({}));
      const out = [];
      const seen = new Set();
      (data.items || []).forEach((doc) => {
        const id = String(doc.file_uuid || '').trim();
        const taskId = String(doc.task_id || '').trim();
        if (id && !seen.has(id)) {
          seen.add(id);
          out.push({ file_uuid: id, task_id: taskId || 'ipophl-other' });
        }
      });
      return out;
    } catch (e) {
      console.warn('Could not load saved IPOPHL documents:', e);
      return [];
    }
  }

  async function fetchServerUuids() {
    const entries = await fetchServerFileEntries();
    return entries.map((e) => e.file_uuid).filter(Boolean);
  }

  async function publishIpophlToGiUpdates() {
    setLoading(true, 'Starting…');
    busyStatus('Sending to GI Updates', [
      { text: 'Collecting files from Phase 5…', active: true },
      { text: 'Upload to admin server', active: false },
      { text: 'Save to XAMPP MySQL (gi_updates)', active: false },
      { text: 'Sync for mobile app', active: false },
    ]);

    const pending =
      window.ipophlAnalyzer && typeof window.ipophlAnalyzer.collectPendingUploads === 'function'
        ? window.ipophlAnalyzer.collectPendingUploads()
        : [];
    let fileEntries = collectFileEntries();
    let existingUuids = fileEntries.map((e) => e.file_uuid).filter(Boolean);

    if (!pending.length && !existingUuids.length) {
      setLoading(true, 'Checking saved documents…');
      fileEntries = await fetchServerFileEntries();
      existingUuids = fileEntries.map((e) => e.file_uuid).filter(Boolean);
    }

    const fileCount = pending.length + existingUuids.length;

    if (!fileCount) {
      setLoading(false);
      busyStatus('Walang file na ipapadala', [
        {
          text: 'Pumili muna ng file sa Phase 5 (berdeng dashed card), tapos click ulit ang Complete Registration.',
          active: false,
        },
      ]);
      setStatus(
        '<strong>Walang file</strong><p>Pumili ng file sa Phase 5, hintayin ang berdeng card na “Ready”, tapos click Complete Registration.</p>',
        'err'
      );
      notify('Pumili muna ng file sa Phase 5, tapos Complete Registration.');
      return;
    }

    setLoading(
      true,
      pending.length
        ? `Uploading ${pending.length} file(s)…`
        : `Saving ${existingUuids.length} file(s) to XAMPP…`
    );
    busyStatus('Sending to GI Updates', [
      { text: `Publishing ${fileCount} file(s) from IPOPHL zones…`, done: true },
      { text: 'Sync files to app server (one batch)', active: true },
      { text: 'Save to gi_updates', active: false },
      { text: 'Ready on mobile', active: false },
    ]);

    const form = new FormData();
    pending.forEach(({ file, task_id }) => {
      form.append('files', file);
      form.append('task_ids', task_id);
    });
    if (existingUuids.length) {
      form.append('file_uuids_json', JSON.stringify(existingUuids));
    }
    if (fileEntries.length) {
      form.append('file_entries_json', JSON.stringify(fileEntries));
    }
    form.append('publish_all_categories', 'false');
    form.append('force_publish', 'true');

    setLoading(true, 'Checking MySQL + app server…');
    try {
      const pre = await fetch(API('/api/ipophl/publish-preflight'), {
        credentials: 'same-origin',
      });
      const preData = await parseJson(pre).catch(() => ({}));
      if (preData.ok === false) {
        const parts = [];
        if (preData.mysql_reachable === false && preData.mysql_error) {
          parts.push('MySQL: ' + preData.mysql_error);
        }
        if (preData.xampp_reachable === false) {
          parts.push(
            preData.error ||
              'App server (port 8080) hindi maabot. I-start ang python app.py sa XAMPP PC.'
          );
        }
        throw new Error(parts.join(' ') || preData.error || 'Connection check failed.');
      }
      busyStatus('Sending to GI Updates', [
        { text: `Found ${pending.length} new + ${existingUuids.length} saved file(s)`, done: true },
        {
          text:
            'MySQL ' +
            (preData.mysql_reachable ? 'OK' : '—') +
            ' · App :8080 ' +
            (preData.xampp_reachable ? 'OK' : '—'),
          done: true,
        },
        { text: 'Uploading and saving…', active: true },
        { text: 'Sync for mobile app', active: false },
      ]);
    } catch (preErr) {
      setLoading(false);
      setStatus('<strong>Connection failed</strong><p>' + (preErr.message || preErr) + '</p>', 'err');
      notify(preErr.message || String(preErr));
      return;
    }

    setLoading(true, 'Saving to XAMPP MySQL…');
    busyStatus('Sending to GI Updates', [
      { text: `Found ${pending.length} new + ${existingUuids.length} saved file(s)`, done: true },
      { text: 'Upload to admin server', done: true },
      { text: 'Writing to gi_updates (XAMPP)…', active: true },
      { text: 'Sync for mobile app', active: false },
    ]);

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
        throw new Error(
          data.error || data.message || data.detail || 'Save failed (HTTP ' + res.status + ')'
        );
      }

      setLoading(true, 'Done — opening GI inbox…');
      busyStatus('Success', [
        { text: 'Upload to admin server', done: true },
        { text: 'XAMPP MySQL saved', done: true },
        { text: 'Ready on mobile — refresh GI Updates', done: true },
      ]);

      const cards = data.cards_published != null ? data.cards_published : '?';
      const dbRows = data.db_rows != null ? data.db_rows : '?';
      const withFiles = data.categories_with_files != null ? data.categories_with_files : '?';

      setStatus(
        '<strong>Na-save sa database</strong>' +
          '<p>' +
          (data.message || 'Published to GI Updates.') +
          '</p>' +
          '<p><small>Cards: <strong>' +
          cards +
          '</strong> · Files with attachment: <strong>' +
          withFiles +
          '</strong> · Admin rows in DB: <strong>' +
          dbRows +
          '</strong></small></p>' +
          '<p><small>Sa phone: GI Updates → refresh. Farmer messages (green envelope) → Farmer\'s Contribution sa admin.</small></p>',
        'ok'
      );

      if (window.ipophlAnalyzer?.clearPendingAfterPublish) {
        window.ipophlAnalyzer.clearPendingAfterPublish();
      }
      if (window.ipophlAnalyzer?.loadExistingDocuments) {
        await window.ipophlAnalyzer.loadExistingDocuments();
      }

      notify(
        data.message ||
          'Saved to XAMPP! GI Updates: ' + cards + ' card(s). I-refresh ang app.'
      );

      /* IPOPHL → mobile GI Updates only; farmer compose messages → Farmer's Contribution inbox */
    } catch (err) {
      console.error('GI publish failed:', err);
      let msg = err.message || 'Could not save to GI Updates.';
      if (msg === 'Failed to fetch') {
        msg =
          'Hindi maabot ang web.py. I-restart ang python web.py sa PC na ito, tapos Ctrl+Shift+R.';
      }
      setStatus('<strong>Hindi na-save</strong><p>' + msg + '</p>', 'err');
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
      e.stopPropagation();
      if (btn.disabled || btn.classList.contains('is-loading')) return;
      publishIpophlToGiUpdates();
    },
    true
  );

  function patchDashboardApp() {
    if (!window.dashboardApp) return;
    window.dashboardApp.completeRegistration = publishIpophlToGiUpdates;
    window.dashboardApp.sendRegistrationEmail = publishIpophlToGiUpdates;
    window.dashboardApp.setCompleteRegistrationLoading = setLoading;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', patchDashboardApp);
  } else {
    patchDashboardApp();
  }
  window.addEventListener('load', patchDashboardApp);
  window.publishIpophlToGiUpdates = publishIpophlToGiUpdates;
})();
