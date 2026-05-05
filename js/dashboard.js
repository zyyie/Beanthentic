// Dashboard functionality for coffee database
const NOTIFICATIONS_READ_STORAGE_KEY = 'beanthentic_dashboard_notification_read';

class DashboardApp {
  constructor() {
    this.data = [];
    this.filteredData = [];
    // Database is now the source of truth; keep a very high cap
    // so admin-added rows are visible in the dashboard.
    this.maxFarmers = Number.MAX_SAFE_INTEGER;
    this.currentPage = 1;
    this.pageSize = 10;
    this.totalRecords = 0;
    this.farmerTableView = 'basic';
    this.mapVarietyFilter = 'liberica';
    this.mapSearchTerm = '';
    this.googleMap = null;
    this.googleMapMarkers = [];
    this.googleMapsReady = false;
    this.googleInfoWindow = null;
    this.activeSettingsTab = 'security';
    /** 'landing' = card hub; 'detail' = loaded fragment */
    this.settingsViewMode = 'landing';
    /** @type {{ id: string; icon: string; title: string; meta: string; detail: string; read: boolean }[]} */
    this.notificationsFeed = this.hydrateNotificationsFeed();
    /** @type {number | null} */
    this.pendingDeleteRowIndex = null;
    /** @type {Record<string, unknown>[]} */
    this.transactionsRows = [];
    /** @type {string} */
    this.transactionsSearchTerm = '';
    /** @type {number | null} */
    this.transactionsFarmerFilterId = null;
    this.init();
  }

  getDefaultNotifications() {
    return [
      {
        id: 'feed-sync-1',
        icon: 'fa-user-plus',
        title: 'New farmer record synced',
        meta: 'Today · 9:41 AM',
        detail:
          'A new farmer record was merged into your dashboard from the latest data sync. You can open Farmer Records to check the new row, verify names and barangay, and fix any typos. If counts look wrong, use the header Refresh button to reload from your saved or imported file.',
      },
      {
        id: 'feed-export-1',
        icon: 'fa-file-export',
        title: 'Export completed — Farmer data (Excel)',
        meta: 'Yesterday · 4:12 PM',
        detail:
          'Your export to Excel finished successfully. The file includes the farmer table as shown in the Export module (columns depend on the view you used). Download again anytime from Export Data if you need another copy. Large exports may take a few seconds—wait for the success message before closing the tab.',
      },
      {
        id: 'feed-reminder-1',
        icon: 'fa-triangle-exclamation',
        title: 'Reminder: Review pending remarks',
        meta: 'Mar 26 · 11:00 AM',
        detail:
          'Some rows still have empty or generic remarks in the REMARKS column. Review Farmer Records (Basic Info tab), filter or search if needed, and add clear notes for follow-up—for example planting status, visits, or data issues. Saving the table stores updates in your browser for next session.',
      },
    ];
  }

  applyReadStateToItems(items) {
    /** @type {Record<string, boolean>} */
    let readById = {};
    try {
      const raw = localStorage.getItem(NOTIFICATIONS_READ_STORAGE_KEY);
      if (raw) readById = JSON.parse(raw) || {};
    } catch {
      readById = {};
    }
    return items.map((n) => ({
      ...n,
      detail: n.detail != null ? n.detail : '',
      read: !!readById[n.id],
    }));
  }

  formatNotificationMeta(timestamp) {
    if (!timestamp) return '';
    try {
      const d = new Date(timestamp);
      if (Number.isNaN(d.getTime())) return String(timestamp);
      return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return String(timestamp);
    }
  }

  mapAdminNotificationToFeedItem(row, index) {
    return {
      id: row.id || `admin-feed-${index}`,
      icon: row.icon || 'fa-bell',
      title: row.title || 'Notification',
      meta: this.formatNotificationMeta(row.meta || row.timestamp),
      detail: row.detail || '',
      category: row.category || '',
      categoryLabel: row.category_label || '',
      read: !!row.read,
    };
  }

  hydrateNotificationsFeed() {
    return this.applyReadStateToItems(this.getDefaultNotifications());
  }

  iconForActivityAction(action) {
    const a = (action || '').toUpperCase();
    const map = {
      LOGIN: 'fa-right-to-bracket',
      LOGOUT: 'fa-right-from-bracket',
      LOGIN_FAILED: 'fa-circle-xmark',
      PASSWORD_CHANGED: 'fa-key',
      PASSWORD_CHANGE_FAILED: 'fa-triangle-exclamation',
      '2FA_ENABLED': 'fa-shield-halved',
      '2FA_DISABLED': 'fa-shield-halved',
      NOTIFICATIONS_UPDATED: 'fa-bell',
      PROFILE_UPDATED: 'fa-user-pen',
      COFFEE_BEAN_TX: 'fa-handshake',
    };
    return map[a] || 'fa-clock-rotate-left';
  }

  titleForActivity(action) {
    const a = (action || '').toUpperCase();
    const map = {
      LOGIN: 'Signed in',
      LOGOUT: 'Signed out',
      LOGIN_FAILED: 'Failed sign-in attempt',
      PASSWORD_CHANGED: 'Password changed',
      PASSWORD_CHANGE_FAILED: 'Password change failed',
      '2FA_ENABLED': 'Two-factor authentication enabled',
      '2FA_DISABLED': 'Two-factor authentication disabled',
      NOTIFICATIONS_UPDATED: 'Notification settings updated',
      PROFILE_UPDATED: 'Profile updated',
      COFFEE_BEAN_TX: 'Coffee bean transaction recorded',
    };
    if (map[a]) return map[a];
    return (action || 'Activity').replace(/_/g, ' ');
  }

  formatActivityMeta(timestamp) {
    if (!timestamp) return '';
    try {
      const d = new Date(timestamp);
      if (Number.isNaN(d.getTime())) return String(timestamp);
      return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return String(timestamp);
    }
  }

  mapActivityLogToFeedItem(row, index) {
    const id = `activity-${index}-${row.timestamp}`;
    const action = row.action || '';
    const icon = this.iconForActivityAction(action);
    const title = this.titleForActivity(action);
    const meta = this.formatActivityMeta(row.timestamp);
    const parts = [row.details, row.ip_address ? `IP: ${row.ip_address}` : ''].filter(Boolean);
    const detail = parts.join(' · ');
    return { id, icon, title, meta, detail, read: false };
  }

  async refreshNotificationsModule() {
    const btn = document.getElementById('notificationsPageRefreshBtn');
    const markAllBtn = document.getElementById('notificationsMarkAllReadBtn');
    if (btn) {
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
    }
    if (markAllBtn) markAllBtn.disabled = true;
    try {
      const res = await fetch('/api/admin-notifications');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rows = Array.isArray(data.items) ? data.items : [];
      const adminItems = rows.map((row, i) => this.mapAdminNotificationToFeedItem(row, i));
      const defaults = this.getDefaultNotifications();
      this.notificationsFeed = this.applyReadStateToItems([...adminItems, ...defaults]);
      this.renderNotificationsList();
      this.showNotification('Notifications refreshed.', 'success');
    } catch (e) {
      console.warn('Notifications refresh failed:', e);
      this.notificationsFeed = this.hydrateNotificationsFeed();
      this.renderNotificationsList();
      this.showNotification('Could not load latest activity. Showing saved list.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
      }
      if (markAllBtn) markAllBtn.disabled = false;
    }
  }

  persistNotificationReadState() {
    const readById = {};
    this.notificationsFeed.forEach((n) => {
      readById[n.id] = !!n.read;
    });
    try {
      localStorage.setItem(NOTIFICATIONS_READ_STORAGE_KEY, JSON.stringify(readById));
    } catch (e) {
      console.warn('Could not save notification read state', e);
    }
  }

  markNotificationRead(id) {
    const n = this.notificationsFeed.find((x) => x.id === id);
    if (!n || n.read) return;
    n.read = true;
    this.persistNotificationReadState();
    this.renderNotificationsList();
  }

  markAllNotificationsRead() {
    let changed = false;
    this.notificationsFeed.forEach((n) => {
      if (!n.read) {
        n.read = true;
        changed = true;
      }
    });
    if (!changed) return;
    this.persistNotificationReadState();
    this.renderNotificationsList();
  }

  /**
   * Header Refresh: reload farmer records (saved → seed), reset search & pager,
   * sync overview charts/stats and notification list.
   */
  async refreshDashboard() {
    const btn = document.getElementById('refreshBtn');
    if (btn) {
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
    }
    try {
      const search = document.getElementById('farmerSearch');
      if (search) search.value = '';

      this.currentPage = 1;
      await this.loadExcelData();
      this.filterData('');

      this.notificationsFeed = this.hydrateNotificationsFeed();
      this.renderNotificationsList();

      this.showNotification('Dashboard refreshed.', 'success');
    } catch (e) {
      console.error('Refresh failed:', e);
      this.showNotification('Refresh failed. Please try again.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
      }
    }
  }

  openNotificationDetail(id) {
    const n = this.notificationsFeed.find((x) => x.id === id);
    if (!n) return;

    if (!n.read) {
      n.read = true;
      this.persistNotificationReadState();
      this.renderNotificationsList();
    }

    const root = document.getElementById('notificationDetailModal');
    const titleEl = document.getElementById('notificationDetailTitle');
    const metaEl = document.getElementById('notificationDetailMeta');
    const bodyEl = document.getElementById('notificationDetailBody');
    const iconEl = document.getElementById('notificationDetailIcon');
    if (!root || !titleEl || !metaEl || !bodyEl || !iconEl) return;

    titleEl.textContent = n.title;
    metaEl.textContent = n.meta;
    bodyEl.textContent = n.detail || 'No additional details for this notification.';

    iconEl.className = `fa-solid ${n.icon || 'fa-bell'}`;

    root.removeAttribute('hidden');
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('confirm-dialog-active');

    const closeBtn = document.getElementById('notificationDetailClose');
    if (closeBtn) closeBtn.focus();
  }

  closeNotificationDetail() {
    const root = document.getElementById('notificationDetailModal');
    if (root) {
      root.setAttribute('hidden', '');
      root.setAttribute('aria-hidden', 'true');
    }
    const del = document.getElementById('deleteFarmerConfirmModal');
    const logoutEl = document.getElementById('logoutConfirmModal');
    const d2 = document.getElementById('disable2faConfirmModal');
    if (del?.hasAttribute('hidden') && logoutEl?.hasAttribute('hidden') && d2?.hasAttribute('hidden')) {
      document.body.classList.remove('confirm-dialog-active');
    }
  }

  initNotificationDetailModal() {
    const root = document.getElementById('notificationDetailModal');
    const closeBtn = document.getElementById('notificationDetailClose');
    if (!root || !closeBtn) return;

    const backdrop = root.querySelector('.notification-detail-dialog__backdrop');
    closeBtn.addEventListener('click', () => this.closeNotificationDetail());
    if (backdrop) backdrop.addEventListener('click', () => this.closeNotificationDetail());

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const logoutEl = document.getElementById('logoutConfirmModal');
      if (logoutEl && !logoutEl.hasAttribute('hidden')) return;
      if (root.hasAttribute('hidden')) return;
      e.preventDefault();
      this.closeNotificationDetail();
    });
  }

  openLogoutConfirmModal() {
    const root = document.getElementById('logoutConfirmModal');
    if (!root) return;
    root.removeAttribute('hidden');
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('confirm-dialog-active');
    document.getElementById('logoutConfirmCancel')?.focus();
  }

  closeLogoutConfirmModal() {
    const root = document.getElementById('logoutConfirmModal');
    if (root) {
      root.setAttribute('hidden', '');
      root.setAttribute('aria-hidden', 'true');
    }
    const del = document.getElementById('deleteFarmerConfirmModal');
    const nd = document.getElementById('notificationDetailModal');
    const d2 = document.getElementById('disable2faConfirmModal');
    if (del?.hasAttribute('hidden') && nd?.hasAttribute('hidden') && d2?.hasAttribute('hidden')) {
      document.body.classList.remove('confirm-dialog-active');
    }
  }

  initLogoutConfirmModal() {
    const root = document.getElementById('logoutConfirmModal');
    const cancelBtn = document.getElementById('logoutConfirmCancel');
    const okBtn = document.getElementById('logoutConfirmOk');
    if (!root || !cancelBtn || !okBtn) return;

    const backdrop = root.querySelector('.confirm-dialog__backdrop');
    cancelBtn.addEventListener('click', () => this.closeLogoutConfirmModal());
    okBtn.addEventListener('click', () => {
      window.location.href = '/logout';
    });
    if (backdrop) backdrop.addEventListener('click', () => this.closeLogoutConfirmModal());

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (root.hasAttribute('hidden')) return;
      e.preventDefault();
      this.closeLogoutConfirmModal();
    });
  }

  getFarmerDisplayNameForDelete(row) {
    if (!row || typeof row !== 'object') return 'this record';
    const full = (this.getValue(row, ['NAME OF FARMER', 'Name of Farmer', 'name']) || '').toString().trim();
    if (full) return full;
    const last = (this.getValue(row, ['LAST NAME', 'Last Name', 'lastName']) || '').toString().trim();
    const first = (this.getValue(row, ['FIRST NAME', 'First Name', 'firstName']) || '').toString().trim();
    const middle = (this.getValue(row, ['MIDDLE NAME', 'Middle Name', 'middleName']) || '').toString().trim();
    const parts = [first, middle, last].filter(Boolean);
    if (parts.length) return parts.join(' ');
    return 'this record';
  }

  syncDeleteConfirmRemoveButton() {
    const ack = document.getElementById('deleteConfirmAcknowledge');
    const okBtn = document.getElementById('deleteConfirmOk');
    if (!okBtn) return;
    okBtn.disabled = !(ack && ack.checked);
  }

  openDeleteFarmerConfirm(rowIndex) {
    const row = this.data[rowIndex];
    const displayName = row ? this.getFarmerDisplayNameForDelete(row) : 'this record';

    const msgEl = document.getElementById('deleteConfirmMessage');
    if (msgEl) {
      msgEl.textContent = `You are about to remove ${displayName} from your farmer records, which will delete their row from the table on this screen, so please double-check that this is the correct farmer before confirming.`;
    }

    const ackText = document.getElementById('deleteConfirmAckText');
    if (ackText) {
      ackText.textContent = `I confirm permanent removal of ${displayName}. This cannot be undone.`;
    }

    const ack = document.getElementById('deleteConfirmAcknowledge');
    if (ack) ack.checked = false;
    this.syncDeleteConfirmRemoveButton();

    this.pendingDeleteRowIndex = rowIndex;
    const root = document.getElementById('deleteFarmerConfirmModal');
    if (!root) return;
    root.removeAttribute('hidden');
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('confirm-dialog-active');
    const cancelBtn = document.getElementById('deleteConfirmCancel');
    if (cancelBtn) cancelBtn.focus();
  }

  closeDeleteFarmerConfirm() {
    const root = document.getElementById('deleteFarmerConfirmModal');
    if (root) {
      root.setAttribute('hidden', '');
      root.setAttribute('aria-hidden', 'true');
    }
    const ack = document.getElementById('deleteConfirmAcknowledge');
    if (ack) ack.checked = false;
    this.syncDeleteConfirmRemoveButton();
    this.pendingDeleteRowIndex = null;
    const logoutEl = document.getElementById('logoutConfirmModal');
    const nd = document.getElementById('notificationDetailModal');
    const d2 = document.getElementById('disable2faConfirmModal');
    if (logoutEl?.hasAttribute('hidden') && nd?.hasAttribute('hidden') && d2?.hasAttribute('hidden')) {
      document.body.classList.remove('confirm-dialog-active');
    }
  }

  confirmPendingDeleteFarmer() {
    const ack = document.getElementById('deleteConfirmAcknowledge');
    if (!ack || !ack.checked) return;

    const idx = this.pendingDeleteRowIndex;
    this.closeDeleteFarmerConfirm();
    if (idx === null || !Number.isFinite(idx) || idx < 0) return;
    if (!this.data[idx]) {
      this.showNotification('Could not find that row to delete.', 'error');
      return;
    }
    this.deleteFarmer(idx);
  }

  initDeleteFarmerConfirmModal() {
    const root = document.getElementById('deleteFarmerConfirmModal');
    const cancelBtn = document.getElementById('deleteConfirmCancel');
    const okBtn = document.getElementById('deleteConfirmOk');
    const ack = document.getElementById('deleteConfirmAcknowledge');
    if (!root || !cancelBtn || !okBtn) return;

    if (ack) {
      ack.addEventListener('change', () => this.syncDeleteConfirmRemoveButton());
    }

    const backdrop = root.querySelector('.confirm-dialog__backdrop');
    cancelBtn.addEventListener('click', () => this.closeDeleteFarmerConfirm());
    okBtn.addEventListener('click', () => this.confirmPendingDeleteFarmer());
    if (backdrop) backdrop.addEventListener('click', () => this.closeDeleteFarmerConfirm());

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const logoutEl = document.getElementById('logoutConfirmModal');
      if (logoutEl && !logoutEl.hasAttribute('hidden')) return;
      const nd = document.getElementById('notificationDetailModal');
      if (nd && !nd.hasAttribute('hidden')) return;
      const d2 = document.getElementById('disable2faConfirmModal');
      if (d2 && !d2.hasAttribute('hidden')) return;
      if (root.hasAttribute('hidden')) return;
      e.preventDefault();
      this.closeDeleteFarmerConfirm();
    });
  }

  init() {
    console.log('Dashboard initialized');
    this.setupEventListeners();
    this.charts = {};
    // Default module is Overview, so ensure normal scrolling.
    const moduleContent = document.querySelector('.module-content');
    if (moduleContent) {
      moduleContent.classList.remove('lock-scroll');
    }
    // Auto-load farmer data when dashboard starts
    setTimeout(() => {
      this.loadExcelData();
    }, 500);
    this.renderNotificationsList();
    // Initialize new dashboard features
    this.initNewDashboardFeatures();
    // Initialize account module
    this.initAccountModule();
  }

  updateNotificationsToolbarState() {
    const markAllBtn = document.getElementById('notificationsMarkAllReadBtn');
    if (!markAllBtn) return;
    const anyUnread = (this.notificationsFeed || []).some((n) => !n.read);
    markAllBtn.disabled = !anyUnread;
  }

  updateHeaderNotificationBadge() {
    const badge = document.getElementById('headerNotificationBadge');
    if (!badge) return;
    const unread = (this.notificationsFeed || []).filter((n) => !n.read).length;
    if (unread <= 0) {
      badge.classList.remove('is-visible');
      badge.textContent = '0';
      return;
    }
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.classList.add('is-visible');
  }

  renderNotificationsList() {
    const list = document.getElementById('notificationsList');
    if (!list) {
      this.updateHeaderNotificationBadge();
      return;
    }

    const esc = (s) =>
      String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const rows = this.notificationsFeed || [];
    if (!rows.length) {
      list.innerHTML = '<li class="notifications-empty">No notifications yet.</li>';
      this.updateNotificationsToolbarState();
      this.updateHeaderNotificationBadge();
      return;
    }

    list.innerHTML = rows
      .map((n) => {
        const readClass = n.read ? ' notification-item--read' : '';
        const categoryMarkup = n.categoryLabel
          ? `<span class="notification-item-category">${esc(n.categoryLabel)}</span>`
          : '';
        const actionMarkup = n.read
          ? '<span class="notification-read-badge" aria-hidden="true">Read</span>'
          : `<button type="button" class="btn btn-secondary notification-mark-read-btn" data-action="mark-notification-read" data-notification-id="${esc(
              n.id
            )}">Mark read</button>`;
        return `<li class="notification-item${readClass}" data-notification-id="${esc(n.id)}" tabindex="0" aria-label="Open details: ${esc(n.title)}">
      <div class="notification-item-icon" aria-hidden="true"><i class="fa-solid ${esc(n.icon)}"></i></div>
      <div class="notification-item-body">
        <p class="notification-item-title">${esc(n.title)}</p>
        ${categoryMarkup}
        <p class="notification-item-meta">${esc(n.meta)}</p>
      </div>
      <div class="notification-item-actions">${actionMarkup}</div>
    </li>`;
      })
      .join('');

    this.updateNotificationsToolbarState();
    this.updateHeaderNotificationBadge();
  }

  escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  applyTransactionsSearchAndRender() {
    const term = (this.transactionsSearchTerm || '').trim().toLowerCase();
    const all = this.transactionsRows || [];
    const filtered =
      !term
        ? all
        : all.filter((row) => {
            const hay = [
              row.farmer_name,
              row.farmer_no,
              row.buyer_name,
              row.notes,
              row.variety,
              row.recorded_by_phone,
              row.recorded_at,
              row.delta_kg,
              row.balance_after_kg,
            ]
              .map((x) => String(x || '').toLowerCase())
              .join(' ');
            return hay.includes(term);
          });
    this.renderTransactionsTableBody(filtered);
  }

  varietyLabel(variety) {
    const v = String(variety || '').toLowerCase();
    if (v === 'liberica') return 'Liberica';
    if (v === 'excelsa') return 'Excelsa';
    if (v === 'robusta') return 'Robusta';
    return variety || '—';
  }

  formatCoffeeDeltaKg(delta) {
    const n = Number(delta);
    if (Number.isNaN(n)) return '—';
    const abs = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (n > 0) return `+${abs}`;
    return `−${abs}`;
  }

  deltaCellClass(delta) {
    const n = Number(delta);
    if (Number.isNaN(n) || n === 0) return 'transactions-delta--zero';
    return n < 0 ? 'transactions-delta--out' : 'transactions-delta--in';
  }

  async loadFarmerOptionsForTransactionsModule() {
    const formSelect = document.getElementById('coffeeTxnFarmerSelect');
    const filterSelect = document.getElementById('transactionsFarmerFilter');
    if (!formSelect && !filterSelect) return;

    const setLoading = () => {
      if (formSelect) {
        formSelect.innerHTML = '<option value="">Loading farmers…</option>';
        formSelect.disabled = true;
      }
    };
    setLoading();

    try {
      const res = await fetch('/api/farmer-picker');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      const opts = items
        .map((f) => {
          const id = f.id;
          const no = f.no != null ? f.no : '';
          const name = (f.name || '').trim() || 'Farmer';
          const label = `#${no} — ${name}`;
          return `<option value="${String(id)}">${this.escapeHtml(label)}</option>`;
        })
        .join('');

      if (formSelect) {
        formSelect.innerHTML = `<option value="">Select farmer…</option>${opts}`;
        formSelect.disabled = false;
      }
      if (filterSelect) {
        const cur = this.transactionsFarmerFilterId != null ? String(this.transactionsFarmerFilterId) : '';
        filterSelect.innerHTML = `<option value="">All farmers</option>${opts}`;
        filterSelect.value = cur;
      }
    } catch (e) {
      console.warn('Farmer picker failed:', e);
      if (formSelect) {
        formSelect.innerHTML = '<option value="">Could not load farmers</option>';
        formSelect.disabled = false;
      }
      this.showNotification('Could not load farmer list.', 'error');
    }
  }

  renderTransactionsTableBody(rows) {
    const tbody = document.getElementById('transactionsTableBody');
    const emptyEl = document.getElementById('transactionsEmptyState');
    if (!tbody) return;

    const esc = (x) => this.escapeHtml(x);

    if (!rows.length) {
      tbody.innerHTML = '';
      if (emptyEl) emptyEl.hidden = false;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;

    tbody.innerHTML = rows
      .map((row) => {
        let dtLabel = '—';
        if (row.recorded_at) {
          try {
            const d = new Date(row.recorded_at);
            if (!Number.isNaN(d.getTime())) {
              dtLabel = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
            }
          } catch {
            dtLabel = String(row.recorded_at);
          }
        }
        const farmerCell =
          row.farmer_no != null && row.farmer_no !== ''
            ? `${esc(row.farmer_no)} — ${esc(row.farmer_name || '')}`
            : esc(row.farmer_name || '—');
        const bal = row.balance_after_kg;
        const balTxt =
          typeof bal === 'number' && !Number.isNaN(bal)
            ? bal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : '—';
        const dClass = this.deltaCellClass(row.delta_kg);
        const dText = this.formatCoffeeDeltaKg(row.delta_kg);
        return `<tr>
      <td>${esc(dtLabel)}</td>
      <td>${farmerCell}</td>
      <td><span class="transactions-variety-pill">${esc(this.varietyLabel(row.variety))}</span></td>
      <td><span class="transactions-delta ${dClass}">${esc(dText)}</span></td>
      <td>${esc(balTxt)}</td>
      <td>${esc(row.buyer_name || '—')}</td>
      <td class="transactions-details">${esc(row.notes || '—')}</td>
      <td>${esc(row.recorded_by_phone || '—')}</td>
    </tr>`;
      })
      .join('');
  }

  async loadTransactionsPage() {
    const tbody = document.getElementById('transactionsTableBody');
    const emptyEl = document.getElementById('transactionsEmptyState');
    if (!tbody) return;

    await this.loadFarmerOptionsForTransactionsModule();

    tbody.innerHTML =
      '<tr><td colspan="8" class="transactions-loading-cell">Loading…</td></tr>';
    if (emptyEl) emptyEl.hidden = true;

    try {
      let url = '/api/farmer-coffee-transactions?limit=400';
      if (this.transactionsFarmerFilterId != null && !Number.isNaN(this.transactionsFarmerFilterId)) {
        url += `&farmer_id=${encodeURIComponent(String(this.transactionsFarmerFilterId))}`;
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.transactionsRows = Array.isArray(data.items) ? data.items : [];
      this.applyTransactionsSearchAndRender();
    } catch (e) {
      console.warn('Transactions load failed:', e);
      this.transactionsRows = [];
      tbody.innerHTML =
        '<tr><td colspan="8" class="transactions-error-cell">Could not load transactions. Try Refresh.</td></tr>';
      this.showNotification('Could not load bean transactions.', 'error');
    }
  }

  initTransactionsModuleControls() {
    const refreshBtn = document.getElementById('transactionsRefreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.loadTransactionsPage());
    }
    const search = document.getElementById('transactionsSearchInput');
    if (search) {
      search.addEventListener('input', (e) => {
        this.transactionsSearchTerm = ((e.target && e.target.value) || '').toString();
        this.applyTransactionsSearchAndRender();
      });
    }
    const farmerFilter = document.getElementById('transactionsFarmerFilter');
    if (farmerFilter) {
      farmerFilter.addEventListener('change', () => {
        const v = farmerFilter.value;
        this.transactionsFarmerFilterId = v ? parseInt(v, 10) : null;
        if (v && Number.isNaN(this.transactionsFarmerFilterId)) {
          this.transactionsFarmerFilterId = null;
        }
        this.loadTransactionsPage();
      });
    }

    const form = document.getElementById('coffeeTxnRecordForm');
    const submitBtn = document.getElementById('coffeeTxnSubmitBtn');
    if (form && submitBtn) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const farmerId = parseInt(String(fd.get('farmer_id') || ''), 10);
        const variety = String(fd.get('variety') || '').trim().toLowerCase();
        const deltaKgRaw = String(fd.get('delta_kg') ?? '').trim();
        const buyer_name = String(fd.get('buyer_name') ?? '').trim();
        const notes = String(fd.get('notes') ?? '').trim();

        if (!farmerId || Number.isNaN(farmerId)) {
          this.showNotification('Choose a farmer.', 'error');
          return;
        }
        const payload = {
          farmer_id: farmerId,
          variety,
          delta_kg: deltaKgRaw,
          buyer_name,
          notes,
        };

        submitBtn.disabled = true;
        submitBtn.setAttribute('aria-busy', 'true');
        try {
          const res = await fetch('/api/farmer-coffee-transactions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(payload),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(body.error || `HTTP ${res.status}`);
          }
          form.reset();
          this.showNotification('Coffee bean transaction saved.', 'success');
          await this.loadTransactionsPage();
        } catch (err) {
          console.warn('Save coffee transaction failed:', err);
          this.showNotification(err.message || 'Could not save transaction.', 'error');
        } finally {
          submitBtn.disabled = false;
          submitBtn.removeAttribute('aria-busy');
        }
      });
    }
  }

  setupEventListeners() {
    // Menu toggle
    const menuToggle = document.getElementById('menuToggle');
    if (menuToggle) {
      menuToggle.addEventListener('click', () => {
        this.toggleSidePanel();
      });
    }

    // Header icon buttons
    const messagingBtn = document.getElementById('messagingBtn');
    if (messagingBtn) {
      messagingBtn.addEventListener('click', () => {
        this.switchModule('messaging');
      });
    }

    const accountBtn = document.getElementById('accountBtn');
    if (accountBtn) {
      accountBtn.addEventListener('click', () => {
        this.switchModule('account');
      });
    }

    const notificationBtn = document.getElementById('notificationBtn');
    if (notificationBtn) {
      notificationBtn.addEventListener('click', () => {
        this.switchModule('notifications-feed');
        this.refreshNotificationsModule();
      });
    }

    this.initTransactionsModuleControls();

    // Sidebar submenu toggles
    const submenuToggles = [
      { link: 'sidebarFarmersLink', submenu: 'sidebarFarmersSubmenu' },
      { link: 'sidebarIpophlLink', submenu: 'sidebarIpophlSubmenu' },
      { link: 'sidebarSettingsLink', submenu: 'sidebarSettingsSubmenu' }
    ];

    submenuToggles.forEach(({ link, submenu }) => {
      const linkEl = document.getElementById(link);
      const submenuEl = document.getElementById(submenu);
      
      if (linkEl && submenuEl) {
        linkEl.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.toggleSubmenu(linkEl, submenuEl);
        });
      }
    });

    // Submenu navigation links
    const submenuLinks = document.querySelectorAll('.submenu .nav-link');
    submenuLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const module = link.dataset.module;
        if (module) {
          this.switchModule(module);
        }
      });
    });

    // Navigation links
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const module = link.dataset.module;
        if (module === 'social-media') {
          window.open(
            'https://www.facebook.com/login.php?next=https%3A%2F%2Fwww.facebook.com%2Fme',
            '_blank',
            'noopener'
          );
          return;
        }
        if (module === 'settings') {
          this.settingsViewMode = 'landing';
          this.syncSettingsSubmenuActive(null);
        }
        this.switchModule(module);
      });
    });

    // Sidebar settings dropdown (UI navigation to settings_dynamic.html fragments)
    const settingsSidebarLink = document.getElementById('sidebarSettingsLink');
    const sidebarSettingsSubmenu = document.getElementById('sidebarSettingsSubmenu');
    if (settingsSidebarLink && sidebarSettingsSubmenu) {
      settingsSidebarLink.addEventListener('click', (e) => {
        e.preventDefault();
        const nextOpen = !sidebarSettingsSubmenu.classList.contains('open');
        sidebarSettingsSubmenu.classList.toggle('open', nextOpen);
        settingsSidebarLink.classList.toggle('open', nextOpen);
      });

      const submenuButtons = sidebarSettingsSubmenu.querySelectorAll('.settings-submenu-item[data-tab]');
      submenuButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
          const tab = btn.getAttribute('data-tab') || 'security';

          submenuButtons.forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');

          this.activeSettingsTab = tab;
          this.settingsViewMode = 'detail';

          // Ensure the Settings module is visible and render the selected fragment inside it.
          this.switchModule('settings');
        });
      });
    }

    // Refresh button (reload data, charts, table, notifications list)
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        this.refreshDashboard();
      });
    }

    // Header profile dropdown: Account Information → Settings / Profile; Log out
    const userProfileDropdown = document.getElementById('userProfileDropdown');
    const userProfileTrigger = document.getElementById('userProfileTrigger');
    const userProfileMenu = document.getElementById('userProfileMenu');
    const userProfileAccountBtn = document.getElementById('userProfileAccountBtn');
    const userProfileLogoutBtn = document.getElementById('userProfileLogoutBtn');

    const openProfileSettings = () => {
      this.activeSettingsTab = 'profile';
      this.settingsViewMode = 'detail';
      const submenuButtons = document.querySelectorAll(
        '#sidebarSettingsSubmenu .settings-submenu-item[data-tab]'
      );
      submenuButtons.forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-tab') === 'profile');
      });
      this.switchModule('settings');
    };

    const closeUserProfileMenu = () => {
      if (!userProfileDropdown || !userProfileTrigger || !userProfileMenu) return;
      userProfileDropdown.classList.remove('is-open');
      userProfileMenu.hidden = true;
      userProfileTrigger.setAttribute('aria-expanded', 'false');
    };

    const openUserProfileMenu = () => {
      if (!userProfileDropdown || !userProfileTrigger || !userProfileMenu) return;
      userProfileDropdown.classList.add('is-open');
      userProfileMenu.hidden = false;
      userProfileTrigger.setAttribute('aria-expanded', 'true');
    };

    if (userProfileTrigger && userProfileMenu) {
      userProfileTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (userProfileMenu.hidden) {
          openUserProfileMenu();
        } else {
          closeUserProfileMenu();
        }
      });

      document.addEventListener('click', () => closeUserProfileMenu());
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeUserProfileMenu();
      });
    }

    if (userProfileAccountBtn) {
      userProfileAccountBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeUserProfileMenu();
        openProfileSettings();
      });
    }

    if (userProfileLogoutBtn) {
      userProfileLogoutBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeUserProfileMenu();
        this.openLogoutConfirmModal();
      });
    }

    const notificationsPageRefreshBtn = document.getElementById('notificationsPageRefreshBtn');
    const notificationsMarkAllReadBtn = document.getElementById('notificationsMarkAllReadBtn');
    if (notificationsPageRefreshBtn) {
      notificationsPageRefreshBtn.addEventListener('click', () => {
        this.refreshNotificationsModule();
      });
    }
    if (notificationsMarkAllReadBtn) {
      notificationsMarkAllReadBtn.addEventListener('click', () => this.markAllNotificationsRead());
    }

    const notificationsListEl = document.getElementById('notificationsList');
    if (notificationsListEl) {
      notificationsListEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="mark-notification-read"]');
        if (btn) {
          e.preventDefault();
          e.stopPropagation();
          const id = btn.getAttribute('data-notification-id');
          if (id) this.markNotificationRead(id);
          return;
        }
        const item = e.target.closest('.notification-item');
        if (!item) return;
        const id = item.getAttribute('data-notification-id');
        if (id) this.openNotificationDetail(id);
      });
      notificationsListEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const btn = e.target.closest('[data-action="mark-notification-read"]');
        if (btn) return;
        const item = e.target.closest('.notification-item');
        if (!item) return;
        e.preventDefault();
        const id = item.getAttribute('data-notification-id');
        if (id) this.openNotificationDetail(id);
      });
    }

    this.initNotificationDetailModal();

    // Export button
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        console.log('Export button clicked');
        this.exportData();
      });
    }

    // Export option buttons
    const exportOptionBtns = document.querySelectorAll('.export-option-btn');
    exportOptionBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const exportType = btn.textContent.includes('Excel') ? 'excel' : 
                          btn.textContent.includes('PDF') ? 'pdf' : 'csv';
        this.handleExport(exportType);
      });
    });

    // Farmer table search
    const farmerSearch = document.getElementById('farmerSearch');
    if (farmerSearch) {
      farmerSearch.addEventListener('input', (e) => {
        const term = (e.target.value || '').toString().trim().toLowerCase();
        this.filterData(term);
      });
    }

    // Farmers List (card view) search
    const farmersListSearch = document.getElementById('farmersListSearch');
    if (farmersListSearch) {
      farmersListSearch.addEventListener('input', (e) => {
        const term = (e.target.value || '').toString().trim().toLowerCase();
        this.filterData(term);
        if (farmerSearch && farmerSearch.value !== e.target.value) {
          farmerSearch.value = e.target.value;
        }
      });
    }

    // Page size selector
    const pageSizeSelect = document.getElementById('pageSizeSelect');
    if (pageSizeSelect) {
      pageSizeSelect.addEventListener('change', (e) => {
        const nextSize = Number.parseInt(e.target.value, 10);
        if (Number.isFinite(nextSize) && nextSize > 0) {
          this.pageSize = nextSize;
          this.currentPage = 1;
          this.updateTable();
        }
      });
    }

    // Farmers List page size selector (sync with table view)
    const farmersListPageSizeSelect = document.getElementById('farmersListPageSizeSelect');
    if (farmersListPageSizeSelect) {
      farmersListPageSizeSelect.addEventListener('change', (e) => {
        const nextSize = Number.parseInt(e.target.value, 10);
        if (Number.isFinite(nextSize) && nextSize > 0) {
          this.pageSize = nextSize;
          this.currentPage = 1;
          this.updateTable();
          if (pageSizeSelect && pageSizeSelect.value !== e.target.value) {
            pageSizeSelect.value = e.target.value;
          }
        }
      });
    }

    // Farmers List: open profile details
    const farmersCardGrid = document.getElementById('farmersCardGrid');
    if (farmersCardGrid) {
      farmersCardGrid.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="open-farmer-profile"]');
        if (btn) {
          const nRaw = btn.getAttribute('data-farmer-no') || '';
          const n = Number.parseInt(nRaw, 10);
          if (Number.isFinite(n)) this.openFarmerProfile(n);
          return;
        }

        const placeholderBtn = e.target.closest('[data-action="open-farmer-placeholder-profile"]');
        if (placeholderBtn) {
          const nRaw = placeholderBtn.getAttribute('data-farmer-no') || '1';
          const n = Number.parseInt(nRaw, 10) || 1;
          this.openFarmerPlaceholderProfile(n);
        }
      });
    }

    const farmerProfileBackBtn = document.getElementById('farmerProfileBackBtn');
    if (farmerProfileBackBtn) {
      farmerProfileBackBtn.addEventListener('click', () => this.closeFarmerProfile());
    }

    // Register module actions (download/share)
    const registerDocsGrid = document.getElementById('registerDocsGrid');
    if (registerDocsGrid) {
      registerDocsGrid.addEventListener('click', async (e) => {
        const actionBtn = e.target.closest('[data-register-action]');
        if (!actionBtn) return;
        const action = actionBtn.getAttribute('data-register-action');
        const docId = actionBtn.getAttribute('data-doc-id');
        if (!action || !docId) return;

        const docs = this.getRegisterDocuments();
        const doc = docs.find((d) => d.id === docId);
        if (!doc) return;

        if (action === 'download') {
          if (doc.file) {
            const url = URL.createObjectURL(doc.file);
            const a = document.createElement('a');
            a.href = url;
            a.download = doc.name || 'document';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 2000);
          } else {
            this.showNotification(`Preview document: ${doc.name}`, 'info');
          }
        }

        if (action === 'share') {
          const text = `${doc.name}${doc.service ? ` (${doc.service})` : ''}`;
          if (navigator.share) {
            try {
              await navigator.share({ title: 'IPOPHL Document', text });
            } catch (_) {
              // user cancelled
            }
          } else if (navigator.clipboard && navigator.clipboard.writeText) {
            try {
              await navigator.clipboard.writeText(text);
              this.showNotification('Document name copied to clipboard.', 'success');
            } catch (_) {
              this.showNotification(text, 'info');
            }
          } else {
            this.showNotification(text, 'info');
          }
        }
      });
    }

    // Maps module controls
    const mapsSearchInput = document.getElementById('mapsSearchInput');
    if (mapsSearchInput) {
      mapsSearchInput.addEventListener('input', (e) => {
        this.mapSearchTerm = (e.target.value || '').toString().trim().toLowerCase();
        this.renderMapsModule();
      });
    }

    const mapsVarietyButtons = document.querySelectorAll('#maps-module .maps-variety-btn');
    mapsVarietyButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        mapsVarietyButtons.forEach((b) => {
          b.classList.remove('is-active');
          b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('is-active');
        btn.setAttribute('aria-selected', 'true');
        this.mapVarietyFilter = (btn.textContent || '').trim().toLowerCase();
        this.renderMapsModule();
      });
    });

    // Farmer table view toggle (delegate: avoids missed hits on pseudo-element overlays / inner nodes)
    const farmersModule = document.getElementById('farmers-module');
    if (farmersModule) {
      farmersModule.addEventListener('click', (e) => {
        const btn = e.target.closest('.view-toggle-btn[data-table-view]');
        if (!btn || !farmersModule.contains(btn)) return;
        const view = btn.getAttribute('data-table-view') || 'basic';
        this.setFarmerTableView(view);
      });
    }

    // Farmer CRUD actions
    const addFarmerBtn = document.getElementById('addFarmerBtn');
    if (addFarmerBtn) {
      addFarmerBtn.addEventListener('click', () => this.addFarmer());
    }

    const loadSampleBtn = document.getElementById('loadSampleBtn');
    if (loadSampleBtn) {
      loadSampleBtn.addEventListener('click', () => {
        this.loadSampleData();
        this.showNotification('Sample data loaded successfully!', 'success');
      });
    }

    const saveFarmersBtn = document.getElementById('saveFarmersBtn');
    if (saveFarmersBtn) {
      saveFarmersBtn.addEventListener('click', () => this.saveFarmers());
    }

    const farmerLimitDismiss = document.getElementById('farmerLimitBannerDismiss');
    if (farmerLimitDismiss) {
      farmerLimitDismiss.addEventListener('click', () => {
        try {
          sessionStorage.setItem('beanthentic_farmer_limit_banner_dismissed', '1');
        } catch (_) {
          /* ignore */
        }
        const b = document.getElementById('farmerLimitBanner');
        if (b) b.hidden = true;
      });
    }

    // Inline edit + row delete (event delegation)
    document.addEventListener('click', (e) => {
      const delBtn = e.target.closest('[data-action="delete-farmer"]');
      if (!delBtn) return;
      const idx = Number.parseInt(delBtn.getAttribute('data-row-index') || '', 10);
      if (!Number.isFinite(idx) || idx < 0) return;
      if (!this.data[idx]) {
        this.showNotification('Could not find that row to delete.', 'error');
        return;
      }
      this.openDeleteFarmerConfirm(idx);
    });

    this.initDeleteFarmerConfirmModal();
    this.initLogoutConfirmModal();

    const settingsBackBtn = document.getElementById('settingsBackToOverviewBtn');
    if (settingsBackBtn) {
      settingsBackBtn.addEventListener('click', () => {
        this.settingsViewMode = 'landing';
        this.syncSettingsSubmenuActive(null);
        this.loadSettingsLanding();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const m = document.getElementById('disable2faConfirmModal');
      if (!m || m.hasAttribute('hidden')) return;
      const logoutEl = document.getElementById('logoutConfirmModal');
      if (logoutEl && !logoutEl.hasAttribute('hidden')) return;
      const nd = document.getElementById('notificationDetailModal');
      if (nd && !nd.hasAttribute('hidden')) return;
      const del = document.getElementById('deleteFarmerConfirmModal');
      if (del && !del.hasAttribute('hidden')) return;
      e.preventDefault();
      this.closeDisable2faConfirmModal();
    });

    document.addEventListener(
      'blur',
      (e) => {
        const cell = e.target.closest('[data-field][data-row-index]');
        if (!cell) return;
        if (cell.getAttribute('contenteditable') !== 'true') return;

        const idx = Number.parseInt(cell.getAttribute('data-row-index') || '', 10);
        const field = cell.getAttribute('data-field') || '';
        if (!Number.isFinite(idx) || idx < 0 || !field) return;

        const rawValue = (cell.textContent || '').trim();
        this.updateFarmerField(idx, field, rawValue);
      },
      true
    );

    // Keep sidebar state consistent when resizing across breakpoints.
    window.addEventListener('resize', () => {
      this.syncSidePanelToViewport();
    });

    this.syncSidePanelToViewport();
  }

  toggleSidePanel() {
    const sidePanel = document.querySelector('.side-panel');
    const mainContent = document.querySelector('.main-content');
    if (!sidePanel || !mainContent) return;
    
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    const page = document.body;

    if (isMobile) {
      sidePanel.classList.toggle('mobile-open');
      mainContent.classList.toggle('expanded');
      // On mobile, header should be full-width; keep "collapsed" state off.
      page.classList.toggle('sidebar-collapsed', !sidePanel.classList.contains('mobile-open'));
      return;
    }

    sidePanel.classList.toggle('collapsed');
    mainContent.classList.toggle('expanded');
    page.classList.toggle('sidebar-collapsed', sidePanel.classList.contains('collapsed'));
  }

  closeMobileSidePanel() {
    const sidePanel = document.querySelector('.side-panel');
    const mainContent = document.querySelector('.main-content');
    if (!sidePanel || !mainContent) return;

    sidePanel.classList.remove('mobile-open');
    mainContent.classList.remove('expanded');
    document.body.classList.add('sidebar-collapsed');
  }

  syncSidePanelToViewport() {
    const sidePanel = document.querySelector('.side-panel');
    const mainContent = document.querySelector('.main-content');
    if (!sidePanel || !mainContent) return;

    const isMobile = window.matchMedia('(max-width: 768px)').matches;

    if (isMobile) {
      // Desktop collapse state shouldn't leak into the mobile off-canvas.
      sidePanel.classList.remove('collapsed');
      document.body.classList.remove('sidebar-collapsed');
      return;
    }

    // Mobile open state shouldn't leak into desktop layout.
    sidePanel.classList.remove('mobile-open');
    if (!sidePanel.classList.contains('collapsed')) {
      mainContent.classList.remove('expanded');
      document.body.classList.remove('sidebar-collapsed');
    } else {
      document.body.classList.add('sidebar-collapsed');
    }
  }

  switchModule(moduleName) {
    const settingsTabs = new Set(['security', 'notifications', 'activity', 'faq', 'profile']);
    const isSettingsTab = settingsTabs.has(moduleName);
    const isHeaderNotificationsFeed = moduleName === 'notifications-feed';
    const resolvedModuleName = isHeaderNotificationsFeed
      ? 'notifications'
      : (isSettingsTab ? 'settings' : moduleName);

    if (isSettingsTab) {
      this.activeSettingsTab = moduleName;
      this.settingsViewMode = 'detail';
      this.syncSettingsSubmenuActive(moduleName);
    }

    // Update navigation active state
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
      link.classList.remove('active');
      link.removeAttribute('aria-current');
      if (
        link.dataset.module === moduleName ||
        (!isSettingsTab && link.dataset.module === resolvedModuleName)
      ) {
        link.classList.add('active');
        link.setAttribute('aria-current', 'page');
      }
    });

    // Update breadcrumb
    const currentModule = document.getElementById('currentModule');
    const moduleNames = {
      'overview': 'Overview',
      'notifications': 'Notifications',
      'notifications-feed': 'Notifications',
      'farmers': 'Farmer Records',
      'farmers-list': 'Farmers',
      'maps': 'Maps',
      'transactions': 'Transactions',
      'register': 'IPOPHL Register',
      'security': 'Account Security',
      'activity': 'Activity Log',
      'faq': 'FAQ',
      'profile': 'Profile Actions',
      'analytics': 'Analytics',
      'ipophl': 'IPOPHL',
      'export': 'Export Data',
      'social-media': 'Social Media',
      'settings': 'Settings',
      'account': 'Account',
      'messaging': 'Messaging'
    };
    currentModule.textContent = moduleNames[moduleName] || 'Overview';

    // Load account data when switching to account module
    if (moduleName === 'account') {
      this.loadAccountData();
    }

    // Switch modules
    const modules = document.querySelectorAll('.module');
    modules.forEach(module => {
      module.classList.add('hidden');
    });

    const targetModule = document.getElementById(`${resolvedModuleName}-module`);
    if (targetModule) {
      targetModule.classList.remove('hidden');
    }

    // Scroll behavior: only lock page scroll for the Farmers module
    const moduleContent = document.querySelector('.module-content');
    if (moduleContent) {
      moduleContent.classList.toggle('lock-scroll', resolvedModuleName === 'farmers');
    }

    if (resolvedModuleName === 'settings') {
      if (this.settingsViewMode === 'landing') {
        this.loadSettingsLanding();
      } else {
        this.loadAdminSettingsFragment(this.activeSettingsTab || 'security');
      }
    }

    if (resolvedModuleName === 'notifications') {
      this.renderNotificationsList();
      this.refreshNotificationsModule();
    }
    if (resolvedModuleName === 'analytics') {
      this.renderAnalyticsModule();
    }
    if (resolvedModuleName === 'maps') {
      this.renderMapsModule();
    }
    if (resolvedModuleName === 'register') {
      this.renderRegisterModule();
    }
    if (resolvedModuleName === 'ipophl') {
      this.renderIpophlModule();
    }
    if (resolvedModuleName === 'transactions') {
      this.loadTransactionsPage();
    }
    if (resolvedModuleName === 'messaging') {
      this.initMessagingModule();
      this.loadMessagingFolder();
    }

    // Close mobile menu
    if (window.innerWidth <= 768) {
      this.closeMobileSidePanel();
    }
  }

  async fetchSettingsState() {
    const res = await fetch('/settings/state');
    if (res.status === 401) {
      this.showNotification('Please sign in again to change settings.', 'error');
      return null;
    }
    if (!res.ok) {
      this.showNotification('Could not load settings from server.', 'error');
      return null;
    }
    return res.json();
  }

  buildTotpUri(identifier, secret) {
    const enc = encodeURIComponent;
    const id = identifier || 'admin';
    return `otpauth://totp/Beanthentic:${enc(id)}?secret=${enc(secret)}&issuer=${enc('Beanthentic')}`;
  }

  fill2faSetupPanel(containerEl, identifier, secret, backupCodes) {
    const twoFaStatus = containerEl.querySelector('[id="2faStatus"]');
    const twoFaSetup = containerEl.querySelector('[id="2faSetup"]');
    const manualKey = containerEl.querySelector('#manualKey');
    const backupCodesList = containerEl.querySelector('#backupCodesList');
    const qrHolder = containerEl.querySelector('#qrCodePlaceholder');
    if (twoFaStatus) twoFaStatus.style.display = 'none';
    if (twoFaSetup) twoFaSetup.style.display = 'block';
    if (manualKey) manualKey.textContent = `Manual key (if you cannot scan): ${secret}`;
    if (backupCodesList && Array.isArray(backupCodes)) {
      backupCodesList.innerHTML = backupCodes.map((c) => `<code>${c}</code>`).join('');
    }
    if (qrHolder && secret) {
      const uri = this.buildTotpUri(identifier, secret);
      const src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(uri)}`;
      qrHolder.innerHTML = `<img src="${src}" alt="Scan to add to authenticator app" width="200" height="200" loading="lazy" />`;
    }
  }

  reset2faQrPlaceholder(containerEl) {
    const qrHolder = containerEl.querySelector('#qrCodePlaceholder');
    if (qrHolder) {
      qrHolder.innerHTML =
        '<i class="fa-solid fa-qrcode" style="font-size: 140px; color: #d1d5db;"></i>';
    }
  }

  openDisable2faConfirmModal() {
    const root = document.getElementById('disable2faConfirmModal');
    if (!root) return;
    root.removeAttribute('hidden');
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('confirm-dialog-active');
    document.getElementById('disable2faPasswordInput')?.focus();
  }

  closeDisable2faConfirmModal() {
    const root = document.getElementById('disable2faConfirmModal');
    if (root) {
      root.setAttribute('hidden', '');
      root.setAttribute('aria-hidden', 'true');
    }
    const input = document.getElementById('disable2faPasswordInput');
    if (input) input.value = '';
    const logoutEl = document.getElementById('logoutConfirmModal');
    const del = document.getElementById('deleteFarmerConfirmModal');
    const nd = document.getElementById('notificationDetailModal');
    const d2 = document.getElementById('disable2faConfirmModal');
    if (
      logoutEl?.hasAttribute('hidden') &&
      del?.hasAttribute('hidden') &&
      nd?.hasAttribute('hidden') &&
      d2?.hasAttribute('hidden')
    ) {
      document.body.classList.remove('confirm-dialog-active');
    }
  }

  syncSettingsSubmenuActive(tab) {
    const submenuButtons = document.querySelectorAll('#sidebarSettingsSubmenu .settings-submenu-item[data-tab]');
    submenuButtons.forEach((b) => {
      if (tab == null) {
        b.classList.remove('active');
      } else {
        b.classList.toggle('active', b.getAttribute('data-tab') === tab);
      }
    });
  }

  loadSettingsLanding() {
    const container = document.getElementById('adminSettingsFragmentContainer');
    const titleEl = document.getElementById('adminSettingsFragmentTitle');
    const pageTitleEl = document.getElementById('adminSettingsPageTitle');
    const toolbar = document.getElementById('settingsDetailToolbar');
    if (!container) return;

    if (toolbar) toolbar.hidden = true;
    if (pageTitleEl) pageTitleEl.textContent = 'Settings';
    if (titleEl) titleEl.textContent = 'Choose a category';

    const cards = [
      {
        tab: 'security',
        title: 'Account Security',
        desc: 'Change your password and manage two-factor authentication.',
        icon: 'fa-shield-halved',
      },
      {
        tab: 'notifications',
        title: 'Notifications Settings',
        desc: 'Control email, SMS, and in-app alerts.',
        icon: 'fa-bell',
      },
      {
        tab: 'activity',
        title: 'Activity Log',
        desc: 'Review recent account actions and filters.',
        icon: 'fa-clock-rotate-left',
      },
      {
        tab: 'faq',
        title: 'FAQ',
        desc: 'Quick answers about passwords, 2FA, and backups.',
        icon: 'fa-circle-question',
      },
      {
        tab: 'profile',
        title: 'Profile Actions',
        desc: 'Update your name, refresh session, or sign out.',
        icon: 'fa-user-gear',
      },
    ];

    const rows = cards
      .map(
        (c) => `
      <button type="button" class="settings-landing-card" data-tab="${c.tab}">
        <span class="settings-landing-card__icon" aria-hidden="true"><i class="fa-solid ${c.icon}"></i></span>
        <span class="settings-landing-card__body">
          <span class="settings-landing-card__title">${c.title}</span>
          <span class="settings-landing-card__desc">${c.desc}</span>
        </span>
        <span class="settings-landing-card__chev" aria-hidden="true"><i class="fa-solid fa-chevron-right"></i></span>
      </button>`
      )
      .join('');

    container.innerHTML = `<div class="settings-landing"><div class="settings-landing-grid">${rows}</div></div>`;

    container.querySelectorAll('.settings-landing-card[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab') || 'security';
        this.activeSettingsTab = tab;
        this.settingsViewMode = 'detail';
        this.syncSettingsSubmenuActive(tab);
        this.loadAdminSettingsFragment(tab);
      });
    });
  }

  async loadAdminSettingsFragment(tab) {
    const container = document.getElementById('adminSettingsFragmentContainer');
    const titleEl = document.getElementById('adminSettingsFragmentTitle');
    const pageTitleEl = document.getElementById('adminSettingsPageTitle');
    const toolbar = document.getElementById('settingsDetailToolbar');
    if (!container) return;

    if (toolbar) toolbar.hidden = false;
    this.settingsViewMode = 'detail';

    const fragments = {
      security: '/admin/settings/account_security.html',
      notifications: '/admin/settings/notifications_settings.html',
      activity: '/admin/settings/activity_log.html',
      faq: '/admin/settings/faq.html',
      profile: '/admin/settings/profile_actions.html',
    };

    const titleMap = {
      security: 'Account Security',
      notifications: 'Notifications Settings',
      activity: 'Activity Log',
      faq: 'FAQ',
      profile: 'Profile Actions',
    };

    const resolvedTab = fragments[tab] ? tab : 'security';
    const url = fragments[resolvedTab];

    if (titleEl) titleEl.textContent = titleMap[resolvedTab] || 'Account Security';
    if (pageTitleEl) pageTitleEl.textContent = titleMap[resolvedTab] || 'Settings';

    container.innerHTML = 'Loading...';
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} while fetching ${url}`);
      }
      const html = await res.text();
      container.innerHTML = `<div class="settings-fragment">${html}</div>`;
      await this.initAdminSettingsInteractions(container);
    } catch (err) {
      console.error('Failed to load settings fragment:', err);
      const msg = err && err.message ? err.message : String(err);
      container.innerHTML = `<div class="alert alert-error">Failed to load settings content: ${msg}</div>`;
    }
  }

  async initAdminSettingsInteractions(containerEl) {
    // FAQ accordion
    const faqItems = containerEl.querySelectorAll('.faq-item');
    faqItems.forEach((item) => {
      const q = item.querySelector('.faq-question');
      const a = item.querySelector('.faq-answer');
      if (!q || !a) return;
      q.addEventListener('click', () => {
        item.classList.toggle('active');
        a.classList.toggle('active');
      });
    });

    // Activity log search
    const search = containerEl.querySelector('#activitySearch');
    const actionFilter = containerEl.querySelector('#activityActionFilter');
    const tbody = containerEl.querySelector('#activityTableBody');
    if (tbody) {
      const rows = Array.from(tbody.querySelectorAll('tr'));

      const getRowActionText = (row) => {
        const tds = row.querySelectorAll('td');
        if (tds.length >= 2) return (tds[1].textContent || '').trim().toLowerCase();
        return '';
      };

      const applyFilters = () => {
        const term = (search && (search.value || '')).toString().toLowerCase().trim();
        const selectedAction = actionFilter && actionFilter.value ? actionFilter.value : 'all';

        rows.forEach((row) => {
          const fullText = row.textContent.toLowerCase();
          const rowAction = getRowActionText(row);
          const actionOk = selectedAction === 'all' || rowAction === selectedAction;
          const termOk = !term || fullText.includes(term);
          row.style.display = actionOk && termOk ? '' : 'none';
        });
      };

      if (search) search.addEventListener('input', applyFilters);
      if (actionFilter) actionFilter.addEventListener('change', applyFilters);
      applyFilters();
    }

    const needsServerState =
      !!containerEl.querySelector('#passwordForm') ||
      !!containerEl.querySelector('#saveNotificationsBtn') ||
      !!containerEl.querySelector('#profileForm');

    let state = null;
    if (needsServerState) {
      state = await this.fetchSettingsState();
    }

    const NOTIFICATION_KEYS = [
      'email_system_events',
      'email_user_registrations',
      'email_security_breaches',
      'sms_system_events',
      'sms_user_registrations',
      'sms_security_breaches',
      'in_app_system_events',
      'in_app_user_registrations',
      'in_app_security_breaches',
    ];

    const saveNotificationsBtn = containerEl.querySelector('#saveNotificationsBtn');
    if (saveNotificationsBtn) {
      if (state && state.notifications) {
        NOTIFICATION_KEYS.forEach((k) => {
          const el = containerEl.querySelector(`#${k}`);
          if (el) el.checked = !!state.notifications[k];
        });
      }
      saveNotificationsBtn.addEventListener('click', async () => {
        const fd = new FormData();
        NOTIFICATION_KEYS.forEach((k) => {
          const el = containerEl.querySelector(`#${k}`);
          fd.append(k, el && el.checked ? 'true' : 'false');
        });
        try {
          const res = await fetch('/settings/notifications', { method: 'POST', body: fd });
          const result = await res.json();
          if (result.error) {
            this.showNotification(result.error, 'error');
            return;
          }
          this.showNotification(result.success || 'Notification settings saved.', 'success');
        } catch {
          this.showNotification('Could not save notifications.', 'error');
        }
      });
    }

    const profileForm = containerEl.querySelector('#profileForm');
    if (profileForm) {
      const u = (state && state.user) || window.__BEANTHENTIC_USER__ || {};
      const fn = containerEl.querySelector('#fullName');
      const ph = containerEl.querySelector('#phone');
      if (fn) fn.value = u.full_name || '';
      if (ph) ph.value = u.phone || '';

      profileForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fullName = (containerEl.querySelector('#fullName')?.value || '').trim();
        if (!fullName) {
          this.showNotification('Full name is required.', 'error');
          return;
        }
        const fd = new FormData();
        fd.append('full_name', fullName);
        try {
          const res = await fetch('/settings/profile', { method: 'POST', body: fd });
          const result = await res.json();
          if (result.error) {
            this.showNotification(result.error, 'error');
            return;
          }
          const nameEl = document.querySelector('.user-name');
          if (nameEl) nameEl.textContent = fullName;
          if (window.__BEANTHENTIC_USER__) window.__BEANTHENTIC_USER__.full_name = fullName;
          this.showNotification(result.success || 'Profile updated.', 'success');
        } catch {
          this.showNotification('Could not update profile.', 'error');
        }
      });
    }

    const refreshSessionBtn = containerEl.querySelector('#refreshSessionBtn');
    if (refreshSessionBtn) {
      refreshSessionBtn.addEventListener('click', () => {
        window.location.reload();
      });
    }

    const logoutBtn = containerEl.querySelector('#logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        this.openLogoutConfirmModal();
      });
    }

    const passwordForm = containerEl.querySelector('#passwordForm');
    if (passwordForm) {
      const cur = passwordForm.querySelector('#currentPassword');
      const np = passwordForm.querySelector('#newPassword');
      const cp = passwordForm.querySelector('#confirmPassword');
      const curErr = passwordForm.querySelector('#currentPasswordError');
      const npErr = passwordForm.querySelector('#newPasswordError');
      const cpErr = passwordForm.querySelector('#confirmPasswordError');

      let verifyTimer = null;
      /** @type {number} */
      let verifySeq = 0;

      const setFieldError = (input, errEl, message) => {
        if (!input) return;
        if (message) {
          input.classList.add('is-invalid');
          input.classList.remove('is-valid');
          if (errEl) {
            errEl.textContent = message;
            errEl.hidden = false;
          }
        } else {
          input.classList.remove('is-invalid');
          if (errEl) {
            errEl.textContent = '';
            errEl.hidden = true;
          }
        }
      };

      const setFieldOk = (input, errEl) => {
        if (!input) return;
        input.classList.remove('is-invalid');
        input.classList.add('is-valid');
        if (errEl) {
          errEl.textContent = '';
          errEl.hidden = true;
        }
      };

      const clearCurrentFieldFeedback = () => {
        if (cur) cur.classList.remove('is-invalid', 'is-valid');
        if (curErr) {
          curErr.textContent = '';
          curErr.hidden = true;
        }
      };

      const verifyCurrentPassword = async () => {
        const pwd = (cur && cur.value) || '';
        if (!pwd.trim()) {
          clearCurrentFieldFeedback();
          return false;
        }
        const seq = ++verifySeq;
        const body = new URLSearchParams();
        body.set('action', 'verify_current_password');
        body.set('current_password', pwd);
        try {
          const res = await fetch('/settings/security', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
          });
          const result = await res.json();
          if (seq !== verifySeq) return null;
          if (result.valid) {
            setFieldOk(cur, curErr);
            return true;
          }
          setFieldError(cur, curErr, result.error || "That doesn't match your current password.");
          return false;
        } catch {
          if (seq !== verifySeq) return null;
          setFieldError(cur, curErr, 'Could not verify. Check your connection.');
          return false;
        }
      };

      const scheduleVerifyCurrent = () => {
        clearTimeout(verifyTimer);
        verifyTimer = setTimeout(() => {
          verifyCurrentPassword();
        }, 450);
      };

      const validateNewPasswords = () => {
        const a = (np && np.value) || '';
        const b = (cp && cp.value) || '';
        if (np && npErr) {
          if (a && a.length < 8) {
            setFieldError(np, npErr, 'Use at least 8 characters.');
          } else {
            setFieldError(np, npErr, '');
          }
        }
        if (cp && cpErr) {
          if (b && a !== b) {
            setFieldError(cp, cpErr, 'Does not match the new password above.');
          } else {
            setFieldError(cp, cpErr, '');
          }
        }
      };

      if (cur) {
        cur.addEventListener('input', () => {
          clearCurrentFieldFeedback();
          const pwd = (cur.value || '').trim();
          if (pwd) scheduleVerifyCurrent();
        });
        cur.addEventListener('blur', () => {
          clearTimeout(verifyTimer);
          verifyCurrentPassword();
        });
      }
      if (np) np.addEventListener('input', validateNewPasswords);
      if (cp) cp.addEventListener('input', validateNewPasswords);

      passwordForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        validateNewPasswords();

        if (!(cur && cur.value.trim())) {
          setFieldError(cur, curErr, 'Enter your current password.');
          this.showNotification('Enter your current password.', 'error');
          return;
        }

        clearTimeout(verifyTimer);
        let currentOk = await verifyCurrentPassword();
        if (currentOk === null) {
          currentOk = await verifyCurrentPassword();
        }
        if (currentOk !== true) {
          this.showNotification('Fix your current password before updating.', 'error');
          return;
        }

        const npV = (np && np.value) || '';
        const cpV = (cp && cp.value) || '';
        if (npV.length < 8) {
          setFieldError(np, npErr, 'Use at least 8 characters.');
          this.showNotification('New password must be at least 8 characters.', 'error');
          return;
        }
        if (npV !== cpV) {
          setFieldError(cp, cpErr, 'Does not match the new password above.');
          this.showNotification('New passwords do not match.', 'error');
          return;
        }

        const fd = new FormData(passwordForm);
        fd.set('action', 'change_password');
        try {
          const res = await fetch('/settings/security', { method: 'POST', body: fd });
          const result = await res.json();
          if (result.error) {
            this.showNotification(result.error, 'error');
            if (result.error.toLowerCase().includes('current')) {
              setFieldError(cur, curErr, result.error);
            }
            return;
          }
          this.showNotification(result.success || 'Password updated.', 'success');
          passwordForm.reset();
          clearCurrentFieldFeedback();
          setFieldError(np, npErr, '');
          setFieldError(cp, cpErr, '');
        } catch {
          this.showNotification('Could not update password.', 'error');
        }
      });
    }

    const enable2faBtn = containerEl.querySelector('#enable2faBtn');
    const disable2faBtn = containerEl.querySelector('#disable2faBtn');
    const viewBackupCodesBtn = containerEl.querySelector('#viewBackupCodesBtn');
    const cancel2faSetupBtn = containerEl.querySelector('#cancel2faSetupBtn');
    const twoFaStatus = containerEl.querySelector('[id="2faStatus"]');
    const twoFaSetup = containerEl.querySelector('[id="2faSetup"]');
    const enable2faToggle = containerEl.querySelector('#enable2faToggle');
    const notEnabledState = containerEl.querySelector('[id="2faNotEnabledState"]');
    const enabledState = containerEl.querySelector('[id="2faEnabledState"]');

    const set2faEnabledState = (enabled) => {
      if (twoFaStatus) twoFaStatus.style.display = 'block';
      if (notEnabledState) notEnabledState.style.display = enabled ? 'none' : 'block';
      if (enabledState) enabledState.style.display = enabled ? 'block' : 'none';
    };

    let twoFaActive = !!(state && state.security && state.security.two_factor_enabled);

    const userIdentifier =
      (state && state.user && state.user.phone) ||
      (window.__BEANTHENTIC_USER__ && window.__BEANTHENTIC_USER__.phone) ||
      '';

    const startEnable2fa = async (showSuccessMsg = true) => {
      try {
        const body = new URLSearchParams();
        body.set('action', 'toggle_2fa');
        body.set('enable_2fa', 'true');
        const res = await fetch('/settings/security', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        const result = await res.json();
        if (result.error) {
          this.showNotification(result.error, 'error');
          return;
        }
        twoFaActive = true;
        if (enable2faToggle) enable2faToggle.checked = true;
        set2faEnabledState(true);
        this.fill2faSetupPanel(containerEl, userIdentifier, result.secret, result.backup_codes);
        if (showSuccessMsg) this.showNotification(result.success || '2FA enabled.', 'success');
      } catch {
        this.showNotification('Could not enable 2FA.', 'error');
      }
    };

    if (passwordForm || enable2faBtn || enable2faToggle) {
      if (twoFaSetup) twoFaSetup.style.display = 'none';
      if (twoFaStatus) twoFaStatus.style.display = 'block';
      set2faEnabledState(twoFaActive);
      if (enable2faToggle) enable2faToggle.checked = twoFaActive;
      this.reset2faQrPlaceholder(containerEl);
    }

    if (enable2faToggle) {
      enable2faToggle.addEventListener('change', () => {
        const on = enable2faToggle.checked;
        if (on) {
          startEnable2fa(true);
        } else if (twoFaActive) {
          enable2faToggle.checked = true;
          this.openDisable2faConfirmModal();
        } else {
          set2faEnabledState(false);
        }
      });
    } else if (notEnabledState && enabledState) {
      set2faEnabledState(twoFaActive);
    }

    if (enable2faBtn) {
      enable2faBtn.addEventListener('click', () => {
        if (enable2faToggle) enable2faToggle.checked = true;
        startEnable2fa(true);
      });
    }

    if (viewBackupCodesBtn) {
      viewBackupCodesBtn.addEventListener('click', async () => {
        const fresh = await this.fetchSettingsState();
        if (!fresh || !fresh.security || !fresh.security.totp_secret) {
          this.showNotification('Backup codes are not available. Enable 2FA first.', 'error');
          return;
        }
        this.fill2faSetupPanel(
          containerEl,
          fresh.user && fresh.user.phone,
          fresh.security.totp_secret,
          fresh.security.backup_codes || []
        );
        this.showNotification('Store these codes in a safe place.', 'success');
      });
    }

    if (disable2faBtn) {
      disable2faBtn.addEventListener('click', () => {
        this.openDisable2faConfirmModal();
      });
    }

    const submitDisable2fa = async () => {
      const pwEl = document.getElementById('disable2faPasswordInput');
      const password = (pwEl && pwEl.value) || '';
      if (!password) {
        this.showNotification('Enter your password to disable 2FA.', 'error');
        return;
      }
      const body = new URLSearchParams();
      body.set('action', 'toggle_2fa');
      body.set('enable_2fa', 'false');
      body.set('password', password);
      try {
        const res = await fetch('/settings/security', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        const result = await res.json();
        if (result.error) {
          this.showNotification(result.error, 'error');
          return;
        }
        this.closeDisable2faConfirmModal();
        twoFaActive = false;
        if (enable2faToggle) enable2faToggle.checked = false;
        set2faEnabledState(false);
        if (twoFaSetup) {
          twoFaSetup.style.display = 'none';
          this.reset2faQrPlaceholder(containerEl);
        }
        if (twoFaStatus) twoFaStatus.style.display = 'block';
        this.showNotification(result.success || '2FA disabled.', 'success');
      } catch {
        this.showNotification('Could not disable 2FA.', 'error');
      }
    };

    const disableOk = document.getElementById('disable2faConfirmOk');
    const disableCancel = document.getElementById('disable2faConfirmCancel');
    const disableBackdrop = document.getElementById('disable2faConfirmBackdrop');
    if (disableOk) disableOk.addEventListener('click', () => submitDisable2fa());
    if (disableCancel) disableCancel.addEventListener('click', () => this.closeDisable2faConfirmModal());
    if (disableBackdrop) disableBackdrop.addEventListener('click', () => this.closeDisable2faConfirmModal());

    if (cancel2faSetupBtn) {
      cancel2faSetupBtn.addEventListener('click', () => {
        if (twoFaSetup) twoFaSetup.style.display = 'none';
        if (twoFaStatus) twoFaStatus.style.display = 'block';
        set2faEnabledState(twoFaActive);
        this.reset2faQrPlaceholder(containerEl);
      });
    }
  }

  handleExport(type) {
    console.log(`Exporting as ${type}...`);
    const exportToast = { placement: 'center' };
    this.showNotification(`Exporting data as ${type.toUpperCase()}...`, 'brown', exportToast);

    // Simulate export process
    setTimeout(() => {
      this.showNotification(`Data exported successfully as ${type.toUpperCase()}!`, 'brown', exportToast);
    }, 2000);
  }

  async loadExcelData() {
    try {
      console.log('Loading farmer data from database API...');

      // Always fetch from DB-backed API so Flask-Admin changes
      // are immediately reflected on the website.
      const response = await fetch('/api/farmer-data');
      if (!response.ok) {
        throw new Error('Failed to fetch farmer data from database');
      }
      const apiData = await response.json();
      this.data = Array.isArray(apiData) ? apiData.slice(0, this.maxFarmers) : [];
      
      this.filteredData = [...this.data];
      this.totalRecords = this.data.length;
      
      console.log('Successfully loaded farmer data:', this.data.length, 'records');
      console.log('First farmer:', this.data[0]);
      console.log('Sample of farmers:', this.data.slice(0, 3));
      
      this.updateStats();
      this.createCharts();
      this.updateTable();
      this.updateStats();
      
    } catch (error) {
      console.error('Error loading farmer data:', error);
      // Fallback to last browser backup only when API is unavailable.
      const saved = this.loadSavedFarmers();
      if (Array.isArray(saved) && saved.length) {
        this.data = saved.slice(0, this.maxFarmers);
        this.filteredData = [...this.data];
        this.totalRecords = this.data.length;
        this.updateStats();
        this.createCharts();
        this.updateTable();
        this.showNotification('Database unreachable. Loaded browser backup data.', 'error');
        return;
      }

      this.showNotification('Failed to load farmer data.', 'error');
      this.data = [];
      this.filteredData = [];
      this.totalRecords = 0;
      this.updateStats();
      this.createCharts();
      this.updateTable();
    }
  }

  loadSampleData() {
    console.log('Loading sample farmer data...');
    
    this.data = [
      {
        'NO.': 1,
        'LAST NAME': 'Montoya',
        'FIRST NAME': 'Romeo',
        'ADDRESS (BARANGAY)': 'San Jose',
        'BIRTHDAY': '1990-01-15',
        'REMARKS': 'Good yield',
        'FA OFFICER / MEMBER': 'Juan Dela Cruz',
        'REGISTERED (YES/NO)': 'Yes',
        'STATUS OF OWNERSHIP': 'A',
        'TOTAL AREA PLANTED (HA.)': 2.5,
        'LIBERICA BEARING': 150,
        'LIBERICA NON-BEARING': 50,
        'EXCELSA BEARING': 200,
        'EXCELSA NON-BEARING': 75,
        'ROBUSTA BEARING': 300,
        'ROBUSTA NON-BEARING': 100,
        'TOTAL BEARING': 650,
        'TOTAL NON-BEARING': 225,
        'TOTAL TREES': 875,
        'LIBERICA PRODUCTION': 450,
        'EXCELSA PRODUCTION': 600,
        'ROBUSTA PRODUCTION': 900,
        'NCFRS': 'NCF001'
      },
      {
        'NO.': 2,
        'LAST NAME': 'Silva',
        'FIRST NAME': 'Anghelito',
        'ADDRESS (BARANGAY)': 'San Pedro',
        'BIRTHDAY': '1985-05-20',
        'REMARKS': 'Needs fertilizer',
        'FA OFFICER / MEMBER': 'Maria Santos',
        'REGISTERED (YES/NO)': 'Yes',
        'STATUS OF OWNERSHIP': 'B',
        'TOTAL AREA PLANTED (HA.)': 1.8,
        'LIBERICA BEARING': 100,
        'LIBERICA NON-BEARING': 30,
        'EXCELSA BEARING': 150,
        'EXCELSA NON-BEARING': 50,
        'ROBUSTA BEARING': 250,
        'ROBUSTA NON-BEARING': 80,
        'TOTAL BEARING': 500,
        'TOTAL NON-BEARING': 160,
        'TOTAL TREES': 660,
        'LIBERICA PRODUCTION': 300,
        'EXCELSA PRODUCTION': 450,
        'ROBUSTA PRODUCTION': 750,
        'NCFRS': 'NCF002'
      },
      {
        'NO.': 3,
        'LAST NAME': 'Malaluan',
        'FIRST NAME': 'Avelino',
        'ADDRESS (BARANGAY)': 'San Miguel',
        'BIRTHDAY': '1978-11-10',
        'REMARKS': 'Excellent growth',
        'FA OFFICER / MEMBER': 'Carlos Reyes',
        'REGISTERED (YES/NO)': 'No',
        'STATUS OF OWNERSHIP': 'C',
        'TOTAL AREA PLANTED (HA.)': 3.2,
        'LIBERICA BEARING': 200,
        'LIBERICA NON-BEARING': 80,
        'EXCELSA BEARING': 180,
        'EXCELSA NON-BEARING': 60,
        'ROBUSTA BEARING': 350,
        'ROBUSTA NON-BEARING': 120,
        'TOTAL BEARING': 730,
        'TOTAL NON-BEARING': 260,
        'TOTAL TREES': 990,
        'LIBERICA PRODUCTION': 600,
        'EXCELSA PRODUCTION': 540,
        'ROBUSTA PRODUCTION': 1050,
        'NCFRS': 'NCF003'
      }
    ];
    
    this.filteredData = [...this.data];
    this.totalRecords = this.data.length;
    
    console.log('Sample data loaded:', this.data.length, 'records');
    
    this.updateTable();
    this.updateStats();
    this.createCharts();
  }

  updateTable() {
    this.renderTableBody();
    this.renderPagination();
    this.updateRecordInfo();
    this.updateFarmerLimitBanner();
    this.renderFarmersListCards();
    this.renderMapsModule();
    this.renderRegisterModule();
  }

  renderFarmersListCards() {
    const grid = document.getElementById('farmersCardGrid');
    if (!grid) return;

    const startIndex = (this.currentPage - 1) * this.pageSize;
    const endIndex = Math.min(startIndex + this.pageSize, this.filteredData.length);
    const pageData = this.filteredData.slice(startIndex, endIndex);

    if (!pageData.length) {
      grid.innerHTML = Array.from({ length: 6 }, (_, idx) => {
        const n = idx + 1;
        return `<article class="farmer-card farmer-card--placeholder" aria-label="Placeholder farmer card ${n}">
  <div class="farmer-card__media">
    <div class="farmer-card__avatar farmer-card__avatar--media" aria-hidden="true"><i class="fa-solid fa-user"></i></div>
  </div>
  <div class="farmer-card__top">
    <div class="farmer-card__name-row">
      <h3 class="farmer-card__name">Name</h3>
      <span class="farmer-card__badge" aria-hidden="true"><i class="fa-solid fa-check"></i></span>
    </div>
    <p class="farmer-card__bio">Coffee farmer profile preview card.</p>
  </div>
  <div class="farmer-card__body">
    <dl class="farmer-card__kv">
      <dt>No.</dt><dd>#${n}</dd>
      <dt>Birth</dt><dd>Month/Date/Year</dd>
      <dt>Phone</dt><dd>+63 900 XXXX XXXX</dd>
      <dt>Address</dt><dd>Barangay, Municipality, Province</dd>
    </dl>
    <div class="farmer-card__actions">
      <button type="button" class="farmer-card__details" data-action="open-farmer-placeholder-profile" data-farmer-no="${n}">
        <span>View Details</span>
        <i class="fa-solid fa-arrow-right"></i>
      </button>
    </div>
  </div>
</article>`;
      }).join('');
      return;
    }

    const esc = (s) =>
      String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const formatNo = (row) => Number(row?.['NO.'] ?? row?.no ?? 0) || 0;
    const buildName = (row) =>
      this.getValue(row, ['NAME OF FARMER', 'name', 'FULL NAME', 'full_name', 'Name']) ||
      [this.getValue(row, ['FIRST NAME', 'first_name', 'firstName']), this.getValue(row, ['LAST NAME', 'last_name', 'lastName'])]
        .filter(Boolean)
        .join(' ')
        .trim();

    grid.innerHTML = pageData
      .map((row) => {
        const n = formatNo(row);
        const fullName = buildName(row) || `Farmer #${n || ''}`.trim();
        const dob = this.getValue(row, ['BIRTHDAY', 'birthday', 'Date of Birth']);
        const phone = this.getValue(row, ['PHONE', 'phone', 'PHONE NO.', 'Phone No.']);
        const address = this.getValue(row, ['ADDRESS (BARANGAY)', 'barangay', 'BARANGAY', 'address']) || 'Address not set';
        const remarks = this.getValue(row, ['REMARKS', 'remarks']) || 'Coffee farmer profile.';
        const photo = this.getValue(row, ['PHOTO', 'photo', 'photo_url', 'image']);
        const mediaMarkup = photo
          ? `<img class="farmer-card__image" src="${esc(photo)}" alt="${esc(fullName)}" loading="lazy" />`
          : `<div class="farmer-card__avatar farmer-card__avatar--media" aria-hidden="true"><i class="fa-solid fa-user"></i></div>`;

        return `<article class="farmer-card" aria-label="${esc(fullName)}">
  <div class="farmer-card__media">
    ${mediaMarkup}
  </div>
  <div class="farmer-card__top">
    <div class="farmer-card__name-row">
      <h3 class="farmer-card__name">${esc(fullName)}</h3>
      <span class="farmer-card__badge" aria-hidden="true"><i class="fa-solid fa-check"></i></span>
    </div>
    <p class="farmer-card__bio">${esc(String(remarks).slice(0, 70))}</p>
  </div>
  <div class="farmer-card__body">
    <dl class="farmer-card__kv">
      <dt>No.</dt><dd>#${esc(n)}</dd>
      <dt>Birth</dt><dd>${esc(dob || '—')}</dd>
      <dt>Phone</dt><dd>${esc(phone || '—')}</dd>
      <dt>Address</dt><dd>${esc(address || '—')}</dd>
    </dl>
    <div class="farmer-card__actions">
      <button type="button" class="farmer-card__details" data-action="open-farmer-profile" data-farmer-no="${esc(n)}">
        <span>View Details</span>
        <i class="fa-solid fa-arrow-right"></i>
      </button>
    </div>
  </div>
</article>`;
      })
      .join('');
  }

  openFarmerProfile(farmerNo) {
    const profileView = document.getElementById('farmerProfileView');
    const listView = document.getElementById('farmersListView');
    if (!profileView || !listView) return;

    const farmer = (this.data || []).find((r) => Number(r['NO.']) === Number(farmerNo));
    if (!farmer) {
      this.showNotification('Farmer not found.', 'error');
      return;
    }

    const fullName =
      this.getValue(farmer, ['NAME OF FARMER', 'name', 'FULL NAME', 'full_name']) ||
      [this.getValue(farmer, ['FIRST NAME', 'first_name', 'firstName']), this.getValue(farmer, ['LAST NAME', 'last_name', 'lastName'])]
        .filter(Boolean)
        .join(' ')
        .trim() ||
      `Farmer #${farmerNo}`;

    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value || '—';
    };
    const setInput = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.value = value || '';
    };

    const nameParts = this.splitFarmerName(fullName);

    setText('farmerProfileName', fullName);
    setText('farmerProfileNo', `No. #${farmerNo}`);
    setText('farmerProfileDob', this.getValue(farmer, ['BIRTHDAY', 'birthday']) || '—');
    setText('farmerProfilePhone', this.getValue(farmer, ['PHONE', 'phone', 'PHONE NO.', 'Phone No.']) || '—');
    setText('farmerProfileAddress', this.getValue(farmer, ['ADDRESS (BARANGAY)', 'address', 'BARANGAY']) || '—');

    setInput('farmerProfileLastName', this.getValue(farmer, ['LAST NAME', 'last_name']) || nameParts.last);
    setInput('farmerProfileFirstName', this.getValue(farmer, ['FIRST NAME', 'first_name']) || nameParts.first);
    setInput('farmerProfileProvince', this.getValue(farmer, ['PROVINCE', 'province']) || '');
    setInput('farmerProfileMunicipality', this.getValue(farmer, ['MUNICIPALITY', 'municipality', 'CITY']) || '');
    setInput('farmerProfileBarangay', this.getValue(farmer, ['BARANGAY', 'ADDRESS (BARANGAY)', 'barangay']) || '');
    setInput('farmerProfileFederation', this.getValue(farmer, ['FA OFFICER / MEMBER', 'FEDERATION', 'Federation Association']) || '');
    setInput('farmerProfileRsbsa', this.getValue(farmer, ['REGISTERED (YES/NO)', 'RSBSA Registered']) || '');
    setInput('farmerProfileRsbsaNumber', this.getValue(farmer, ['NCFRS', 'RSBSA Registered Number']) || '');
    setInput('farmerProfileOwnership', this.getValue(farmer, ['STATUS OF OWNERSHIP', 'Status Ownership']) || '');
    setInput(
      'farmerProfileTotalArea',
      this.formatValue(this.getValue(farmer, ['TOTAL AREA PLANTED (HA.)', 'Total Plant Area', 'TOTAL AREA']) || '')
    );

    listView.hidden = true;
    profileView.hidden = false;
  }

  closeFarmerProfile() {
    const profileView = document.getElementById('farmerProfileView');
    const listView = document.getElementById('farmersListView');
    if (!profileView || !listView) return;
    profileView.hidden = true;
    listView.hidden = false;
  }

  openFarmerPlaceholderProfile(farmerNo = 1) {
    const profileView = document.getElementById('farmerProfileView');
    const listView = document.getElementById('farmersListView');
    if (!profileView || !listView) return;

    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value || '—';
    };
    const setInput = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.value = value || '';
    };

    setText('farmerProfileName', 'Full Name');
    setText('farmerProfileNo', `No. #${farmerNo}`);
    setText('farmerProfileDob', 'Month / Date / Year');
    setText('farmerProfilePhone', '+63 900 XXXX XXXX');
    setText('farmerProfileAddress', 'Barangay, Municipality (or City), Province');

    setInput('farmerProfileLastName', 'Last Name');
    setInput('farmerProfileFirstName', 'First Name');
    setInput('farmerProfileProvince', 'Batangas');
    setInput('farmerProfileMunicipality', 'Lipa City');
    setInput('farmerProfileBarangay', 'Barangay');
    setInput('farmerProfileFederation', 'Federation Association');
    setInput('farmerProfileRsbsa', 'Yes/No');
    setInput('farmerProfileRsbsaNumber', 'NCFRS-0000');
    setInput('farmerProfileOwnership', 'Landowner / Lease / Others');
    setInput('farmerProfileTotalArea', '0.00');

    listView.hidden = true;
    profileView.hidden = false;
  }

  /** Show full-width notice when farmer count reaches max (reference: dismissible banner). */
  updateFarmerLimitBanner() {
    const banner = document.getElementById('farmerLimitBanner');
    const textEl = document.getElementById('farmerLimitBannerText');
    if (!banner || !textEl) return;

    if (this.data.length < this.maxFarmers) {
      try {
        sessionStorage.removeItem('beanthentic_farmer_limit_banner_dismissed');
      } catch (_) {
        /* ignore */
      }
    }

    textEl.textContent = `You've reached the maximum of ${this.maxFarmers} farmers for this dashboard. Remove a row or export data before adding another.`;

    const atMax = this.data.length >= this.maxFarmers;
    let dismissed = false;
    try {
      dismissed = sessionStorage.getItem('beanthentic_farmer_limit_banner_dismissed') === '1';
    } catch (_) {
      /* ignore */
    }

    banner.hidden = !atMax || dismissed;
  }

  renderTableBody() {
    const tableBody =
      this.farmerTableView === 'trees'
        ? document.getElementById('tableBodyTrees')
        : this.farmerTableView === 'production'
          ? document.getElementById('tableBodyProduction')
          : this.farmerTableView === 'affiliation'
            ? document.getElementById('tableBodyAffiliation')
            : this.farmerTableView === 'farm'
              ? document.getElementById('tableBodyFarm')
              : document.getElementById('tableBodyBasic');
    console.log('Rendering table, total data length:', this.filteredData.length);
    
    if (!tableBody) {
      console.error('Table body not found!');
      return;
    }
    
    const startIndex = (this.currentPage - 1) * this.pageSize;
    const endIndex = Math.min(startIndex + this.pageSize, this.filteredData.length);
    const pageData = this.filteredData.slice(startIndex, endIndex);

    console.log('Page data:', pageData.length, 'records from', startIndex, 'to', endIndex);

    if (pageData.length === 0) {
      const colSpan =
        this.farmerTableView === 'trees'
          ? 13
          : this.farmerTableView === 'production'
            ? 7
            : this.farmerTableView === 'affiliation'
              ? 7
              : this.farmerTableView === 'farm'
                ? 10
                : 7;
      tableBody.innerHTML = `<tr><td colspan="${colSpan}" class="no-data">No data available.</td></tr>`;
      return;
    }

    const bodyHTML = pageData.map((row, index) => {
      const actualIndex = startIndex + index + 1;
      const rowIndexInData = this.data.indexOf(row);
      console.log('Rendering farmer', actualIndex, ':', row['NAME OF FARMER'] || 'Unknown');

      // Always display the farmer's original NO., not the filtered/paginated row index.
      // Falls back to actualIndex if the field is missing/invalid.
      const rowNo = Number.parseInt(this.getValue(row, ['NO.', 'NO', 'no.']), 10);
      const displayNo = Number.isFinite(rowNo) ? rowNo : actualIndex;

      const fullName = this.getValue(row, ['NAME OF FARMER', 'Name of Farmer', 'name']);
      const nameParts = this.splitFarmerName(fullName);

      const cells =
        this.farmerTableView === 'trees'
          ? [
              this.createInputCell(displayNo, 'number'),
              this.createInputCell(nameParts.last, 'text'),
              this.createInputCell(nameParts.first, 'text'),

              this.createInputCell(this.getValue(row, ['LIBERICA BEARING', 'Liberica_Bearing']), 'number', 'highlight-yellow'),
              this.createInputCell(this.getValue(row, ['LIBERICA NON-BEARING', 'Liberica_Non-bearing']), 'number', 'highlight-yellow'),
              this.createInputCell(this.getValue(row, ['EXCELSA BEARING', 'Excelsa_Bearing']), 'number', 'highlight-yellow'),
              this.createInputCell(this.getValue(row, ['EXCELSA NON-BEARING', 'Excelsa_Non-bearing']), 'number', 'highlight-yellow'),
              this.createInputCell(this.getValue(row, ['ROBUSTA BEARING', 'Robusta_Bearing']), 'number', 'highlight-yellow'),
              this.createInputCell(this.getValue(row, ['ROBUSTA NON-BEARING', 'Robusta_Non-bearing']), 'number', 'highlight-yellow'),

              this.createInputCell(this.getValue(row, ['TOTAL BEARING', 'Total_Bearing']), 'number', 'highlight-green'),
              this.createInputCell(this.getValue(row, ['TOTAL NON-BEARING', 'Total_Non-bearing']), 'number', 'highlight-green'),
              this.createInputCell(this.getValue(row, ['TOTAL TREES', 'TOTAL_TREES']), 'number', 'highlight-green'),
              this.createRowActionsCell(rowIndexInData)
            ]
          : this.farmerTableView === 'production'
            ? [
                this.createInputCell(displayNo, 'number'),
                this.createInputCell(nameParts.last, 'text'),
                this.createInputCell(nameParts.first, 'text'),
                this.createInputCell(this.getValue(row, ['LIBERICA PRODUCTION', 'Liberica_Production']), 'number', 'highlight-blue'),
                this.createInputCell(this.getValue(row, ['EXCELSA PRODUCTION', 'Excelsa_Production']), 'number', 'highlight-blue'),
                this.createInputCell(this.getValue(row, ['ROBUSTA PRODUCTION', 'Robusta_Production']), 'number', 'highlight-blue'),
                this.createRowActionsCell(rowIndexInData)
              ]
          : this.farmerTableView === 'affiliation'
            ? [
                this.createInputCell(displayNo, 'number'),
                this.createInputCell(nameParts.last, 'text'),
                this.createInputCell(nameParts.first, 'text'),
                this.createInputCell(this.getValue(row, ['FA OFFICER / MEMBER', 'FA Officer / member', 'officer']), 'text'),
                this.createRSBSABadge(this.getValue(row, ['RSBSA Registered (Yes/No)', 'REGISTERED (YES/NO)', 'Registered (Yes/No)', 'registered'])),
                this.createInputCell(this.getValue(row, ['NCFRS', 'ncfrs']), 'text'),
                this.createRowActionsCell(rowIndexInData)
              ]
          : this.farmerTableView === 'farm'
            ? [
                this.createInputCell(displayNo, 'number'),
                this.createInputCell(nameParts.last, 'text'),
                this.createInputCell(nameParts.first, 'text'),
                this.createOwnershipCell(this.getValue(row, ['OWNER_OPERATOR', 'Owner-Operator', 'A'])),
                this.createOwnershipCell(this.getValue(row, ['LESSOR', 'Lessor', 'B'])),
                this.createOwnershipCell(this.getValue(row, ['LESSEE', 'Lessee', 'C'])),
                this.createOwnershipCell(this.getValue(row, ['SHAREHOLDER', 'Shareholder', 'D'])),
                this.createOwnershipCell(this.getValue(row, ['OTHERS', 'Others', 'E'])),
                this.createInputCell(this.getValue(row, ['Total Area Planted (HA.)', 'TOTAL AREA PLANTED (HA.)', 'area']), 'number'),
                this.createRowActionsCell(rowIndexInData)
              ]
          : [
              this.createInputCell(displayNo, 'number'),
              this.createInputCell(nameParts.last, 'text'),
              this.createInputCell(nameParts.first, 'text'),
              this.createInputCell(this.getValue(row, ['ADDRESS (BARANGAY)', 'Address (Barangay)', 'address']), 'text'),
              this.createInputCell(this.getValue(row, ['BIRTHDAY', 'birthday']), 'text'),
              this.createEditableCell(this.getValue(row, ['REMARKS', 'remarks']), rowIndexInData, 'REMARKS', 'text'),
              this.createRowActionsCell(rowIndexInData)
            ];

      return `<tr data-row-index="${rowIndexInData}">${cells.join('')}</tr>`;
    }).join('');

    tableBody.innerHTML = bodyHTML;
    console.log('Table rendered successfully with', pageData.length, 'farmer records');
  }

  setFarmerTableView(view) {
    // Preserve scroll positions to avoid "jump to top" when sidebar is open.
    const farmersRoot = document.getElementById('farmers-module');
    const moduleContent = document.querySelector('.module-content');
    const tableWrapper = farmersRoot
      ? farmersRoot.querySelector('.table-wrapper')
      : document.querySelector('.table-wrapper');
    const prevWindowScrollY = window.scrollY;
    const prevWindowScrollX = window.scrollX;
    const prevModuleScrollTop = moduleContent ? moduleContent.scrollTop : 0;
    const prevTableScrollTop = tableWrapper ? tableWrapper.scrollTop : 0;
    const prevTableScrollLeft = tableWrapper ? tableWrapper.scrollLeft : 0;

    const key = String(view || '')
      .trim()
      .toLowerCase();
    this.farmerTableView =
      key === 'trees'
        ? 'trees'
        : key === 'production'
          ? 'production'
          : key === 'affiliation'
            ? 'affiliation'
            : key === 'farm'
              ? 'farm'
              : 'basic';

    const btns = farmersRoot
      ? farmersRoot.querySelectorAll('.view-toggle-btn[data-table-view]')
      : document.querySelectorAll('.view-toggle-btn[data-table-view]');
    btns.forEach((btn) => {
      const btnKey = btn.getAttribute('data-table-view') || 'basic';
      const active = btnKey === this.farmerTableView;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    const basicTable = document.getElementById('farmerTableBasic');
    const treesTable = document.getElementById('farmerTableTrees');
    const productionTable = document.getElementById('farmerTableProduction');
    const affiliationTable = document.getElementById('farmerTableAffiliation');
    const farmTable = document.getElementById('farmerTableFarm');

    if (basicTable && treesTable && productionTable && affiliationTable && farmTable) {
      const showBasic = this.farmerTableView === 'basic';
      const showTrees = this.farmerTableView === 'trees';
      const showProduction = this.farmerTableView === 'production';
      const showAffiliation = this.farmerTableView === 'affiliation';
      const showFarm = this.farmerTableView === 'farm';

      basicTable.classList.toggle('is-hidden', !showBasic);
      treesTable.classList.toggle('is-hidden', !showTrees);
      productionTable.classList.toggle('is-hidden', !showProduction);
      affiliationTable.classList.toggle('is-hidden', !showAffiliation);
      farmTable.classList.toggle('is-hidden', !showFarm);

      basicTable.setAttribute('aria-hidden', showBasic ? 'false' : 'true');
      treesTable.setAttribute('aria-hidden', showTrees ? 'false' : 'true');
      productionTable.setAttribute('aria-hidden', showProduction ? 'false' : 'true');
      affiliationTable.setAttribute('aria-hidden', showAffiliation ? 'false' : 'true');
      farmTable.setAttribute('aria-hidden', showFarm ? 'false' : 'true');
    }

    this.renderTableBody();

    // Restore scroll after DOM changes/rendering.
    const restore = () => {
      if (moduleContent) moduleContent.scrollTop = prevModuleScrollTop;
      if (tableWrapper) {
        tableWrapper.scrollTop = prevTableScrollTop;
        tableWrapper.scrollLeft = prevTableScrollLeft;
      }
      window.scrollTo({ top: prevWindowScrollY, left: prevWindowScrollX, behavior: 'auto' });
    };

    // Do it multiple times to account for layout reflow and table row height changes.
    requestAnimationFrame(restore);
    setTimeout(restore, 50);
    setTimeout(restore, 120);
  }

  createInputCell(value, type = 'text', highlightClass = '') {
    const formattedValue = this.formatValue(value);
    const className = highlightClass ? ` class="${highlightClass}"` : '';
    
    return `<td${className}>${formattedValue}</td>`;
  }

  createEditableCell(value, rowIndex, field, type = 'text', highlightClass = '') {
    const formattedValue = this.formatValue(value);
    const className = [highlightClass, 'cell-editable'].filter(Boolean).join(' ');
    const classAttr = className ? ` class="${className}"` : '';
    const isReadOnly = field === '__no' || field === '__totalProduction';
    const editable = isReadOnly ? 'false' : 'true';

    return `<td${classAttr} data-row-index="${rowIndex}" data-field="${field}" contenteditable="${editable}">${formattedValue}</td>`;
  }

  createRowActionsCell(rowIndex) {
    return `<td><button type="button" class="row-action-btn" data-action="delete-farmer" data-row-index="${rowIndex}">Delete</button></td>`;
  }

  createRSBSABadge(value) {
    const normalizedValue = String(value).toLowerCase().trim();
    const isYes = normalizedValue === 'yes' || normalizedValue === 'y';
    
    if (isYes) {
      return `<td><span class="rsbsa-badge rsbsa-yes">YES</span></td>`;
    } else if (normalizedValue === 'no' || normalizedValue === 'n') {
      return `<td><span class="rsbsa-badge rsbsa-no">NO</span></td>`;
    } else {
      return `<td></td>`;
    }
  }

  createOwnershipCell(value) {
    const hasValue = value && String(value).trim() !== '';
    
    if (hasValue) {
      return `<td class="ownership-cell">X</td>`;
    } else {
      return `<td class="ownership-cell"></td>`;
    }
  }

  getTotalProduction(row) {
    const lib = Number(this.getValue(row, ['LIBERICA PRODUCTION', 'Liberica_Production']) || 0) || 0;
    const exc = Number(this.getValue(row, ['EXCELSA PRODUCTION', 'Excelsa_Production']) || 0) || 0;
    const rob = Number(this.getValue(row, ['ROBUSTA PRODUCTION', 'Robusta_Production']) || 0) || 0;
    return lib + exc + rob;
  }

  updateFarmerField(rowIndex, field, rawValue) {
    const row = this.data[rowIndex];
    if (!row) return;
    if (field === '__no' || field === '__totalProduction') return;

    const numericFields = new Set([
      'Total Area Planted (HA.)',
      'TOTAL AREA PLANTED (HA.)',
      'LIBERICA BEARING',
      'LIBERICA NON-BEARING',
      'EXCELSA BEARING',
      'EXCELSA NON-BEARING',
      'ROBUSTA BEARING',
      'ROBUSTA NON-BEARING',
      'TOTAL BEARING',
      'TOTAL NON-BEARING',
      'TOTAL TREES',
      'LIBERICA PRODUCTION',
      'EXCELSA PRODUCTION',
      'ROBUSTA PRODUCTION'
    ]);

    if (numericFields.has(field)) {
      const cleaned = rawValue.replace(/,/g, '');
      const n = Number(cleaned);
      row[field] = Number.isFinite(n) ? n : 0;
    } else {
      row[field] = rawValue;
    }

    // Refresh computed cells when needed
    if (this.farmerTableView === 'production') {
      this.renderTableBody();
    }
  }

  addFarmer() {
    if (this.data.length >= this.maxFarmers) {
      this.showNotification(
        `Maximum of ${this.maxFarmers} farmers reached. Remove a row or export data before adding another.`,
        'primary',
        { placement: 'center' }
      );
      return;
    }
    const newRow = {
      'NAME OF FARMER': '',
      'ADDRESS (BARANGAY)': '',
      'FA OFFICER / MEMBER': '',
      'BIRTHDAY': '',
      'RSBSA Registered (Yes/No)': '',
      'STATUS OF OWNERSHIP': '',
      'Total Area Planted (HA.)': 0,
      'LIBERICA BEARING': 0,
      'LIBERICA NON-BEARING': 0,
      'EXCELSA BEARING': 0,
      'EXCELSA NON-BEARING': 0,
      'ROBUSTA BEARING': 0,
      'ROBUSTA NON-BEARING': 0,
      'TOTAL BEARING': 0,
      'TOTAL NON-BEARING': 0,
      'TOTAL TREES': 0,
      'LIBERICA PRODUCTION': 0,
      'EXCELSA PRODUCTION': 0,
      'ROBUSTA PRODUCTION': 0,
      'NCFRS': '',
      'REMARKS': ''
    };

    this.data.push(newRow);
    this.filteredData = [...this.data];
    this.totalRecords = this.data.length;
    this.currentPage = Math.max(1, Math.ceil(this.filteredData.length / this.pageSize));
    this.updateTable();
    this.updateStats();
  }

  deleteFarmer(rowIndex) {
    if (!this.data[rowIndex]) return;
    this.data.splice(rowIndex, 1);
    this.filteredData = [...this.data];
    this.totalRecords = this.data.length;

    const totalPages = Math.max(1, Math.ceil(this.filteredData.length / this.pageSize));
    this.currentPage = Math.min(this.currentPage, totalPages);
    this.updateTable();
    this.updateStats();
  }

  saveFarmers() {
    try {
      localStorage.setItem('beanthentic_farmers', JSON.stringify(this.data));
      this.showNotification('Farmer records saved to this browser backup only.', 'success');
    } catch (e) {
      console.error('Failed saving farmers:', e);
      this.showNotification('Failed to save farmer records.', 'error');
    }
  }

  loadSavedFarmers() {
    try {
      const raw = localStorage.getItem('beanthentic_farmers');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  getValue(row, possibleKeys) {
    for (const key of possibleKeys) {
      if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
        return row[key];
      }
    }
    return '';
  }

  splitFarmerName(fullName) {
    const raw = (fullName ?? '').toString().trim().replace(/\s+/g, ' ');
    if (!raw) return { first: '', last: '' };

    const parts = raw.split(' ');
    const first = parts.shift() || '';
    const last = parts.join(' ');
    return { first, last };
  }

  formatValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') {
      return value.toLocaleString();
    }
    return value.toString();
  }

  filterData(searchTerm) {
    const term = (searchTerm ?? '').toString().trim().toLowerCase();

    if (!term) {
      this.filteredData = [...this.data];
    } else {
      const numericCandidate = term.replace(/^(no\.?|#)\s*/i, '');
      const isWholeNumber = /^\d+$/.test(numericCandidate);
      const isLettersOnly = /^[a-z]+$/i.test(term);

      if (isWholeNumber) {
        // Exact match for the "NO." column only (prevents matching dates/other fields).
        const n = Number.parseInt(numericCandidate, 10);
        this.filteredData = this.data.filter(row => Number(row['NO.']) === n);
      } else if (isLettersOnly) {
        // If the term matches farmer "LAST NAME" prefixes, show only those results.
        // Otherwise, fall back to a general "includes" search across all fields.
        const matchesByLastNamePrefix = this.data.filter(row => {
          const { last } = this.splitFarmerName(row['NAME OF FARMER'] ?? '');
          return last.toLowerCase().startsWith(term);
        });

        if (matchesByLastNamePrefix.length > 0) {
          this.filteredData = matchesByLastNamePrefix;
        } else {
          this.filteredData = this.data.filter(row =>
            Object.values(row).some(value => (
              value && value.toString().toLowerCase().includes(term)
            ))
          );
        }
      } else {
        // Fallback: name prefix match first, then a general "includes" search across all fields.
        this.filteredData = this.data.filter(row => {
          const { first, last } = this.splitFarmerName(row['NAME OF FARMER'] ?? '');
          if (first.toLowerCase().startsWith(term) || last.toLowerCase().startsWith(term)) return true;

          return Object.values(row).some(value => (
            value && value.toString().toLowerCase().includes(term)
          ));
        });
      }
    }
    
    this.currentPage = 1;
    this.updateTable();
    this.updateStats();
  }

  addNewRow() {
    const newRow = {
      'NO.': this.data.length + 1,
      'NAME OF FARMER': '',
      'ADDRESS (BARANGAY)': '',
      'FA OFFICER / MEMBER': '',
      'BIRTHDAY': '',
      'REGISTERED (YES/NO)': '',
      'STATUS OF OWNERSHIP': '',
      'TOTAL AREA PLANTED (HA.)': '',
      'LIBERICA BEARING': '',
      'LIBERICA NON-BEARING': '',
      'EXCELSA BEARING': '',
      'EXCELSA NON-BEARING': '',
      'ROBUSTA BEARING': '',
      'ROBUSTA NON-BEARING': '',
      'TOTAL BEARING': 0,
      'TOTAL NON-BEARING': 0,
      'TOTAL TREES': 0,
      'LIBERICA PRODUCTION': '',
      'EXCELSA PRODUCTION': '',
      'ROBUSTA PRODUCTION': '',
      'NCFRS': '',
      'REMARKS': ''
    };
    
    this.data.push(newRow);
    this.filteredData = [...this.data];
    this.totalRecords = this.data.length;
    
    this.currentPage = Math.ceil(this.totalRecords / this.pageSize);
    this.updateTable();
    this.updateStats();
    
    this.showNotification('New farmer row added!', 'success');
  }

  exportData() {
    console.log('Exporting data...');
    this.showNotification('Data exported successfully!', 'brown', { placement: 'center' });
  }

  renderPagination() {
    const pagination = document.getElementById('pagination');
    const listPagination = document.getElementById('farmersListPagination');
    const totalPages = Math.ceil(this.filteredData.length / this.pageSize);
    
    if (totalPages <= 1) {
      if (pagination) {
        pagination.innerHTML = '';
        pagination.setAttribute('hidden', 'hidden');
      }
      if (listPagination) {
        listPagination.innerHTML = '';
        listPagination.setAttribute('hidden', 'hidden');
      }
      return;
    }

    let paginationHTML = '';
    
    // Previous button (icon)
    paginationHTML += `
      <button class="page-btn page-btn--icon" ${this.currentPage === 1 ? 'disabled' : ''} 
        onclick="window.dashboardApp.goToPage(${this.currentPage - 1})"
        aria-label="Previous page">
        <i class="fa-solid fa-chevron-left" aria-hidden="true"></i>
      </button>
    `;

    // Page numbers
    const maxVisiblePages = 5;
    let startPage = Math.max(1, this.currentPage - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
    
    if (endPage - startPage < maxVisiblePages - 1) {
      startPage = Math.max(1, endPage - maxVisiblePages + 1);
    }

    for (let i = startPage; i <= endPage; i++) {
      paginationHTML += `
        <button class="page-btn ${i === this.currentPage ? 'active' : ''}" 
          onclick="window.dashboardApp.goToPage(${i})"
          aria-label="Page ${i}">
          ${i}
        </button>
      `;
    }

    // Next button (icon)
    paginationHTML += `
      <button class="page-btn page-btn--icon" ${this.currentPage === totalPages ? 'disabled' : ''} 
        onclick="window.dashboardApp.goToPage(${this.currentPage + 1})"
        aria-label="Next page">
        <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
      </button>
    `;

    if (pagination) {
      pagination.innerHTML = paginationHTML;
      pagination.removeAttribute('hidden');
    }
    if (listPagination) {
      listPagination.innerHTML = paginationHTML;
      listPagination.removeAttribute('hidden');
    }
  }

  goToPage(page) {
    const totalPages = Math.ceil(this.filteredData.length / this.pageSize);
    if (page >= 1 && page <= totalPages) {
      this.currentPage = page;
      this.updateTable();
      this.updateStats();
    }
  }

  updateRecordInfo() {
    const recordInfo = document.getElementById('recordInfo');
    const startIndex = (this.currentPage - 1) * this.pageSize + 1;
    const endIndex = Math.min(this.currentPage * this.pageSize, this.filteredData.length);
    const listRecordInfo = document.getElementById('farmersListRecordInfo');
    const text = `Showing ${startIndex}-${endIndex} of ${this.filteredData.length} records`;

    if (recordInfo) recordInfo.textContent = text;
    if (listRecordInfo) listRecordInfo.textContent = text;
  }

  updateStats() {
    // Calculate statistics
    const totalFarmers = this.data.length;
    const totalTrees = this.data.reduce((sum, farmer) => sum + (farmer['TOTAL TREES'] || 0), 0);
    const totalArea = this.data.reduce((sum, farmer) => {
      const area = Number(
        farmer['Total Area Planted (HA.)'] ?? farmer['TOTAL AREA PLANTED (HA.)'] ?? 0
      );
      return sum + (Number.isFinite(area) ? area : 0);
    }, 0);
    const totalProduction = this.data.reduce((sum, farmer) => 
      sum + (farmer['LIBERICA PRODUCTION'] || 0) + (farmer['EXCELSA PRODUCTION'] || 0) + (farmer['ROBUSTA PRODUCTION'] || 0), 0
    );

    // Update stat cards
    document.getElementById('totalFarmers').textContent = totalFarmers.toLocaleString();
    document.getElementById('totalTrees').textContent = totalTrees.toLocaleString();
    document.getElementById('totalArea').textContent = totalArea.toFixed(2);
    document.getElementById('totalProduction').textContent = totalProduction.toLocaleString();

    console.log('Stats updated:', { totalFarmers, totalTrees, totalArea, totalProduction });
    this.renderAnalyticsModule();
  }

  createCharts() {
    if (!window.Chart) return;
    this.createTreeDistributionChart();
    this.createProductionChart();
  }

  createTreeDistributionChart() {
    const ctx = document.getElementById('treeChart').getContext('2d');
    
    // Calculate tree distribution
    const libericaTrees = this.data.reduce((sum, farmer) => sum + (farmer['LIBERICA BEARING'] || 0) + (farmer['LIBERICA NON-BEARING'] || 0), 0);
    const excelsaTrees = this.data.reduce((sum, farmer) => sum + (farmer['EXCELSA BEARING'] || 0) + (farmer['EXCELSA NON-BEARING'] || 0), 0);
    const robustaTrees = this.data.reduce((sum, farmer) => sum + (farmer['ROBUSTA BEARING'] || 0) + (farmer['ROBUSTA NON-BEARING'] || 0), 0);

    // Destroy existing chart if it exists
    if (this.charts.treeChart) {
      this.charts.treeChart.destroy();
    }

    this.charts.treeChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Liberica', 'Excelsa', 'Robusta'],
        datasets: [{
          data: [libericaTrees, excelsaTrees, robustaTrees],
          backgroundColor: [
            'rgba(139, 74, 43, 0.8)',
            'rgba(62, 166, 66, 0.8)',
            'rgba(255, 193, 7, 0.8)'
          ],
          borderColor: [
            'rgba(139, 74, 43, 1)',
            'rgba(62, 166, 66, 1)',
            'rgba(255, 193, 7, 1)'
          ],
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              padding: 20,
              font: {
                size: 12
              }
            }
          }
        }
      }
    });
  }

  createProductionChart() {
    const ctx = document.getElementById('productionChart').getContext('2d');
    
    // Calculate production by type
    const libericaProduction = this.data.reduce((sum, farmer) => sum + (farmer['LIBERICA PRODUCTION'] || 0), 0);
    const excelsaProduction = this.data.reduce((sum, farmer) => sum + (farmer['EXCELSA PRODUCTION'] || 0), 0);
    const robustaProduction = this.data.reduce((sum, farmer) => sum + (farmer['ROBUSTA PRODUCTION'] || 0), 0);

    // Destroy existing chart if it exists
    if (this.charts.productionChart) {
      this.charts.productionChart.destroy();
    }

    this.charts.productionChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['Liberica', 'Excelsa', 'Robusta'],
        datasets: [{
          label: 'Production (kilos)',
          data: [libericaProduction, excelsaProduction, robustaProduction],
          backgroundColor: [
            'rgba(139, 74, 43, 0.8)',
            'rgba(62, 166, 66, 0.8)',
            'rgba(255, 193, 7, 0.8)'
          ],
          borderColor: [
            'rgba(139, 74, 43, 1)',
            'rgba(62, 166, 66, 1)',
            'rgba(255, 193, 7, 1)'
          ],
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: function(value) {
                return value.toLocaleString() + ' kg';
              }
            }
          }
        }
      }
    });
  }

  num(row, keys) {
    const raw = this.getValue(row, keys);
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  yesNo(row, keys) {
    const raw = (this.getValue(row, keys) || '').toString().trim().toLowerCase();
    if (['yes', 'y', 'true', '1'].includes(raw)) return true;
    if (['no', 'n', 'false', '0'].includes(raw)) return false;
    return null;
  }

  computeGiAnalytics() {
    const byBarangay = new Map();
    const failCounts = new Map([
      ['Tree Count (< 500 trees)', 0],
      ['RSBSA Registration', 0],
      ['Traditional Method (from remarks)', 0],
      ['Soil Type info in remarks', 0],
      ['NCFRS / Traceability ID', 0],
    ]);

    const varietyTotals = {
      Liberica: 0,
      Robusta: 0,
      Excelsa: 0,
    };

    let eligible = 0;
    let notEligible = 0;
    let qrGenerated = 0;
    let verified = 0;
    let pending = 0;
    let topBarangayName = '-';
    let topBarangayCount = 0;

    const rows = Array.isArray(this.data) ? this.data : [];
    const eligibilityByIndex = [];
    rows.forEach((farmer, idx) => {
      const barangay = (this.getValue(farmer, ['ADDRESS (BARANGAY)', 'Address (Barangay)', 'address']) || 'Unknown')
        .toString()
        .trim();
      const rsbsa = this.yesNo(farmer, [
        'RSBSA Registered (Yes/No)',
        'REGISTERED (YES/NO)',
        'Registered (Yes/No)',
        'registered',
      ]);
      const totalTrees =
        this.num(farmer, ['TOTAL TREES', 'TOTAL_TREES']) ||
        (this.num(farmer, ['TOTAL BEARING', 'Total_Bearing']) +
          this.num(farmer, ['TOTAL NON-BEARING', 'Total_Non-bearing']));
      const remarks = (this.getValue(farmer, ['REMARKS', 'remarks']) || '').toString().toLowerCase();
      const ncfrs = (this.getValue(farmer, ['NCFRS', 'ncfrs']) || '').toString().trim();

      const libTrees =
        this.num(farmer, ['LIBERICA BEARING', 'Liberica_Bearing']) +
        this.num(farmer, ['LIBERICA NON-BEARING', 'Liberica_Non-bearing']);
      const robTrees =
        this.num(farmer, ['ROBUSTA BEARING', 'Robusta_Bearing']) +
        this.num(farmer, ['ROBUSTA NON-BEARING', 'Robusta_Non-bearing']);
      const excTrees =
        this.num(farmer, ['EXCELSA BEARING', 'Excelsa_Bearing']) +
        this.num(farmer, ['EXCELSA NON-BEARING', 'Excelsa_Non-bearing']);

      varietyTotals.Liberica += libTrees;
      varietyTotals.Robusta += robTrees;
      varietyTotals.Excelsa += excTrees;

      const hasTraditionalHint =
        /traditional|organic|heritage|manual|handpicked|intercrop/.test(remarks);
      const hasSoilHint = /soil|loam|clay|volcanic|pH/.test(remarks);

      const checks = {
        treeCount: totalTrees >= 500,
        rsbsa: rsbsa === true,
        traditional: hasTraditionalHint,
        soil: hasSoilHint,
        ncfrs: !!ncfrs,
      };

      const isEligible = Object.values(checks).every(Boolean);
      eligibilityByIndex.push(isEligible);
      if (isEligible) {
        eligible += 1;
      } else {
        notEligible += 1;
        if (!checks.treeCount) failCounts.set('Tree Count (< 500 trees)', failCounts.get('Tree Count (< 500 trees)') + 1);
        if (!checks.rsbsa) failCounts.set('RSBSA Registration', failCounts.get('RSBSA Registration') + 1);
        if (!checks.traditional) failCounts.set('Traditional Method (from remarks)', failCounts.get('Traditional Method (from remarks)') + 1);
        if (!checks.soil) failCounts.set('Soil Type info in remarks', failCounts.get('Soil Type info in remarks') + 1);
        if (!checks.ncfrs) failCounts.set('NCFRS / Traceability ID', failCounts.get('NCFRS / Traceability ID') + 1);
      }

      if (ncfrs) qrGenerated += 1;
      if (ncfrs && rsbsa === true) verified += 1;
      else pending += 1;
      byBarangay.set(barangay, (byBarangay.get(barangay) || 0) + 1);
    });

    for (const [name, count] of byBarangay.entries()) {
      if (count > topBarangayCount) {
        topBarangayCount = count;
        topBarangayName = name;
      }
    }

    const trendWindow = 6;
    const bucketSize = Math.max(1, Math.ceil(rows.length / trendWindow));
    const trendLabels = [];
    const trendValues = [];
    const now = new Date();
    let cumulativeReady = 0;
    for (let i = 0; i < rows.length; i++) {
      if (eligibilityByIndex[i]) cumulativeReady += 1;
      const bucketEnd = i === rows.length - 1 || (i + 1) % bucketSize === 0;
      if (bucketEnd) {
        const step = trendValues.length;
        const d = new Date(now.getFullYear(), now.getMonth() - (trendWindow - 1 - step), 1);
        trendLabels.push(
          d.toLocaleString(undefined, { month: 'short', year: '2-digit' })
        );
        trendValues.push(cumulativeReady);
      }
    }

    return {
      total: rows.length,
      eligible,
      notEligible,
      qrGenerated,
      verified,
      pending,
      byBarangay,
      topBarangayName,
      topBarangayCount,
      trendLabels,
      trendValues,
      failCounts,
      varietyTotals,
    };
  }

  setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  renderAnalyticsModule() {
    const analyticsRoot = document.getElementById('analytics-module');
    if (!analyticsRoot || analyticsRoot.classList.contains('hidden')) return;
    if (!window.Chart) return;

    const metrics = this.computeGiAnalytics();
    const total = Math.max(metrics.total, 1);
    const eligibleRate = (metrics.eligible / total) * 100;

    this.setText('giEligibleCount', metrics.eligible.toLocaleString());
    this.setText('giEligibleRate', `${eligibleRate.toFixed(1)}% of farmers`);
    this.setText('cityGiReadinessRate', `${eligibleRate.toFixed(1)}%`);
    this.setText('qrGeneratedCount', metrics.qrGenerated.toLocaleString());
    this.setText('verifiedProfilesCount', metrics.verified.toLocaleString());
    this.setText('pendingProfilesCount', `${metrics.pending.toLocaleString()} pending`);

    this.renderTopBarangaysChart(metrics);
    this.renderCoffeeVarietyChart(metrics);
    this.renderGiGrowthTrendChart(metrics);
    this.renderVerificationStatusChart(metrics);
  }

  renderIpophlModule() {
    const ipophlRoot = document.getElementById('ipophl-module');
    if (!ipophlRoot || ipophlRoot.classList.contains('hidden')) return;
    
    // Initialize IPOPHL module functionality
    this.initializePhaseNavigation();
    this.initializePhaseButtons();
    this.initializeFileUpload();
    this.initializeLinkInputs();
    this.initializeProgressSteps();
    
    // Load and display submission status
    this.loadSubmissionStatus();
    this.updateSubmissionStatus();
    this.updateGiProcessIndicator();
  }

  initializePhaseNavigation() {
    // Initialize current phase
    if (!this.currentPhase) this.currentPhase = 1;
    
    // Show initial phase
    this.showPhase(this.currentPhase);
  }

  initializeProgressSteps() {
    const progressSteps = document.querySelectorAll('.progress-step');
    
    progressSteps.forEach(step => {
      step.addEventListener('click', (e) => {
        const phaseNum = parseInt(e.currentTarget.dataset.phase);
        this.navigateToPhase(phaseNum);
      });
    });
  }

  initializePhaseButtons() {
    // Phase navigation buttons
    const nextPhaseBtns = document.querySelectorAll('.next-phase');
    const prevPhaseBtns = document.querySelectorAll('.prev-phase');
    const completeBtn = document.querySelector('.complete-btn');
    
    nextPhaseBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const nextPhase = parseInt(e.target.dataset.next);
        this.navigateToPhase(nextPhase);
      });
    });
    
    prevPhaseBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const prevPhase = parseInt(e.target.dataset.prev);
        this.navigateToPhase(prevPhase);
      });
    });
    
    if (completeBtn) {
      completeBtn.addEventListener('click', () => {
        this.completeRegistration();
      });
    }
  }

  navigateToPhase(phaseNum) {
    // Validate phase transition
    if (phaseNum < 1 || phaseNum > 5) return;
    
    // Allow free navigation between phases without validation
    this.currentPhase = phaseNum;
    this.showPhase(phaseNum);
    this.updateProgress(phaseNum);
    this.updateGiProcessIndicator();
  }

  showPhase(phaseNum) {
    // Hide all phases
    const allPhases = document.querySelectorAll('.phase-section');
    allPhases.forEach(phase => {
      phase.classList.remove('active');
    });
    
    // Show selected phase
    const targetPhase = document.getElementById(`phase-${phaseNum}`);
    if (targetPhase) {
      targetPhase.classList.add('active');
    }
  }

  updateProgress(phaseNum) {
    const progressSteps = document.querySelectorAll('.progress-step');
    
    progressSteps.forEach((step, index) => {
      const stepNum = index + 1;
      step.classList.remove('active', 'completed');
      
      if (stepNum === phaseNum) {
        step.classList.add('active');
      } else if (stepNum < phaseNum) {
        step.classList.add('completed');
      }
    });
  }

  validatePhaseCompletion(phaseNum) {
    // Check if all required tasks in the phase have attachments
    const phaseSection = document.getElementById(`phase-${phaseNum}`);
    if (!phaseSection) return false;
    
    const uploadZones = phaseSection.querySelectorAll('.file-upload-zone');
    let hasAttachments = false;
    
    uploadZones.forEach(zone => {
      const service = zone.dataset.service;
      if (this.ipophlFiles && this.ipophlFiles[service] && this.ipophlFiles[service].length > 0) {
        hasAttachments = true;
      }
    });
    
    return hasAttachments;
  }

  completeRegistration() {
    // Collect all phase data (no validation required since users can navigate freely)
    const allAttachments = this.collectAllPhaseData();
    
    // Check if there's any data at all
    const hasAnyData = Object.values(allAttachments).some(phase => 
      (phase.files && phase.files.length > 0) || (phase.links && phase.links.length > 0)
    );
    
    if (!hasAnyData) {
      this.showIpophlNotification('Please upload at least one file or add one link before completing registration.');
      return;
    }
    
    // Send email with registration data
    this.sendRegistrationEmail(allAttachments);
    
    this.showIpophlNotification('GI Registration completed! Email sent to IPOPHL.');
    
    console.log('Completed GI Registration:', {
      phases: allAttachments,
      completedAt: new Date().toISOString()
    });
  }

  sendRegistrationEmail(registrationData) {
    try {
      // Create email content
      const emailContent = this.createEmailContent(registrationData);
      
      // Create Gmail web interface link with correct IPOPHL addresses
      const subject = encodeURIComponent('GI Registration Application - Lipa City Products');
      const body = encodeURIComponent(emailContent);
      const to = encodeURIComponent('copyright@ipophl.gov.ph,csd@ipophl.gov.ph');
      
      // Redirect to Gmail web interface
      const gmailLink = `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${subject}&body=${body}`;
      
      // Open Gmail in new tab
      window.open(gmailLink, '_blank');
      
      this.showIpophlNotification('Opening Gmail to send registration to IPOPHL...');
    } catch (error) {
      console.error('Error opening Gmail:', error);
      this.showIpophlNotification('Failed to open Gmail. Please try again.');
    }
  }

  createEmailContent(registrationData) {
    let content = `GEographical Indication Registration Application\n`;
    content += `=========================================\n\n`;
    content += `Date: ${new Date().toLocaleDateString()}\n`;
    content += `Applicant: ${this.getCurrentUserIdentifier() || 'Not specified'}\n\n`;
    
    // Add phase summaries
    for (let i = 1; i <= 5; i++) {
      const phaseKey = `phase${i}`;
      const phase = registrationData[phaseKey];
      
      content += `PHASE ${i}: ${this.getPhaseTitle(i)}\n`;
      content += `${'='.repeat(40)}\n`;
      
      if (phase && phase.files && phase.files.length > 0) {
        content += `Files Attached (${phase.files.length}):\n`;
        phase.files.forEach(file => {
          content += `- ${file.name} (${this.formatFileSize(file.size)})\n`;
        });
      }
      
      if (phase && phase.links && phase.links.length > 0) {
        content += `\nLinks Provided (${phase.links.length}):\n`;
        phase.links.forEach(link => {
          content += `- ${link.url}\n`;
        });
      }
      
      content += '\n';
    }
    
    content += `\nAdditional Notes:\n`;
    content += `- This is an automated submission from the Beanthentic GI Registration System\n`;
    content += `- All required documentation has been prepared according to IPOPHL guidelines\n`;
    content += `- Please review and process this application accordingly\n\n`;
    
    return content;
  }

  getPhaseTitle(phaseNum) {
    const titles = {
      1: 'Pre-Application Groundwork',
      2: 'Preparing Application Documents', 
      3: 'Filing with IPOPHL',
      4: 'Examination and Publication',
      5: 'Registration and Ongoing Compliance'
    };
    return titles[phaseNum] || `Phase ${phaseNum}`;
  }

  getCurrentUserIdentifier() {
    // Try to get user phone from session or dashboard
    return session?.user_phone || null;
  }

  collectAllPhaseData() {
    const phases = {};
    
    for (let i = 1; i <= 5; i++) {
      phases[`phase${i}`] = {
        files: [],
        links: []
      };
      
      // Collect files for this phase
      const phaseSection = document.getElementById(`phase-${i}`);
      if (phaseSection) {
        const uploadZones = phaseSection.querySelectorAll('.file-upload-zone');
        uploadZones.forEach(zone => {
          const service = zone.dataset.service;
          if (this.ipophlFiles && this.ipophlFiles[service]) {
            phases[`phase${i}`].files.push(...this.ipophlFiles[service]);
          }
          if (this.ipophlLinks && this.ipophlLinks[service]) {
            phases[`phase${i}`].links.push(...this.ipophlLinks[service]);
          }
        });
      }
    }
    
    return phases;
  }

  initializeFileUpload() {
    const uploadZones = document.querySelectorAll('.file-upload-zone');
    
    uploadZones.forEach(zone => {
      const fileInput = zone.querySelector('.file-input');
      const service = zone.dataset.service;
      
      // Click to upload
      zone.addEventListener('click', (e) => {
        if (e.target !== fileInput) {
          fileInput.click();
        }
      });
      
      // File selection
      fileInput.addEventListener('change', (e) => {
        this.handleFileUpload(e.target.files, service);
      });
      
      // Drag and drop
      zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('drag-over');
      });
      
      zone.addEventListener('dragleave', () => {
        zone.classList.remove('drag-over');
      });
      
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        this.handleFileUpload(e.dataTransfer.files, service);
      });
    });
  }

  initializeLinkInputs() {
    const addLinkBtns = document.querySelectorAll('.add-link-btn');
    
    addLinkBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const service = e.target.dataset.service;
        const input = e.target.previousElementSibling;
        const url = input.value.trim();
        
        if (url && this.isValidUrl(url)) {
          this.addLink(service, url);
          input.value = '';
        } else {
          this.showIpophlNotification('Please enter a valid URL.');
        }
      });
    });
    
    // Enter key support for link inputs
    const linkInputs = document.querySelectorAll('.link-input');
    linkInputs.forEach(input => {
      input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          const btn = input.nextElementSibling;
          btn.click();
        }
      });
    });
  }

  handleFileUpload(files, service) {
    const filesContainer = document.getElementById(`${service}-files`);
    
    Array.from(files).forEach(file => {
      if (this.isValidFileType(file)) {
        // Check for duplicates
        if (!this.isFileAlreadyUploaded(service, file)) {
          this.addFileToList(service, file);
        } else {
          this.showIpophlNotification(`File "${file.name}" is already uploaded.`);
        }
      } else {
        this.showIpophlNotification(`Invalid file type: ${file.name}`);
      }
    });
  }

  isFileAlreadyUploaded(service, file) {
    if (!this.ipophlFiles || !this.ipophlFiles[service]) {
      return false;
    }
    
    // Check for duplicate by name and size
    return this.ipophlFiles[service].some(existingFile => 
      existingFile.name === file.name && existingFile.size === file.size
    );
  }

  addFileToList(service, file) {
    const filesContainer = document.getElementById(`${service}-files`);
    const fileId = `${service}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const fileItem = document.createElement('div');
    fileItem.className = 'file-item';
    fileItem.dataset.fileId = fileId;
    
    const fileIcon = this.getFileIcon(file.name);
    const fileSize = this.formatFileSize(file.size);
    
    fileItem.innerHTML = `
      <div class="file-info">
        <i class="file-icon ${fileIcon}"></i>
        <span class="file-name">${file.name}</span>
        <span class="file-size">${fileSize}</span>
      </div>
      <div class="file-actions">
        <button class="file-action-btn preview" title="Preview">
          <i class="fa-solid fa-eye"></i>
        </button>
        <button class="file-action-btn delete" title="Delete">
          <i class="fa-solid fa-times"></i>
        </button>
      </div>
    `;
    
    filesContainer.appendChild(fileItem);
    
    // Store file data
    if (!this.ipophlFiles) this.ipophlFiles = {};
    if (!this.ipophlFiles[service]) this.ipophlFiles[service] = [];
    
    this.ipophlFiles[service].push({
      id: fileId,
      file: file,
      name: file.name,
      size: file.size,
      type: file.type
    });
    
    // Add event listeners
    fileItem.querySelector('.preview').addEventListener('click', () => {
      this.previewFile(file);
    });
    
    fileItem.querySelector('.delete').addEventListener('click', () => {
      this.removeFile(service, fileId);
    });

    this.updateGiProcessIndicator();
  }

  addLink(service, url) {
    const filesContainer = document.getElementById(`${service}-files`);
    const linkId = `${service}-link-${Date.now()}`;
    
    const linkItem = document.createElement('div');
    linkItem.className = 'link-item';
    linkItem.dataset.linkId = linkId;
    
    linkItem.innerHTML = `
      <a href="${url}" target="_blank" class="link-url">${url}</a>
      <button class="file-action-btn delete" title="Remove">
        <i class="fa-solid fa-times"></i>
      </button>
    `;
    
    filesContainer.appendChild(linkItem);
    
    // Store link data
    if (!this.ipophlLinks) this.ipophlLinks = {};
    if (!this.ipophlLinks[service]) this.ipophlLinks[service] = [];
    
    this.ipophlLinks[service].push({
      id: linkId,
      url: url
    });
    
    // Add event listener
    linkItem.querySelector('.delete').addEventListener('click', () => {
      this.removeLink(service, linkId);
    });

    this.updateGiProcessIndicator();
  }

  removeFile(service, fileId) {
    const fileItem = document.querySelector(`[data-file-id="${fileId}"]`);
    if (fileItem) {
      fileItem.remove();
    }
    
    if (this.ipophlFiles && this.ipophlFiles[service]) {
      this.ipophlFiles[service] = this.ipophlFiles[service].filter(f => f.id !== fileId);
    }

    this.updateGiProcessIndicator();
  }

  removeLink(service, linkId) {
    const linkItem = document.querySelector(`[data-link-id="${linkId}"]`);
    if (linkItem) {
      linkItem.remove();
    }
    
    if (this.ipophlLinks && this.ipophlLinks[service]) {
      this.ipophlLinks[service] = this.ipophlLinks[service].filter(l => l.id !== linkId);
    }

    this.updateGiProcessIndicator();
  }

  getIpophlServicesByPhase() {
    return {
      1: ['phase1-product', 'phase1-entity', 'phase1-stakeholders'],
      2: ['phase2-mop', 'phase2-cert', 'phase2-details'],
      3: ['phase3-filing', 'phase3-payment'],
      4: ['phase4-exam', 'phase4-response', 'phase4-pub'],
      5: ['phase5-cert', 'phase5-compliance']
    };
  }

  getIpophlCompletionSnapshot() {
    const servicesByPhase = this.getIpophlServicesByPhase();
    const allServices = Object.values(servicesByPhase).flat();
    const completedServices = allServices.filter((service) => {
      const hasFiles = Boolean(this.ipophlFiles && this.ipophlFiles[service] && this.ipophlFiles[service].length > 0);
      const hasLinks = Boolean(this.ipophlLinks && this.ipophlLinks[service] && this.ipophlLinks[service].length > 0);
      return hasFiles || hasLinks;
    });

    const total = allServices.length;
    const completed = completedServices.length;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

    return { total, completed, percentage };
  }

  getGiAiStatusDescriptor() {
    const aiResult = this.randomForestGiResult;

    if (aiResult === true || aiResult?.status === 'pass') {
      return { label: 'AI pass', className: 'gi-status-pill--pass' };
    }
    if (aiResult === false || aiResult?.status === 'fail') {
      return { label: 'AI fail', className: 'gi-status-pill--fail' };
    }
    return { label: 'Pending AI review', className: 'gi-status-pill--pending' };
  }

  updateGiProcessIndicator() {
    const percentEl = document.getElementById('giProcessPercent');
    const metaEl = document.getElementById('giProcessMeta');
    const fillEl = document.getElementById('giProcessFill');
    const trackEl = document.getElementById('giProcessTrack');
    const aiStatusEl = document.getElementById('giAiStatus');

    if (!percentEl || !metaEl || !fillEl || !trackEl || !aiStatusEl) return;

    const snapshot = this.getIpophlCompletionSnapshot();
    percentEl.textContent = `${snapshot.percentage}%`;
    metaEl.textContent = `${snapshot.completed} of ${snapshot.total} document groups completed`;
    fillEl.style.width = `${snapshot.percentage}%`;
    trackEl.setAttribute('aria-valuenow', String(snapshot.percentage));

    const aiStatus = this.getGiAiStatusDescriptor();
    aiStatusEl.textContent = aiStatus.label;
    aiStatusEl.classList.remove('gi-status-pill--pending', 'gi-status-pill--pass', 'gi-status-pill--fail');
    aiStatusEl.classList.add(aiStatus.className);
  }

  previewFile(file) {
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (e) => {
        this.showImagePreview(e.target.result, file.name);
      };
      reader.readAsDataURL(file);
    } else {
      this.showIpophlNotification(`Preview not available for ${file.type} files`);
    }
  }

  showImagePreview(src, filename) {
    const modal = document.createElement('div');
    modal.className = 'image-preview-modal';
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.8);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2000;
      cursor: pointer;
    `;
    
    const img = document.createElement('img');
    img.src = src;
    img.style.cssText = `
      max-width: 90%;
      max-height: 90%;
      object-fit: contain;
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    `;
    
    modal.appendChild(img);
    document.body.appendChild(modal);
    
    modal.addEventListener('click', () => {
      document.body.removeChild(modal);
    });
  }

  getServiceFromCard(card) {
    const title = card.querySelector('h3').textContent.toLowerCase();
    if (title.includes('trademark')) return 'trademark';
    if (title.includes('gi') || title.includes('certification')) return 'gi';
    if (title.includes('patent')) return 'patent';
    if (title.includes('search')) return 'search';
    return 'unknown';
  }

  getAttachmentsForService(service) {
    return {
      files: this.ipophlFiles && this.ipophlFiles[service] ? this.ipophlFiles[service] : [],
      links: this.ipophlLinks && this.ipophlLinks[service] ? this.ipophlLinks[service] : []
    };
  }

  submitIpophlApplication(service, attachments) {
    const message = `Submitting ${service} application with ${attachments.files.length} file(s) and ${attachments.links.length} link(s).`;
    this.showIpophlNotification(message);
    
    // Here you would normally send the data to a server
    console.log('IPOPHL Application:', {
      service: service,
      attachments: attachments,
      timestamp: new Date().toISOString()
    });
  }

  // Utility functions
  isValidFileType(file) {
    const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 
                       'application/pdf', 'application/msword', 
                       'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                       'application/dwg', 'image/vnd.dwg'];
    return validTypes.includes(file.type) || file.name.match(/\.(jpg|jpeg|png|gif|webp|pdf|doc|docx|dwg)$/i);
  }

  isValidUrl(string) {
    try {
      new URL(string);
      return true;
    } catch (_) {
      return false;
    }
  }

  getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const iconMap = {
      'pdf': 'fa-solid fa-file-pdf',
      'doc': 'fa-solid fa-file-word',
      'docx': 'fa-solid fa-file-word',
      'jpg': 'fa-solid fa-file-image',
      'jpeg': 'fa-solid fa-file-image',
      'png': 'fa-solid fa-file-image',
      'gif': 'fa-solid fa-file-image',
      'webp': 'fa-solid fa-file-image',
      'dwg': 'fa-solid fa-file-code'
    };
    return iconMap[ext] || 'fa-solid fa-file';
  }

  formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  showIpophlNotification(message) {
    // Create a simple notification for IPOPHL actions
    const notification = document.createElement('div');
    notification.className = 'ipophl-notification';
    notification.textContent = message;
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #8B4A2B;
      color: white;
      padding: 15px 20px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 1000;
      max-width: 300px;
    `;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 3000);
  }

  renderTopBarangaysChart(metrics) {
    const canvas = document.getElementById('topBarangaysChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (this.charts.topBarangaysChart) this.charts.topBarangaysChart.destroy();
    const sorted = [...metrics.byBarangay.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    this.charts.topBarangaysChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: sorted.map(([k]) => k),
        datasets: [
          {
            label: 'Coffee farms',
            data: sorted.map(([, v]) => v),
            backgroundColor: 'rgba(139, 74, 43, 0.82)',
            borderColor: 'rgba(139, 74, 43, 1)',
            borderWidth: 1.5,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  }

  renderCoffeeDensityHeatmap(metrics) {
    const root = document.getElementById('coffeeDensityHeatmap');
    if (!root) return;
    const sorted = [...metrics.byBarangay.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    const max = Math.max(1, ...sorted.map(([, v]) => v));
    root.innerHTML = sorted
      .map(([name, count]) => {
        const intensity = count / max;
        const alpha = 0.12 + intensity * 0.58;
        return `<div class="analytics-heat-row">
          <div class="analytics-heat-label">${name}</div>
          <div class="analytics-heat-bar-wrap">
            <div class="analytics-heat-bar" style="width:${Math.max(6, Math.round(intensity * 100))}%;background:rgba(139,74,43,${alpha.toFixed(2)});"></div>
          </div>
          <div class="analytics-heat-count">${count}</div>
        </div>`;
      })
      .join('');
  }

  renderGiReadinessGaugeChart(metrics) {
    const canvas = document.getElementById('giReadinessGaugeChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (this.charts.giReadinessGaugeChart) this.charts.giReadinessGaugeChart.destroy();
    const total = Math.max(1, metrics.total);
    const rate = (metrics.eligible / total) * 100;
    this.charts.giReadinessGaugeChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['GI Ready', 'Remaining'],
        datasets: [
          {
            data: [rate, 100 - rate],
            backgroundColor: ['rgba(62, 166, 66, 0.88)', 'rgba(230, 233, 237, 1)'],
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '72%',
        rotation: -90,
        circumference: 180,
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              label: (ctxItem) => `${ctxItem.label}: ${ctxItem.parsed.toFixed(1)}%`,
            },
          },
        },
      },
    });
  }

  renderGiGrowthTrendChart(metrics) {
    const canvas = document.getElementById('giGrowthTrendChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (this.charts.giGrowthTrendChart) this.charts.giGrowthTrendChart.destroy();
    this.charts.giGrowthTrendChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: metrics.trendLabels,
        datasets: [
          {
            label: 'GI-Ready farmers',
            data: metrics.trendValues,
            borderColor: 'rgba(139, 74, 43, 1)',
            backgroundColor: 'rgba(139, 74, 43, 0.16)',
            fill: true,
            tension: 0.25,
            pointRadius: 3,
            pointHoverRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true, position: 'bottom' } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  }

  renderCoffeeVarietyChart(metrics) {
    const canvas = document.getElementById('coffeeVarietyChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (this.charts.coffeeVarietyChart) this.charts.coffeeVarietyChart.destroy();
    this.charts.coffeeVarietyChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Liberica', 'Robusta', 'Excelsa'],
        datasets: [
          {
            data: [
              metrics.varietyTotals.Liberica,
              metrics.varietyTotals.Robusta,
              metrics.varietyTotals.Excelsa,
            ],
            backgroundColor: [
              'rgba(139, 74, 43, 0.84)',
              'rgba(62, 166, 66, 0.82)',
              'rgba(255, 193, 7, 0.84)',
            ],
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '60%',
        plugins: { legend: { position: 'bottom' } },
      },
    });
  }

  renderVerificationStatusChart(metrics) {
    const canvas = document.getElementById('verificationStatusChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (this.charts.verificationStatusChart) this.charts.verificationStatusChart.destroy();
    this.charts.verificationStatusChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['Verified', 'Pending'],
        datasets: [
          {
            label: 'Profiles',
            data: [metrics.verified, metrics.pending],
            backgroundColor: ['rgba(62, 166, 66, 0.82)', 'rgba(255, 193, 7, 0.86)'],
            borderColor: ['rgba(62, 166, 66, 1)', 'rgba(255, 193, 7, 1)'],
            borderWidth: 1.5,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  }

  onGoogleMapsReady() {
    this.googleMapsReady = true;
    this.renderMapsModule();
  }

  getLipaCityCenter() {
    return { lat: 13.9411, lng: 121.1648 };
  }

  getLipaCityBounds() {
    return {
      north: 14.09,
      south: 13.82,
      west: 121.08,
      east: 121.27,
    };
  }

  getBarangayCoordinates() {
    return {
      'antipolo del norte': { lat: 13.9492, lng: 121.1642 },
      'antipolo del sur': { lat: 13.9365, lng: 121.1601 },
      balintawak: { lat: 13.9472, lng: 121.1719 },
      bulacnin: { lat: 13.9241, lng: 121.1748 },
      dagatan: { lat: 13.9618, lng: 121.1398 },
      'mataas na lupa': { lat: 13.9652, lng: 121.1825 },
      'san benito': { lat: 13.9559, lng: 121.1536 },
      'san carlos': { lat: 13.9523, lng: 121.1838 },
      'san jose': { lat: 13.9276, lng: 121.1568 },
      'san lucas': { lat: 13.9223, lng: 121.1789 },
      tibig: { lat: 13.9328, lng: 121.1447 },
      tambo: { lat: 13.9024, lng: 121.1599 },
      marauoy: { lat: 13.9138, lng: 121.1388 },
      bolbok: { lat: 13.9675, lng: 121.2064 },
      sabang: { lat: 13.9769, lng: 121.1712 },
      lodlod: { lat: 13.9271, lng: 121.1328 },
      halang: { lat: 13.9528, lng: 121.2098 },
      plaridel: { lat: 13.9714, lng: 121.1967 },
      'poblacion barangay 1': { lat: 13.9418, lng: 121.1638 },
      'poblacion barangay 2': { lat: 13.9427, lng: 121.1657 },
      'poblacion barangay 3': { lat: 13.9404, lng: 121.1617 },
      'poblacion barangay 4': { lat: 13.9395, lng: 121.1678 },
    };
  }

  normalizeBarangayName(name) {
    return (name || '').toString().trim().toLowerCase();
  }

  isVarietyMatch(row, variety) {
    if (variety === 'liberica') {
      return (
        Number(this.getValue(row, ['LIBERICA BEARING']) || 0) > 0 ||
        Number(this.getValue(row, ['LIBERICA NON-BEARING']) || 0) > 0 ||
        Number(this.getValue(row, ['LIBERICA PRODUCTION']) || 0) > 0
      );
    }
    if (variety === 'robusta') {
      return (
        Number(this.getValue(row, ['ROBUSTA BEARING']) || 0) > 0 ||
        Number(this.getValue(row, ['ROBUSTA NON-BEARING']) || 0) > 0 ||
        Number(this.getValue(row, ['ROBUSTA PRODUCTION']) || 0) > 0
      );
    }
    if (variety === 'excelsa') {
      return (
        Number(this.getValue(row, ['EXCELSA BEARING']) || 0) > 0 ||
        Number(this.getValue(row, ['EXCELSA NON-BEARING']) || 0) > 0 ||
        Number(this.getValue(row, ['EXCELSA PRODUCTION']) || 0) > 0
      );
    }
    return true;
  }

  getFilteredMapRows() {
    return (this.data || []).filter((row) => {
      const barangay = this.normalizeBarangayName(
        this.getValue(row, ['ADDRESS (BARANGAY)', 'BARANGAY', 'barangay', 'address'])
      );
      const searchOk = !this.mapSearchTerm || barangay.includes(this.mapSearchTerm);
      const varietyOk = this.isVarietyMatch(row, this.mapVarietyFilter || 'liberica');
      return searchOk && varietyOk;
    });
  }

  buildMapBarangayPoints(rows) {
    const coordsByBarangay = this.getBarangayCoordinates();
    const bounds = this.getLipaCityBounds();
    const center = this.getLipaCityCenter();
    const pointsMap = new Map();

    const toFallbackCoordinate = (name) => {
      let hash = 0;
      for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
      const lat = bounds.south + ((hash % 1000) / 1000) * (bounds.north - bounds.south);
      const lng = bounds.west + ((((hash >> 10) % 1000) / 1000) * (bounds.east - bounds.west));
      return { lat: Number.isFinite(lat) ? lat : center.lat, lng: Number.isFinite(lng) ? lng : center.lng };
    };

    rows.forEach((row) => {
      const raw = this.getValue(row, ['ADDRESS (BARANGAY)', 'BARANGAY', 'barangay', 'address']) || 'Unknown';
      const key = this.normalizeBarangayName(raw);
      const coords = coordsByBarangay[key] || toFallbackCoordinate(key || 'unknown');
      const current = pointsMap.get(key) || { barangay: raw, lat: coords.lat, lng: coords.lng, count: 0 };
      current.count += 1;
      pointsMap.set(key, current);
    });

    return Array.from(pointsMap.values());
  }

  densityTier(count) {
    if (count >= 150) return 'high';
    if (count >= 100) return 'medium';
    if (count >= 50) return 'low';
    return 'very-low';
  }

  markerColorForDensity(tier) {
    if (tier === 'high') return '#784421';
    if (tier === 'medium') return '#2f855a';
    if (tier === 'low') return '#9c7a54';
    return '#b0895f';
  }

  ensureGoogleMap() {
    if (this.googleMap || !window.google?.maps) return;
    const canvas = document.getElementById('mapsGoogleCanvas');
    if (!canvas) return;
    this.googleMap = new window.google.maps.Map(canvas, {
      center: this.getLipaCityCenter(),
      zoom: 12,
      minZoom: 11,
      maxZoom: 16,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      restriction: { latLngBounds: this.getLipaCityBounds(), strictBounds: true },
    });
    this.googleInfoWindow = new window.google.maps.InfoWindow();
  }

  clearMapMarkers() {
    this.googleMapMarkers.forEach((marker) => marker.setMap(null));
    this.googleMapMarkers = [];
  }

  renderGoogleMapMarkers(points) {
    if (!this.googleMap || !window.google?.maps) return;
    this.clearMapMarkers();
    const fitBounds = new window.google.maps.LatLngBounds();

    points.forEach((point) => {
      const tier = this.densityTier(point.count);
      const marker = new window.google.maps.Marker({
        position: { lat: point.lat, lng: point.lng },
        map: this.googleMap,
        title: `${point.barangay} (${point.count})`,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: this.markerColorForDensity(tier),
          fillOpacity: 0.95,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
      });
      marker.addListener('click', () => {
        if (!this.googleInfoWindow) return;
        this.googleInfoWindow.setContent(
          `<div style="min-width:160px"><strong>${point.barangay}</strong><br/>Farmers: ${point.count}<br/>Variety: ${(
            this.mapVarietyFilter || 'liberica'
          ).toUpperCase()}</div>`
        );
        this.googleInfoWindow.open(this.googleMap, marker);
      });
      this.googleMapMarkers.push(marker);
      fitBounds.extend(marker.getPosition());
    });

    if (points.length > 1) this.googleMap.fitBounds(fitBounds, 70);
    else if (points.length === 1) {
      this.googleMap.setCenter({ lat: points[0].lat, lng: points[0].lng });
      this.googleMap.setZoom(13);
    } else {
      this.googleMap.setCenter(this.getLipaCityCenter());
      this.googleMap.setZoom(12);
    }
  }

  updateMapInsights(points, rows) {
    const covered = points.length;
    const totalArea = rows.reduce(
      (sum, row) => sum + (Number(this.getValue(row, ['Total Area Planted (HA.)', 'TOTAL AREA PLANTED (HA.)']) || 0) || 0),
      0
    );
    const avgArea = rows.length ? totalArea / rows.length : 0;

    const statEls = document.querySelectorAll('#maps-module .maps-panel--overview .overview-stat strong');
    if (statEls[0]) statEls[0].textContent = String(covered);
    if (statEls[1]) statEls[1].textContent = `${totalArea.toLocaleString(undefined, { maximumFractionDigits: 1 })}ha`;
    if (statEls[2]) statEls[2].textContent = `${avgArea.toLocaleString(undefined, { maximumFractionDigits: 1 })}ha`;

    const topList = document.querySelector('#maps-module .top-barangays-list');
    if (topList) {
      const sorted = [...points].sort((a, b) => b.count - a.count).slice(0, 5);
      topList.innerHTML = sorted
        .map((p) => {
          const tier = this.densityTier(p.count);
          return `<li><span><em class="dot dot--${tier}"></em>${p.barangay}</span><strong>${p.count}</strong></li>`;
        })
        .join('');
      if (!sorted.length) topList.innerHTML = '<li><span>No matching barangays</span><strong>0</strong></li>';
    }
  }

  renderMapsModule() {
    const fallback = document.getElementById('mapsGoogleFallback');
    const canvas = document.getElementById('mapsGoogleCanvas');
    const hasKey = !!(window.__GOOGLE_MAPS_API_KEY__ || '').trim();
    const ready = this.googleMapsReady || !!window.__BEANTHENTIC_GOOGLE_MAPS_READY__;
    const rows = this.getFilteredMapRows();
    const points = this.buildMapBarangayPoints(rows);

    this.updateMapInsights(points, rows);
    if (!canvas) return;

    if (!hasKey || !ready || !window.google?.maps) {
      if (fallback) fallback.hidden = false;
      canvas.classList.add('is-hidden');
      return;
    }

    if (fallback) fallback.hidden = true;
    canvas.classList.remove('is-hidden');
    this.ensureGoogleMap();
    if (this.googleMap && window.google?.maps?.event) {
      window.google.maps.event.trigger(this.googleMap, 'resize');
    }
    this.renderGoogleMapMarkers(points);
  }

  getRegisterDocuments() {
    const docs = [];
    const filesByService = this.ipophlFiles || {};
    Object.entries(filesByService).forEach(([service, files]) => {
      (files || []).forEach((entry) => {
        docs.push({
          id: entry.id || `${service}-${entry.name || Date.now()}`,
          name: entry.name || 'Document',
          service,
          file: entry.file || null,
        });
      });
    });

    if (docs.length > 0) return docs.slice(0, 12);

    return [
      { id: 'placeholder-logo', name: 'Logo', service: 'Brand Assets', file: null, placeholder: true },
      { id: 'placeholder-cert', name: 'Certification', service: 'GI Certificate', file: null, placeholder: true },
    ];
  }

  renderRegisterModule() {
    const grid = document.getElementById('registerDocsGrid');
    if (!grid) return;
    const docs = this.getRegisterDocuments();

    const esc = (s) =>
      String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    grid.innerHTML = docs
      .map(
        (doc) => `<article class="register-doc-card${doc.placeholder ? ' is-placeholder' : ''}">
  <div class="register-doc-card__preview">${esc(doc.name)}</div>
  <div class="register-doc-card__actions">
    <button type="button" class="register-doc-btn register-doc-btn--primary" data-register-action="download" data-doc-id="${esc(doc.id)}">
      Download
    </button>
    <button type="button" class="register-doc-btn register-doc-btn--secondary" data-register-action="share" data-doc-id="${esc(doc.id)}">
      Share
    </button>
  </div>
</article>`
      )
      .join('');
  }

  showNotification(message, type = 'success', options = {}) {
    const { placement = 'center' } = options;
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    if (placement === 'right') {
      notification.classList.add('notification--right');
    }
    notification.textContent = message;

    document.body.appendChild(notification);
    
    setTimeout(() => {
      notification.remove();
    }, 3000);
  }

  // New dashboard functionality
  initNewDashboardFeatures() {
    this.initThemeToggle();
    this.initGlobalSearch();
    this.initDashboardActions();
    this.updateNotificationBadges();
    this.initLastUpdatedTime();
  }

  initThemeToggle() {
    const themeToggle = document.getElementById('themeToggle');
    if (!themeToggle) return;

    // Check for saved theme preference
    const savedTheme = localStorage.getItem('beanthentic-theme') || 'light';
    this.applyTheme(savedTheme);

    themeToggle.addEventListener('click', () => {
      const currentTheme = document.body.getAttribute('data-theme') || 'light';
      const newTheme = currentTheme === 'light' ? 'dark' : 'light';
      
      this.applyTheme(newTheme);
      localStorage.setItem('beanthentic-theme', newTheme);
    });
  }

  applyTheme(theme) {
    document.body.setAttribute('data-theme', theme);
    const themeIcon = document.querySelector('#themeToggle .action-icon');
    if (themeIcon) {
      themeIcon.className = theme === 'dark' ? 'action-icon fa-solid fa-sun' : 'action-icon fa-solid fa-moon';
    }
  }

  initGlobalSearch() {
    const searchInput = document.getElementById('globalSearch');
    if (!searchInput) return;

    searchInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase().trim();
      this.performGlobalSearch(query);
    });

    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const query = e.target.value.trim();
        if (query) {
          this.handleSearchSubmit(query);
        }
      }
    });
  }

  performGlobalSearch(query) {
    if (!query) {
      this.clearSearchResults();
      return;
    }

    // Search across different data types
    const results = {
      farmers: this.searchFarmers(query),
      records: this.searchRecords(query),
      analytics: this.searchAnalytics(query)
    };

    this.displaySearchResults(results, query);
  }

  searchFarmers(query) {
    if (!this.data || this.data.length === 0) return [];
    
    return this.data.filter(farmer => {
      const searchableFields = [
        farmer.fullName || '',
        farmer.barangay || '',
        farmer.municipality || '',
        farmer.province || '',
        farmer.contactNumber || '',
        farmer.remarks || ''
      ];
      
      return searchableFields.some(field => 
        field.toLowerCase().includes(query)
      );
    }).slice(0, 5);
  }

  searchRecords(query) {
    // Search in other records (implement as needed)
    return [];
  }

  searchAnalytics(query) {
    // Search in analytics data (implement as needed)
    return [];
  }

  displaySearchResults(results, query) {
    // Implement search results display
    console.log('Search results for:', query, results);
  }

  clearSearchResults() {
    // Clear search results display
  }

  handleSearchSubmit(query) {
    // Handle search submission (navigate to results page)
    console.log('Search submitted:', query);
  }

  initDashboardActions() {
    const exportBtn = document.getElementById('exportOverviewBtn');
    const refreshBtn = document.getElementById('refreshOverviewBtn');

    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        this.exportOverviewReport();
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        this.refreshOverviewData();
      });
    }
  }

  exportOverviewReport() {
    // Export dashboard overview as report
    const reportData = {
      totalFarmers: document.getElementById('totalFarmers')?.textContent || '0',
      totalTrees: document.getElementById('totalTrees')?.textContent || '0',
      totalArea: document.getElementById('totalArea')?.textContent || '0',
      totalProduction: document.getElementById('totalProduction')?.textContent || '0',
      exportDate: new Date().toISOString()
    };

    // Create and download CSV
    const csvContent = this.generateOverviewCSV(reportData);
    this.downloadFile(csvContent, 'dashboard-overview.csv', 'text/csv');
    
    this.showNotification('Dashboard overview exported successfully', 'success');
  }

  generateOverviewCSV(data) {
    const headers = ['Metric', 'Value', 'Export Date'];
    const rows = [
      ['Total Farmers', data.totalFarmers, data.exportDate],
      ['Total Trees', data.totalTrees, data.exportDate],
      ['Total Area (hectares)', data.totalArea, data.exportDate],
      ['Total Production (kilos)', data.totalProduction, data.exportDate]
    ];

    return [headers, ...rows].map(row => row.join(',')).join('\n');
  }

  downloadFile(content, filename, contentType) {
    const blob = new Blob([content], { type: contentType });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }

  refreshOverviewData() {
    // Refresh dashboard data
    this.loadDashboardData();
    this.updateLastUpdatedTime();
    this.showNotification('Dashboard data refreshed', 'success');
  }

  updateNotificationBadges() {
    const headerBadge = document.getElementById('headerNotificationBadge');
    const navBadge = document.getElementById('navNotificationBadge');
    
    const unreadCount = this.notificationsFeed.filter(n => !n.read).length;
    
    if (headerBadge) headerBadge.textContent = unreadCount;
    if (navBadge) navBadge.textContent = unreadCount;
  }

  initLastUpdatedTime() {
    const lastUpdatedElement = document.getElementById('lastUpdated');
    if (!lastUpdatedElement) return;

    this.updateLastUpdatedTime();
    
    // Update every minute
    setInterval(() => {
      this.updateLastUpdatedTime();
    }, 60000);
  }

  updateLastUpdatedTime() {
    const lastUpdatedElement = document.getElementById('lastUpdated');
    if (!lastUpdatedElement) return;

    const now = new Date();
    const timeString = now.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true 
    });
    
    lastUpdatedElement.textContent = `Today at ${timeString}`;
  }

  // Toggle submenu visibility
  toggleSubmenu(linkEl, submenuEl) {
    const isExpanded = linkEl.getAttribute('aria-expanded') === 'true';
    
    if (isExpanded) {
      linkEl.setAttribute('aria-expanded', 'false');
      submenuEl.classList.remove('expanded');
      linkEl.classList.remove('active');
    } else {
      // Close other submenus first
      this.closeAllSubmenus();
      linkEl.setAttribute('aria-expanded', 'true');
      submenuEl.classList.add('expanded');
      linkEl.classList.add('active');
    }
  }

  // Close all submenus
  closeAllSubmenus() {
    const submenuLinks = document.querySelectorAll('.nav-link.has-submenu');
    const submenus = document.querySelectorAll('.submenu');
    
    submenuLinks.forEach(link => {
      link.setAttribute('aria-expanded', 'false');
      link.classList.remove('active');
    });
    submenus.forEach(submenu => submenu.classList.remove('expanded'));
  }

  // Legacy duplicate methods removed: main switchModule() above is the source of truth.

  async loadAccountData() {
    try {
      const response = await fetch('/settings/state');
      if (!response.ok) throw new Error('Failed to load user data');
      const data = await response.json();
      
      const displayName = data.user?.full_name || 'Admin';
      const phone = data.user?.phone || '—';
      
      const displayNameEl = document.getElementById('accountDisplayName');
      const phoneEl = document.getElementById('accountPhone');
      
      if (displayNameEl) displayNameEl.textContent = displayName;
      if (phoneEl) phoneEl.textContent = phone;
    } catch (error) {
      console.error('Failed to load account data:', error);
      const displayNameEl = document.getElementById('accountDisplayName');
      const phoneEl = document.getElementById('accountPhone');
      
      if (displayNameEl) displayNameEl.textContent = 'Admin';
      if (phoneEl) phoneEl.textContent = '—';
    }
  }

  initAccountModule() {
    const manageSettingsBtn = document.getElementById('manageSettingsBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    
    if (manageSettingsBtn) {
      manageSettingsBtn.addEventListener('click', () => {
        this.switchModule('settings');
        this.activeSettingsTab = 'profile';
        this.settingsViewMode = 'detail';
        this.syncSettingsSubmenuActive('profile');
      });
    }
    
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        if (confirm('Are you sure you want to log out?')) {
          window.location.href = '/logout';
        }
      });
    }
  }

  // ═══════════════════════════════════════════════════
  // MESSAGING MODULE
  // ═══════════════════════════════════════════════════

  initMessagingModule() {
    if (this._messagingInitialized) return;
    this._messagingInitialized = true;

    this.messagingFolder = 'inbox';
    this.messagingCategory = '';
    this.messagingSearchTerm = '';
    this.messagingMessages = [];
    this.messagingSelectedId = null;

    // Folder clicks
    const folderList = document.getElementById('messagingFolders');
    if (folderList) {
      folderList.addEventListener('click', (e) => {
        const item = e.target.closest('.messaging-folder-item');
        if (!item) return;
        const folder = item.getAttribute('data-folder');
        if (!folder) return;
        this.messagingFolder = folder;
        this.messagingSelectedId = null;
        folderList.querySelectorAll('.messaging-folder-item').forEach(el => el.classList.remove('is-active'));
        item.classList.add('is-active');
        this.closeMessagingDetail();
        this.loadMessagingFolder();
      });
    }

    // Category clicks
    const categories = document.querySelectorAll('.messaging-category-item');
    categories.forEach(cat => {
      cat.addEventListener('click', () => {
        this.messagingCategory = cat.getAttribute('data-category') || '';
        categories.forEach(c => c.classList.remove('is-active'));
        cat.classList.add('is-active');
        this.loadMessagingFolder();
      });
    });

    // Search
    const searchInput = document.getElementById('messagingSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.messagingSearchTerm = (e.target.value || '').trim();
        this.loadMessagingFolder();
      });
    }

    // Refresh
    const refreshBtn = document.getElementById('messagingRefreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.loadMessagingFolder());
    }

    // Mark all read
    const markAllBtn = document.getElementById('messagingMarkAllReadBtn');
    if (markAllBtn) {
      markAllBtn.addEventListener('click', () => this.messagingMarkAllRead());
    }

    // Compose
    const composeBtn = document.getElementById('messagingComposeBtn');
    if (composeBtn) {
      composeBtn.addEventListener('click', () => this.openMessagingCompose());
    }
    const composeClose = document.getElementById('messagingComposeClose');
    if (composeClose) {
      composeClose.addEventListener('click', () => this.closeMessagingCompose());
    }
    const composeCancel = document.getElementById('messagingComposeCancel');
    if (composeCancel) {
      composeCancel.addEventListener('click', () => this.closeMessagingCompose());
    }
    const composeOverlay = document.getElementById('messagingComposeOverlay');
    if (composeOverlay) {
      composeOverlay.addEventListener('click', (e) => {
        if (e.target === composeOverlay) this.closeMessagingCompose();
      });
    }
    const composeForm = document.getElementById('messagingComposeForm');
    if (composeForm) {
      composeForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.sendMessage();
      });
    }

    // Message list clicks
    const listEl = document.getElementById('messagingList');
    if (listEl) {
      listEl.addEventListener('click', (e) => {
        const starBtn = e.target.closest('.messaging-item__star');
        if (starBtn) {
          e.stopPropagation();
          const id = Number(starBtn.getAttribute('data-msg-id'));
          if (id) this.toggleMessagingStar(id);
          return;
        }
        const item = e.target.closest('.messaging-item');
        if (item) {
          const id = Number(item.getAttribute('data-msg-id'));
          if (id) this.openMessagingDetail(id);
        }
      });
    }

    // Detail actions
    const backBtn = document.getElementById('messagingDetailBackBtn');
    if (backBtn) {
      backBtn.addEventListener('click', () => this.closeMessagingDetail());
    }
    const starBtn = document.getElementById('messagingDetailStarBtn');
    if (starBtn) {
      starBtn.addEventListener('click', () => {
        if (this.messagingSelectedId) this.toggleMessagingStar(this.messagingSelectedId);
      });
    }
    const archiveBtn = document.getElementById('messagingDetailArchiveBtn');
    if (archiveBtn) {
      archiveBtn.addEventListener('click', () => {
        if (this.messagingSelectedId) this.toggleMessagingArchive(this.messagingSelectedId);
      });
    }
    const deleteBtn = document.getElementById('messagingDetailDeleteBtn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        if (this.messagingSelectedId) this.deleteMessagingMessage(this.messagingSelectedId);
      });
    }

    // Escape to close compose / detail
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const overlay = document.getElementById('messagingComposeOverlay');
      if (overlay && overlay.classList.contains('is-visible')) {
        this.closeMessagingCompose();
        return;
      }
    });

    // Fetch unread count for header badge on init
    this.updateMessagingBadge();
  }

  async loadMessagingFolder() {
    const listEl = document.getElementById('messagingList');
    if (!listEl) return;

    listEl.innerHTML = '<li class="messaging-loading"><i class="fa-solid fa-spinner"></i><span>Loading messages…</span></li>';

    try {
      let url = `/api/messages?folder=${encodeURIComponent(this.messagingFolder)}`;
      if (this.messagingCategory) url += `&category=${encodeURIComponent(this.messagingCategory)}`;
      if (this.messagingSearchTerm) url += `&search=${encodeURIComponent(this.messagingSearchTerm)}`;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.messagingMessages = Array.isArray(data.items) ? data.items : [];

      // Update badge
      const badge = document.getElementById('messagingInboxBadge');
      if (badge) {
        const unread = data.unread_count || 0;
        badge.textContent = unread > 0 ? (unread > 99 ? '99+' : String(unread)) : '';
      }
      this.updateMessagingBadge();

      this.renderMessagingList();
    } catch (err) {
      console.warn('Failed to load messages:', err);
      listEl.innerHTML = '<li class="messaging-list-empty"><i class="fa-solid fa-circle-exclamation"></i><p>Could not load messages. Try refreshing.</p></li>';
    }
  }

  renderMessagingList() {
    const listEl = document.getElementById('messagingList');
    if (!listEl) return;

    const msgs = this.messagingMessages;
    if (!msgs.length) {
      const folderLabels = { inbox: 'inbox', sent: 'sent folder', starred: 'starred list', archived: 'archive' };
      const label = folderLabels[this.messagingFolder] || 'folder';
      listEl.innerHTML = `<li class="messaging-list-empty">
        <i class="fa-solid fa-envelope-open"></i>
        <p>No messages in your ${this.escapeHtml(label)}.</p>
      </li>`;
      return;
    }

    const esc = (s) => this.escapeHtml(s);
    listEl.innerHTML = msgs.map(m => {
      const unreadClass = m.is_read ? '' : ' is-unread';
      const activeClass = m.id === this.messagingSelectedId ? ' is-active' : '';
      const initials = this.getInitials(m.sender_name);
      const avatarClass = this.getAvatarClass(m.category);
      const categoryTag = this.getCategoryTag(m.category);
      const timeStr = this.formatMessageTime(m.created_at);
      const starClass = m.is_starred ? ' is-starred' : '';
      const starIcon = m.is_starred ? 'fa-solid fa-star' : 'fa-regular fa-star';
      const preview = (m.body || '').substring(0, 100);

      return `<li class="messaging-item${unreadClass}${activeClass}" data-msg-id="${m.id}">
        <div class="messaging-item__avatar ${avatarClass}">${esc(initials)}</div>
        <div class="messaging-item__content">
          <div class="messaging-item__top">
            <span class="messaging-item__sender">${esc(m.sender_name || m.sender_phone)}</span>
            <span class="messaging-item__time">${esc(timeStr)}</span>
          </div>
          <div class="messaging-item__subject">${esc(m.subject)}</div>
          <div class="messaging-item__preview">${esc(preview)}</div>
          <div class="messaging-item__meta">
            ${categoryTag}
            <button type="button" class="messaging-item__star${starClass}" data-msg-id="${m.id}" title="Star">
              <i class="${starIcon}"></i>
            </button>
          </div>
        </div>
      </li>`;
    }).join('');
  }

  getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }

  getAvatarClass(category) {
    const map = {
      'announcement': 'messaging-item__avatar--announcement',
      'farmer-update': 'messaging-item__avatar--farmer',
      'reminder': 'messaging-item__avatar--reminder',
    };
    return map[category] || '';
  }

  getCategoryTag(category) {
    const labels = {
      'general': 'General',
      'farmer-update': 'Farmer Update',
      'announcement': 'Announcement',
      'reminder': 'Reminder',
    };
    const label = labels[category] || '';
    if (!label) return '';
    const cssClass = `messaging-item__category-tag--${category}`;
    return `<span class="messaging-item__category-tag ${cssClass}">${this.escapeHtml(label)}</span>`;
  }

  formatMessageTime(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return isoStr;
      const now = new Date();
      const diffMs = now - d;
      const diffH = diffMs / 3600000;
      if (diffH < 1) {
        const mins = Math.floor(diffMs / 60000);
        return mins <= 1 ? 'Just now' : `${mins}m ago`;
      }
      if (diffH < 24 && d.getDate() === now.getDate()) {
        return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
      }
      if (diffH < 168) {
        return d.toLocaleDateString(undefined, { weekday: 'short' });
      }
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return isoStr;
    }
  }

  async openMessagingDetail(id) {
    this.messagingSelectedId = id;
    const main = document.getElementById('messagingMain');
    const detail = document.getElementById('messagingDetail');
    if (main) main.classList.add('has-detail');
    if (detail) detail.classList.add('is-visible');

    // Highlight in list
    document.querySelectorAll('.messaging-item').forEach(el => {
      el.classList.toggle('is-active', Number(el.getAttribute('data-msg-id')) === id);
    });

    try {
      const res = await fetch(`/api/messages/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const m = data.message;
      if (!m) throw new Error('No message data');

      // Populate detail pane
      const subjectEl = document.getElementById('messagingDetailSubject');
      const avatarEl = document.getElementById('messagingDetailAvatar');
      const nameEl = document.getElementById('messagingDetailSenderName');
      const phoneEl = document.getElementById('messagingDetailSenderPhone');
      const tsEl = document.getElementById('messagingDetailTimestamp');
      const bodyEl = document.getElementById('messagingDetailBody');

      if (subjectEl) subjectEl.textContent = m.subject;
      if (avatarEl) {
        avatarEl.textContent = this.getInitials(m.sender_name);
        avatarEl.className = 'messaging-detail__sender-avatar';
      }
      if (nameEl) nameEl.textContent = m.sender_name || m.sender_phone;
      if (phoneEl) phoneEl.textContent = m.sender_phone ? `+63${m.sender_phone}` : '';
      if (tsEl) {
        try {
          const d = new Date(m.created_at);
          tsEl.textContent = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        } catch {
          tsEl.textContent = m.created_at || '';
        }
      }
      if (bodyEl) bodyEl.textContent = m.body;

      // Mark as read in list UI
      const listItem = document.querySelector(`.messaging-item[data-msg-id="${id}"]`);
      if (listItem) listItem.classList.remove('is-unread');

      // Update unread count in local data
      const local = this.messagingMessages.find(x => x.id === id);
      if (local && !local.is_read) {
        local.is_read = true;
        this.updateMessagingBadge();
      }
    } catch (err) {
      console.warn('Failed to load message detail:', err);
      const bodyEl = document.getElementById('messagingDetailBody');
      if (bodyEl) bodyEl.textContent = 'Could not load this message.';
    }
  }

  closeMessagingDetail() {
    this.messagingSelectedId = null;
    const main = document.getElementById('messagingMain');
    const detail = document.getElementById('messagingDetail');
    if (main) main.classList.remove('has-detail');
    if (detail) detail.classList.remove('is-visible');
    document.querySelectorAll('.messaging-item').forEach(el => el.classList.remove('is-active'));
  }

  async toggleMessagingStar(id) {
    try {
      const res = await fetch(`/api/messages/${id}/star`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // Update local data
      const m = this.messagingMessages.find(x => x.id === id);
      if (m) m.is_starred = data.is_starred;

      // Update star in list
      const starBtn = document.querySelector(`.messaging-item__star[data-msg-id="${id}"]`);
      if (starBtn) {
        starBtn.classList.toggle('is-starred', data.is_starred);
        const icon = starBtn.querySelector('i');
        if (icon) icon.className = data.is_starred ? 'fa-solid fa-star' : 'fa-regular fa-star';
      }
    } catch (err) {
      console.warn('Star toggle failed:', err);
    }
  }

  async toggleMessagingArchive(id) {
    try {
      const res = await fetch(`/api/messages/${id}/archive`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      this.showNotification(data.is_archived ? 'Message archived.' : 'Message unarchived.', 'success');
      this.closeMessagingDetail();
      this.loadMessagingFolder();
    } catch (err) {
      console.warn('Archive toggle failed:', err);
      this.showNotification('Could not archive message.', 'error');
    }
  }

  async deleteMessagingMessage(id) {
    if (!confirm('Delete this message permanently?')) return;
    try {
      const res = await fetch(`/api/messages/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      this.showNotification('Message deleted.', 'success');
      this.closeMessagingDetail();
      this.loadMessagingFolder();
    } catch (err) {
      console.warn('Delete failed:', err);
      this.showNotification('Could not delete message.', 'error');
    }
  }

  async messagingMarkAllRead() {
    try {
      const res = await fetch('/api/messages/mark-all-read', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      this.showNotification('All messages marked as read.', 'success');
      this.loadMessagingFolder();
    } catch (err) {
      console.warn('Mark all read failed:', err);
    }
  }

  openMessagingCompose() {
    const overlay = document.getElementById('messagingComposeOverlay');
    if (overlay) overlay.classList.add('is-visible');
    const subjectInput = document.getElementById('msgComposeSubject');
    if (subjectInput) setTimeout(() => subjectInput.focus(), 100);
  }

  closeMessagingCompose() {
    const overlay = document.getElementById('messagingComposeOverlay');
    if (overlay) overlay.classList.remove('is-visible');
    const form = document.getElementById('messagingComposeForm');
    if (form) form.reset();
  }

  async sendMessage() {
    const subject = (document.getElementById('msgComposeSubject')?.value || '').trim();
    const body = (document.getElementById('msgComposeBody')?.value || '').trim();
    const category = document.getElementById('msgComposeCategory')?.value || 'general';
    const recipientPhone = (document.getElementById('msgComposeRecipient')?.value || '').trim();

    if (!subject || !body) {
      this.showNotification('Subject and message body are required.', 'error');
      return;
    }

    const sendBtn = document.getElementById('messagingComposeSend');
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.setAttribute('aria-busy', 'true');
    }

    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ subject, body, category, recipient_phone: recipientPhone }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      this.showNotification('Message sent!', 'success');
      this.closeMessagingCompose();
      this.loadMessagingFolder();
    } catch (err) {
      console.warn('Send message failed:', err);
      this.showNotification(err.message || 'Could not send message.', 'error');
    } finally {
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.removeAttribute('aria-busy');
      }
    }
  }

  async updateMessagingBadge() {
    try {
      const res = await fetch('/api/messages/unread-count');
      if (!res.ok) return;
      const data = await res.json();
      const count = data.unread_count || 0;

      const headerBadge = document.getElementById('headerMessageBadge');
      if (headerBadge) {
        if (count > 0) {
          headerBadge.textContent = count > 99 ? '99+' : String(count);
          headerBadge.classList.add('is-visible');
        } else {
          headerBadge.textContent = '';
          headerBadge.classList.remove('is-visible');
        }
      }

      const inboxBadge = document.getElementById('messagingInboxBadge');
      if (inboxBadge) {
        inboxBadge.textContent = count > 0 ? (count > 99 ? '99+' : String(count)) : '';
      }
    } catch {
      // Silently fail
    }
  }
}

// Initialize dashboard when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.dashboardApp = new DashboardApp();
  if (window.__BEANTHENTIC_GOOGLE_MAPS_READY__ && typeof window.dashboardApp.onGoogleMapsReady === 'function') {
    window.dashboardApp.onGoogleMapsReady();
  }
});

// Export for potential module usage
window.DashboardApp = DashboardApp;
