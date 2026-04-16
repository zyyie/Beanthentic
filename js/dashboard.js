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
    this.activeSettingsTab = 'security';
    /** 'landing' = card hub; 'detail' = loaded fragment */
    this.settingsViewMode = 'landing';
    /** @type {{ id: string; icon: string; title: string; meta: string; detail: string; read: boolean }[]} */
    this.notificationsFeed = this.hydrateNotificationsFeed();
    /** @type {number | null} */
    this.pendingDeleteRowIndex = null;
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
      const res = await fetch('/api/activity-feed');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rows = Array.isArray(data.items) ? data.items : [];
      const activityItems = rows.map((row, i) => this.mapActivityLogToFeedItem(row, i));
      const defaults = this.getDefaultNotifications();
      this.notificationsFeed = this.applyReadStateToItems([...activityItems, ...defaults]);
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
        const actionMarkup = n.read
          ? '<span class="notification-read-badge" aria-hidden="true">Read</span>'
          : `<button type="button" class="btn btn-secondary notification-mark-read-btn" data-action="mark-notification-read" data-notification-id="${esc(
              n.id
            )}">Mark read</button>`;
        return `<li class="notification-item${readClass}" data-notification-id="${esc(n.id)}" tabindex="0" aria-label="Open details: ${esc(n.title)}">
      <div class="notification-item-icon" aria-hidden="true"><i class="fa-solid ${esc(n.icon)}"></i></div>
      <div class="notification-item-body">
        <p class="notification-item-title">${esc(n.title)}</p>
        <p class="notification-item-meta">${esc(n.meta)}</p>
      </div>
      <div class="notification-item-actions">${actionMarkup}</div>
    </li>`;
      })
      .join('');

    this.updateNotificationsToolbarState();
    this.updateHeaderNotificationBadge();
  }

  setupEventListeners() {
    // Menu toggle
    const menuToggle = document.getElementById('menuToggle');
    if (menuToggle) {
      menuToggle.addEventListener('click', () => {
        this.toggleSidePanel();
      });
    }

    // Navigation links
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const module = link.dataset.module;
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
    // Update navigation active state
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
      link.classList.remove('active');
      if (link.dataset.module === moduleName) {
        link.classList.add('active');
      }
    });

    // Update breadcrumb
    const currentModule = document.getElementById('currentModule');
    const moduleNames = {
      'overview': 'Overview',
      'notifications': 'Notifications',
      'farmers': 'Farmer Records',
      'analytics': 'Analytics',
      'ipophl': 'IPOPHL',
      'export': 'Export Data',
      'settings': 'Settings'
    };
    currentModule.textContent = moduleNames[moduleName] || 'Overview';

    // Switch modules
    const modules = document.querySelectorAll('.module');
    modules.forEach(module => {
      module.classList.add('hidden');
    });

    const targetModule = document.getElementById(`${moduleName}-module`);
    if (targetModule) {
      targetModule.classList.remove('hidden');
    }

    // Scroll behavior: only lock page scroll for the Farmers module
    const moduleContent = document.querySelector('.module-content');
    if (moduleContent) {
      moduleContent.classList.toggle('lock-scroll', moduleName === 'farmers');
    }

    if (moduleName === 'settings') {
      if (this.settingsViewMode === 'landing') {
        this.loadSettingsLanding();
      } else {
        this.loadAdminSettingsFragment(this.activeSettingsTab || 'security');
      }
    }

    if (moduleName === 'notifications') {
      this.renderNotificationsList();
    }
    if (moduleName === 'analytics') {
      this.renderAnalyticsModule();
    }
    if (moduleName === 'ipophl') {
      this.renderIpophlModule();
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

  buildTotpUri(email, secret) {
    const enc = encodeURIComponent;
    const id = email || 'admin';
    return `otpauth://totp/Beanthentic:${enc(id)}?secret=${enc(secret)}&issuer=${enc('Beanthentic')}`;
  }

  fill2faSetupPanel(containerEl, email, secret, backupCodes) {
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
      const uri = this.buildTotpUri(email, secret);
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
      const em = containerEl.querySelector('#email');
      if (fn) fn.value = u.full_name || '';
      if (em) em.value = u.email || '';

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

    const userEmail =
      (state && state.user && state.user.email) ||
      (window.__BEANTHENTIC_USER__ && window.__BEANTHENTIC_USER__.email) ||
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
        this.fill2faSetupPanel(containerEl, userEmail, result.secret, result.backup_codes);
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
          fresh.user && fresh.user.email,
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
    this.data = [
      {
        'NO.': 1,
        'NAME OF FARMER': 'Romeo Montoya',
        'ADDRESS (BARANGAY)': 'San Jose',
        'FA OFFICER / MEMBER': 'Juan Dela Cruz',
        'BIRTHDAY': '1990-01-15',
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
        'NCFRS': 'NCF001',
        'REMARKS': 'Good yield'
      },
      {
        'NO.': 2,
        'NAME OF FARMER': 'Anghelito Silva',
        'ADDRESS (BARANGAY)': 'San Pedro',
        'FA OFFICER / MEMBER': 'Maria Santos',
        'BIRTHDAY': '1985-05-20',
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
        'NCFRS': 'NCF002',
        'REMARKS': 'Needs fertilizer'
      },
      {
        'NO.': 3,
        'NAME OF FARMER': 'Avelino Malaluan',
        'ADDRESS (BARANGAY)': 'San Miguel',
        'FA OFFICER / MEMBER': 'Carlos Reyes',
        'BIRTHDAY': '1978-11-10',
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
        'NCFRS': 'NCF003',
        'REMARKS': 'Excellent growth'
      }
    ];
    
    this.filteredData = [...this.data];
    this.totalRecords = this.data.length;
    
    this.updateTable();
    this.updateStats();
    this.createCharts();
  }

  updateTable() {
    this.renderTableBody();
    this.renderPagination();
    this.updateRecordInfo();
    this.updateFarmerLimitBanner();
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
    const totalPages = Math.ceil(this.filteredData.length / this.pageSize);
    
    if (totalPages <= 1) {
      pagination.innerHTML = '';
      return;
    }

    let paginationHTML = '';
    
    // Previous button
    paginationHTML += `
      <button class="page-btn" ${this.currentPage === 1 ? 'disabled' : ''} 
        onclick="window.dashboardApp.goToPage(${this.currentPage - 1})">
        Previous
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
          onclick="window.dashboardApp.goToPage(${i})">
          ${i}
        </button>
      `;
    }

    // Next button
    paginationHTML += `
      <button class="page-btn" ${this.currentPage === totalPages ? 'disabled' : ''} 
        onclick="window.dashboardApp.goToPage(${this.currentPage + 1})">
        Next
      </button>
    `;

    pagination.innerHTML = paginationHTML;
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
    
    recordInfo.textContent = `Showing ${startIndex}-${endIndex} of ${this.filteredData.length} records`;
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
    if (!this.validatePhaseCompletion(5)) {
      this.showIpophlNotification('Please complete all required tasks in Phase 5 before completing registration.');
      return;
    }
    
    // Collect all phase data
    const allAttachments = this.collectAllPhaseData();
    
    this.showIpophlNotification('GI Registration process completed! All phases and documentation have been submitted.');
    
    console.log('Completed GI Registration:', {
      phases: allAttachments,
      completedAt: new Date().toISOString()
    });
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
        this.addFileToList(service, file);
      } else {
        this.showIpophlNotification(`Invalid file type: ${file.name}`);
      }
    });
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
  }

  removeFile(service, fileId) {
    const fileItem = document.querySelector(`[data-file-id="${fileId}"]`);
    if (fileItem) {
      fileItem.remove();
    }
    
    if (this.ipophlFiles && this.ipophlFiles[service]) {
      this.ipophlFiles[service] = this.ipophlFiles[service].filter(f => f.id !== fileId);
    }
  }

  removeLink(service, linkId) {
    const linkItem = document.querySelector(`[data-link-id="${linkId}"]`);
    if (linkItem) {
      linkItem.remove();
    }
    
    if (this.ipophlLinks && this.ipophlLinks[service]) {
      this.ipophlLinks[service] = this.ipophlLinks[service].filter(l => l.id !== linkId);
    }
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
}

// Initialize dashboard when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.dashboardApp = new DashboardApp();
});

// Export for potential module usage
window.DashboardApp = DashboardApp;
