/**
 * IPOPHL Complete Registration — publish to GI Updates, then open Gmail to IPOPHL.
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

  function completeBtn() {
    return document.querySelector('#ipophl-module .complete-btn');
  }

  function setButtonCompleted() {
    const btn = completeBtn();
    if (!btn) return;
    if (!btn.dataset.defaultLabel) {
      btn.dataset.defaultLabel = (btn.textContent || 'Complete Registration').trim();
    }
    btn.disabled = true;
    btn.classList.add('is-completed');
    btn.classList.remove('is-loading');
    btn.removeAttribute('aria-busy');
    btn.textContent = btn.dataset.defaultLabel;
  }

  function setButtonEnabled() {
    const btn = completeBtn();
    if (!btn) return;
    if (!btn.dataset.defaultLabel) {
      btn.dataset.defaultLabel = (btn.textContent || 'Complete Registration').trim();
    }
    btn.disabled = false;
    btn.classList.remove('is-completed', 'is-loading');
    btn.removeAttribute('aria-busy');
    btn.textContent = btn.dataset.defaultLabel;
  }

  function openPendingGmailTab() {
    const tab = window.open('about:blank', '_blank');
    if (!tab) return null;
    try {
      tab.document.title = 'Gmail — IPOPHL';
      tab.document.body.innerHTML =
        '<div style="font-family:system-ui,sans-serif;padding:2rem;color:#374151">' +
        '<p style="font-size:1.1rem;margin:0 0 .5rem">Preparing Gmail for IPOPHL…</p>' +
        '<p style="margin:0;color:#6b7280">Keep this tab open while registration finishes.</p>' +
        '</div>';
    } catch (_) {
      /* cross-origin guard */
    }
    return tab;
  }

  function closeGmailTab(tab) {
    if (!tab || tab.closed) return;
    try {
      tab.close();
    } catch (_) {
      /* ignore */
    }
  }

  function navigateGmailTab(tab, url) {
    if (!url) return false;
    if (tab && !tab.closed) {
      try {
        tab.location.href = url;
        tab.focus();
        return true;
      } catch (_) {
        /* fall through */
      }
    }
    const opened = window.open(url, '_blank');
    return !!(opened && !opened.closed);
  }

  async function downloadRegistrationZip() {
    const res = await fetch(API('/api/ipophl/registration-zip'), { credentials: 'same-origin' });
    if (!res.ok) {
      const err = await parseJson(res).catch(() => ({}));
      throw new Error(err.error || `Could not download registration zip (HTTP ${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'beanthentic-ipophl-registration.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function resolveGmailInfo(gmailInfo) {
    if (gmailInfo && gmailInfo.gmail_url) return gmailInfo;
    const res = await fetch(API('/api/ipophl/gmail-compose'), { credentials: 'same-origin' });
    const data = await parseJson(res).catch(() => ({}));
    if (!res.ok || !data.gmail_url) {
      throw new Error(data.error || 'Could not prepare Gmail compose link.');
    }
    return data;
  }

  function notifyGmailFallback(url, to) {
    const recipient = to || 'info@ipophl.gov.ph';
    const el = document.createElement('div');
    el.className = 'ipophl-notification ipophl-notification--gmail-fallback';
    el.style.cssText =
      'position:fixed;top:20px;right:20px;background:#92400e;color:#fff;padding:14px 18px;border-radius:8px;z-index:99999;max-width:400px;line-height:1.45;';
    const text = document.createElement('p');
    text.style.margin = '0 0 8px';
    text.textContent = 'Popup blocked. Open Gmail manually for ' + recipient + ':';
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open Gmail compose';
    link.style.cssText = 'color:#fff;text-decoration:underline';
    el.appendChild(text);
    el.appendChild(link);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 30000);
  }

  async function openGmailToIpophl(gmailInfo, gmailTab) {
    const info = await resolveGmailInfo(gmailInfo);
    const opened = navigateGmailTab(gmailTab, info.gmail_url);
    if (!opened) {
      notifyGmailFallback(info.gmail_url, info.to);
    } else {
      notify(
        'Gmail opened for IPOPHL (' +
          (info.to || 'info@ipophl.gov.ph') +
          '). Attach the downloaded zip, then send.'
      );
    }
    try {
      await downloadRegistrationZip();
    } catch (zipErr) {
      console.warn('Registration zip download failed:', zipErr);
      notify(
        (zipErr.message || 'Zip download failed') +
          ' — attach files manually from the IPOPHL module if needed.'
      );
    }
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
      'position:fixed;top:20px;right:20px;background:#047857;color:#fff;padding:14px 18px;border-radius:8px;z-index:99999;max-width:400px;line-height:1.45;';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 12000);
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

  async function publishIpophlToGiUpdates(gmailTab) {
    setButtonCompleted();

    const pending =
      window.ipophlAnalyzer && typeof window.ipophlAnalyzer.collectPendingUploads === 'function'
        ? window.ipophlAnalyzer.collectPendingUploads()
        : [];
    let fileEntries = collectFileEntries();
    let existingUuids = fileEntries.map((e) => e.file_uuid).filter(Boolean);

    if (!pending.length && !existingUuids.length) {
      fileEntries = await fetchServerFileEntries();
      existingUuids = fileEntries.map((e) => e.file_uuid).filter(Boolean);
    }

    const fileCount = pending.length + existingUuids.length;

    if (!fileCount) {
      closeGmailTab(gmailTab);
      setButtonEnabled();
      notify('Pumili muna ng file sa Phase 5, tapos Complete Registration.');
      return;
    }

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

    try {
      const pre = await fetch(API('/api/ipophl/publish-preflight'), {
        credentials: 'same-origin',
      });
      const preData = await parseJson(pre).catch(() => ({}));
      if (preData.ok === false) {
        const parts = [];
        if (preData.mysql_reachable === false && preData.mysql_error) {
          parts.push('Database: ' + preData.mysql_error);
        }
        if (preData.xampp_reachable === false && preData.source !== 'supabase') {
          parts.push(
            preData.error ||
              'App server (port 8080) hindi maabot. I-start ang python app.py sa XAMPP PC.'
          );
        }
        throw new Error(parts.join(' ') || preData.error || 'Connection check failed.');
      }
    } catch (preErr) {
      closeGmailTab(gmailTab);
      setButtonEnabled();
      notify(preErr.message || String(preErr));
      return;
    }

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
        const detail = data.detail || data.error || data.message;
        throw new Error(detail || 'Save failed (HTTP ' + res.status + ')');
      }

      if (window.ipophlAnalyzer?.clearPendingAfterPublish) {
        window.ipophlAnalyzer.clearPendingAfterPublish();
      }
      if (window.ipophlAnalyzer?.loadExistingDocuments) {
        await window.ipophlAnalyzer.loadExistingDocuments();
      }

      const cards = data.cards_published != null ? data.cards_published : '?';
      notify(
        data.message ||
          'Published to GI Updates: ' + cards + ' card(s). Farmers can refresh the app.'
      );

      try {
        await openGmailToIpophl(data.gmail, gmailTab);
      } catch (gmailErr) {
        console.warn('Gmail redirect failed:', gmailErr);
        closeGmailTab(gmailTab);
        notify(gmailErr.message || 'GI Updates saved, but Gmail could not be opened.');
      }
    } catch (err) {
      console.error('GI publish failed:', err);
      let msg = err.message || 'Could not save to GI Updates.';
      if (msg === 'Failed to fetch') {
        msg =
          'Hindi maabot ang web.py. I-restart ang python web.py sa PC na ito, tapos Ctrl+Shift+R.';
      }
      closeGmailTab(gmailTab);
      setButtonEnabled();
      notify(msg);
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
      if (btn.disabled || btn.classList.contains('is-completed')) return;
      const gmailTab = openPendingGmailTab();
      publishIpophlToGiUpdates(gmailTab);
    },
    true
  );

  function patchDashboardApp() {
    if (!window.dashboardApp) return;
    window.dashboardApp.completeRegistration = publishIpophlToGiUpdates;
    window.dashboardApp.sendRegistrationEmail = publishIpophlToGiUpdates;
    window.dashboardApp.setCompleteRegistrationLoading = function (isLoading) {
      if (isLoading) setButtonCompleted();
      else setButtonEnabled();
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
