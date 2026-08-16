// Dashboard functionality for coffee database
const NOTIFICATIONS_READ_STORAGE_KEY = 'beanthentic_dashboard_notification_read';
const NOTIFICATIONS_FEED_STORAGE_KEY = 'beanthentic_dashboard_notification_feed';
const LAST_MAX_FARMER_ID_KEY = 'beanthentic_last_max_farmer_id';
const KNOWN_FARMER_IDS_KEY = 'beanthentic_known_farmer_ids';
const NOTIFIED_COMPLETE_FARMER_IDS_KEY = 'beanthentic_notified_complete_farmer_ids';
const ADMIN_NOTIFICATIONS_POLL_MS = 60000;

/** Prefix for API paths when the app is mounted under a subpath (e.g. /Beanthentic). */
function beanthenticApiUrl(path) {
  const base = (typeof window.__BEANTHENTIC_API_BASE__ === 'string' ? window.__BEANTHENTIC_API_BASE__ : '').replace(/\/$/, '');
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${normalized}` : normalized;
}
window.beanthenticApiUrl = beanthenticApiUrl;

/** Resolve GI contribution attachment paths to a browser-openable URL on this admin host. */
function resolveGiAttachmentUrl(attachment) {
  if (!attachment || typeof attachment !== 'object') return '';
  const raw = String(
    attachment.url || attachment.path || attachment.filename || attachment.name || ''
  ).trim();
  if (!raw) return '';

  let path = raw.replace(/\\/g, '/');
  if (/^https?:\/\//i.test(path)) {
    try {
      const parsed = new URL(path);
      if (parsed.pathname.includes('/uploads/gi_contributions/')) {
        path = parsed.pathname;
      } else {
        return path;
      }
    } catch (_err) {
      return raw;
    }
  }

  if (!path.startsWith('/')) {
    if (path.includes('uploads/gi_contributions/')) {
      path = `/${path.replace(/^\/+/, '')}`;
    } else {
      path = `/uploads/gi_contributions/${path.replace(/^\/+/, '')}`;
    }
  }
  return beanthenticApiUrl(path);
}

/** Ask the admin server to mirror a farmer GI file locally, then return its URL. */
async function ensureGiAttachmentUrl(attachment) {
  const direct = resolveGiAttachmentUrl(attachment);
  const rawName = String(
    attachment?.filename || attachment?.name || attachment?.path || attachment?.url || ''
  ).trim();
  const basename = rawName.split(/[/\\]/).pop()?.split('?')[0] || '';
  if (!basename) return direct;
  try {
    const res = await fetch(
      beanthenticApiUrl(`/api/gi-contributions/ensure-attachment?filename=${encodeURIComponent(basename)}`),
      { credentials: 'same-origin' }
    );
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok && data.url) {
      return beanthenticApiUrl(String(data.url));
    }
  } catch (_err) {
    /* fall back to direct URL */
  }
  return direct;
}
window.resolveGiAttachmentUrl = resolveGiAttachmentUrl;
window.ensureGiAttachmentUrl = ensureGiAttachmentUrl;

/** Parse fetch responses; avoid opaque JSON errors when the server returns HTML. */
async function beanthenticParseJsonResponse(res) {
  const text = await res.text();
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const trimmed = text.trim();
  if (!contentType.includes('application/json')) {
    if (trimmed.toLowerCase().startsWith('<!doctype') || trimmed.startsWith('<html')) {
      if (res.status === 404) {
        throw new Error(
          'Profile photo endpoint was not found. Restart the server (python web.py) and open the dashboard at the same address (e.g. http://127.0.0.1:5000/dashboard).'
        );
      }
      if (res.status === 405) {
        throw new Error(
          'Photo upload was blocked (HTTP 405). Stop the server, run python web.py again, then hard-refresh the dashboard (Ctrl+F5).'
        );
      }
      throw new Error(
        `Server returned a web page instead of JSON (HTTP ${res.status}). Use http://127.0.0.1:5000/dashboard if you are running python web.py.`
      );
    }
    throw new Error(trimmed.slice(0, 240) || `Request failed (HTTP ${res.status}).`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error('Server returned invalid JSON.');
  }
}
window.beanthenticParseJsonResponse = beanthenticParseJsonResponse;

class DashboardApp {
  constructor() {
    this.data = [];
    this.farmersData = [];
    this.filteredData = [];
    // Database is now the source of truth; keep a very high cap
    // so admin-added rows are visible in the dashboard.
    this.maxFarmers = Number.MAX_SAFE_INTEGER;
    this.currentPage = 1;
    this.pageSize = 10;
    this.totalRecords = 0;
    this.farmerTableView = 'basic';
    this.mapVarietyFilter = 'all';
    this.mapSearchTerm = '';
    this.leafletMap = null;
    this.leafletTileLayer = null;
    this.leafletMarkers = [];
    this.leafletHeatLayers = [];
    this.leafletBoundary = null;
    this.mapLayers = {
      farmerLocations: true,
      farmBoundaries: true,
      densityHeatmap: false,
      roadNetwork: false,
    };
    this.activeSettingsTab = 'security';
    /** 'landing' = card hub; 'detail' = loaded fragment */
    this.settingsViewMode = 'landing';
    /** @type {{ id: string; icon: string; title: string; meta: string; detail: string; read: boolean }[]} */
    this.notificationsFeed = this.hydrateNotificationsFeed();
    /** @type {number | null} */
    this.pendingDeleteRowIndex = null;
    this.currentFarmerNo = null;
    this.transactionsRows = [];
    this.transactionsDataSource = '';
    this.transactionsSearchTerm = '';
    this.transactionsFarmerFilterId = null;
    this.transactionsVarietyFilter = '';
    this.transactionsCurrentPage = 1;
    this.transactionsTotalPages = 1;
    this.transactionsSortOrder = 'newest';
    this.transactionsMonthFilter = '';
    this.transactionsYearFilter = '';
    this.farmerProfileSource = 'profiles';
    
    // Client Report Pagination
    this.clientReportCurrentPage = 1;
    this.clientReportPageSize = 10;
    this.clientReportTotalPages = 1;
    this.misconductReportRows = [];
    /** @type {Record<number, { unlocked_by?: string, unlocked_at?: string, enabled?: boolean }>} */
    this.selfSaleUnlockAuditByFarmer = {};
    this._pendingUnlockConfirmFarmerId = null;

    this.coffeePricelistItems = [];
    
    // Explicitly hide the receipt modal on startup
    this.closeReceipt();
    
    this.init();
  }

  getDefaultNotifications() {
    return [];
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
      read: !!n.read || !!readById[n.id],
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
      detail: row.detail || row.message || '',
      category: row.category || '',
      categoryLabel: row.category_label || '',
      targetModule: row.targetModule || row.target_module || '',
      targetId: row.targetId || row.target_id || '',
      targetPayload: row.targetPayload || row.target_payload || null,
      read: !!row.read,
    };
  }

  isRegistrationNotificationId(id) {
    return /^reg-(pending|local|act)-/i.test(String(id || ''));
  }

  mergeAdminNotificationFeed(apiRows) {
    // Server durable feed is authoritative; do not keep stale registration
    // cards from localStorage after a wipe or dismiss-all on the API side.
    const apiItems = (apiRows || []).map((row, i) => this.mapAdminNotificationToFeedItem(row, i));
    return apiItems.sort((a, b) => {
      const ta = Date.parse(a.meta || '') || 0;
      const tb = Date.parse(b.meta || '') || 0;
      return tb - ta;
    });
  }

  hydrateNotificationsFeed() {
    try {
      const raw = localStorage.getItem(NOTIFICATIONS_FEED_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) {
          return this.applyReadStateToItems(parsed);
        }
      }
    } catch {
      /* ignore */
    }
    return this.applyReadStateToItems([]);
  }

  persistNotificationsFeedCache() {
    try {
      const slim = (this.notificationsFeed || []).map((n) => ({
        id: n.id,
        icon: n.icon,
        title: n.title,
        meta: n.meta,
        detail: n.detail,
        category: n.category,
        categoryLabel: n.categoryLabel,
        targetModule: n.targetModule,
        targetId: n.targetId,
        targetPayload: n.targetPayload,
        read: !!n.read,
      }));
      localStorage.setItem(NOTIFICATIONS_FEED_STORAGE_KEY, JSON.stringify(slim));
    } catch (e) {
      console.warn('Could not cache notification feed', e);
    }
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
    const detail = row.details || '';
    return { id, icon, title, meta, detail, read: false };
  }

  async fetchAdminNotifications({ silent = false, showToastOnNewRegistration = false } = {}) {
    try {
      const res = await fetch(beanthenticApiUrl('/api/admin-notifications'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rows = Array.isArray(data.items) ? data.items : [];
      const prevRegIds = new Set(
        (this.notificationsFeed || [])
          .filter((n) => this.isRegistrationNotificationId(n.id))
          .map((n) => n.id)
      );
      const adminItems = rows.map((row, i) => this.mapAdminNotificationToFeedItem(row, i));
      const merged = this.mergeAdminNotificationFeed(adminItems);
      this.notificationsFeed = this.applyReadStateToItems(merged);
      this.persistNotificationsFeedCache();
      if (!merged.length) {
        try {
          localStorage.removeItem(NOTIFICATIONS_FEED_STORAGE_KEY);
        } catch {
          /* ignore */
        }
      }
      this.renderNotificationsList();
      this.updateNotificationBadges();

      const newReg = merged.filter(
        (n) =>
          this.isRegistrationNotificationId(n.id) &&
          !prevRegIds.has(n.id) &&
          !n.read
      );
      if (showToastOnNewRegistration && newReg.length > 0) {
        const first = newReg[0];
        this.showNotification(
          first.title || 'Bagong farmer registration',
          'success'
        );
      }
      if (!silent && adminItems.length > 0) {
        this.showNotification('Notifications refreshed.', 'success');
      }
      return true;
    } catch (e) {
      console.warn('Admin notifications fetch failed:', e);
      if (!silent) {
        this.notificationsFeed = this.applyReadStateToItems(this.notificationsFeed || []);
        this.renderNotificationsList();
        this.updateNotificationBadges();
        this.showNotification('Could not load latest notifications.', 'error');
      }
      return false;
    }
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
      await this.fetchAdminNotifications({ silent: false });
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
      }
      if (markAllBtn) markAllBtn.disabled = false;
    }
  }

  farmerIdFromRow(row) {
    return Number(row?.farmer_id ?? row?.['NO.'] ?? row?.['no'] ?? 0) || 0;
  }

  /** 1-based row number in the current farmer list (not the database id). */
  farmerDisplaySeqNo(row, list = this.data) {
    const rows = Array.isArray(list) ? list : [];
    const idx = rows.indexOf(row);
    return idx >= 0 ? idx + 1 : 0;
  }

  farmerRowByDisplaySeq(seq, list = this.data) {
    const n = Number(seq);
    const rows = Array.isArray(list) ? list : [];
    if (!Number.isFinite(n) || n < 1 || n > rows.length) return null;
    return rows[n - 1] ?? null;
  }

  farmerRowById(farmerId) {
    const id = Number(farmerId);
    if (!id) return null;
    return (this.data || []).find((r) => this.farmerIdFromRow(r) === id) ?? null;
  }

  farmerIndexById(farmerId) {
    const id = Number(farmerId);
    if (!id) return -1;
    return (this.data || []).findIndex((r) => this.farmerIdFromRow(r) === id);
  }

  resolveFarmerFromRef(ref) {
    const n = Number(ref);
    if (!n) return null;
    return this.farmerRowById(n) || this.farmerRowByDisplaySeq(n);
  }

  loadKnownFarmerIds() {
    try {
      const raw = localStorage.getItem(KNOWN_FARMER_IDS_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.map((x) => Number(x)).filter((n) => n > 0));
    } catch {
      return new Set();
    }
  }

  saveKnownFarmerIds(idSet) {
    try {
      const arr = [...idSet].filter((n) => n > 0).sort((a, b) => a - b).slice(-2000);
      localStorage.setItem(KNOWN_FARMER_IDS_KEY, JSON.stringify(arr));
      const maxId = arr.length ? arr[arr.length - 1] : 0;
      sessionStorage.setItem(LAST_MAX_FARMER_ID_KEY, String(maxId));
    } catch {
      /* ignore */
    }
  }

  loadNotifiedCompleteFarmerIds() {
    try {
      const raw = localStorage.getItem(NOTIFIED_COMPLETE_FARMER_IDS_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.map((x) => Number(x)).filter((n) => n > 0));
    } catch {
      return new Set();
    }
  }

  saveNotifiedCompleteFarmerIds(idSet) {
    try {
      const arr = [...idSet].filter((n) => n > 0).sort((a, b) => a - b).slice(-2000);
      localStorage.setItem(NOTIFIED_COMPLETE_FARMER_IDS_KEY, JSON.stringify(arr));
    } catch {
      /* ignore */
    }
  }

  looksLikePhoneNumber(value) {
    const s = String(value || '').replace(/[\s\-()]/g, '');
    if (!s) return false;
    return /^(\+?63)?9\d{9}$/.test(s) || /^09\d{9}$/.test(s);
  }

  farmerDisplayNameFromRow(row) {
    const fid = this.farmerIdFromRow(row);
    const first = String(row['FIRST NAME'] || row.first_name || '').trim();
    const last = String(row['LAST NAME'] || row.last_name || '').trim();
    const full = `${first} ${last}`.trim();
    if (full && !this.looksLikePhoneNumber(full) && !this.looksLikePhoneNumber(first)) {
      return full;
    }
    const legal = String(row['NAME OF FARMER'] || '').trim();
    if (legal && !this.looksLikePhoneNumber(legal)) return legal;
    return fid ? `Farmer #${fid}` : 'Farmer';
  }

  farmerProfilePhotoUrl(row) {
    const explicit = this.getValue(row, [
      'profile_photo_url',
      'profile_photo_data',
      'profile_photo',
      'PHOTO',
      'photo',
      'photo_url',
      'image',
    ]);
    const s = String(explicit || '').trim();
    if (s && s !== 'undefined') {
      if (/^data:image\//i.test(s)) return s;
      if (/^https?:\/\//i.test(s)) return s;
    }
    const fid = Number(row?.farmer_id ?? row?.['NO.'] ?? 0);
    if (fid > 0) {
      return beanthenticApiUrl(`/api/farmer-profile-photo/${fid}?t=${Date.now()}`);
    }
    return '';
  }

  hydrateFarmerCardPhotos() {
    const grid = document.getElementById('farmersCardGrid');
    if (!grid) return;
    grid.querySelectorAll('.farmer-card__avatar-circle[data-farmer-id]').forEach((circle) => {
      this._hydrateAvatarElement(circle, {
        imgSelector: 'img.farmer-card__image',
        fallbackSelector: '.farmer-card__avatar-fallback',
      });
    });
  }

  findFarmerByPhone(phone) {
    const target = this.messagingPhoneTail(phone);
    if (!target || !Array.isArray(this.data)) return null;
    return (
      this.data.find((f) => {
        const fPhone = this.getValue(f, ['PHONE', 'phone', 'PHONE NO.', 'Phone No.']);
        return this.messagingPhoneTail(fPhone) === target;
      }) || null
    );
  }

  farmerIdFromPhone(phone) {
    const farmer = this.findFarmerByPhone(phone);
    if (!farmer) return null;
    const fid = this.farmerIdFromRow(farmer);
    return fid > 0 ? fid : null;
  }

  _hydrateAvatarElement(container, { imgSelector, fallbackSelector }) {
    const fid = String(container.dataset.farmerId || '').trim();
    if (!fid || fid === '0') return;
    const img = container.querySelector(imgSelector || 'img.messaging-avatar__img');
    const fallback = container.querySelector(fallbackSelector || '.messaging-avatar__fallback');
    if (!img) return;
    const directUrl = String(container.dataset.photoUrl || '').trim();
    const apiUrl = beanthenticApiUrl(`/api/farmer-profile-photo/${fid}?t=${Date.now()}`);
    const showFallback = () => {
      container.classList.remove('has-photo');
      img.hidden = true;
      img.removeAttribute('src');
      if (fallback) fallback.style.display = '';
    };
    const showPhoto = (src) => {
      img.onload = () => {
        img.hidden = false;
        container.classList.add('has-photo');
        if (fallback) fallback.style.display = 'none';
      };
      img.onerror = showFallback;
      img.src = src;
      if (img.complete && img.naturalWidth > 0) {
        img.hidden = false;
        container.classList.add('has-photo');
        if (fallback) fallback.style.display = 'none';
      }
    };
    if (directUrl && (/^https?:\/\//i.test(directUrl) || /^data:image\//i.test(directUrl) || directUrl.startsWith('/'))) {
      showPhoto(directUrl.startsWith('/') ? beanthenticApiUrl(directUrl) : directUrl);
      return;
    }
    const runFetch = () => {
      void fetch(apiUrl, { credentials: 'same-origin' })
        .then((res) => {
          if (!res.ok) throw new Error('photo');
          return res.blob();
        })
        .then((blob) => {
          if (!blob || !blob.size || !String(blob.type || '').startsWith('image/')) {
            throw new Error('empty');
          }
          if (img._blobUrl) URL.revokeObjectURL(img._blobUrl);
          img._blobUrl = URL.createObjectURL(blob);
          showPhoto(img._blobUrl);
        })
        .catch(() => showPhoto(apiUrl));
    };
    if (typeof IntersectionObserver === 'function') {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          observer.disconnect();
          runFetch();
        });
      }, { rootMargin: '120px' });
      observer.observe(container);
      return;
    }
    runFetch();
  }

  buildMessagingAvatarHtml({ phone, name, className = 'messaging-item__avatar', farmerId = null, admin = false } = {}) {
    const esc = (s) => this.escapeHtml(s);
    const initials = admin ? 'AD' : esc(this.getInitials(name || 'Farmer'));
    const farmer = !admin && phone ? this.findFarmerByPhone(phone) : null;
    const resolvedFid = farmerId || (farmer ? this.farmerIdFromRow(farmer) : this.farmerIdFromPhone(phone));
    const photoUrl = farmer ? this.farmerProfilePhotoUrl(farmer) : '';
    const attrs = [
      resolvedFid ? ` data-farmer-id="${esc(String(resolvedFid))}"` : '',
      photoUrl && /^https?:\/\//i.test(photoUrl) ? ` data-photo-url="${esc(photoUrl)}"` : '',
      phone ? ` data-phone="${esc(phone)}"` : '',
    ].join('');
    const adminClass = admin ? ' messaging-avatar--admin' : '';
    return `<div class="${className}${adminClass}"${attrs} aria-hidden="true"><img class="messaging-avatar__img" alt="" hidden /><span class="messaging-avatar__fallback">${initials}</span></div>`;
  }

  hydrateMessagingAvatars(root) {
    let nodes = [];
    if (!root) {
      const mod = document.getElementById('messaging-module');
      if (mod) nodes = [...mod.querySelectorAll('[data-farmer-id]')];
    } else if (root.matches && root.matches('[data-farmer-id]')) {
      nodes = [root];
    } else if (root.querySelectorAll) {
      nodes = [...root.querySelectorAll('[data-farmer-id]')];
    }
    nodes.forEach((el) => {
      if (!el.querySelector('.messaging-avatar__img')) return;
      this._hydrateAvatarElement(el, {
        imgSelector: 'img.messaging-avatar__img',
        fallbackSelector: '.messaging-avatar__fallback',
      });
    });
  }

  _revokeFarmerProfileAvatarBlob() {
    if (this._farmerProfileAvatarBlobUrl) {
      URL.revokeObjectURL(this._farmerProfileAvatarBlobUrl);
      this._farmerProfileAvatarBlobUrl = null;
    }
  }

  applyFarmerProfileAvatar(row) {
    const wrap = document.querySelector('.farmer-profile-avatar-large');
    if (!wrap) return;
    let img = wrap.querySelector('img.farmer-profile-avatar-img');
    let icon = wrap.querySelector('i');
    const url = this.farmerProfilePhotoUrl(row);
    if (!img) {
      img = document.createElement('img');
      img.className = 'farmer-profile-avatar-img';
      img.alt = '';
      wrap.insertBefore(img, wrap.firstChild);
    }
    const showPlaceholder = () => {
      this._revokeFarmerProfileAvatarBlob();
      img.hidden = true;
      img.removeAttribute('src');
      if (icon) icon.style.display = '';
    };
    const showPhoto = (src) => {
      img.onerror = () => {
        wrap.classList.remove('has-photo');
        showPlaceholder();
      };
      img.onload = () => {
        img.hidden = false;
        wrap.classList.add('has-photo');
        if (icon) icon.style.display = 'none';
      };
      img.src = src;
      if (img.complete && img.naturalWidth > 0) {
        img.hidden = false;
        wrap.classList.add('has-photo');
        if (icon) icon.style.display = 'none';
      }
    };
    if (!url) {
      showPlaceholder();
      return;
    }
    if (/\/api\/farmer-profile-photo\/\d+/i.test(url)) {
      void fetch(url, { credentials: 'same-origin' })
        .then((res) => {
          if (!res.ok) throw new Error('photo');
          return res.blob();
        })
        .then((blob) => {
          if (!blob || !blob.size) throw new Error('empty');
          this._revokeFarmerProfileAvatarBlob();
          this._farmerProfileAvatarBlobUrl = URL.createObjectURL(blob);
          showPhoto(this._farmerProfileAvatarBlobUrl);
        })
        .catch(() => showPhoto(url));
      return;
    }
    showPhoto(url);
  }

  isFarmerRegistrationComplete(row) {
    const first = String(row['FIRST NAME'] || row.first_name || '').trim();
    const last = String(row['LAST NAME'] || row.last_name || '').trim();
    if (!first || !last) return false;
    if (this.looksLikePhoneNumber(first) || this.looksLikePhoneNumber(last)) return false;

    const barangay = String(row['ADDRESS (BARANGAY)'] || row.barangay || '').trim();
    const farmHa = Number(row['TOTAL AREA PLANTED (HA.)'] ?? row['Total Area Planted (HA.)'] ?? row.farm_size_ha ?? 0);
    const trees = Number(row['TOTAL TREES'] ?? row.total_bearing_trees ?? 0);
    return Boolean(barangay || farmHa > 0 || trees > 0);
  }

  detectNewFarmersFromData() {
    if (!Array.isArray(this.data) || !this.data.length) return;
    const notifiedComplete = this.loadNotifiedCompleteFarmerIds();
    const isFirstBaseline = notifiedComplete.size === 0;

    if (isFirstBaseline) {
      this.data.forEach((r) => {
        const fid = this.farmerIdFromRow(r);
        if (fid > 0 && this.isFarmerRegistrationComplete(r)) {
          notifiedComplete.add(fid);
        }
      });
      this.saveNotifiedCompleteFarmerIds(notifiedComplete);
    } else {
      this.data.forEach((r) => {
        const fid = this.farmerIdFromRow(r);
        if (fid <= 0 || !this.isFarmerRegistrationComplete(r)) return;
        if (notifiedComplete.has(fid)) return;
        this.addLocalFarmerRegistrationNotification(r);
        notifiedComplete.add(fid);
      });
      this.saveNotifiedCompleteFarmerIds(notifiedComplete);
    }

    const known = this.loadKnownFarmerIds();
    this.data.forEach((r) => {
      const fid = this.farmerIdFromRow(r);
      if (fid > 0) known.add(fid);
    });
    this.saveKnownFarmerIds(known);
  }

  addLocalFarmerRegistrationNotification(row) {
    const fid = this.farmerIdFromRow(row);
    if (!fid || !this.isFarmerRegistrationComplete(row)) return;
    const name = this.farmerDisplayNameFromRow(row);
    const nid = `reg-local-${fid}`;
    if ((this.notificationsFeed || []).some((n) => n.id === nid)) return;

    const item = {
      id: nid,
      icon: 'fa-user-plus',
      title: `New farmer registration: ${name}`,
      meta: this.formatNotificationMeta(new Date().toISOString()),
      detail: `New registration submitted. Review ${name} in Farmer Records.`,
      targetModule: 'farmers-list',
      targetPayload: { farmerId: fid, farmerNo: fid },
      read: false,
      category: 'registrations',
      categoryLabel: 'Registrations',
    };
    this.notificationsFeed = this.applyReadStateToItems([item, ...(this.notificationsFeed || [])]);
    this.persistNotificationsFeedCache();
    this.renderNotificationsList();
    this.updateNotificationBadges();
    this.showNotification(`New farmer: ${name}`, 'success');
  }

  startNotificationPolling() {
    setTimeout(() => {
      this.fetchAdminNotifications({ silent: true, showToastOnNewRegistration: true });
    }, 1200);
    if (this._adminNotificationsPoll) clearInterval(this._adminNotificationsPoll);
    this._adminNotificationsPoll = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      this.fetchAdminNotifications({ silent: true, showToastOnNewRegistration: true });
    }, ADMIN_NOTIFICATIONS_POLL_MS);
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
    this.persistNotificationsFeedCache();
  }

  markNotificationRead(id) {
    const n = this.notificationsFeed.find((x) => x.id === id);
    if (!n || n.read) return;
    n.read = true;
    this.persistNotificationReadState();
    this.renderNotificationsList();
    void fetch(beanthenticApiUrl('/api/admin-notifications/mark-read'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => {});
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
    void fetch(beanthenticApiUrl('/api/admin-notifications/mark-read'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    }).catch(() => {});
  }

  async deleteNotification(id) {
    const idx = this.notificationsFeed.findIndex((n) => n.id === id);
    if (idx === -1) return;
    this.notificationsFeed.splice(idx, 1);
    this.persistNotificationReadState();
    this.renderNotificationsList();
    try {
      await fetch(beanthenticApiUrl('/api/admin-notifications/dismiss'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
    } catch (e) {
      console.warn('Could not dismiss notification on server', e);
    }
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

      await this.fetchAdminNotifications({ silent: true, showToastOnNewRegistration: true });

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

    // Handle navigation action if targetModule exists
    if (n.targetModule) {
      this.switchModule(n.targetModule);
      
      // Additional logic for specific modules
      if (n.targetModule === 'messaging' && n.targetPayload?.phone) {
        this.goToFarmerMessage(n.targetPayload.phone);
      } else if (n.targetModule === 'farmers-list') {
        const farmerNo =
          n.targetPayload?.farmerNo ?? n.targetPayload?.farmerId ?? null;
        if (farmerNo != null) this.openFarmerProfile(farmerNo);
      }
    }
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
    this.syncConfirmDialogBodyClass();
  }

  syncConfirmDialogBodyClass() {
    const ids = ['deleteFarmerConfirmModal', 'disable2faConfirmModal', 'logoutConfirmModal', 'deactivateAccountConfirmModal'];
    const anyOpen = ids.some((id) => {
      const el = document.getElementById(id);
      return el && !el.hasAttribute('hidden');
    });
    if (!anyOpen) {
      document.body.classList.remove('confirm-dialog-active');
    }
  }

  _revokeProfilePhotoPreview() {
    if (this._profilePhotoPreviewUrl) {
      URL.revokeObjectURL(this._profilePhotoPreviewUrl);
      this._profilePhotoPreviewUrl = null;
    }
  }

  applyAccountProfilePhoto(photoUrl, displayName) {
    const avatar = document.getElementById('accountProfileAvatar');
    const img = document.getElementById('accountProfileAvatarImg');
    const placeholder = document.getElementById('accountProfileAvatarPlaceholder');
    if (!avatar || !img) return;

    if (photoUrl) {
      const isBlob = String(photoUrl).startsWith('blob:');
      if (!isBlob || (this._profilePhotoPreviewUrl && photoUrl !== this._profilePhotoPreviewUrl)) {
        this._revokeProfilePhotoPreview();
      }
      const src = isBlob
        ? photoUrl
        : (() => {
            const resolved = beanthenticApiUrl(photoUrl.split('?')[0]);
            const query = photoUrl.includes('?') ? photoUrl.slice(photoUrl.indexOf('?')) : '';
            return query ? `${resolved}${query}&t=${Date.now()}` : `${resolved}?t=${Date.now()}`;
          })();
      img.src = src;
      img.alt = displayName ? `${displayName} profile photo` : 'Profile photo';
      img.removeAttribute('hidden');
      avatar.classList.add('has-photo');
      if (placeholder) placeholder.style.display = 'none';
    } else {
      this._revokeProfilePhotoPreview();
      img.removeAttribute('src');
      img.setAttribute('hidden', '');
      avatar.classList.remove('has-photo');
      if (placeholder) placeholder.style.display = '';
    }
  }

  previewAccountProfilePhoto(blob, displayName) {
    if (!blob) return;
    this._revokeProfilePhotoPreview();
    this._profilePhotoPreviewUrl = URL.createObjectURL(blob);
    this.applyAccountProfilePhoto(this._profilePhotoPreviewUrl, displayName);
  }

  openProfilePhotoModal(options = {}) {
    const root = document.getElementById('profilePhotoModal');
    if (!root) return;
    root.removeAttribute('hidden');
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('confirm-dialog-active');
    if (options.startCamera) {
      void this.startProfilePhotoCamera();
    } else {
      document.getElementById('profilePhotoUploadBtn')?.focus();
    }
  }

  closeProfilePhotoModal() {
    this.stopProfilePhotoCamera();
    this._revokeProfilePhotoPreview();
    document.querySelector('.profile-photo-actions')?.removeAttribute('hidden');
    const root = document.getElementById('profilePhotoModal');
    if (root) {
      root.setAttribute('hidden', '');
      root.setAttribute('aria-hidden', 'true');
    }
    const fileInput = document.getElementById('profilePhotoFileInput');
    if (fileInput) fileInput.value = '';
    const panel = document.getElementById('profilePhotoCameraPanel');
    if (panel) panel.setAttribute('hidden', '');
    document.getElementById('profilePhotoCameraHint')?.setAttribute('hidden', '');
    const cameraSelect = document.getElementById('profilePhotoCameraSelect');
    if (cameraSelect) {
      cameraSelect.innerHTML = '';
      cameraSelect.setAttribute('hidden', '');
    }
    document.getElementById('profilePhotoCameraSelectLabel')?.setAttribute('hidden', '');
    const logoutEl = document.getElementById('logoutConfirmModal');
    const deactivateEl = document.getElementById('deactivateAccountConfirmModal');
    const del = document.getElementById('deleteFarmerConfirmModal');
    const d2 = document.getElementById('disable2faConfirmModal');
    if (
      logoutEl?.hasAttribute('hidden') &&
      deactivateEl?.hasAttribute('hidden') &&
      del?.hasAttribute('hidden') &&
      d2?.hasAttribute('hidden')
    ) {
      document.body.classList.remove('confirm-dialog-active');
    }
  }

  stopProfilePhotoCamera() {
    if (this._profilePhotoStream) {
      this._profilePhotoStream.getTracks().forEach((track) => track.stop());
      this._profilePhotoStream = null;
    }
    const video = document.getElementById('profilePhotoVideo');
    if (video) video.srcObject = null;
  }

  /** Labels that usually mean a virtual / idle webcam (e.g. DroidCam waiting screen). */
  isLikelyVirtualOrIdleCamera(label) {
    const text = (label || '').toLowerCase();
    return /droidcam|obs virtual|virtual camera|manycam|snap camera|epoccam|iriun|nvidia broadcast|xsplit/.test(text);
  }

  pickPreferredProfilePhotoDevice(devices) {
    if (!devices?.length) return null;
    const withLabels = devices.filter((d) => (d.label || '').trim());
    const physical = (withLabels.length ? withLabels : devices).filter(
      (d) => !this.isLikelyVirtualOrIdleCamera(d.label)
    );
    return physical[0] || devices[0];
  }

  async listProfilePhotoCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  async populateProfilePhotoCameraSelect(devices, selectedDeviceId) {
    const select = document.getElementById('profilePhotoCameraSelect');
    const label = document.getElementById('profilePhotoCameraSelectLabel');
    if (!select) return;

    select.innerHTML = '';
    devices.forEach((device, index) => {
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.textContent = (device.label || '').trim() || `Camera ${index + 1}`;
      select.appendChild(opt);
    });

    const preferred = selectedDeviceId || this.pickPreferredProfilePhotoDevice(devices)?.deviceId;
    if (preferred) select.value = preferred;

    const showPicker = devices.length > 1;
    if (showPicker) {
      select.removeAttribute('hidden');
      label?.removeAttribute('hidden');
    } else {
      select.setAttribute('hidden', '');
      label?.setAttribute('hidden', '');
    }
  }

  updateProfilePhotoCameraHint(activeLabel) {
    const hint = document.getElementById('profilePhotoCameraHint');
    if (!hint) return;
    if (this.isLikelyVirtualOrIdleCamera(activeLabel)) {
      hint.textContent =
        'This camera is DroidCam (or similar) and is not streaming yet. Open the DroidCam app on your phone and connect, or pick your built-in webcam from the list above.';
      hint.removeAttribute('hidden');
    } else {
      hint.setAttribute('hidden', '');
      hint.textContent = '';
    }
  }

  profilePhotoCameraBlockedMessage() {
    const port = window.location.port || '5000';
    return (
      `On this computer, open http://127.0.0.1:${port}/dashboard for the camera, ` +
      'or use Upload photo here.'
    );
  }

  profilePhotoLocalhostUrl() {
    try {
      const u = new URL(window.location.href);
      const host = (u.hostname || '').toLowerCase();
      if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') return '';
      const port = u.port || '5000';
      return `http://127.0.0.1:${port}${u.pathname}${u.search}${u.hash}`;
    } catch (_e) {
      return '';
    }
  }

  profilePhotoNeedsLocalhostForCamera() {
    if (window.isSecureContext && window.location.protocol === 'https:') return false;
    const host = (window.location.hostname || '').toLowerCase();
    return host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]';
  }

  redirectProfilePhotoToLocalhost() {
    const localUrl = this.profilePhotoLocalhostUrl();
    if (!localUrl) {
      this.showNotification(this.profilePhotoCameraBlockedMessage(), 'error');
      return false;
    }
    const u = new URL(localUrl);
    u.searchParams.set('openCamera', '1');
    window.location.assign(u.toString());
    return true;
  }

  ensureProfilePhotoMediaDevices() {
    if (typeof navigator === 'undefined') return false;
    if (!navigator.mediaDevices) {
      navigator.mediaDevices = {};
    }
    if (typeof navigator.mediaDevices.getUserMedia === 'function') {
      return true;
    }
    const legacy =
      navigator.getUserMedia ||
      navigator.webkitGetUserMedia ||
      navigator.mozGetUserMedia ||
      navigator.msGetUserMedia;
    if (!legacy) return false;
    navigator.mediaDevices.getUserMedia = (constraints) =>
      new Promise((resolve, reject) => {
        legacy.call(navigator, constraints, resolve, reject);
      });
    return true;
  }

  async _requestProfilePhotoStream(videoConstraints) {
    this.ensureProfilePhotoMediaDevices();
    const gum = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    if (!gum) throw new Error('Camera API unavailable');
    try {
      return await gum({ video: videoConstraints, audio: false });
    } catch (err) {
      if (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError') {
        return gum({ video: true, audio: false });
      }
      throw err;
    }
  }

  async startProfilePhotoCamera(deviceId) {
    const panel = document.getElementById('profilePhotoCameraPanel');
    const video = document.getElementById('profilePhotoVideo');
    const select = document.getElementById('profilePhotoCameraSelect');
    if (!panel || !video) return;

    if (this.profilePhotoNeedsLocalhostForCamera()) {
      this.redirectProfilePhotoToLocalhost();
      return;
    }

    this.ensureProfilePhotoMediaDevices();
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      this.showNotification(
        'Camera is not supported in this browser. Use Upload photo or try Chrome/Edge.',
        'error'
      );
      return;
    }

    try {
      this.stopProfilePhotoCamera();
      panel.removeAttribute('hidden');
      document.querySelector('.profile-photo-actions')?.setAttribute('hidden', '');

      let cameras = await this.listProfilePhotoCameras();
      const needsPermission = cameras.every((d) => !(d.label || '').trim());
      if (needsPermission) {
        const bootstrap = await this._requestProfilePhotoStream(true);
        bootstrap.getTracks().forEach((track) => track.stop());
        cameras = await this.listProfilePhotoCameras();
      }

      const chosenId =
        deviceId ||
        select?.value ||
        this.pickPreferredProfilePhotoDevice(cameras)?.deviceId ||
        cameras[0]?.deviceId;

      await this.populateProfilePhotoCameraSelect(cameras, chosenId);

      const videoConstraints = chosenId
        ? { deviceId: { ideal: chosenId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } };

      const stream = await this._requestProfilePhotoStream(videoConstraints);
      this._profilePhotoStream = stream;
      video.srcObject = stream;
      await video.play();

      const active = cameras.find((d) => d.deviceId === chosenId);
      this.updateProfilePhotoCameraHint(active?.label || stream.getVideoTracks()[0]?.label || '');
    } catch (err) {
      const name = err?.name || '';
      let message = this.profilePhotoCameraBlockedMessage();
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        message =
          'Camera permission was denied. Click the lock/camera icon in the address bar, allow camera access, then try again.';
      } else if (name === 'NotFoundError') {
        message = 'No camera was found on this device. Use Upload photo instead.';
      } else if (name === 'NotReadableError') {
        message = 'The camera is in use by another app. Close it and try again.';
      }
      this.showNotification(message, 'error');
      panel.setAttribute('hidden', '');
      document.querySelector('.profile-photo-actions')?.removeAttribute('hidden');
      console.error(err);
    }
  }

  async uploadProfilePhotoBlob(blob, filename, { preview = true } = {}) {
    if (!blob) {
      this.showNotification('No photo to upload.', 'error');
      return false;
    }
    const heroName = document.getElementById('accountHeroName')?.textContent || 'Admin';
    if (preview) {
      this.previewAccountProfilePhoto(blob, heroName);
    }

    const uploadName =
      filename ||
      (blob.type === 'image/png' ? 'profile.png' : blob.type === 'image/webp' ? 'profile.webp' : 'profile.jpg');
    const mime = blob.type || 'image/jpeg';
    const file = blob instanceof File ? blob : new File([blob], uploadName, { type: mime });
    const fd = new FormData();
    fd.append('photo', file, uploadName);

    const captureBtn = document.getElementById('profilePhotoCaptureBtn');
    if (captureBtn) {
      captureBtn.disabled = true;
      captureBtn.textContent = 'Saving…';
    }

    try {
      const res = await fetch(beanthenticApiUrl('/api/admin-profile-photo'), {
        method: 'POST',
        body: fd,
        credentials: 'same-origin',
      });
      const result = await beanthenticParseJsonResponse(res);
      if (!res.ok || result.error) throw new Error(result.error || 'Could not update profile photo.');
      this.applyAccountProfilePhoto(result.profile_photo_url, heroName);
      this.showNotification(result.success || 'Profile photo saved.', 'success');
      this.closeProfilePhotoModal();
      return true;
    } catch (err) {
      this.showNotification(err.message || 'Could not update profile photo.', 'error');
      return false;
    } finally {
      if (captureBtn) {
        captureBtn.disabled = false;
        captureBtn.textContent = 'Save to profile';
      }
    }
  }

  async captureProfilePhotoFromCamera() {
    const video = document.getElementById('profilePhotoVideo');
    const canvas = document.getElementById('profilePhotoCanvas');
    if (!video || !canvas || !video.videoWidth) {
      this.showNotification('Camera is not ready yet. Wait for the preview or allow camera access.', 'error');
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) {
      this.showNotification('Could not capture photo.', 'error');
      return;
    }
    this.stopProfilePhotoCamera();
    await this.uploadProfilePhotoBlob(blob, 'camera-profile.jpg');
  }

  initProfilePhotoModal() {
    const editBtn = document.getElementById('accountAvatarEditBtn');
    const closeBtn = document.getElementById('closeProfilePhotoModalBtn');
    const backdrop = document.getElementById('profilePhotoModalBackdrop');
    const uploadBtn = document.getElementById('profilePhotoUploadBtn');
    const takeBtn = document.getElementById('profilePhotoTakeBtn');
    const fileInput = document.getElementById('profilePhotoFileInput');
    const captureBtn = document.getElementById('profilePhotoCaptureBtn');
    const cancelCameraBtn = document.getElementById('profilePhotoCancelCameraBtn');
    const root = document.getElementById('profilePhotoModal');

    if (editBtn) {
      editBtn.addEventListener('click', () => this.openProfilePhotoModal());
    }
    if (closeBtn) closeBtn.addEventListener('click', () => this.closeProfilePhotoModal());
    if (backdrop) backdrop.addEventListener('click', () => this.closeProfilePhotoModal());

    if (uploadBtn && fileInput) {
      uploadBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
          this.showNotification('Please choose an image file.', 'error');
          fileInput.value = '';
          return;
        }
        await this.uploadProfilePhotoBlob(file, file.name);
        fileInput.value = '';
      });
    }

    if (takeBtn) takeBtn.addEventListener('click', () => this.startProfilePhotoCamera());
    const cameraSelect = document.getElementById('profilePhotoCameraSelect');
    if (cameraSelect) {
      cameraSelect.addEventListener('change', () => {
        this.startProfilePhotoCamera(cameraSelect.value);
      });
    }
    if (captureBtn) captureBtn.addEventListener('click', () => this.captureProfilePhotoFromCamera());
    if (cancelCameraBtn) {
      cancelCameraBtn.addEventListener('click', () => {
        this.stopProfilePhotoCamera();
        document.getElementById('profilePhotoCameraPanel')?.setAttribute('hidden', '');
        document.querySelector('.profile-photo-actions')?.removeAttribute('hidden');
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!root || root.hasAttribute('hidden')) return;
      e.preventDefault();
      this.closeProfilePhotoModal();
    });

    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('openCamera') === '1') {
        params.delete('openCamera');
        const qs = params.toString();
        const clean = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash || ''}`;
        window.history.replaceState({}, '', clean);
        setTimeout(() => this.openProfilePhotoModal({ startCamera: true }), 0);
      }
    } catch (_e) {}
  }

  openDeactivateAccountModal() {
    const root = document.getElementById('deactivateAccountConfirmModal');
    const pwd = document.getElementById('deactivateAccountPassword');
    if (!root) return;
    if (pwd) pwd.value = '';
    root.removeAttribute('hidden');
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('confirm-dialog-active');
    pwd?.focus();
  }

  closeDeactivateAccountModal() {
    const root = document.getElementById('deactivateAccountConfirmModal');
    const pwd = document.getElementById('deactivateAccountPassword');
    if (root) {
      root.setAttribute('hidden', '');
      root.setAttribute('aria-hidden', 'true');
    }
    if (pwd) pwd.value = '';
    this.syncConfirmDialogBodyClass();
  }

  async confirmDeactivateAccount() {
    const pwd = (document.getElementById('deactivateAccountPassword')?.value || '').trim();
    if (!pwd) {
      this.showNotification('Enter your password to deactivate your account.', 'error');
      return;
    }
    const okBtn = document.getElementById('deactivateAccountConfirmOk');
    if (okBtn) okBtn.disabled = true;
    const fd = new FormData();
    fd.append('password', pwd);
    try {
      const res = await fetch(beanthenticApiUrl('/api/admin-account/deactivate'), { method: 'POST', body: fd });
      const result = await res.json();
      if (!res.ok || result.error) throw new Error(result.error || 'Could not deactivate account.');
      this.closeDeactivateAccountModal();
      this.showNotification(result.success || 'Account deactivated.', 'success');
      window.location.href = result.redirect || '/login';
    } catch (err) {
      this.showNotification(err.message || 'Could not deactivate account.', 'error');
    } finally {
      if (okBtn) okBtn.disabled = false;
    }
  }

  initDeactivateAccountModal() {
    const root = document.getElementById('deactivateAccountConfirmModal');
    const cancelBtn = document.getElementById('deactivateAccountConfirmCancel');
    const okBtn = document.getElementById('deactivateAccountConfirmOk');
    const backdrop = root?.querySelector('.confirm-dialog__backdrop');
    if (!root || !cancelBtn || !okBtn) return;

    cancelBtn.addEventListener('click', () => this.closeDeactivateAccountModal());
    okBtn.addEventListener('click', () => this.confirmDeactivateAccount());
    if (backdrop) backdrop.addEventListener('click', () => this.closeDeactivateAccountModal());

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (root.hasAttribute('hidden')) return;
      e.preventDefault();
      this.closeDeactivateAccountModal();
    });
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
    this.syncConfirmDialogBodyClass();
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
    this.startNotificationPolling();
    // Initialize new dashboard features
    this.initNewDashboardFeatures();
    // Initialize Account module
    this.initAccountModule();
    // Initialize Farmer's Contribution module
    this.initBeanthenticContributions();
    // IPOPHL Complete → GI Updates (delegated; survives cached/old phase button init)
    this.initIpophlCompleteRegistration();
    // Initialize Farmer Profile tabs
    this.initFarmerProfileTabs();
    // Initialize Map Layer Toggles
    this.initMapLayerToggles();
    // Initialize Farmer Admin Actions Modal
    this.initFarmerActionModal();
    this.initRecordsUnlockConfirmModal();
    this.initClientReportActionModal();
    // Start global suspension timers
    this.startSuspensionTimers();
    // Maps: reload pins from live farmer list
    this.initMapsLiveRefresh();

    // Global click listener to close custom dropdowns
    document.addEventListener('click', (e) => {
      // Close modern dropdowns
      if (!e.target.closest('.modern-dropdown')) {
        document.querySelectorAll('.modern-dropdown.active').forEach((d) => {
          d.classList.remove('active');
        });
      }

      // Close profile actions dropdown
      if (!e.target.closest('.profile-actions-dropdown')) {
        const content = document.getElementById('profileActionsContent');
        if (content) content.classList.remove('active');
        
        // Also close card menus
        document.querySelectorAll('.card-menu-content.active').forEach(c => {
          c.classList.remove('active');
        });
      }
    });
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
      list.innerHTML = window.BeanthenticUI
        ? window.BeanthenticUI.emptyState({
            icon: 'fa-bell',
            title: 'No notifications yet',
            hint: 'System alerts and farmer activity updates will show up here.',
          })
        : '<li class="notifications-empty">No notifications yet.</li>';
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
        return `<li class="notification-item${readClass}" data-notification-id="${esc(n.id)}" tabindex="0" aria-label="Open details: ${esc(n.title)}">
      <div class="notification-item-icon" aria-hidden="true"><i class="fa-solid ${esc(n.icon)}"></i></div>
      <div class="notification-item-body">
        <p class="notification-item-title">${esc(n.title)}</p>
        ${categoryMarkup}
        <p class="notification-item-meta">${esc(n.meta)}</p>
      </div>
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

  /** User-facing message from API error payloads (never show raw pymysql tuples). */
  formatAppLoadError(dataOrMessage, fallback) {
    let msg = '';
    if (dataOrMessage && typeof dataOrMessage === 'object') {
      msg =
        dataOrMessage.message ||
        dataOrMessage.detail ||
        dataOrMessage.error ||
        dataOrMessage.hint ||
        '';
    } else {
      msg = String(dataOrMessage || '');
    }
    msg = String(msg || fallback || 'Could not load data.').trim();
    const low = msg.toLowerCase();
    if (low.includes('mysql:') && low.includes('access denied')) {
      return (
        'MySQL login failed. Set app_db_host to your XAMPP PC LAN IP and the correct ' +
        'app_db_pass in settings.json (Connection Settings).'
      );
    }
    if (low.startsWith('mysql:') || low.includes('pymysql.err')) {
      return fallback || 'Could not connect to the app database. Check settings.json.';
    }
    if (low.includes('10035') || low.includes('non-blocking socket')) {
      return (
        'Temporary network glitch while loading data. Refresh the page or wait a few seconds and try again.'
      );
    }
    if (low.includes('supabase') || low.includes('beanthentic_supabase')) {
      return msg;
    }
    return msg;
  }

  varietyLabel(variety) {
    const raw = String(variety || '').trim();
    if (!raw) return '—';
    const v = raw.toLowerCase();
    if (v === 'liberica') return 'Liberica';
    if (v === 'excelsa') return 'Excelsa';
    if (v === 'robusta') return 'Robusta';
    // Compound product labels (e.g. "robusta · roasted beans · 250g")
    return raw
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  deltaCellClass(delta) {
    const n = Number(delta);
    if (Number.isNaN(n) || n === 0) return 'transactions-delta--zero';
    return n < 0 ? 'transactions-delta--out' : 'transactions-delta--in';
  }

  formatCoffeeDeltaKg(delta) {
    const n = Number(delta);
    if (Number.isNaN(n)) return '—';
    const abs = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return n >= 0 ? `+${abs}` : `−${abs}`;
  }

  movementLabel(delta) {
    const n = Number(delta);
    if (Number.isNaN(n) || n === 0) return 'No Change';
    return n < 0 ? 'Stock Out' : 'Stock In';
  }

  populateTransactionsYearFilter() {
    const select = document.getElementById('transactionsYearFilter');
    if (!select) return;
    const years = new Set();
    const nowY = new Date().getFullYear();
    years.add(nowY);
    (this.transactionsRows || []).forEach((row) => {
      const d = new Date(row.recorded_at || row.created_at || '');
      if (!Number.isNaN(d.getTime())) years.add(d.getFullYear());
    });
    const current = select.value;
    const sorted = [...years].sort((a, b) => b - a);
    select.innerHTML =
      '<option value="">All Years</option>' +
      sorted.map((y) => `<option value="${y}">${y}</option>`).join('');
    if (current && [...select.options].some((o) => o.value === current)) {
      select.value = current;
    }
  }

  applyTransactionsFiltersAndRender() {
    this.populateTransactionsYearFilter();
    const term = (this.transactionsSearchTerm || '').trim().toLowerCase();
    let rows = (this.transactionsRows || []).filter((row) => {
      // Variety Filter
      const varietyOk =
        !this.transactionsVarietyFilter ||
        String(row.variety || '').toLowerCase() === this.transactionsVarietyFilter;

      // Month/Year Filters
      let dateOk = true;
      if (row.recorded_at && (this.transactionsMonthFilter || this.transactionsYearFilter)) {
        const d = new Date(row.recorded_at);
        if (!Number.isNaN(d.getTime())) {
          if (this.transactionsMonthFilter && d.getMonth() + 1 !== parseInt(this.transactionsMonthFilter, 10)) {
            dateOk = false;
          }
          if (this.transactionsYearFilter && d.getFullYear() !== parseInt(this.transactionsYearFilter, 10)) {
            dateOk = false;
          }
        }
      }

      // Search Term
      const haystack = [
        row.farmer_name,
        row.farmer_no,
        row.buyer_name,
        row.notes,
        row.variety,
        row.recorded_by_phone,
        row.recorded_at,
      ]
        .map((x) => String(x || '').toLowerCase())
        .join(' ');
      const termOk = !term || haystack.includes(term);

      return varietyOk && dateOk && termOk;
    });

    // Sorting
    if (this.transactionsSortOrder === 'oldest') {
      rows.sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
    } else {
      rows.sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at));
    }

    // Pagination Logic
    const pageSize = 5;
    this.transactionsTotalPages = Math.ceil(rows.length / pageSize) || 1;
    if (this.transactionsCurrentPage > this.transactionsTotalPages) this.transactionsCurrentPage = this.transactionsTotalPages;
    if (this.transactionsCurrentPage < 1) this.transactionsCurrentPage = 1;

    const start = (this.transactionsCurrentPage - 1) * pageSize;
    const pagedRows = rows.slice(start, start + pageSize);

    // Update Pagination UI
    const pageInput = document.getElementById('txnMainPageInput');
    const totalPagesLabel = document.querySelector('.txn-page-of');
    if (pageInput) pageInput.value = this.transactionsCurrentPage;
    if (totalPagesLabel) totalPagesLabel.textContent = `of ${this.transactionsTotalPages}`;

    const prevBtn = document.getElementById('txnMainPrevBtn');
    const nextBtn = document.getElementById('txnMainNextBtn');
    if (prevBtn) prevBtn.disabled = this.transactionsCurrentPage <= 1;
    if (nextBtn) nextBtn.disabled = this.transactionsCurrentPage >= this.transactionsTotalPages;

    this.renderTransactionsTableBody(pagedRows);
  }

  async loadFarmerOptionsForTransactionsModule() {
    const filterSelect = document.getElementById('transactionsFarmerFilter');
    if (!filterSelect) return;
    try {
      const res = await fetch(beanthenticApiUrl('/api/farmer-picker'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      const opts = items
        .map((f) => {
          const id = String(f.id || '');
          const no = f.no != null ? `#${f.no} — ` : '';
          const name = this.escapeHtml((f.name || '').trim() || 'Farmer');
          return `<option value="${id}">${no}${name}</option>`;
        })
        .join('');
      const cur = this.transactionsFarmerFilterId != null ? String(this.transactionsFarmerFilterId) : '';
      filterSelect.innerHTML = `<option value="">All farmers</option>${opts}`;
      filterSelect.value = cur;
    } catch (e) {
      console.warn('Transactions farmer-picker failed:', e);
      filterSelect.innerHTML = '<option value="">All farmers</option>';
    }
  }

  renderTransactionsTableBody(rows) {
    const tbody = document.getElementById('transactionsTableBody');
    if (!tbody) return;

    if (!rows.length) {
      const emptyMsg =
        this.transactionsDataSource === 'app_mysql' || this.transactionsDataSource === 'app_server_http'
          ? 'No approved transactions yet. Approve in the farmer app Record page — they will appear here and in app History.'
          : 'No client transactions available';
      tbody.innerHTML =
        '<tr><td colspan="9" style="text-align: center; padding: 3rem; color: #94a3b8; font-weight: 500;">' +
        emptyMsg +
        '</td></tr>';
      return;
    }

    tbody.innerHTML = rows
      .map((row) => {
        const farmerNo = row.farmer_no != null && row.farmer_no !== '' ? `#${this.escapeHtml(row.farmer_no)}` : '—';
        const farmerName = this.escapeHtml(row.farmer_name || '—');
        
        let dateStr = '—';
        let timeStr = '—';
        if (row.recorded_at) {
          try {
            const d = new Date(row.recorded_at);
            if (!Number.isNaN(d.getTime())) {
              dateStr = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
              timeStr = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
            }
          } catch {
            dateStr = String(row.recorded_at);
          }
        }

        const deltaText = row.delta_kg != null ? `${Math.abs(row.delta_kg).toFixed(2)} kg` : '0.00 kg';
        const amountVal = row.amount != null ? Number(row.amount) : row.total != null ? Number(row.total) : 0;
        const amountText = `₱${this.formatReceiptMoney(amountVal)}`;
        const variety = this.varietyLabel(row.variety) || '—';
        const txnId = String(row.id || row.customer_transaction_id || '');

        return `<tr>
          <td style="font-weight: 600; color: #111827;">${farmerNo}</td>
          <td style="font-weight: 700;">${farmerName}</td>
          <td>${this.escapeHtml(dateStr)}</td>
          <td>${this.escapeHtml(row.buyer_name || '—')}</td>
          <td><span class="txn-product-badge">${this.escapeHtml(variety)}</span></td>
          <td style="font-weight: 700;">${this.escapeHtml(deltaText)}</td>
          <td style="font-weight: 700; color: #111827;">${this.escapeHtml(amountText)}</td>
          <td><button type="button" class="txn-view-btn" data-action="view-receipt" data-txn-id="${this.escapeHtml(txnId)}">Receipt</button></td>
        </tr>`;
      })
      .join('');
  }

  async loadTransactionsPage() {
    const tbody = document.getElementById('transactionsTableBody');
    if (!tbody) return;

    this.transactionsCurrentPage = 1; // Reset to page 1 on load
    await this.loadFarmerOptionsForTransactionsModule();
    tbody.innerHTML = window.BeanthenticUI?.loadingRow(9) || '<tr><td colspan="9" class="transactions-loading-cell">Loading...</td></tr>';

    try {
      const res = await fetch(beanthenticApiUrl('/api/transactions-list?limit=2000'));
      const data = await res.json().catch(() => ({}));
      if (data && data.ok === false) {
        throw new Error(
          this.formatAppLoadError(data, 'Could not load transactions.')
        );
      }
      if (!Array.isArray(data.items)) {
        if (!res.ok) {
          throw new Error(
            (data && data.detail) ||
              (data && data.error) ||
              'HTTP ' + res.status + ' — restart admin web (python web.py) after update.'
          );
        }
        throw new Error('Invalid response from server.');
      }
      this.transactionsRows = data.items;
      this.transactionsDataSource = data.source || '';
      this.populateTransactionsYearFilter();
      this.applyTransactionsFiltersAndRender();
    } catch (e) {
      console.warn('Transactions load failed:', e);
      this.transactionsRows = [];
      this.transactionsDataSource = '';
      const msg = this.escapeHtml(String(e.message || e));
      if (tbody) {
        tbody.innerHTML =
          '<tr><td colspan="9" style="text-align:center;padding:2rem 1.5rem;color:#94a3b8;font-weight:500;line-height:1.5;">' +
          'Could not load transactions.<br><span style="font-size:0.9rem;font-weight:600;">' +
          msg +
          '</span><br><span style="font-size:0.85rem;">Check <code>app_db_host</code> / <code>app_server_base</code> in settings.json and that XAMPP MySQL is running.</span></td></tr>';
      }
    }
  }

  getExampleTransactions() {
    const today = new Date();
    const getYmd = (daysAgo) => {
      const d = new Date();
      d.setDate(today.getDate() - daysAgo);
      return d.toISOString();
    };

    return [
      {
        id: 'ex-1',
        farmer_no: '12',
        farmer_name: 'Juan Dela Cruz',
        recorded_at: getYmd(0),
        buyer_name: 'Lipa Coffee Trading',
        variety: 'liberica',
        delta_kg: 25.5,
        amount: 3060.00
      },
      {
        id: 'ex-2',
        farmer_no: '08',
        farmer_name: 'Maria Santos',
        recorded_at: getYmd(1),
        buyer_name: 'Batangas Brew Co.',
        variety: 'robusta',
        delta_kg: 50.0,
        amount: 4500.00
      },
      {
        id: 'ex-3',
        farmer_no: '25',
        farmer_name: 'Ricardo Gomez',
        recorded_at: getYmd(2),
        buyer_name: 'Manila Coffee Roasters',
        variety: 'excelsa',
        delta_kg: 15.75,
        amount: 2205.00
      },
      {
        id: 'ex-4',
        farmer_no: '15',
        farmer_name: 'Elena Reyes',
        recorded_at: getYmd(3),
        buyer_name: 'Local Farmers Coop',
        variety: 'liberica',
        delta_kg: 30.2,
        amount: 3624.00
      },
      {
        id: 'ex-5',
        farmer_no: '03',
        farmer_name: 'Antonio Luna',
        recorded_at: getYmd(4),
        buyer_name: 'Global Bean Exports',
        variety: 'robusta',
        delta_kg: 100.0,
        amount: 9000.00
      }
    ];
  }

  formatReceiptMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0.00';
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  formatReceiptDateTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return { date: '-', time: '-' };
    }
    return {
      date: d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
      time: d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    };
  }

  findTransactionRow(txnId) {
    const key = String(txnId || '');
    return (this.transactionsRows || []).find(
      (r) => String(r.id) === key || String(r.customer_transaction_id) === key
    );
  }

  openReceipt(txnId) {
    const row = this.findTransactionRow(txnId);
    if (!row) return;

    const modal = document.getElementById('txnReceiptModal');
    if (!modal) return;

    this.__previousFocus = document.activeElement;

    const amountNum =
      row.amount != null
        ? Number(row.amount)
        : row.total != null
          ? Number(row.total)
          : 0;
    const paymentAmtNum =
      row.payment_amount != null
        ? Number(row.payment_amount)
        : row.paymentAmount != null
          ? Number(row.paymentAmount)
          : 0;
    const totalNum = row.total != null ? Number(row.total) : amountNum;
    const changeNum =
      row.change != null
        ? Number(row.change)
        : Math.max(0, paymentAmtNum - totalNum);
    const paymentText = (row.payment_method || row.payment || 'Cash').toString().trim() || 'Cash';
    const productText = this.varietyLabel(row.product || row.variety || '-');
    const qtyVal = row.qty != null ? row.qty : row.delta_kg;
    const qtyStr =
      qtyVal != null && String(qtyVal) !== ''
        ? `${qtyVal}${row.unit ? String(row.unit).toUpperCase() : 'KG'}`
        : '-';
    const ref = (row.reference_no || row.ref || '').toString().trim();
    const dt = this.formatReceiptDateTime(row.recorded_at);

    const setText = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    setText('receiptRef', ref ? `#${ref}` : '-');
    setText('receiptDate', dt.date);
    setText('receiptTime', dt.time);
    setText('receiptBuyerName', row.buyer_name || row.buyer || '-');
    setText('receiptProduct', productText);
    setText('receiptQty', qtyStr);
    setText('receiptAmount', this.formatReceiptMoney(amountNum));
    setText('receiptPayment', paymentText);
    setText('receiptPaymentAmount', this.formatReceiptMoney(paymentAmtNum));
    setText('receiptTotal', this.formatReceiptMoney(totalNum));
    setText('receiptChange', this.formatReceiptMoney(changeNum));

    modal.removeAttribute('hidden');
    modal.removeAttribute('aria-hidden');
    modal.removeAttribute('inert');
    document.body.classList.add('confirm-dialog-active');

    const closeBtn = document.getElementById('txnReceiptClose');
    if (closeBtn) setTimeout(() => closeBtn.focus(), 100);
  }

  closeReceipt() {
    console.log('CloseReceipt function called');
    const modal = document.getElementById('txnReceiptModal');
    if (modal) {
      // 1. Remove focus from anything inside the modal first
      if (document.activeElement && modal.contains(document.activeElement)) {
        document.activeElement.blur();
      }

      // 2. Set states
      modal.setAttribute('hidden', '');
      modal.setAttribute('aria-hidden', 'true');
      modal.setAttribute('inert', ''); // Prevents focus on descendants
      document.body.classList.remove('confirm-dialog-active');
      
      // 3. Return focus to where it was before opening
      if (this.__previousFocus && typeof this.__previousFocus.focus === 'function') {
        this.__previousFocus.focus();
        this.__previousFocus = null;
      }
      
      console.log('Modal hidden and focus handled');
    }
  }

  initTransactionsModuleControls() {
    if (this.__transactionsControlsInitialized) return;
    this.__transactionsControlsInitialized = true;

    const refreshBtn = document.getElementById('transactionsRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => this.loadTransactionsPage());

    const modal = document.getElementById('txnReceiptModal');
    const closeBtn = document.getElementById('txnReceiptClose');
    
    // Robust closing logic
    if (modal) {
      modal.addEventListener('click', (e) => {
        // Close if clicking specifically on the backdrop container
        if (e.target === modal || e.target.classList.contains('txn-receipt-backdrop')) {
          console.log('Backdrop clicked');
          this.closeReceipt();
        }
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        console.log('JS Close Button clicked');
        e.preventDefault();
        e.stopPropagation();
        this.closeReceipt();
      });
    }

    // Escape key support
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && !modal.hasAttribute('hidden')) {
        this.closeReceipt();
      }
    });

    const tbody = document.getElementById('transactionsTableBody');
    if (tbody) {
      tbody.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="view-receipt"]');
        if (btn) {
          const txnId = btn.getAttribute('data-txn-id');
          this.openReceipt(txnId);
        }
      });
    }

    const printBtn = document.getElementById('receiptPrintBtn');
    if (printBtn) {
      printBtn.addEventListener('click', () => {
        window.print();
      });
    }

    const search = document.getElementById('transactionsSearchInput');
    if (search) {
      search.addEventListener('input', (e) => {
        this.transactionsSearchTerm = String((e.target && e.target.value) || '');
        this.transactionsCurrentPage = 1;
        this.applyTransactionsFiltersAndRender();
      });
    }

    const sortFilter = document.getElementById('transactionsSortFilter');
    if (sortFilter) {
      sortFilter.addEventListener('change', () => {
        this.transactionsSortOrder = sortFilter.value;
        this.applyTransactionsFiltersAndRender();
      });
    }

    const monthFilter = document.getElementById('transactionsMonthFilter');
    if (monthFilter) {
      monthFilter.addEventListener('change', () => {
        this.transactionsMonthFilter = monthFilter.value;
        this.transactionsCurrentPage = 1;
        this.applyTransactionsFiltersAndRender();
      });
    }

    const yearFilter = document.getElementById('transactionsYearFilter');
    if (yearFilter) {
      yearFilter.addEventListener('change', () => {
        this.transactionsYearFilter = yearFilter.value;
        this.transactionsCurrentPage = 1;
        this.applyTransactionsFiltersAndRender();
      });
    }

    const productFilter = document.getElementById('transactionsProductFilter');
    if (productFilter) {
      productFilter.addEventListener('change', () => {
        this.transactionsVarietyFilter = productFilter.value.toLowerCase();
        this.transactionsCurrentPage = 1;
        this.applyTransactionsFiltersAndRender();
      });
    }

    // Pagination
    const prevBtn = document.getElementById('txnMainPrevBtn');
    const nextBtn = document.getElementById('txnMainNextBtn');
    const pageInput = document.getElementById('txnMainPageInput');

    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (this.transactionsCurrentPage > 1) {
          this.transactionsCurrentPage--;
          this.applyTransactionsFiltersAndRender();
        }
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        if (this.transactionsCurrentPage < (this.transactionsTotalPages || 1)) {
          this.transactionsCurrentPage++;
          this.applyTransactionsFiltersAndRender();
        }
      });
    }

    if (pageInput) {
      pageInput.addEventListener('change', () => {
        let val = parseInt(pageInput.value, 10);
        if (isNaN(val) || val < 1) val = 1;
        if (val > (this.transactionsTotalPages || 1)) val = this.transactionsTotalPages || 1;
        this.transactionsCurrentPage = val;
        this.applyTransactionsFiltersAndRender();
      });
    }
  }

  async renderClientReportModule() {
    this.initClientReportModuleControls();
    await this.loadMisconductReports();
  }

  initClientReportModuleControls() {
    if (this.__clientReportControlsInitialized) return;
    this.__clientReportControlsInitialized = true;

    this.clientReportSearchTerm = this.clientReportSearchTerm || '';
    this.clientReportStatusFilter = this.clientReportStatusFilter || '';

    const refreshBtn = document.getElementById('clientReportRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => {
      this.clientReportCurrentPage = 1;
      this.loadMisconductReports();
    });

    const search = document.getElementById('clientReportSearchInput');
    if (search) {
      search.addEventListener('input', (e) => {
        this.clientReportSearchTerm = String((e.target && e.target.value) || '');
        this.clientReportCurrentPage = 1;
        this.applyClientReportFiltersAndRender();
      });
    }

    const status = document.getElementById('clientReportStatusFilter');
    if (status) {
      status.addEventListener('change', () => {
        this.clientReportStatusFilter = String(status.value || '');
        this.clientReportCurrentPage = 1;
        this.applyClientReportFiltersAndRender();
      });
    }
  }

  async renderCoffeePricingModule() {
    this.initCoffeePricingModuleControls();
    await this.loadCoffeePricingData();
  }

  initCoffeePricingModuleControls() {
    if (this.__coffeePricingControlsInitialized) return;
    this.__coffeePricingControlsInitialized = true;

    const refreshBtn = document.getElementById('coffeePricingRefreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.loadCoffeePricingData());
    }

    const filter = document.getElementById('coffeePricingAppFilter');
    if (filter) {
      filter.addEventListener('change', () => this.loadCoffeePricingApplications());
    }

    this.initOfficialPricelistModal();

    const appsBody = document.getElementById('coffeePricingAppsBody');
    if (appsBody) {
      appsBody.addEventListener('click', (e) => {
        const approveBtn = e.target.closest('[data-app-approve]');
        const rejectBtn = e.target.closest('[data-app-reject]');
        if (approveBtn) {
          this.reviewPriceApplication(Number(approveBtn.dataset.appApprove || 0), 'approved', approveBtn);
        }
        if (rejectBtn) {
          this.reviewPriceApplication(Number(rejectBtn.dataset.appReject || 0), 'rejected', rejectBtn);
        }
      });
    }

    const unlockBody = document.getElementById('coffeePricingUnlockBody');
    if (unlockBody) {
      unlockBody.addEventListener('click', async (e) => {
        const viewBtn = e.target.closest('[data-view-farmer]');
        if (viewBtn) {
          const fid = Number(viewBtn.dataset.viewFarmer || 0);
          if (fid > 0) {
            this.switchModule('farmers-list');
            this.openFarmerProfile(fid, 'profiles');
          }
          return;
        }
        const unlockBtn = e.target.closest('[data-unlock-self-sale]');
        if (!unlockBtn) return;
        const fid = Number(unlockBtn.dataset.unlockSelfSale || 0);
        if (fid < 1) return;
        const farmerRow = (this.data || []).find((f) => this.farmerIdFromRow(f) === fid) || { farmer_id: fid };
        await this.setFarmerSelfSale(fid, true, farmerRow);
        this.renderCoffeePricingUnlockQueue();
      });
    }
    this.renderCoffeePricingUnlockQueue();
  }

  consolidationPreferenceOf(row) {
    return String(
      this.getValue(row, ['consolidation_preference', 'CONSOLIDATION PREFERENCE', 'delivery_preference']) || ''
    )
      .trim()
      .toLowerCase();
  }

  pricelistStatusOf(row) {
    return String(this.getValue(row, ['pricelist_status', 'PRICELIST STATUS']) || '')
      .trim()
      .toLowerCase();
  }

  isSelfSaleEnabledRow(row) {
    if (!row) return false;
    return row.self_sale_enabled === true || row.self_sale_enabled === 'true' || row.self_sale_enabled === 1;
  }

  isSellPathPreference(pref) {
    const p = String(pref || '').toLowerCase();
    return p === 'sell_produce' || p === 'drop_off_and_sell';
  }

  formatConsolidationPreference(pref) {
    const p = String(pref || '').trim().toLowerCase();
    if (p === 'all_to_consolidator') return 'Drop off at consolidator';
    if (p === 'sell_produce') return 'Sell produce';
    if (p === 'drop_off_and_sell') return 'Drop off and sell';
    if (p === 'drop_off_to_admin') return 'Drop-off to admin';
    return p ? this.formatPricingLabel(p) : 'Not set';
  }

  farmerRecordsAccessState(row) {
    const status = String(this.getValue(row, ['STATUS', 'status', 'farmer_status']) || '').trim().toLowerCase();
    const pref = this.consolidationPreferenceOf(row);
    const pls = this.pricelistStatusOf(row);
    const selfSale = this.isSelfSaleEnabledRow(row);
    const active = !status || status === 'active';
    if (selfSale) {
      return { unlocked: true, reason: '', label: 'Unlocked (self-sale)', pref, pls: pls || 'approved', selfSale };
    }
    if (!active) {
      return { unlocked: false, reason: 'inactive', label: 'Frozen (account inactive)', pref, pls, selfSale };
    }
    if (this.isSellPathPreference(pref) && pls === 'pending') {
      return { unlocked: false, reason: 'pricelist', label: 'Frozen (awaiting unlock)', pref, pls, selfSale };
    }
    return { unlocked: true, reason: '', label: 'Unlocked', pref, pls: pls || 'approved', selfSale };
  }

  farmerRecordsAccessHint(access) {
    if (!access || access.unlocked) return 'Records are unlocked for this farmer.';
    if (access.reason === 'inactive') return 'Account is inactive. Reactivate the farmer to unlock records.';
    if (access.reason === 'pricelist') {
      return 'Frozen until you enable self-sale or approve their pending price application.';
    }
    return access.label || 'Records are locked.';
  }

  farmerDisplayName(row) {
    return (
      this.getValue(row, ['NAME OF FARMER', 'name']) ||
      [this.getValue(row, ['FIRST NAME', 'first_name']), this.getValue(row, ['LAST NAME', 'last_name'])]
        .filter(Boolean)
        .join(' ')
        .trim() ||
      `Farmer #${this.farmerIdFromRow(row)}`
    );
  }

  renderCoffeePricingUnlockQueue() {
    const tbody = document.getElementById('coffeePricingUnlockBody');
    const countEl = document.getElementById('coffeePricingUnlockCount');
    if (!tbody) return;
    const rows = (Array.isArray(this.data) ? this.data : [])
      .map((row) => {
        const access = this.farmerRecordsAccessState(row);
        return { row, access, id: this.farmerIdFromRow(row) };
      })
      .filter((item) => item.id > 0 && !item.access.unlocked && item.access.reason === 'pricelist')
      .sort((a, b) => String(this.farmerDisplayName(a.row)).localeCompare(String(this.farmerDisplayName(b.row))));

    if (countEl) {
      countEl.textContent = rows.length ? `${rows.length} waiting` : 'All clear';
      countEl.classList.toggle('is-clear', rows.length === 0);
    }

    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="coffee-pricing-empty-cell">' +
        '<strong>All clear.</strong> Sell-path farmers (Sell or Drop-off &amp; Sell) appear here until you enable self-sale or approve their price application.' +
        '</td></tr>';
      return;
    }

    tbody.innerHTML = rows
      .map(({ row, access, id }) => {
        const prefLabel = this.formatConsolidationPreference(access.pref);
        const pls = access.pls || 'pending';
        return `<tr data-farmer-id="${id}">
          <td>${this.escapeHtml(this.farmerDisplayName(row))}</td>
          <td>${this.escapeHtml(prefLabel)}</td>
          <td>${this.escapeHtml(this.formatUnlockStatus(pls))}</td>
          <td>${access.selfSale ? 'On' : 'Off'}</td>
          <td title="${this.escapeHtml(this.farmerRecordsAccessHint(access))}">${this.escapeHtml(access.label)}<span class="pricing-frozen-hint">${this.escapeHtml(this.farmerRecordsAccessHint(access))}</span></td>
          <td>
            <div class="pricing-action-group">
              <button type="button" class="btn btn-primary btn-sm coffee-pricing-unlock-action" data-unlock-self-sale="${id}">
                Enable self-sale
              </button>
              <button type="button" class="btn btn-secondary btn-sm" data-view-farmer="${id}">View profile</button>
            </div>
          </td>
        </tr>`;
      })
      .join('');
  }

  formatUnlockStatus(value) {
    const v = String(value || '').trim().toLowerCase();
    if (v === 'pending') return 'Pending unlock';
    if (v === 'approved') return 'Approved';
    if (!v) return '—';
    return this.formatPricingLabel(v);
  }

  formatPhpAmount(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '—';
    return `₱${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  formatPricingLabel(value) {
    const v = String(value || '').trim();
    if (!v) return 'Default';
    return v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  async loadCoffeePricingData() {
    await Promise.all([this.loadCoffeePricelist(), this.loadCoffeePricingApplications()]);
    this.renderCoffeePricingUnlockQueue();
  }

  formatUnlockAuditLine(audit) {
    if (!audit || !audit.unlocked_at) return '';
    const who = String(audit.unlocked_by || 'Admin').trim() || 'Admin';
    let when = String(audit.unlocked_at);
    try {
      const d = new Date(audit.unlocked_at);
      if (!Number.isNaN(d.getTime())) {
        when = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      }
    } catch {
      /* keep raw */
    }
    const action = audit.enabled === false ? 'Last toggled off' : 'Unlocked';
    return `${action} by ${who} · ${when}`;
  }

  renderSelfSaleUnlockAuditLine(farmerId, elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const audit = this.selfSaleUnlockAuditByFarmer[Number(farmerId)];
    const line = this.formatUnlockAuditLine(audit);
    if (!line) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = line;
  }

  rememberSelfSaleUnlockAudit(farmerId, audit) {
    const fid = Number(farmerId);
    if (!fid || !audit) return;
    this.selfSaleUnlockAuditByFarmer[fid] = {
      unlocked_by: audit.unlocked_by || audit.by || 'Admin',
      unlocked_at: audit.unlocked_at || audit.at || new Date().toISOString(),
      enabled: audit.enabled !== false,
      pricelist_status: audit.pricelist_status || 'approved',
      records_unlocked: audit.records_unlocked !== false,
    };
  }

  initRecordsUnlockConfirmModal() {
    const root = document.getElementById('recordsUnlockConfirmModal');
    if (!root || root.dataset.bound) return;
    root.dataset.bound = '1';
    const closeBtn = document.getElementById('recordsUnlockConfirmClose');
    const viewBtn = document.getElementById('recordsUnlockConfirmView');
    const backdrop = root.querySelector('.confirm-dialog__backdrop');
    const close = () => this.closeRecordsUnlockConfirmation();
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (backdrop) backdrop.addEventListener('click', close);
    if (viewBtn) {
      viewBtn.addEventListener('click', () => {
        const fid = this._pendingUnlockConfirmFarmerId;
        this.closeRecordsUnlockConfirmation();
        if (fid) {
          this.switchModule('farmers-list');
          this.openFarmerProfile(fid, 'profiles');
        }
      });
    }
  }

  closeRecordsUnlockConfirmation() {
    const root = document.getElementById('recordsUnlockConfirmModal');
    if (!root) return;
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('confirm-dialog-active');
    this._pendingUnlockConfirmFarmerId = null;
  }

  showRecordsUnlockConfirmation(farmerId, audit = null) {
    const fid = Number(farmerId);
    if (!fid) return;
    if (audit) this.rememberSelfSaleUnlockAudit(fid, audit);
    const row = (this.data || []).find((f) => this.farmerIdFromRow(f) === fid) || null;
    const name = row ? this.farmerDisplayName(row) : `Farmer #${fid}`;
    const access = row ? this.farmerRecordsAccessState(row) : null;
    const stored = this.selfSaleUnlockAuditByFarmer[fid] || audit || {};

    this._pendingUnlockConfirmFarmerId = fid;
    this.switchModule('coffee-pricing');
    this.renderCoffeePricingUnlockQueue();

    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value || '—';
    };
    setText('recordsUnlockFarmerName', name);
    setText('recordsUnlockStatus', 'Active');
    setText('recordsUnlockPricelist', 'Approved');
    setText('recordsUnlockSelfSale', 'On');
    setText(
      'recordsUnlockAuditLine',
      this.formatUnlockAuditLine(stored) ||
        `Unlocked by ${(window.__BEANTHENTIC_USER__ && window.__BEANTHENTIC_USER__.full_name) || 'Admin'} · just now`
    );
    const msg = document.getElementById('recordsUnlockConfirmMessage');
    if (msg) {
      msg.textContent = access
        ? `Records access confirmed: ${access.label}. Unlock status is approved and self-sale is enabled.`
        : 'Records access confirmed: status active and unlock approved.';
    }

    const root = document.getElementById('recordsUnlockConfirmModal');
    if (!root) return;
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('confirm-dialog-active');
  }

  async loadCoffeePricelist() {
    const tbody = document.getElementById('coffeePricelistBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="3" class="transactions-loading-cell">Loading pricelist...</td></tr>';
    try {
      const res = await fetch(beanthenticApiUrl('/api/coffee-pricelist'), { credentials: 'same-origin' });
      const data = await beanthenticParseJsonResponse(res);
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load pricelist.');
      this.coffeePricelistOptions = data.options || {};
      this.coffeePricelistItems = Array.isArray(data.items) ? data.items : [];
      this.renderCoffeePricelistTable(this.coffeePricelistItems);
    } catch (err) {
      this.coffeePricelistItems = [];
      tbody.innerHTML = `<tr><td colspan="3" class="transactions-loading-cell">${this.escapeHtml(err.message || 'Load failed.')}</td></tr>`;
    }
  }

  normalizeOfficialPricelistItems(items) {
    const allItems = Array.isArray(items) ? items : [];
    const byVariety = new Map();
    allItems.forEach((item) => {
      if (item && item.is_active === false) return;
      const v = String(item.variety || '').toLowerCase();
      if (!v || byVariety.has(v)) return;
      byVariety.set(v, item);
    });
    const preferred = ['liberica', 'excelsa', 'robusta']
      .map((v) => byVariety.get(v))
      .filter(Boolean);
    return preferred.length ? preferred : allItems.filter((i) => i.is_active !== false);
  }

  renderCoffeePricelistTable(items) {
    const tbody = document.getElementById('coffeePricelistBody');
    if (!tbody) return;
    this.coffeePricelistItems = this.normalizeOfficialPricelistItems(items);

    if (!this.coffeePricelistItems.length) {
      tbody.innerHTML = '<tr><td colspan="3">No official pricelist rows yet. Refresh after server seed.</td></tr>';
      return;
    }

    tbody.innerHTML = this.coffeePricelistItems
      .map((item) => {
        const price = Number(item.price_per_kg || 0);
        const notes = String(item.notes || '').trim();
        return `<tr>
          <td>${this.escapeHtml(this.formatPricingLabel(item.variety))}</td>
          <td><strong>${this.formatPhpAmount(price)}</strong> <span class="coffee-pricelist-gcb-tag">GCB</span></td>
          <td>${notes ? this.escapeHtml(notes) : '<span class="coffee-pricelist-muted">—</span>'}</td>
        </tr>`;
      })
      .join('');
  }

  initOfficialPricelistModal() {
    const editBtn = document.getElementById('coffeePricelistEditBtn');
    const saveBtn = document.getElementById('officialPricelistSaveBtn');
    const cancelBtn = document.getElementById('officialPricelistCancelBtn');
    const root = document.getElementById('officialPricelistModal');
    if (!root || root.dataset.bound) return;
    root.dataset.bound = '1';
    const backdrop = root.querySelector('.confirm-dialog__backdrop');
    if (editBtn) editBtn.addEventListener('click', () => this.openOfficialPricelistModal());
    if (saveBtn) saveBtn.addEventListener('click', () => this.saveOfficialPricelistModal());
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.closeOfficialPricelistModal());
    if (backdrop) backdrop.addEventListener('click', () => this.closeOfficialPricelistModal());
  }

  openOfficialPricelistModal() {
    const root = document.getElementById('officialPricelistModal');
    const rowsEl = document.getElementById('officialPricelistFormRows');
    if (!root || !rowsEl) return;
    const items = this.normalizeOfficialPricelistItems(this.coffeePricelistItems || []);
    if (!items.length) {
      this.showNotification('Load the official pricelist first.', 'error');
      return;
    }
    rowsEl.innerHTML = items
      .map((item) => {
        const priceId = Number(item.price_id || 0);
        const variety = String(item.variety || '');
        return `<div class="official-pricelist-row" data-price-id="${priceId}">
          <input type="hidden" name="variety" value="${this.escapeHtml(variety)}" />
          <input type="hidden" name="bean_type" value="${this.escapeHtml(item.bean_type || 'gcb')}" />
          <input type="hidden" name="classification" value="${this.escapeHtml(item.classification || '')}" />
          <label class="official-pricelist-row-label">${this.escapeHtml(this.formatPricingLabel(variety))}</label>
          <div class="official-pricelist-row-fields">
            <label>Price / kg (₱)
              <input type="number" step="0.01" min="0" name="price_per_kg" value="${Number(item.price_per_kg || 0)}" required />
            </label>
            <label>Notes
              <input type="text" name="notes" value="${this.escapeHtml(item.notes || '')}" placeholder="Optional admin note" />
            </label>
          </div>
        </div>`;
      })
      .join('');
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('confirm-dialog-active');
  }

  closeOfficialPricelistModal() {
    const root = document.getElementById('officialPricelistModal');
    if (!root) return;
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('confirm-dialog-active');
  }

  readOfficialPricelistModalRow(rowEl) {
    const read = (name) => {
      const el = rowEl.querySelector(`[name="${name}"]`);
      return el ? el.value : '';
    };
    return {
      price_id: Number(rowEl.dataset.priceId || 0) || undefined,
      variety: read('variety'),
      bean_type: read('bean_type') || 'gcb',
      classification: read('classification'),
      price_per_kg: read('price_per_kg'),
      notes: read('notes'),
      is_active: true,
    };
  }

  async saveOfficialPricelistModal() {
    const rowsEl = document.getElementById('officialPricelistFormRows');
    if (!rowsEl) return;
    const rowEls = Array.from(rowsEl.querySelectorAll('.official-pricelist-row'));
    if (!rowEls.length) return;
    const saveBtn = document.getElementById('officialPricelistSaveBtn');
    if (saveBtn) saveBtn.disabled = true;
    try {
      for (const rowEl of rowEls) {
        const payload = this.readOfficialPricelistModalRow(rowEl);
        const res = await fetch(beanthenticApiUrl('/api/coffee-pricelist'), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await beanthenticParseJsonResponse(res);
        if (!res.ok || !data.ok) throw new Error(data.error || 'Save failed.');
      }
      this.showNotification('Official prices updated.', 'success');
      this.closeOfficialPricelistModal();
      await this.loadCoffeePricelist();
    } catch (err) {
      this.showNotification(err.message || 'Could not save official prices.', 'error');
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  async loadCoffeePricingApplications() {
    const tbody = document.getElementById('coffeePricingAppsBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="transactions-loading-cell">Loading applications...</td></tr>';
    const filter = document.getElementById('coffeePricingAppFilter');
    const status = filter ? String(filter.value || '') : 'pending';
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    try {
      const res = await fetch(`/api/farmer-price-applications${qs}`, { credentials: 'same-origin' });
      const data = await beanthenticParseJsonResponse(res);
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load applications.');
      this.renderCoffeePricingApplications(data.items || []);
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="transactions-loading-cell">${this.escapeHtml(err.message || 'Load failed.')}</td></tr>`;
    }
  }

  farmerNameById(farmerId) {
    const fid = Number(farmerId || 0);
    const sourceRows = Array.isArray(this.farmersData) && this.farmersData.length
      ? this.farmersData
      : (this.data || []);
    const row = sourceRows.find((f) => this.farmerIdFromRow(f) === fid);
    if (!row) return `Farmer #${fid}`;
    return this.getValue(row, ['NAME OF FARMER', 'name']) || `Farmer #${fid}`;
  }

  renderCoffeePricingApplications(items) {
    const tbody = document.getElementById('coffeePricingAppsBody');
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML = window.BeanthenticUI
        ? window.BeanthenticUI.emptyTableRow(6, {
            icon: 'fa-tags',
            title: 'No price applications found',
            hint: 'Farmer price requests will appear here once submitted.',
          })
        : '<tr><td colspan="6">No price applications found.</td></tr>';
      return;
    }
    tbody.innerHTML = items.map((item) => {
      const appId = Number(item.application_id || 0);
      const status = String(item.status || 'pending').toLowerCase();
      const notes = [item.farmer_notes, item.admin_notes].filter(Boolean).join(' · ');
      const requested = item.requested_price_per_kg != null ? this.formatPhpAmount(item.requested_price_per_kg) : '—';
      const reference = item.reference_price_per_kg != null ? this.formatPhpAmount(item.reference_price_per_kg) : '—';
      const reqNum = Number(item.requested_price_per_kg);
      const refNum = Number(item.reference_price_per_kg);
      let deltaClass = '';
      if (Number.isFinite(reqNum) && Number.isFinite(refNum) && refNum > 0) {
        const pct = ((reqNum - refNum) / refNum) * 100;
        deltaClass = pct > 5 ? 'is-above' : pct < -5 ? 'is-below' : 'is-near';
      }
      const actions = status === 'pending'
        ? `<div class="pricing-action-group pricing-action-group--stack">
            <button type="button" class="btn btn-primary btn-sm" data-app-approve="${appId}" title="Accept price, enable self-sale, and unlock Records">Approve price &amp; unlock Records</button>
            <button type="button" class="btn btn-secondary btn-sm" data-app-reject="${appId}">Reject</button>
          </div>`
        : '—';
      return `<tr>
        <td>
          <div>${this.escapeHtml(this.farmerNameById(item.farmer_id))}</div>
          ${notes ? `<small class="pricing-app-notes">${this.escapeHtml(notes)}</small>` : ''}
        </td>
        <td>${this.escapeHtml(this.formatPricingLabel(item.variety))}</td>
        <td>${Number(item.quantity_kg || 0).toLocaleString()}</td>
        <td>
          <div class="pricing-app-compare ${deltaClass}">
            <span><em>Requested</em> ${requested}</span>
            <span><em>Official</em> ${reference}</span>
          </div>
        </td>
        <td><span class="pricing-status-badge ${this.escapeHtml(status)}">${this.escapeHtml(status)}</span></td>
        <td>${actions}</td>
      </tr>`;
    }).join('');
  }

  async reviewPriceApplication(applicationId, status, triggerEl = null) {
    if (applicationId < 1) return;
    const farmerLabel =
      triggerEl && triggerEl.closest('tr')
        ? triggerEl.closest('tr').querySelector('td')?.textContent?.trim().split('\n')[0]
        : '';
    if (status === 'approved') {
      const ok = window.confirm(
        farmerLabel
          ? `Approve this price for ${farmerLabel}? This enables self-sale and unlocks Records.`
          : 'Approve this price? This enables self-sale and unlocks Records.'
      );
      if (!ok) return;
    }
    const notePrompt =
      status === 'rejected'
        ? 'Add a note for the farmer (reason for rejection):'
        : 'Optional admin note for this approval:';
    const note = window.prompt(notePrompt, '') || '';
    if (status === 'rejected' && !note.trim()) {
      const proceed = window.confirm('Reject without a note? The farmer will not see a reason.');
      if (!proceed) return;
    }
    try {
      const res = await fetch(`/api/farmer-price-applications/${applicationId}/review`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, admin_notes: note }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Review failed.');
      this.showNotification(
        status === 'approved'
          ? 'Application approved — self-sale / Records unlocked for this farmer.'
          : `Application ${status}.`,
        'success'
      );
      await this.loadCoffeePricingApplications();
      if (this.currentFarmerNo) {
        await this.loadFarmerSelfSaleApplications(this.currentFarmerNo);
      }
      // Refresh farmer rows so unlock queue / self-sale toggles stay in sync.
      try {
        await this.loadExcelData();
      } catch (_e) {
        /* ignore */
      }
      if (status === 'approved') {
        const farmerId = Number(data.item?.farmer_id || data.unlock_audit?.farmer_id || 0);
        if (farmerId > 0) {
          this.showRecordsUnlockConfirmation(farmerId, data.unlock_audit || null);
        }
      }
    } catch (err) {
      this.showNotification(err.message || 'Could not review application.', 'error');
    }
  }

  initFarmerSelfSalePanel(farmer) {
    const statusEl = document.getElementById('farmerSelfSaleStatus');
    const prefEl = document.getElementById('farmerSelfSalePreference');
    const appsWrap = document.getElementById('farmerSelfSaleApplicationsWrap');
    const manageBtn = document.getElementById('farmerSelfSaleManageBtn');
    const farmerId = this.farmerIdFromRow(farmer);
    const enabled = this.isSelfSaleEnabledRow(farmer);
    const access = this.farmerRecordsAccessState(farmer);

    if (prefEl) {
      prefEl.textContent = `Delivery preference: ${this.formatConsolidationPreference(access.pref)} · Unlock status: ${
        access.pls ? this.formatUnlockStatus(access.pls) : '—'
      } · Records: ${access.label}`;
    }

    if (manageBtn && !manageBtn.dataset.bound) {
      manageBtn.dataset.bound = '1';
      manageBtn.addEventListener('click', () => this.switchModule('coffee-pricing'));
    }

    if (statusEl) {
      statusEl.textContent = enabled
        ? 'Self-sale enabled — Records unlocked. Price applications are managed in Coffee Pricing.'
        : access.reason === 'pricelist'
          ? 'Self-sale is off — Records frozen. Enable self-sale from Coffee Pricing → Records Unlock Queue, or approve a price application.'
          : 'Self-sale is disabled for this farmer.';
      statusEl.classList.toggle('is-enabled', enabled);
      statusEl.classList.toggle('is-locked', !enabled && access.reason === 'pricelist');
    }
    this.renderSelfSaleUnlockAuditLine(farmerId, 'farmerSelfSaleAudit');

    if (appsWrap) {
      appsWrap.hidden = false;
    }

    if (farmerId) {
      this.loadFarmerSelfSaleApplications(farmerId);
    } else if (appsWrap) {
      const body = document.getElementById('farmerSelfSaleAppsBody');
      if (body) body.innerHTML = '<tr><td colspan="7">No applications yet.</td></tr>';
    }
  }

  async setFarmerSelfSale(farmerId, enabled, farmerRow) {
    try {
      const res = await fetch(beanthenticApiUrl('/api/farmer-self-sale'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ farmer_id: farmerId, enabled: !!enabled }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Update failed.');
      if (data.unlock_audit) this.rememberSelfSaleUnlockAudit(farmerId, data.unlock_audit);
      if (farmerRow) {
        farmerRow.self_sale_enabled = !!enabled;
        if (enabled) {
          farmerRow.pricelist_status = 'approved';
          farmerRow.status = 'active';
          farmerRow.STATUS = 'active';
        }
      }
      const cached = (this.data || []).find((f) => this.farmerIdFromRow(f) === Number(farmerId));
      if (cached) {
        cached.self_sale_enabled = !!enabled;
        if (enabled) {
          cached.pricelist_status = 'approved';
          cached.status = 'active';
          cached.STATUS = 'active';
        }
      }
      if (Array.isArray(this.farmersData)) {
        const cached2 = this.farmersData.find((f) => this.farmerIdFromRow(f) === Number(farmerId));
        if (cached2) {
          cached2.self_sale_enabled = !!enabled;
          if (enabled) {
            cached2.pricelist_status = 'approved';
            cached2.status = 'active';
            cached2.STATUS = 'active';
          }
        }
      }
      this.initFarmerSelfSalePanel(
        farmerRow || {
          farmer_id: farmerId,
          self_sale_enabled: enabled,
          pricelist_status: enabled ? 'approved' : undefined,
          status: enabled ? 'active' : undefined,
        }
      );
      this.renderCoffeePricingUnlockQueue();
      this.showNotification(
        enabled
          ? 'Self-sale enabled — Records module unlocked for this farmer.'
          : 'Self-sale disabled for farmer.',
        'success'
      );
      if (enabled) {
        this.showRecordsUnlockConfirmation(farmerId, data.unlock_audit || null);
        const phone = this.getValue(farmerRow || cached, ['PHONE', 'phone', 'PHONE NO.']);
        if (phone) {
          this.messagingApi('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
              recipient_phone: phone,
              category: 'pricing',
              subject: 'Price records unlocked',
              body: 'Your coffee records have been unlocked. You can now view the official pricelist and sell produce.',
            }),
          }).catch(() => {});
        }
      } else {
        this.renderSelfSaleUnlockAuditLine(farmerId, 'farmerSelfSaleAudit');
      }
    } catch (err) {
      this.showNotification(err.message || 'Could not update self-sale status.', 'error');
      this.initFarmerSelfSalePanel(farmerRow || { farmer_id: farmerId, self_sale_enabled: !enabled });
    }
  }

  async loadFarmerSelfSaleApplications(farmerId) {
    const body = document.getElementById('farmerSelfSaleAppsBody');
    if (!body) return;
    body.innerHTML = window.BeanthenticUI?.loadingRow(7) || '<tr><td colspan="7">Loading...</td></tr>';
    try {
      const res = await fetch(beanthenticApiUrl(`/api/farmer-price-applications?farmer_id=${encodeURIComponent(farmerId)}`), {
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load applications.');
      const items = data.items || [];
      if (!items.length) {
        body.innerHTML = '<tr><td colspan="7">No applications yet.</td></tr>';
        return;
      }
      body.innerHTML = items.map((item) => {
        const status = String(item.status || 'pending').toLowerCase();
        const submitted = item.submitted_at ? new Date(item.submitted_at).toLocaleDateString() : '—';
        return `<tr>
          <td>${this.escapeHtml(submitted)}</td>
          <td>${this.escapeHtml(this.formatPricingLabel(item.variety))}</td>
          <td>${this.escapeHtml(String(item.bean_type || '').toUpperCase())}</td>
          <td>${Number(item.quantity_kg || 0).toLocaleString()}</td>
          <td>${item.requested_price_per_kg != null ? this.formatPhpAmount(item.requested_price_per_kg) : '—'}</td>
          <td>${item.reference_price_per_kg != null ? this.formatPhpAmount(item.reference_price_per_kg) : '—'}</td>
          <td><span class="pricing-status-badge ${this.escapeHtml(status)}">${this.escapeHtml(status)}</span></td>
        </tr>`;
      }).join('');
    } catch (err) {
      body.innerHTML = `<tr><td colspan="7">${this.escapeHtml(err.message || 'Load failed.')}</td></tr>`;
    }
  }

  renderClientReportPagination() {
    const paginationEl = document.getElementById('clientReportPagination');
    if (!paginationEl) return;

    if (this.clientReportTotalPages <= 1) {
      paginationEl.innerHTML = '';
      return;
    }

    let html = '';
    
    // Prev button
    html += `<button class="page-btn" ${this.clientReportCurrentPage === 1 ? 'disabled' : ''} onclick="dashboardApp.changeClientReportPage(${this.clientReportCurrentPage - 1})"><i class="fa-solid fa-chevron-left"></i></button>`;

    // Page numbers
    const startPage = Math.max(1, this.clientReportCurrentPage - 2);
    const endPage = Math.min(this.clientReportTotalPages, startPage + 4);
    const adjustedStart = Math.max(1, endPage - 4);

    for (let i = adjustedStart; i <= endPage; i++) {
      html += `<button class="page-btn ${i === this.clientReportCurrentPage ? 'active' : ''}" onclick="dashboardApp.changeClientReportPage(${i})">${i}</button>`;
    }

    // Next button
    html += `<button class="page-btn" ${this.clientReportCurrentPage === this.clientReportTotalPages ? 'disabled' : ''} onclick="dashboardApp.changeClientReportPage(${this.clientReportCurrentPage + 1})"><i class="fa-solid fa-chevron-right"></i></button>`;

    paginationEl.innerHTML = html;
  }

  changeClientReportPage(page) {
    if (page < 1 || page > this.clientReportTotalPages) return;
    this.clientReportCurrentPage = page;
    this.applyClientReportFiltersAndRender();
  }

  async loadMisconductReports() {
    const tbody = document.getElementById('clientReportTableBody');
    if (!tbody) return;
    tbody.innerHTML = window.BeanthenticUI?.loadingRow(7) || '<tr><td colspan="7" class="transactions-loading-cell">Loading...</td></tr>';

    try {
      const res = await fetch(beanthenticApiUrl('/api/client-reports-list?limit=1000'), { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (data && data.ok === false) {
        throw new Error(
          this.formatAppLoadError(data, 'Could not load reports.')
        );
      }
      if (!Array.isArray(data.items)) {
        if (!res.ok) {
          throw new Error(
            (data && data.detail) ||
              (data && data.error) ||
              'HTTP ' + res.status + ' — restart admin web (python web.py) after update.'
          );
        }
        throw new Error('Invalid response from server.');
      }
      this.misconductReportRows = data.items;
      if (!Array.isArray(this.transactionsRows) || !this.transactionsRows.length) {
        try {
          const txnRes = await fetch(beanthenticApiUrl('/api/transactions-list?limit=2000'), { credentials: 'same-origin' });
          const txnData = await txnRes.json().catch(() => ({}));
          if (Array.isArray(txnData.items)) this.transactionsRows = txnData.items;
        } catch (_e) {
          /* optional for transaction deep-links */
        }
      }
      this.applyClientReportFiltersAndRender();
    } catch (e) {
      console.warn('Misconduct reports load failed:', e);
      const msg = this.escapeHtml(String(e.message || e));
      tbody.innerHTML =
        '<tr><td colspan="7" class="transactions-error-cell">Could not load reports.<br>' +
        msg +
        '</td></tr>';
      this.misconductReportRows = [];
      this.showNotification('Could not load misconduct reports.', 'error');
      this.updateClientReportCountLabel(0);
    }
  }

  applyClientReportFiltersAndRender() {
    const tbody = document.getElementById('clientReportTableBody');
    if (!tbody) return;

    const term = String(this.clientReportSearchTerm || '').trim().toLowerCase();
    const status = String(this.clientReportStatusFilter || '').trim().toLowerCase();
    const rows = Array.isArray(this.misconductReportRows) ? this.misconductReportRows : [];

    const filtered = rows.filter((r) => {
      if (status && String(r.status || '').toLowerCase() !== status) return false;
      if (!term) return true;
      const hay = [
        r.reporter_name,
        r.reporter_contact,
        r.farmer_name,
        r.allegation,
        r.status,
      ]
        .map((v) => String(v || '').toLowerCase())
        .join(' ');
      return hay.includes(term);
    });

    this.clientReportTotalPages = Math.ceil(filtered.length / this.clientReportPageSize);
    if (this.clientReportCurrentPage > this.clientReportTotalPages) {
      this.clientReportCurrentPage = Math.max(1, this.clientReportTotalPages);
    }

    if (!filtered.length) {
      tbody.innerHTML = window.BeanthenticUI
        ? window.BeanthenticUI.emptyTableRow(7, {
            icon: 'fa-flag',
            title: 'No reports found',
            hint: 'Misconduct and client reports will list here when filed.',
          })
        : '<tr><td colspan="7" class="transactions-error-cell">No reports found.</td></tr>';
      this.updateClientReportCountLabel(0);
      this.renderClientReportPagination();
      return;
    }

    const start = (this.clientReportCurrentPage - 1) * this.clientReportPageSize;
    const end = start + this.clientReportPageSize;
    const paged = filtered.slice(start, end);

    tbody.innerHTML = paged
      .map((r) => this.renderClientReportRow(r))
      .join('');
      
    this.updateClientReportCountLabel(filtered.length);
    this.renderClientReportPagination();
  }

  renderClientReportRow(r) {
    let dateStr = '—';
    let timeStr = '—';
    if (r.created_at) {
      try {
        const d = new Date(r.created_at);
        if (!Number.isNaN(d.getTime())) {
          dateStr = d.toLocaleDateString(undefined, { dateStyle: 'medium' });
          timeStr = d.toLocaleTimeString(undefined, { timeStyle: 'short' });
        }
      } catch {
        dateStr = String(r.created_at);
      }
    }

    const farmerLabel = this.escapeHtml(r.farmer_name || '—');
    const statusValue = String(r.status || 'under review').toLowerCase();
    const statusClass = statusValue.replace(/\s+/g, '-');
    const farmerRef = Number(r.farmer_id || r.farmer_no || 0);
    const txnId = this.resolveClientReportTransactionId(r);
    const profileBtn = farmerRef
      ? `<button type="button" class="client-report-link-btn" data-client-report-link="farmer" data-farmer-ref="${farmerRef}">Profile</button>`
      : `<button type="button" class="client-report-link-btn is-disabled" disabled title="No farmer linked">Profile</button>`;
    const txnBtn = txnId
      ? `<button type="button" class="client-report-link-btn" data-client-report-link="transaction" data-txn-id="${txnId}" data-farmer-ref="${farmerRef || ''}">Transaction</button>`
      : `<button type="button" class="client-report-link-btn is-disabled" disabled title="No related transaction">Transaction</button>`;

    return `<tr data-report-id="${Number(r.id) || 0}">
      <td>${this.escapeHtml(dateStr)}</td>
      <td>${this.escapeHtml(timeStr)}</td>
      <td>${farmerLabel}</td>
      <td>${this.escapeHtml(r.allegation || '')}</td>
      <td><span class="client-report-status-pill is-${this.escapeHtml(statusClass)}">${this.escapeHtml(this.clientReportStatusLabel(statusValue))}</span></td>
      <td><div class="client-report-links">${profileBtn}${txnBtn}</div></td>
      <td>
        <div class="report-action-container">
          <button class="take-action-btn" type="button" data-client-report-action="${Number(r.id) || 0}">
            Update status
          </button>
        </div>
      </td>
    </tr>`;
  }

  resolveClientReportTransactionId(report) {
    const direct = Number(report?.customer_transaction_id || report?.transaction_id || 0);
    if (direct > 0) return direct;
    const farmerId = Number(report?.farmer_id || report?.farmer_no || 0);
    if (!farmerId) return 0;
    const rows = Array.isArray(this.transactionsRows) ? this.transactionsRows : [];
    const match = rows.find((txn) => Number(txn.farmer_id || txn.farmer_no || 0) === farmerId);
    return Number(match?.id || match?.customer_transaction_id || 0) || 0;
  }

  async updateMisconductStatus(reportId, newStatus, resolutionNote = '') {
    try {
      const res = await fetch(`/api/misconduct-reports/${reportId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ status: newStatus, resolution_note: resolutionNote }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      this.showNotification(`Report #${reportId} updated to ${newStatus}`, 'success');
      await this.loadMisconductReports();
    } catch (e) {
      console.warn('Status update failed:', e);
      this.showNotification(e.message || 'Could not update status.', 'error');
      await this.loadMisconductReports();
    }
  }

  initClientReportActionModal() {
    const root = document.getElementById('clientReportActionModal');
    if (!root || root.dataset.bound) return;
    root.dataset.bound = '1';
    const cancelBtn = document.getElementById('clientReportActionCancel');
    const saveBtn = document.getElementById('clientReportActionSave');
    const statusSelect = document.getElementById('clientReportStatusSelect');
    const noteInput = document.getElementById('clientReportResolutionNote');
    const requiredMark = document.getElementById('clientReportNoteRequiredMark');
    const backdrop = root.querySelector('.confirm-dialog__backdrop');

    const syncNoteRequirement = () => {
      const status = String(statusSelect?.value || '').toLowerCase();
      const needsNote = ['closed', 'resolved', 'dismissed'].includes(status);
      if (requiredMark) requiredMark.hidden = !needsNote;
      if (noteInput) noteInput.required = needsNote;
    };

    if (statusSelect) statusSelect.addEventListener('change', syncNoteRequirement);
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.closeClientReportActionModal());
    if (backdrop) backdrop.addEventListener('click', () => this.closeClientReportActionModal());
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const reportId = Number(root.dataset.reportId || 0);
        const status = String(statusSelect?.value || '').trim();
        const note = String(noteInput?.value || '').trim();
        if (!reportId || !status) return;
        if (['closed', 'resolved', 'dismissed'].includes(status.toLowerCase()) && !note) {
          this.showNotification('Add a resolution note before closing this report.', 'error');
          noteInput?.focus();
          return;
        }
        saveBtn.disabled = true;
        try {
          await this.updateMisconductStatus(reportId, status, note);
          this.closeClientReportActionModal();
        } finally {
          saveBtn.disabled = false;
        }
      });
    }

    const table = document.getElementById('clientReportTable');
    if (table && !table.dataset.reportLinksBound) {
      table.dataset.reportLinksBound = '1';
      table.addEventListener('click', (e) => {
        const actionBtn = e.target.closest('[data-client-report-action]');
        if (actionBtn) {
          this.openReportActionModal(Number(actionBtn.dataset.clientReportAction || 0));
          return;
        }
        const linkBtn = e.target.closest('[data-client-report-link]');
        if (!linkBtn || linkBtn.disabled) return;
        const kind = linkBtn.dataset.clientReportLink;
        if (kind === 'farmer') {
          this.openClientReportFarmerProfile(Number(linkBtn.dataset.farmerRef || 0));
        } else if (kind === 'transaction') {
          this.openClientReportTransaction(
            Number(linkBtn.dataset.txnId || 0),
            Number(linkBtn.dataset.farmerRef || 0)
          );
        }
      });
    }
    syncNoteRequirement();
  }

  closeClientReportActionModal() {
    const root = document.getElementById('clientReportActionModal');
    if (!root) return;
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('confirm-dialog-active');
    delete root.dataset.reportId;
  }

  openReportActionModal(reportId) {
    const report = (this.misconductReportRows || []).find((r) => Number(r.id) === Number(reportId));
    if (!report) return;
    const root = document.getElementById('clientReportActionModal');
    const statusSelect = document.getElementById('clientReportStatusSelect');
    const noteInput = document.getElementById('clientReportResolutionNote');
    const subtitle = document.getElementById('clientReportActionSubtitle');
    if (!root || !statusSelect) {
      // Fallback: open farmer profile if modal markup is missing.
      this.openClientReportFarmerProfile(Number(report.farmer_id || report.farmer_no || 0));
      return;
    }
    root.dataset.reportId = String(reportId);
    const current = String(report.status || 'under review').toLowerCase();
    const options = [...statusSelect.options].map((o) => o.value);
    statusSelect.value = options.includes(current) ? current : 'under review';
    if (noteInput) noteInput.value = report.resolution_note || '';
    if (subtitle) {
      subtitle.textContent = `Report #${reportId} · ${report.farmer_name || 'Farmer'} — a resolution note is required for Closed / Resolved / Dismissed.`;
    }
    statusSelect.dispatchEvent(new Event('change'));
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('confirm-dialog-active');
  }

  openClientReportFarmerProfile(farmerRef) {
    const ref = Number(farmerRef);
    if (!ref) {
      this.showNotification('Farmer record not found for this report.', 'error');
      return;
    }
    this.switchModule('farmers-list');
    this.openFarmerProfile(ref, 'client-report');
  }

  async openClientReportTransaction(txnId, farmerRef = 0) {
    const id = Number(txnId);
    this.switchModule('transactions');
    if (!Array.isArray(this.transactionsRows) || !this.transactionsRows.length) {
      await this.loadTransactionsPage();
    }
    if (farmerRef) {
      this.transactionsFarmerFilterId = Number(farmerRef);
      const filterSelect = document.getElementById('transactionsFarmerFilter');
      if (filterSelect) filterSelect.value = String(farmerRef);
      this.applyTransactionsFiltersAndRender();
    }
    if (id > 0) {
      this.openReceipt(id);
    } else {
      this.showNotification('No related transaction for this report.', 'info');
    }
  }

  clientReportStatusLabel(value) {
    const v = String(value || '').toLowerCase();
    if (v === 'blocked') return 'Blocked';
    if (v === 'resolved') return 'Resolved';
    if (v === 'dismissed') return 'Dismissed';
    if (v === 'closed') return 'Closed';
    return 'Under review';
  }

  updateClientReportCountLabel(count) {
    const el = document.getElementById('clientReportCountLabel');
    if (!el) return;
    const n = Number(count) || 0;
    el.textContent = `${n} report${n === 1 ? '' : 's'}`;
  }

  openAccountModuleFromHeader() {
    this.switchModule('account');
    // Keep URL state in sync when opening from the header icon.
    if (window.location.hash !== '#account') {
      window.location.hash = 'account';
    }
    this.loadAccountData();
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
      messagingBtn.addEventListener('click', async () => {
        this.switchModule('messaging');
        await this.openLatestUnreadMessageThread();
      });
    }

    const accountBtn = document.getElementById('accountBtn');
    if (accountBtn) {
      accountBtn.addEventListener('click', () => {
        this.openAccountModuleFromHeader();
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

    // Farmer Profile Actions Dropdown
    const profileActionsToggle = document.getElementById('profileActionsToggle');
    const profileActionsContent = document.getElementById('profileActionsContent');
    if (profileActionsToggle && profileActionsContent) {
      profileActionsToggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        profileActionsContent.classList.toggle('active');
      });

      // Close dropdown when clicking anywhere else
      document.addEventListener('click', (e) => {
        if (!profileActionsToggle.contains(e.target) && !profileActionsContent.contains(e.target)) {
          profileActionsContent.classList.remove('active');
        }
      });
    }

    // Sidebar submenu toggles
    const submenuToggles = [
      { link: 'sidebarFarmersLink', submenu: 'sidebarFarmersSubmenu' },
      { link: 'sidebarTransactionsLink', submenu: 'sidebarTransactionsSubmenu' },
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
        const item = e.target.closest('.notification-item');
        if (!item) return;
        const id = item.getAttribute('data-notification-id');
        if (id) this.openNotificationDetail(id);
      });
      notificationsListEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const item = e.target.closest('.notification-item');
        if (!item) return;
        e.preventDefault();
        const id = item.getAttribute('data-notification-id');
        if (id) this.openNotificationDetail(id);
      });
    }



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
        // Toggle card menu
        const toggle = e.target.closest('.card-menu-toggle');
        if (toggle) {
          e.preventDefault();
          e.stopPropagation();
          const content = toggle.nextElementSibling;
          if (content) {
            // Close other open card menus first
            document.querySelectorAll('.card-menu-content.active').forEach(c => {
              if (c !== content) c.classList.remove('active');
            });
            content.classList.toggle('active');
          }
          return;
        }

        // Handle card actions (Warning/Suspend/Unsuspend)
        const actionBtn = e.target.closest('[data-card-action]');
        if (actionBtn) {
          e.preventDefault();
          e.stopPropagation();
          const action = actionBtn.getAttribute('data-card-action');
          const farmerId = Number(actionBtn.getAttribute('data-farmer-id'));
          const idx = this.farmerIndexById(farmerId);
          
          if (idx !== -1) {
            if (action === 'warning') {
              this.openFarmerActionModal('warning', idx);
            } else if (action === 'unsuspend') {
              // Unsuspend directly without modal
              this.handleUnblockFarmer(idx, 'Manual Unsuspend');
            } else {
              this.openFarmerActionModal(action, idx);
            }
          }
          
          // Close the menu
          const content = actionBtn.closest('.card-menu-content');
          if (content) content.classList.remove('active');
          return;
        }

        const btn = e.target.closest('[data-action="open-farmer-profile"]');
        if (btn) {
          const idRaw = btn.getAttribute('data-farmer-id') || btn.getAttribute('data-farmer-no') || '';
          const farmerId = Number.parseInt(idRaw, 10);
          if (Number.isFinite(farmerId)) this.openFarmerProfile(farmerId);
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

    const farmerProfileMessageBtn = document.getElementById('farmerProfileMessageBtn');
    if (farmerProfileMessageBtn) {
      farmerProfileMessageBtn.addEventListener('click', () => {
        if (!this.currentFarmerNo) return;
        const farmer = this.farmerRowById(this.currentFarmerNo);
        if (farmer) {
          const phone = this.getValue(farmer, ['PHONE', 'phone', 'PHONE NO.', 'Phone No.']);
          if (phone) {
            this.goToFarmerMessage(phone);
          } else {
            this.showNotification('Farmer phone number not found.', 'error');
          }
        }
      });
    }

    const btnViewFarmerProduction = document.getElementById('btnViewFarmerProduction');
    if (btnViewFarmerProduction) {
      btnViewFarmerProduction.addEventListener('click', () => this.openFarmerProductionModal());
    }
    const closeFarmerProductionModalBtn = document.getElementById('closeFarmerProductionModalBtn');
    if (closeFarmerProductionModalBtn) {
      closeFarmerProductionModalBtn.addEventListener('click', () => this.closeFarmerProductionModal());
    }
    const farmerProductionModalBackdrop = document.getElementById('farmerProductionModalBackdrop');
    if (farmerProductionModalBackdrop) {
      farmerProductionModalBackdrop.addEventListener('click', () => this.closeFarmerProductionModal());
    }

    // Farmer Profile Admin Actions
    const profileWarningBtn = document.getElementById('profileWarningBtn');
    if (profileWarningBtn) {
      profileWarningBtn.addEventListener('click', () => {
        // Automatically close dropdown on click
        const profileActionsContent = document.getElementById('profileActionsContent');
        if (profileActionsContent) profileActionsContent.classList.remove('active');

        if (this.currentFarmerNo) {
          const idx = this.farmerIndexById(this.currentFarmerNo);
          if (idx !== -1) {
            this.openFarmerActionModal('warning', idx);
          }
        }
      });
    }

    const profileSuspendBtn = document.getElementById('profileSuspendBtn');
    if (profileSuspendBtn) {
      profileSuspendBtn.addEventListener('click', () => {
        // Automatically close dropdown on click
        const profileActionsContent = document.getElementById('profileActionsContent');
        if (profileActionsContent) profileActionsContent.classList.remove('active');

        if (this.currentFarmerNo) {
          const idx = this.farmerIndexById(this.currentFarmerNo);
          if (idx !== -1) {
            const isBlocked = this.data[idx].is_blocked === true || this.data[idx].is_blocked === 'true';
            if (isBlocked) {
              // Unsuspend directly without modal
              this.handleUnblockFarmer(idx, 'Manual Unsuspend');
            } else {
              this.openFarmerActionModal('suspend', idx);
            }
          }
        }
      });
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
        this.mapSearchTerm = this.normalizeBarangayName((e.target.value || '').toString());
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
    const addFarmerBtn = document.getElementById('addFarmerBtn') || document.querySelector('.add-farmer-btn');
    if (addFarmerBtn) {
      addFarmerBtn.addEventListener('click', () => this.openAddFarmerModal());
    }

    const loadSampleBtn = document.getElementById('loadSampleBtn');
    if (loadSampleBtn) {
      loadSampleBtn.addEventListener('click', () => {
        this.loadSampleData();
        this.showNotification('Sample data loaded successfully!', 'success');
      });
    }

    const saveFarmersBtn = document.getElementById('saveFarmersBtn') || document.querySelector('.save-btn');
    if (saveFarmersBtn) {
      saveFarmersBtn.addEventListener('click', () => this.saveFarmers());
    }

    this.initAddFarmerModal();

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

    // Inline edit + row actions (event delegation)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      
      const action = btn.getAttribute('data-action');
      const idx = Number.parseInt(btn.getAttribute('data-row-index') || '', 10);
      if (!Number.isFinite(idx) || idx < 0) return;
      if (!this.data[idx]) return;

      if (action === 'warning-farmer') {
        this.openFarmerActionModal('warning', idx);
      } else if (action === 'block-farmer') {
        this.openFarmerActionModal('suspend', idx);
      } else if (action === 'unblock-farmer') {
        this.handleUnblockFarmer(idx, 'Manual Unsuspend');
      } else if (action === 'delete-farmer') {
        this.openDeleteFarmerConfirm(idx);
      }
    });

    this.initDeleteFarmerConfirmModal();
    this.initLogoutConfirmModal();
    this.initProfilePhotoModal();
    this.initDeactivateAccountModal();

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
    const settingsTabs = new Set(['security', 'activity', 'faq', 'profile']);
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
      'farmers': "Farmer's Record",
      'farmers-list': "Farmer's Profile",
      'maps': 'Maps',
      'transactions': 'Client Transaction',
      'client-report': 'Client Report',
      'coffee-pricing': 'Coffee Pricing',
      'register': 'IPOPHL Register',
      'security': 'Account Security',
      'activity': 'Activity Log',
      'faq': 'FAQ',
      'profile': 'Profile Actions',
      'analytics': 'Analytics',
      'ipophl': 'IPOPHL',
      'social-media': 'Social Media',
      'settings': 'Settings',
      'account': 'Account',
      'messaging': 'Messaging'
    };
    if (currentModule) {
      currentModule.textContent = moduleNames[moduleName] || 'Overview';
      currentModule.classList.remove('is-updating');
      void currentModule.offsetWidth;
      currentModule.classList.add('is-updating');
    }

    // Load account data when switching to account module
    if (moduleName === 'account') {
      this.loadAccountData();
    }

    // Switch modules with a brief enter animation
    const modules = document.querySelectorAll('.module');
    modules.forEach(module => {
      module.classList.add('hidden');
    });

    const targetModule = document.getElementById(`${resolvedModuleName}-module`);
    if (targetModule) {
      targetModule.classList.remove('hidden');
      targetModule.classList.remove('is-entering');
      void targetModule.offsetWidth;
      targetModule.classList.add('is-entering');
      window.setTimeout(() => targetModule.classList.remove('is-entering'), 360);
    }

    const moduleContent = document.querySelector('.module-content');
    if (moduleContent) {
      moduleContent.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // Scroll behavior: lock page scroll for Farmers and Messaging (inner panes scroll)
    if (moduleContent) {
      moduleContent.classList.toggle(
        'lock-scroll',
        resolvedModuleName === 'farmers' || resolvedModuleName === 'messaging'
      );
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
    if (resolvedModuleName === 'farmers-list') {
      this.renderFarmersListCards();
    }
    if (resolvedModuleName === 'register') {
      this.renderRegisterModule();
      this.loadContributionsFromApi();
    }
    if (resolvedModuleName === 'transactions') {
      this.loadTransactionsPage();
    }
    if (resolvedModuleName === 'client-report') {
      this.renderClientReportModule();
    }
    if (resolvedModuleName === 'coffee-pricing') {
      this.renderCoffeePricingModule();
    }
    if (resolvedModuleName === 'ipophl') {
      this.renderIpophlModule();
      if (window.ipophlAnalyzer?.rebindAllFileCards) {
        window.ipophlAnalyzer.rebindAllFileCards();
      }
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
    const d2 = document.getElementById('disable2faConfirmModal');
    if (
      logoutEl?.hasAttribute('hidden') &&
      del?.hasAttribute('hidden') &&
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
        desc: 'Change your password to keep your account safe.',
        icon: 'fa-shield-halved',
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
        desc: 'Quick answers about passwords and account security.',
        icon: 'fa-circle-question',
      },
      {
        tab: 'profile',
        title: 'Profile Actions',
        desc: 'Update your name or sign out.',
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
      activity: '/admin/settings/activity_log.html',
      faq: '/admin/settings/faq.html',
      profile: '/admin/settings/profile_actions.html',
    };

    const titleMap = {
      security: 'Account Security',
      activity: 'Activity Log',
      faq: 'FAQ',
      profile: 'Profile Actions',
    };

    const resolvedTab = fragments[tab] ? tab : 'security';
    const url = beanthenticApiUrl(fragments[resolvedTab]);

    if (titleEl) titleEl.textContent = titleMap[resolvedTab] || 'Account Security';
    if (pageTitleEl) pageTitleEl.textContent = titleMap[resolvedTab] || 'Settings';

    container.innerHTML = window.BeanthenticUI?.loadingPanel('Loading settings') || 'Loading...';
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
      q.setAttribute('aria-expanded', item.classList.contains('active') ? 'true' : 'false');
      q.addEventListener('click', () => {
        item.classList.toggle('active');
        a.classList.toggle('active');
        q.setAttribute('aria-expanded', item.classList.contains('active') ? 'true' : 'false');
      });
    });

    // Activity log search
    const search = containerEl.querySelector('#activitySearch');
    const actionFilter = containerEl.querySelector('#activityActionFilter');
    const tbody = containerEl.querySelector('#activityTableBody');
    if (tbody) {
      try {
        const res = await fetch(beanthenticApiUrl('/api/activity-feed'), { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        const items = Array.isArray(data.items) ? data.items : [];
        if (items.length) {
          tbody.innerHTML = items
            .map((entry) => {
              const ts = this.escapeHtml(this.formatNotificationMeta(entry.timestamp) || entry.timestamp || '—');
              const action = this.escapeHtml(entry.action || '—');
              const details = this.escapeHtml(entry.details || '');
              const ip = this.escapeHtml(entry.ip_address || '—');
              return `<tr><td>${ts}</td><td>${action}</td><td>${details}</td><td>${ip}</td></tr>`;
            })
            .join('');
        } else {
          tbody.innerHTML = '<tr><td colspan="4">No activity recorded yet.</td></tr>';
        }
      } catch (_) {
        tbody.innerHTML = '<tr><td colspan="4">Could not load activity log.</td></tr>';
      }

      const rows = Array.from(tbody.querySelectorAll('tr'));

      const getRowActionText = (row) => {
        const tds = row.querySelectorAll('td');
        if (tds.length >= 2) return (tds[1].textContent || '').trim().toLowerCase();
        return '';
      };

      const applyFilters = () => {
        const term = (search?.value || '').toLowerCase().trim();
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
      !!containerEl.querySelector('#profileForm');

    let state = null;
    if (needsServerState) {
      state = await this.fetchSettingsState();
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
          this.updateAdminGreeting(fullName);
          this.showNotification(result.success || 'Profile updated.', 'success');
        } catch {
          this.showNotification('Could not update profile.', 'error');
        }
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
    if (enable2faBtn) {
      enable2faBtn.addEventListener('click', () => {
        this.showNotification('2FA feature is currently unavailable.', 'info');
      });
    }
  }

  async loadExcelData() {
    try {
      console.log('Loading farmer data from database API...');

      // Always fetch from DB-backed API so Flask-Admin changes
      // are immediately reflected on the website.
      const response = await fetch(beanthenticApiUrl('/api/farmer-data'));
      console.log('API response status:', response.status);
      let apiData;
      try {
        apiData = await response.json();
      } catch (_parseErr) {
        apiData = null;
      }

      if (!response.ok) {
        const detail =
          apiData && typeof apiData === 'object' && apiData.detail
            ? String(apiData.detail)
            : apiData && typeof apiData === 'object' && apiData.error
              ? String(apiData.error)
              : `HTTP ${response.status}`;
        throw new Error(detail || 'Failed to fetch farmer data from database');
      }

      if (apiData && typeof apiData === 'object' && !Array.isArray(apiData)) {
        if (apiData.error) {
          throw new Error(String(apiData.detail || apiData.error));
        }
      }

      console.log('Received data length:', Array.isArray(apiData) ? apiData.length : 0);
      this.data = Array.isArray(apiData)
        ? apiData
            .filter((row) => this.isFarmerRegistrationComplete(row))
            .slice(0, this.maxFarmers)
            .map((row) => this.applyOwnershipFlags(row))
        : [];
      this.farmersData = this.data;
      if (this.data.length === 0) {
        this.showNotification(
          'No completed farmer registrations yet. Records appear here only after a farmer finishes the full app registration.',
          'brown'
        );
      }
      
      this.filteredData = [...this.data];
      this.totalRecords = this.data.length;
      
      console.log('Successfully loaded farmer data:', this.data.length, 'records');
      console.log('First farmer:', this.data[0]);
      console.log('Sample of farmers:', this.data.slice(0, 3));

      try {
        localStorage.setItem('beanthentic_farmers', JSON.stringify(this.data));
      } catch (_) {
        /* ignore quota errors */
      }
      this.renderCoffeePricingUnlockQueue();

      this.updateStats();
      this.createCharts();
      this.updateTable();
      this.detectNewFarmersFromData();
      this.fetchAdminNotifications({ silent: true, showToastOnNewRegistration: true });
      
    } catch (error) {
      console.error('Error loading farmer data:', error);
      
      // 1. Try to fallback to browser backup first
      const saved = this.loadSavedFarmers();
      if (Array.isArray(saved) && saved.length) {
        this.data = saved
          .filter((row) => this.isFarmerRegistrationComplete(row))
          .slice(0, this.maxFarmers);
        this.farmersData = this.data;
        this.filteredData = [...this.data];
        this.totalRecords = this.data.length;
        this.renderCoffeePricingUnlockQueue();
        this.updateStats();
        this.createCharts();
        this.updateTable();
        const backupMsg =
          error && error.message
            ? `Could not load farmer data (${error.message}). Showing saved browser backup.`
            : 'Could not load farmer data from Supabase. Showing saved browser backup.';
        this.showNotification(backupMsg, 'error');
        return;
      }

      console.log('API and Backup unavailable. Showing empty farmer list.');
      this.data = [];
      this.farmersData = [];
      this.filteredData = [];
      this.totalRecords = 0;
      this.showNotification(
        error && error.message
          ? `Could not load farmer records (${error.message}). Demo data is disabled.`
          : 'Could not load farmer records. Check the app database connection.',
        'error'
      );
      
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
        'RSBSA NUMBER': 'RSB-2026-001',
        'NCFRS': 'NCF001',
        'PHONE': '+63 912 345 6789'
      },
      {
        'NO.': 2,
        'LAST NAME': 'Silva',
        'FIRST NAME': 'Anghelito',
        'ADDRESS (BARANGAY)': 'San Pedro',
        'BIRTHDAY': '1985-05-20',
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
        'RSBSA NUMBER': 'RSB-2026-002',
        'NCFRS': 'NCF002',
        'PHONE': '+63 923 456 7890'
      },
      {
        'NO.': 3,
        'LAST NAME': 'Malaluan',
        'FIRST NAME': 'Avelino',
        'ADDRESS (BARANGAY)': 'San Miguel',
        'BIRTHDAY': '1978-11-10',
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
        'RSBSA NUMBER': 'RSB-2026-003',
        'NCFRS': 'NCF003',
        'PHONE': '+63 934 567 8901'
      }
    ];
    this.farmersData = this.data;
    
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

  getSuspensionCountdown(until) {
    if (!until) return '';
    const diff = until - Date.now();
    if (diff <= 0) return 'Lifting...';

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    let parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);

    return parts.join(' ');
  }

  startSuspensionTimers() {
    if (this.suspensionInterval) clearInterval(this.suspensionInterval);
    this.suspensionInterval = setInterval(() => {
      let needsRefresh = false;
      
      // Update countdowns in cards and profile
      document.querySelectorAll('.suspension-countdown').forEach(el => {
        const until = Number(el.dataset.until);
        if (until) {
          const now = Date.now();
          const diff = until - now;
          
          if (diff <= 0) {
            // Auto-unsuspend if time is up
            const farmerId = Number(el.dataset.farmerId);
            const idx = this.farmerIndexById(farmerId);
            if (idx !== -1 && this.data[idx].is_blocked) {
              this.data[idx].is_blocked = false;
              delete this.data[idx].suspended_until;
              needsRefresh = true;
            }
            el.textContent = 'Lifting...';
          } else {
            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((diff % (1000 * 60)) / 1000);
            
            // Standard text update (Hidden but still useful for card views)
            if (el.id !== 'profileSuspensionTimer') {
              el.textContent = this.getSuspensionCountdown(until);
            }
            
            // Special boxed update for profile view
            if (el.id === 'profileSuspensionTimer') {
              const d = document.getElementById('timerDays');
              const h = document.getElementById('timerHours');
              const m = document.getElementById('timerMinutes');
              
              if (d) d.textContent = String(days).padStart(2, '0');
              if (h) h.textContent = String(hours).padStart(2, '0');
              if (m) m.textContent = String(minutes).padStart(2, '0');
            }
          }
        }
      });

      if (needsRefresh) {
        this.renderFarmersListCards();
        this.renderTableBody();
        this.refreshMapFromLiveFarmers({ silent: true, reloadFarmers: false });
        if (this.currentFarmerNo) {
          const idx = this.farmerIndexById(this.currentFarmerNo);
          if (idx !== -1) this.updateProfileStatusButtons(this.data[idx].is_blocked);
        }
      }
    }, 1000);
  }

  renderFarmersListCards() {
    const grid = document.getElementById('farmersCardGrid');
    if (!grid) return;

    const startIndex = (this.currentPage - 1) * this.pageSize;
    const endIndex = Math.min(startIndex + this.pageSize, this.filteredData.length);
    const pageData = this.filteredData.slice(startIndex, endIndex);

    const esc = (s) =>
      String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    if (!pageData.length) {
      if (this.data.length === 0) {
        grid.innerHTML = window.BeanthenticUI
          ? `<div style="grid-column: 1 / -1;">${window.BeanthenticUI.emptyState({
              icon: 'fa-people-group',
              title: 'No completed registrations yet',
              hint: 'Farmers appear here only after they finish the full registration in the mobile app.',
            })}</div>`
          : `
          <div class="placeholder-content" style="grid-column: 1 / -1; padding: 4rem 2rem;">
            <div class="placeholder-icon"><i class="fa-solid fa-people-group"></i></div>
            <h3>No completed registrations yet</h3>
            <p>Farmers appear here only after they finish the full registration in the mobile app.</p>
          </div>
        `;
        return;
      }
        grid.innerHTML = window.BeanthenticUI
          ? `<div style="grid-column: 1 / -1;">${window.BeanthenticUI.emptyState({
              icon: 'fa-magnifying-glass',
              title: 'No matching farmers',
              hint: 'Try a different name, barangay, or phone number.',
            })}</div>`
          : `
          <div class="placeholder-content" style="grid-column: 1 / -1; padding: 4rem 2rem;">
            <div class="placeholder-icon"><i class="fa-solid fa-magnifying-glass"></i></div>
            <h3>No matching farmers</h3>
            <p>Try a different name, barangay, or phone number.</p>
          </div>
        `;
        return;
    }

    const formatNo = (row) => this.farmerDisplaySeqNo(row, this.data);
    const buildName = (row) => this.farmerDisplayNameFromRow(row);

    grid.innerHTML = pageData
      .map((row) => {
        const displaySeq = formatNo(row);
        const farmerId = this.farmerIdFromRow(row);
        const fullName = buildName(row) || `Farmer #${displaySeq || ''}`.trim();
        const dob = this.getValue(row, ['BIRTHDAY', 'birthday', 'Date of Birth']);
        const phone = this.getValue(row, ['PHONE', 'phone', 'PHONE NO.', 'Phone No.']);
        const address = this.getValue(row, ['ADDRESS (BARANGAY)', 'barangay', 'BARANGAY', 'address']) || 'Address not set';
        const isBlocked = row.is_blocked === true || row.is_blocked === 'true';
        const photoUrl = this.farmerProfilePhotoUrl(row);
        const photoAttr = photoUrl ? ` data-photo-url="${esc(photoUrl)}"` : '';
        
        return `<article class="farmer-card" aria-label="${esc(fullName)}">
  <div class="farmer-card__header">
    <div class="farmer-card__header-badges">
      <div class="farmer-card__status-badge ${isBlocked ? 'is-blocked' : ''}">
        ${isBlocked ? 'Suspended' : 'Active'}
        ${isBlocked && row.suspended_until ? `<span class="suspension-countdown" data-until="${row.suspended_until}" data-farmer-id="${esc(farmerId)}">${this.getSuspensionCountdown(row.suspended_until)}</span>` : ''}
      </div>
    </div>
    <div class="profile-actions-dropdown">
      <button type="button" class="profile-actions-toggle card-menu-toggle" aria-label="More actions">
        <i class="fa-solid fa-ellipsis"></i>
      </button>
      <div class="profile-actions-content card-menu-content">
        <button type="button" class="profile-action-item warning" data-card-action="warning" data-farmer-id="${esc(farmerId)}">
          <i class="fa-solid fa-triangle-exclamation"></i> Warning
        </button>
        ${!isBlocked ? `
          <button type="button" class="profile-action-item suspend" data-card-action="suspend" data-farmer-id="${esc(farmerId)}">
            <i class="fa-solid fa-user-slash"></i> Suspend
          </button>
        ` : `
          <button type="button" class="profile-action-item unsuspend" data-card-action="unsuspend" data-farmer-id="${esc(farmerId)}">
            <i class="fa-solid fa-user-check"></i> Unsuspend
          </button>
        `}
      </div>
    </div>
  </div>
  <div class="farmer-card__media">
    <div class="farmer-card__avatar-circle" data-farmer-id="${esc(farmerId)}"${photoAttr}>
      <img class="farmer-card__image" alt="${esc(fullName)}" hidden />
      <i class="fa-solid fa-user farmer-card__avatar-fallback" style="font-size: 2rem; color: #cbd5e1;"></i>
    </div>
  </div>
  <div class="farmer-card__identity">
    <h3 class="farmer-card__name">${esc(fullName)}</h3>
  </div>
  <div class="farmer-card__inner-box" style="background: #ffffff; border: 1px solid #f1f5f9;">
    <div class="farmer-card__detail-row">
      <i class="fa-solid fa-hashtag"></i>
      <span>#${esc(displaySeq)}</span>
    </div>
    <div class="farmer-card__detail-row">
      <i class="fa-solid fa-cake-candles"></i>
      <span>${esc(dob || '—')}</span>
    </div>
    <div class="farmer-card__detail-row">
      <i class="fa-solid fa-location-dot"></i>
      <span>${esc(address || '—')}</span>
    </div>
    <div class="farmer-card__detail-row">
      <i class="fa-solid fa-phone"></i>
      <span class="farmer-card__pill" style="background: #f8fafc; border: 1px solid #e2e8f0; color: #475569;">${esc(phone || '—')}</span>
    </div>
  </div>
  <div class="farmer-card__footer">
    <button type="button" class="view-details-btn" data-action="open-farmer-profile" data-farmer-id="${esc(farmerId)}">
      View details <i class="fa-solid fa-chevron-right"></i>
    </button>
  </div>
</article>`;
      })
      .join('');
    this.hydrateFarmerCardPhotos();
  }

  openFarmerProfile(farmerRef, source = 'profiles') {
    this.farmerProfileSource = source;
    const profileView = document.getElementById('farmerProfileView');
    const listView = document.getElementById('farmersListView');
    if (!profileView || !listView) return;

    // Update Back button text based on source
    const backBtn = document.getElementById('farmerProfileBackBtn');
    if (backBtn) {
      const span = backBtn.querySelector('span');
      if (span) {
        span.textContent = source === 'client-report' ? 'Back to Client Report' : 'Back to Profiles';
      }
    }

    // Reset See More state
    const detailsArea = document.getElementById('detailsScrollArea');
    const seeMoreBtn = document.getElementById('btnSeeMoreDetails');
    if (detailsArea) detailsArea.classList.remove('expanded');
    if (seeMoreBtn) seeMoreBtn.textContent = 'See more';

    const farmer = this.resolveFarmerFromRef(farmerRef);
    if (!farmer) {
      this.showNotification('Farmer not found.', 'error');
      return;
    }

    const farmerId = this.farmerIdFromRow(farmer);
    const displaySeq = this.farmerDisplaySeqNo(farmer);
    this.currentFarmerNo = farmerId;
    this.updateProfileStatusButtons(farmer.is_blocked === true || farmer.is_blocked === 'true');

    const fullName =
      this.getValue(farmer, ['NAME OF FARMER', 'name', 'FULL NAME', 'full_name']) ||
      [this.getValue(farmer, ['FIRST NAME', 'first_name', 'firstName']), this.getValue(farmer, ['LAST NAME', 'last_name', 'lastName'])]
        .filter(Boolean)
        .join(' ')
        .trim() ||
      `Farmer #${displaySeq}`;

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
    this.applyFarmerProfileAvatar(farmer);
    setText('farmerProfileNo', `No. ${displaySeq}`);
    setText('farmerProfileDob', this.getValue(farmer, ['BIRTHDAY', 'birthday']) || '—');
    setText('farmerProfilePhone', this.getValue(farmer, ['PHONE', 'phone', 'PHONE NO.', 'Phone No.']) || '—');
    setText('farmerProfileAddress', this.getValue(farmer, ['ADDRESS (BARANGAY)', 'address', 'BARANGAY']) || '—');

    setText('farmerProfileLastNameText', this.getValue(farmer, ['LAST NAME', 'last_name']) || nameParts.last);
    setText('farmerProfileFirstNameText', this.getValue(farmer, ['FIRST NAME', 'first_name']) || nameParts.first);
    setText('farmerProfileProvinceText', this.getValue(farmer, ['PROVINCE', 'province']) || 'Batangas');
    setText('farmerProfileMunicipalityText', this.getValue(farmer, ['MUNICIPALITY', 'municipality', 'CITY']) || 'Lipa City');
    setText('farmerProfileBarangayText', this.getValue(farmer, ['BARANGAY', 'ADDRESS (BARANGAY)', 'barangay']) || '');
    setText('farmerProfileFederationText', this.getValue(farmer, ['FA OFFICER / MEMBER', 'FEDERATION', 'Federation Association']) || '');
    setText(
      'farmerProfileRsbsaText',
      this.getValue(farmer, ['RSBSA Registered (Yes/No)', 'RSBSA Registered', 'REGISTERED (YES/NO)']) || ''
    );
    setText(
      'farmerProfileRsbsaNumberText',
      this.getValue(farmer, ['RSBSA NUMBER', 'RSBSA Registered Number', 'rsbsa_number']) || ''
    );
    setText(
      'farmerProfileRsbsaStatusText',
      this.getValue(farmer, ['RSBSA Status', 'RSBSA STATUS', 'rsbsa_status']) || ''
    );
    setText('farmerProfileNcfrsText', this.getValue(farmer, ['NCFRS', 'ncfrs']) || '');
    setText('farmerProfileOwnershipText', this.getValue(farmer, ['STATUS OF OWNERSHIP', 'Status Ownership']) || '');
    setText(
      'farmerProfileTotalAreaText',
      this.formatAreaHa(this.getValue(farmer, ['TOTAL AREA PLANTED (HA.)', 'Total Plant Area', 'TOTAL AREA', 'farm_size_ha']) || '')
    );
    setText(
      'farmerProfileCoffeeVarietiesText',
      this.getValue(farmer, ['COFFEE VARIETIES', 'coffee_varieties', 'coffee_variety']) || ''
    );
    const deliveryPref = this.getValue(farmer, ['COFFEE DISTRIBUTION', 'coffee_distribution', 'distribution_option']) || '';
    const flowSummary = this.getDeliveryFlowSummary(farmer);
    setText('farmerProfileDistributionText', flowSummary ? `${deliveryPref || 'Mixed'} (${flowSummary})` : deliveryPref);
    setText('farmerProfileFlowPreferenceText', deliveryPref || '—');
    setText('farmerProfileFlowSummaryText', flowSummary || 'No split quantity');
    setText('farmerProfileFlowLibText', this.formatVarietyFlowLine(farmer, 'liberica'));
    setText('farmerProfileFlowExcText', this.formatVarietyFlowLine(farmer, 'excelsa'));
    setText('farmerProfileFlowRobText', this.formatVarietyFlowLine(farmer, 'robusta'));

    // Populate Detailed Registration Fields
    setText('farmerProfileLibBearingText', this.varietyValueOrBlank(farmer, 'liberica', this.getValue(farmer, ['LIBERICA BEARING', 'Liberica_Bearing']) || '0', '—'));
    setText('farmerProfileLibNonBearingText', this.varietyValueOrBlank(farmer, 'liberica', this.getValue(farmer, ['LIBERICA NON-BEARING', 'Liberica_Non-bearing']) || '0', '—'));
    setText('farmerProfileRobBearingText', this.varietyValueOrBlank(farmer, 'robusta', this.getValue(farmer, ['ROBUSTA BEARING', 'Robusta_Bearing']) || '0', '—'));
    setText('farmerProfileRobNonBearingText', this.varietyValueOrBlank(farmer, 'robusta', this.getValue(farmer, ['ROBUSTA NON-BEARING', 'Robusta_Non-bearing']) || '0', '—'));
    setText('farmerProfileExcBearingText', this.varietyValueOrBlank(farmer, 'excelsa', this.getValue(farmer, ['EXCELSA BEARING', 'Excelsa_Bearing']) || '0', '—'));
    setText('farmerProfileExcNonBearingText', this.varietyValueOrBlank(farmer, 'excelsa', this.getValue(farmer, ['EXCELSA NON-BEARING', 'Excelsa_Non-bearing']) || '0', '—'));

    // Harvest quantities
    const libHarvest = this.getVarietyHarvestProduction(farmer, 'liberica');
    const excHarvest = this.getVarietyHarvestProduction(farmer, 'excelsa');
    const robHarvest = this.getVarietyHarvestProduction(farmer, 'robusta');
    const fmtProd = (value) => this.formatKg(value);
    setText('farmerProfileHarvestLibQtyText', this.varietyValueOrBlank(farmer, 'liberica', this.formatQtyWithUnit(libHarvest, this.getVarietyHarvestUnit(farmer, 'liberica')), '—'));
    setText('farmerProfileHarvestExcQtyText', this.varietyValueOrBlank(farmer, 'excelsa', this.formatQtyWithUnit(excHarvest, this.getVarietyHarvestUnit(farmer, 'excelsa')), '—'));
    setText('farmerProfileHarvestRobQtyText', this.varietyValueOrBlank(farmer, 'robusta', this.formatQtyWithUnit(robHarvest, this.getVarietyHarvestUnit(farmer, 'robusta')), '—'));

    // GCB details
    setText('farmerProfileGcbLibClassText', this.varietyValueOrBlank(farmer, 'liberica', this.formatGcbClassification(farmer, 'liberica') || '—', '—'));
    setText('farmerProfileGcbLibQtyText', this.varietyValueOrBlank(farmer, 'liberica', fmtProd(this.getVarietyProduction(farmer, 'liberica')), '—'));
    setText('farmerProfileGcbExcClassText', this.varietyValueOrBlank(farmer, 'excelsa', this.formatGcbClassification(farmer, 'excelsa') || '—', '—'));
    setText('farmerProfileGcbExcQtyText', this.varietyValueOrBlank(farmer, 'excelsa', fmtProd(this.getVarietyProduction(farmer, 'excelsa')), '—'));
    setText('farmerProfileGcbRobClassText', this.varietyValueOrBlank(farmer, 'robusta', this.formatGcbClassification(farmer, 'robusta') || '—', '—'));
    setText('farmerProfileGcbRobQtyText', this.varietyValueOrBlank(farmer, 'robusta', fmtProd(this.getVarietyProduction(farmer, 'robusta')), '—'));

    // Roasted details
    setText('farmerProfileRoastedLibClassText', this.varietyValueOrBlank(farmer, 'liberica', this.formatRoastedClassification(farmer, 'liberica') || '—', '—'));
    setText('farmerProfileRoastedLibQtyText', this.varietyValueOrBlank(farmer, 'liberica', fmtProd(this.getVarietyRoastedProduction(farmer, 'liberica')), '—'));
    setText('farmerProfileRoastedExcClassText', this.varietyValueOrBlank(farmer, 'excelsa', this.formatRoastedClassification(farmer, 'excelsa') || '—', '—'));
    setText('farmerProfileRoastedExcQtyText', this.varietyValueOrBlank(farmer, 'excelsa', fmtProd(this.getVarietyRoastedProduction(farmer, 'excelsa')), '—'));
    setText('farmerProfileRoastedRobClassText', this.varietyValueOrBlank(farmer, 'robusta', this.formatRoastedClassification(farmer, 'robusta') || '—', '—'));
    setText('farmerProfileRoastedRobQtyText', this.varietyValueOrBlank(farmer, 'robusta', fmtProd(this.getVarietyRoastedProduction(farmer, 'robusta')), '—'));

    // Legacy fields for backward compatibility
    const libProd = this.getVarietyProduction(farmer, 'liberica');
    const excProd = this.getVarietyProduction(farmer, 'excelsa');
    const robProd = this.getVarietyProduction(farmer, 'robusta');
    setText('farmerProfileGcbLibProdText', fmtProd(libProd));
    setText('farmerProfileGcbExcProdText', fmtProd(excProd));
    setText('farmerProfileGcbRobProdText', fmtProd(robProd));
    setText('farmerProfileRoastedLibProdText', fmtProd(this.getRoastedFromGcb(libProd)));
    setText('farmerProfileRoastedExcProdText', fmtProd(this.getRoastedFromGcb(excProd)));
    setText('farmerProfileRoastedRobProdText', fmtProd(this.getRoastedFromGcb(robProd)));
    setText('farmerProfileProdUnitText', this.getValue(farmer, ['PRODUCTION UNIT', 'Production_Unit']) || 'kg');
    const harvestUnitBadge = document.querySelector('.farmer-profile-production-table--harvest')
      ?.closest('.registration-detail-section')
      ?.querySelector('.unit-badge');
    if (harvestUnitBadge) {
      harvestUnitBadge.textContent = this.getHarvestUnitBadge(farmer);
    }

    // Populate Bean Summary
    this.initBeanVarietyFilters(farmer);

    // Populate Transactions for this specific farmer
    this.populateFarmerTransactions(farmerId, fullName);

    this.initFarmerSelfSalePanel(farmer);

    // Init See More
    this.initSeeMoreDetails();

    const toolbar = document.getElementById('farmersListToolbar');
    if (toolbar) toolbar.style.display = 'none';

    listView.hidden = true;
    profileView.hidden = false;
  }

  initBeanVarietyFilters(farmer) {
    const filterBtns = document.querySelectorAll('.bean-variety-btn');
    if (!filterBtns.length) return;

    // Reset buttons state
    filterBtns.forEach(btn => {
      btn.classList.toggle('active', btn.textContent.trim() === 'All');
    });

    // Remove existing listeners by cloning
    filterBtns.forEach(btn => {
      const newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);
    });

    // Re-query new buttons
    const newFilterBtns = document.querySelectorAll('.bean-variety-btn');
    newFilterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        newFilterBtns.forEach(b => b.classList.toggle('active', b === btn));
        const variety = btn.textContent.trim();
        this.populateBeanSummary(farmer, variety);
      });
    });

    // Initial population
    this.populateBeanSummary(farmer, 'All');
  }

  populateBeanSummary(farmer, variety = 'All') {
    const initialValueEl = document.getElementById('initialBeansValue');
    const remainingValueEl = document.getElementById('remainingBeansValue');
    const remainingDateEl = document.getElementById('remainingBeansDate');

    if (!initialValueEl || !remainingValueEl) return;

    let initialBeans = 0;
    
    if (variety === 'All') {
      initialBeans = this.getTotalProduction(farmer);
    } else {
      const key = `${variety.toUpperCase()} PRODUCTION`;
      initialBeans = Number(this.getValue(farmer, [key, variety.toLowerCase() + '_production']) || 0);
    }

    // Keep real values from registration/transactions; no demo fallback.
    const beansRemaining = Math.max(0, Math.floor(initialBeans * 0.14));

    initialValueEl.textContent = initialBeans;
    remainingValueEl.textContent = beansRemaining;

    // Use current date as example
    const today = new Date();
    const options = { year: 'numeric', month: 'long', day: 'numeric' };
    if (remainingDateEl) remainingDateEl.textContent = today.toLocaleDateString('en-US', options);
  }

  async populateFarmerTransactions(farmerId, farmerName) {
    const txnBody = document.getElementById('farmerTransactionsBody');
    if (!txnBody) return;

    // Loading state
    txnBody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 2rem;">Loading transactions...</td></tr>';

    let transactions = [];
    
    try {
      const response = await fetch(
        beanthenticApiUrl(`/api/transactions-list?farmer_id=${encodeURIComponent(farmerId)}&limit=100`)
      );
      const data = await response.json().catch(() => ({}));
      if (data && data.ok === false) {
        throw new Error(data.detail || data.error || 'Could not load transactions');
      }
      if (response.ok && Array.isArray(data.items)) {
        transactions = data.items;
      }
    } catch (error) {
      console.warn('Could not fetch real transactions:', error);
    }

    if (transactions.length === 0) {
      txnBody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 2rem; color: #64748b;">No transactions recorded.</td></tr>';
      return;
    }

    let txnPage = 1;
    const txnPageSize = 5;
    const totalPages = Math.ceil(transactions.length / txnPageSize) || 1;

    const renderTxns = (page) => {
      const start = (page - 1) * txnPageSize;
      const end = start + txnPageSize;
      const pagedTxns = transactions.slice(start, end);

      txnBody.innerHTML = pagedTxns.map(t => {
        const date = t.recorded_at ? new Date(t.recorded_at).toLocaleDateString('en-US') : '—';
        const qty = Math.abs(t.delta_kg || 0).toFixed(1);
        const unit = t.unit || 'kg';
        
        return `
          <tr>
            <td class="txn-date" style="background: #ffffff;">${date}</td>
            <td style="background: #ffffff;">${this.escapeHtml(t.buyer_name || 'Direct Sale')}</td>
            <td style="background: #ffffff;">${this.escapeHtml(this.varietyLabel(t.variety || t.product || 'Coffee Beans'))}</td>
            <td style="font-weight:700; background: #ffffff;">${qty} ${unit}</td>
          </tr>
        `;
      }).join('');

      // Update pagination UI
      const curPageEl = document.getElementById('txnCurrentPage');
      const totalPagesEl = document.getElementById('txnTotalPages');
      const prevBtn = document.getElementById('txnPrevBtn');
      const nextBtn = document.getElementById('txnNextBtn');

      if (curPageEl) curPageEl.textContent = page;
      if (totalPagesEl) totalPagesEl.textContent = totalPages;
      if (prevBtn) prevBtn.disabled = page === 1;
      if (nextBtn) nextBtn.disabled = page >= totalPages || totalPages <= 1;
    };

    // Set up listeners
    const prevBtn = document.getElementById('txnPrevBtn');
    const nextBtn = document.getElementById('txnNextBtn');

    if (prevBtn && nextBtn) {
      const newPrev = prevBtn.cloneNode(true);
      const newNext = nextBtn.cloneNode(true);
      prevBtn.parentNode.replaceChild(newPrev, prevBtn);
      nextBtn.parentNode.replaceChild(newNext, nextBtn);

      newPrev.addEventListener('click', () => {
        if (txnPage > 1) {
          txnPage--;
          renderTxns(txnPage);
        }
      });

      newNext.addEventListener('click', () => {
        if (txnPage < totalPages) {
          txnPage++;
          renderTxns(txnPage);
        }
      });
    }

    renderTxns(1);
  }

  initFarmerProfileTabs() {
    const tabs = document.querySelectorAll('.farmer-profile-tab-btn');
    const panes = document.querySelectorAll('.farmer-profile-pane');

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const targetTab = tab.dataset.profileTab;

        // Update buttons
        tabs.forEach(t => {
          t.classList.toggle('active', t === tab);
          t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
        });

        // Update panes
        panes.forEach(pane => {
          const isTarget = pane.id === `profilePane${targetTab.charAt(0).toUpperCase() + targetTab.slice(1)}`;
          pane.classList.toggle('active', isTarget);
          pane.hidden = !isTarget;
        });
      });
    });
  }

  initSeeMoreDetails() {
    const btn = document.getElementById('btnSeeMoreDetails');
    const area = document.getElementById('detailsScrollArea');
    if (!btn || !area) return;

    // Use a fresh listener to avoid multiple attaches
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);

    newBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      const isExpanded = area.classList.toggle('expanded');
      newBtn.textContent = isExpanded ? 'Show less' : 'See more';
      
      // Update blur overlay visibility based on expansion
      const overlay = document.getElementById('detailsBlurOverlay');
      if (overlay) {
        overlay.style.opacity = isExpanded ? '0' : '1';
      }
    });
  }

  closeFarmerProfile() {
    this.closeFarmerProductionModal();
    const profileView = document.getElementById('farmerProfileView');
    const listView = document.getElementById('farmersListView');
    if (!profileView || !listView) return;

    if (this.farmerProfileSource === 'client-report') {
      this.switchModule('client-report');
      // Also ensure the farmers list views are reset for next time
      profileView.hidden = true;
      listView.hidden = false;
      const toolbar = document.getElementById('farmersListToolbar');
      if (toolbar) toolbar.style.display = 'flex';
    } else {
      const toolbar = document.getElementById('farmersListToolbar');
      if (toolbar) toolbar.style.display = 'flex';

      profileView.hidden = true;
      listView.hidden = false;
    }
  }

  openFarmerProductionModal() {
    const modal = document.getElementById('farmerProductionModal');
    if (!modal) return;
    const nameEl = document.getElementById('farmerProfileName');
    const titleEl = document.getElementById('farmerProductionModalTitle');
    if (titleEl) {
      const name = nameEl?.textContent?.trim();
      titleEl.innerHTML = name
        ? `Production <span class="year-label">(2026)</span> · ${this.escapeHtml(name)}`
        : 'Production <span class="year-label">(2026)</span>';
    }
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
  }

  closeFarmerProductionModal() {
    const modal = document.getElementById('farmerProductionModal');
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
  }

  openFarmerPlaceholderProfile(farmerNo = 1) {
    this.farmerProfileSource = 'profiles';
    const profileView = document.getElementById('farmerProfileView');
    const listView = document.getElementById('farmersListView');
    if (!profileView || !listView) return;

    // Update Back button text
    const backBtn = document.getElementById('farmerProfileBackBtn');
    if (backBtn) {
      const span = backBtn.querySelector('span');
      if (span) {
        span.textContent = 'Back to Profiles';
      }
    }

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

    setText('farmerProfileLastNameText', 'Last Name');
    setText('farmerProfileFirstNameText', 'First Name');
    setText('farmerProfileProvinceText', 'Batangas');
    setText('farmerProfileMunicipalityText', 'Lipa City');
    setText('farmerProfileBarangayText', 'Barangay');
    setText('farmerProfileFederationText', 'Federation Association');
    setText('farmerProfileRsbsaText', 'Yes/No');
    setText('farmerProfileRsbsaNumberText', 'RSBSA-0000');
    setText('farmerProfileRsbsaStatusText', 'Pending RSBSA');
    setText('farmerProfileNcfrsText', 'NCFRS-0000');
    setText('farmerProfileOwnershipText', 'Landowner / Lease / Others');
    setText('farmerProfileTotalAreaText', '0.00');
    setText('farmerProfileCoffeeVarietiesText', 'Liberica, Robusta');
    setText('farmerProfileDistributionText', 'Drop Off At Consolidator');
    setText('farmerProfileFlowPreferenceText', 'Drop Off At Consolidator');
    setText('farmerProfileFlowSummaryText', 'No split quantity');
    setText('farmerProfileFlowLibText', '—');
    setText('farmerProfileFlowExcText', '—');
    setText('farmerProfileFlowRobText', '—');

    this.initBeanVarietyFilters({});
    this.initSeeMoreDetails();
    this.populateFarmerTransactions(0, 'Full Name');

    const toolbar = document.getElementById('farmersListToolbar');
    if (toolbar) toolbar.style.display = 'none';

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
          : this.farmerTableView === 'automated-yields'
            ? document.getElementById('tableBodyAutomatedYields')
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
          ? 12
          : this.farmerTableView === 'production'
            ? 18
            : this.farmerTableView === 'automated-yields'
              ? 18
              : this.farmerTableView === 'affiliation'
                ? 8
                : this.farmerTableView === 'farm'
                  ? 9
                  : 5;
      tableBody.innerHTML = window.BeanthenticUI
        ? window.BeanthenticUI.emptyTableRow(colSpan, {
            icon: 'fa-table',
            title: 'No data available',
            hint: 'Try adjusting filters or wait for new farmer records to sync.',
          })
        : `<tr><td colspan="${colSpan}" class="no-data">No data available.</td></tr>`;
      return;
    }

    const bodyHTML = pageData.map((row, index) => {
      const actualIndex = startIndex + index + 1;
      const rowIndexInData = this.data.indexOf(row);
      const displayNo = this.farmerDisplaySeqNo(row, this.data) || actualIndex;
      console.log('Rendering farmer', displayNo, ':', row['NAME OF FARMER'] || 'Unknown');

      const fullName = this.getValue(row, ['NAME OF FARMER', 'Name of Farmer', 'name']);
      const nameParts = this.splitFarmerName(fullName);

      const cells =
        this.farmerTableView === 'trees'
          ? [
              this.createInputCell(displayNo, 'number'),
              this.createInputCell(nameParts.last, 'text'),
              this.createInputCell(nameParts.first, 'text'),

              this.createInputCell(this.varietyValueOrBlank(row, 'liberica', this.getValue(row, ['LIBERICA BEARING', 'Liberica_Bearing']), ''), 'number', 'highlight-yellow'),
              this.createInputCell(this.varietyValueOrBlank(row, 'liberica', this.getValue(row, ['LIBERICA NON-BEARING', 'Liberica_Non-bearing']), ''), 'number', 'highlight-yellow'),
              this.createInputCell(this.varietyValueOrBlank(row, 'excelsa', this.getValue(row, ['EXCELSA BEARING', 'Excelsa_Bearing']), ''), 'number', 'highlight-yellow'),
              this.createInputCell(this.varietyValueOrBlank(row, 'excelsa', this.getValue(row, ['EXCELSA NON-BEARING', 'Excelsa_Non-bearing']), ''), 'number', 'highlight-yellow'),
              this.createInputCell(this.varietyValueOrBlank(row, 'robusta', this.getValue(row, ['ROBUSTA BEARING', 'Robusta_Bearing']), ''), 'number', 'highlight-yellow'),
              this.createInputCell(this.varietyValueOrBlank(row, 'robusta', this.getValue(row, ['ROBUSTA NON-BEARING', 'Robusta_Non-bearing']), ''), 'number', 'highlight-yellow'),

              this.createInputCell(this.getValue(row, ['TOTAL BEARING', 'Total_Bearing']), 'number', 'highlight-green'),
              this.createInputCell(this.getValue(row, ['TOTAL NON-BEARING', 'Total_Non-bearing']), 'number', 'highlight-green'),
              this.createInputCell(this.getValue(row, ['TOTAL TREES', 'TOTAL_TREES']), 'number', 'highlight-green')
            ]
          : this.farmerTableView === 'production'
            ? [
                this.createInputCell(displayNo, 'number'),
                this.createInputCell(nameParts.last, 'text'),
                this.createInputCell(nameParts.first, 'text'),
                // Harvest
                this.createInputCell(this.varietyValueOrBlank(row, 'liberica', this.getVarietyHarvestProduction(row, 'liberica'), ''), 'number', 'highlight-yellow'),
                this.createInputCell(this.varietyValueOrBlank(row, 'excelsa', this.getVarietyHarvestProduction(row, 'excelsa'), ''), 'number', 'highlight-yellow'),
                this.createInputCell(this.varietyValueOrBlank(row, 'robusta', this.getVarietyHarvestProduction(row, 'robusta'), ''), 'number', 'highlight-yellow'),
                // GCB
                this.createInputCell(this.varietyValueOrBlank(row, 'liberica', this.formatGcbClassification(row, 'liberica'), '—'), 'text', 'highlight-blue'),
                this.createInputCell(this.varietyValueOrBlank(row, 'liberica', this.getVarietyProduction(row, 'liberica'), ''), 'number', 'highlight-blue'),
                this.createInputCell(this.varietyValueOrBlank(row, 'excelsa', this.formatGcbClassification(row, 'excelsa'), '—'), 'text', 'highlight-blue'),
                this.createInputCell(this.varietyValueOrBlank(row, 'excelsa', this.getVarietyProduction(row, 'excelsa'), ''), 'number', 'highlight-blue'),
                this.createInputCell(this.varietyValueOrBlank(row, 'robusta', this.formatGcbClassification(row, 'robusta'), '—'), 'text', 'highlight-blue'),
                this.createInputCell(this.varietyValueOrBlank(row, 'robusta', this.getVarietyProduction(row, 'robusta'), ''), 'number', 'highlight-blue'),
                // Roasted
                this.createInputCell(this.varietyValueOrBlank(row, 'liberica', this.formatRoastedClassification(row, 'liberica'), '—'), 'text', 'highlight-green'),
                this.createInputCell(this.varietyValueOrBlank(row, 'liberica', this.getVarietyRoastedProduction(row, 'liberica'), ''), 'number', 'highlight-green'),
                this.createInputCell(this.varietyValueOrBlank(row, 'excelsa', this.formatRoastedClassification(row, 'excelsa'), '—'), 'text', 'highlight-green'),
                this.createInputCell(this.varietyValueOrBlank(row, 'excelsa', this.getVarietyRoastedProduction(row, 'excelsa'), ''), 'number', 'highlight-green'),
                this.createInputCell(this.varietyValueOrBlank(row, 'robusta', this.formatRoastedClassification(row, 'robusta'), '—'), 'text', 'highlight-green'),
                this.createInputCell(this.varietyValueOrBlank(row, 'robusta', this.getVarietyRoastedProduction(row, 'robusta'), ''), 'number', 'highlight-green')
              ]
            : this.farmerTableView === 'automated-yields'
              ? [
                  this.createInputCell(displayNo, 'number'),
                  this.createInputCell(nameParts.last, 'text'),
                  this.createInputCell(nameParts.first, 'text'),
                  ...this.buildAutomatedYieldVarietyCells(row, 'liberica'),
                  ...this.buildAutomatedYieldVarietyCells(row, 'robusta'),
                  ...this.buildAutomatedYieldVarietyCells(row, 'excelsa')
                ]
          : this.farmerTableView === 'affiliation'
            ? [
                this.createInputCell(displayNo, 'number'),
                this.createInputCell(nameParts.last, 'text'),
                this.createInputCell(nameParts.first, 'text'),
                this.createInputCell(this.getValue(row, ['FA OFFICER / MEMBER', 'FA OFFICER/MEMBER', 'federation_assoc', 'FA Officer / member', 'officer']), 'text'),
                this.createRSBSABadge(this.getValue(row, ['RSBSA Registered (Yes/No)', 'RSBSA REGISTERED (YES/NO)', 'REGISTERED (YES/NO)', 'Registered (Yes/No)', 'registered', 'rsbsa_registered'])),
                this.createInputCell(this.getValue(row, ['RSBSA NUMBER', 'RSBSA Registered Number', 'rsbsa_number']), 'text'),
                this.createRSBSAStatusBadge(
                  this.getValue(row, ['RSBSA Registered (Yes/No)', 'RSBSA REGISTERED (YES/NO)', 'REGISTERED (YES/NO)', 'Registered (Yes/No)', 'registered']),
                  this.getValue(row, ['RSBSA Status', 'RSBSA STATUS', 'rsbsa_status'])
                ),
                this.createInputCell(this.getValue(row, ['NCFRS', 'ncfrs']), 'text')
              ]
          : this.farmerTableView === 'farm'
            ? [
                this.createInputCell(displayNo, 'number'),
                this.createInputCell(nameParts.last, 'text'),
                this.createInputCell(nameParts.first, 'text'),
                this.createOwnershipCell(this.getValue(row, ['LANDOWNER', 'OWNER_OPERATOR', 'Owner-Operator', 'A'])),
                this.createOwnershipCell(this.getValue(row, ['CLOA', 'LESSOR', 'Lessor', 'B'])),
                this.createOwnershipCell(this.getValue(row, ['LEASE', 'LESSEE', 'Lessee', 'C'])),
                this.createOwnershipCell(this.getValue(row, ['SEASONAL', 'SHAREHOLDER', 'Shareholder', 'D'])),
                this.createOwnershipCell(this.getValue(row, ['OTHERS', 'Others', 'E'])),
                this.createInputCell(
                  this.formatAreaHa(this.getValue(row, ['Total Area Planted (HA.)', 'TOTAL AREA PLANTED (HA.)', 'area', 'farm_size_ha'])),
                  'text'
                )
              ]
          : [
              this.createInputCell(displayNo, 'number'),
              this.createInputCell(nameParts.last, 'text'),
              this.createInputCell(nameParts.first, 'text'),
              this.createInputCell(this.getValue(row, ['ADDRESS (BARANGAY)', 'Address (Barangay)', 'address']), 'text'),
              this.createInputCell(this.getValue(row, ['BIRTHDAY', 'birthday']), 'text')
            ];

      return `<tr data-row-index="${rowIndexInData}">${cells.join('')}</tr>`;
    }).join('');

    tableBody.innerHTML = bodyHTML;
    console.log('Table rendered successfully with', pageData.length, 'farmer records');
  }

  normalizeFarmerTableViewKey(view) {
    const key = String(view || '').trim().toLowerCase();
    if (key === 'trees') return 'trees';
    if (key === 'production') return 'production';
    if (key === 'automated-yields' || key === 'yields' || key === 'automated_yields') {
      return 'automated-yields';
    }
    if (key === 'affiliation') return 'affiliation';
    if (key === 'farm') return 'farm';
    return 'basic';
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

    const key = this.normalizeFarmerTableViewKey(view);
    this.farmerTableView = key;

    const btns = farmersRoot
      ? farmersRoot.querySelectorAll('.view-toggle-btn[data-table-view]')
      : document.querySelectorAll('.view-toggle-btn[data-table-view]');
    btns.forEach((btn) => {
      const btnKey = this.normalizeFarmerTableViewKey(btn.getAttribute('data-table-view') || 'basic');
      const active = btnKey === this.farmerTableView;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    const basicTable = document.getElementById('farmerTableBasic');
    const treesTable = document.getElementById('farmerTableTrees');
    const productionTable = document.getElementById('farmerTableProduction');
    const automatedYieldsTable = document.getElementById('farmerTableAutomatedYields');
    const affiliationTable = document.getElementById('farmerTableAffiliation');
    const farmTable = document.getElementById('farmerTableFarm');

    if (basicTable && treesTable && productionTable && affiliationTable && farmTable) {
      const showBasic = this.farmerTableView === 'basic';
      const showTrees = this.farmerTableView === 'trees';
      const showProduction = this.farmerTableView === 'production';
      const showAutomatedYields = this.farmerTableView === 'automated-yields';
      const showAffiliation = this.farmerTableView === 'affiliation';
      const showFarm = this.farmerTableView === 'farm';

      basicTable.classList.toggle('is-hidden', !showBasic);
      treesTable.classList.toggle('is-hidden', !showTrees);
      productionTable.classList.toggle('is-hidden', !showProduction);
      if (automatedYieldsTable) {
        automatedYieldsTable.classList.toggle('is-hidden', !showAutomatedYields);
        automatedYieldsTable.setAttribute('aria-hidden', showAutomatedYields ? 'false' : 'true');
      }
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
    let display = value;
    if (type === 'number' && (display === null || display === undefined)) {
      display = '';
    }
    if ((type === 'text' || type === 'number') && (display === '' || display === null || display === undefined)) {
      display = '—';
    }
    const formattedValue = this.formatValue(display);
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
    const row = this.data[rowIndex];
    const isBlocked = row && (row.is_blocked === true || row.is_blocked === 'true');
    
    return `<td>
      <div class="row-actions">
        <button type="button" class="row-action-btn action-warning" data-action="warning-farmer" data-row-index="${rowIndex}">Warning</button>
        ${isBlocked 
          ? `<button type="button" class="row-action-btn action-unblock" data-action="unblock-farmer" data-row-index="${rowIndex}">Unblock</button>`
          : `<button type="button" class="row-action-btn action-block" data-action="block-farmer" data-row-index="${rowIndex}">Block</button>`
        }
      </div>
    </td>`;
  }

  createRSBSABadge(value) {
    const normalizedValue = String(value || 'no').toLowerCase().trim();
    const isYes = normalizedValue === 'yes' || normalizedValue === 'y';

    if (isYes) {
      return `<td><span class="rsbsa-badge rsbsa-yes">YES</span></td>`;
    }
    if (normalizedValue === 'pending' || normalizedValue === 'p') {
      return `<td><span class="rsbsa-badge rsbsa-pending">PENDING</span></td>`;
    }
    return `<td><span class="rsbsa-badge rsbsa-no">NO</span></td>`;
  }

  getFarmerDbId(farmer) {
    if (!farmer) return 0;
    const fid = Number(farmer.farmer_id ?? farmer['farmer_id'] ?? 0);
    if (Number.isFinite(fid) && fid > 0) return fid;
    // Only use NO. when row came from live DB (has user_id); sample/backup rows must not use NO.
    if (Object.prototype.hasOwnProperty.call(farmer, 'user_id') && farmer.user_id != null) {
      const no = Number(farmer['NO.'] ?? farmer.NO ?? 0);
      if (Number.isFinite(no) && no > 0) return no;
    }
    return 0;
  }

  applyFarmerAccountStatusToRow(farmer, status) {
    if (!farmer || !status) return;
    farmer.is_blocked = !!status.is_suspended;
    if (status.suspended_until) {
      const dt = new Date(String(status.suspended_until).replace(' ', 'T'));
      farmer.suspended_until = Number.isNaN(dt.getTime()) ? null : dt.getTime();
    } else {
      farmer.suspended_until = null;
    }
    farmer.suspension_reason = status.suspension_reason || '';
    farmer.warning_count = Number(status.warning_count || 0);
    farmer.last_warning_reason = status.last_warning_reason || '';
  }

  async postFarmerAccountAction(farmerId, action, reason, days) {
    const res = await fetch(beanthenticApiUrl('/api/farmer-account-action'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        farmer_id: farmerId,
        action,
        reason,
        days: days || 3,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok !== true) {
      throw new Error(data.detail || data.message || data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  async handleWarningFarmer(idx, reason) {
    const farmer = this.data[idx];
    if (!farmer) return;

    const farmerId = this.getFarmerDbId(farmer);
    if (!farmerId) {
      this.showNotification('Farmer ID missing — reload farmer list from database.', 'error');
      return;
    }

    try {
      const data = await this.postFarmerAccountAction(farmerId, 'warning', reason);
      this.applyFarmerAccountStatusToRow(farmer, data.account_status);
      this.showNotification(
        `Warning sent to ${farmer['NAME OF FARMER']}. Popup appears on their app homepage after login.`,
        'success'
      );
      if (this.currentFarmerNo === farmerId) {
        this.updateProfileStatusButtons(!!farmer.is_blocked);
      }
      this.renderFarmersListCards();
      this.renderTableBody();
    } catch (err) {
      console.error('Failed to record warning:', err);
      this.showNotification(err.message || 'Could not record warning.', 'error');
    }
  }

  async handleBlockFarmer(idx, reason) {
    const farmer = this.data[idx];
    if (!farmer) return;

    const farmerId = this.getFarmerDbId(farmer);
    if (!farmerId) {
      this.showNotification('Farmer ID missing — reload farmer list from database.', 'error');
      return;
    }

    try {
      const data = await this.postFarmerAccountAction(farmerId, 'suspend', reason, 3);
      this.applyFarmerAccountStatusToRow(farmer, data.account_status);
      this.showNotification(`${farmer['NAME OF FARMER']} suspended for 3 days.`, 'success');
      if (this.currentFarmerNo === farmerId) {
        this.updateProfileStatusButtons(true);
      }
      this.renderFarmersListCards();
      this.renderTableBody();
      this.refreshMapFromLiveFarmers({ silent: true, reloadFarmers: false });
    } catch (err) {
      console.error('Failed to suspend farmer:', err);
      this.showNotification(err.message || 'Could not suspend farmer.', 'error');
    }
  }

  async handleUnblockFarmer(idx, reason) {
    const farmer = this.data[idx];
    if (!farmer) return;

    const farmerId = this.getFarmerDbId(farmer);
    if (!farmerId) {
      this.showNotification('Farmer ID missing — reload farmer list from database.', 'error');
      return;
    }

    try {
      const data = await this.postFarmerAccountAction(farmerId, 'unsuspend', reason);
      this.applyFarmerAccountStatusToRow(farmer, data.account_status);
      this.showNotification(`${farmer['NAME OF FARMER']} access has been restored.`, 'success');
      if (this.currentFarmerNo === farmerId) {
        this.updateProfileStatusButtons(false);
      }
      this.renderFarmersListCards();
      this.renderTableBody();
      this.refreshMapFromLiveFarmers({ silent: true, reloadFarmers: false });
    } catch (err) {
      console.error('Failed to unsuspend farmer:', err);
      this.showNotification(err.message || 'Could not unsuspend farmer.', 'error');
    }
  }

  updateProfileStatusButtons(isBlocked) {
    const suspendBtn = document.getElementById('profileSuspendBtn');
    const countdownContainer = document.getElementById('profileSuspensionCountdown');
    const timerEl = document.getElementById('profileSuspensionTimer');
    
    if (!suspendBtn) return;

    const icon = suspendBtn.querySelector('i');
    const label = suspendBtn.querySelector('span');

    if (isBlocked) {
      suspendBtn.classList.remove('suspend');
      suspendBtn.classList.add('unsuspend');
      if (icon) icon.className = 'fa-solid fa-user-check';
      if (label) label.textContent = 'Unsuspend';
      
      // Show countdown if we have a suspension end time
      const farmer = this.farmerRowById(this.currentFarmerNo);

      if (farmer && farmer.suspended_until && countdownContainer && timerEl) {
        countdownContainer.hidden = false;
        countdownContainer.style.setProperty('display', 'flex', 'important');
        timerEl.dataset.until = farmer.suspended_until;
        timerEl.dataset.farmerId = String(this.currentFarmerNo);
      } else {
        if (countdownContainer) {
          countdownContainer.hidden = true;
          countdownContainer.style.setProperty('display', 'none', 'important');
        }
      }
    } else {
      suspendBtn.classList.remove('unsuspend');
      suspendBtn.classList.add('suspend');
      if (icon) icon.className = 'fa-solid fa-user-slash';
      if (label) label.textContent = 'Suspend';
      
      if (countdownContainer) {
        countdownContainer.hidden = true;
        countdownContainer.style.setProperty('display', 'none', 'important');
      }
    }
  }

  createRSBSAStatusBadge(registeredValue, statusValue) {
    const normalizedReg = String(registeredValue || '').toLowerCase().trim();
    const isNo = normalizedReg === 'no' || normalizedReg === 'n';
    const isYes = normalizedReg === 'yes' || normalizedReg === 'y';

    let status = String(statusValue || '').toUpperCase().trim();

    if (isNo) {
      if (!status) status = 'NOT YET APPLIED';
      if (status.includes('PENDING')) status = 'PENDING RSBSA';
      return `<td><span class="rsbsa-badge rsbsa-pending">${status}</span></td>`;
    } else if (isYes) {
      if (!status) status = 'REGISTERED';
      return `<td><span class="rsbsa-badge rsbsa-pending">${status}</span></td>`;
    }
    
    return status ? `<td><span class="rsbsa-badge rsbsa-pending">${status}</span></td>` : `<td></td>`;
  }

  createOwnershipCell(value) {
    const hasValue = value && String(value).trim() !== '';
    
    if (hasValue) {
      return `<td class="ownership-cell">X</td>`;
    } else {
      return `<td class="ownership-cell"></td>`;
    }
  }

  gcbClassificationLabels = {
    small_beans: 'Small Beans',
    medium_beans: 'Medium Beans',
    large_beans: 'Large Beans',
  };

  roastedClassificationLabels = {
    ground_beans: 'Ground Beans',
    whole_beans: 'Whole Beans',
  };

  selectedVarietiesFromRow(row) {
    const out = new Set();
    const raw = this.getValue(row, ['COFFEE VARIETIES', 'coffee_varieties', 'coffee_variety']);
    if (raw) {
      String(raw)
        .split(/[,\|;/]/)
        .map((token) => token.trim().toLowerCase())
        .forEach((token) => {
          if (!token) return;
          if (token.includes('liberica') || token.includes('barako')) out.add('liberica');
          else if (token.includes('excelsa')) out.add('excelsa');
          else if (token.includes('robusta')) out.add('robusta');
        });
    }
    const detailVars = row?.production_detail?.varieties;
    if (detailVars && typeof detailVars === 'object') {
      Object.keys(detailVars).forEach((key) => {
        const v = String(key || '').trim().toLowerCase();
        if (v === 'liberica' || v === 'excelsa' || v === 'robusta') out.add(v);
      });
    }
    return out;
  }

  hasVarietySelected(row, variety) {
    const v = String(variety || '').trim().toLowerCase();
    if (!v) return false;
    const selected = this.selectedVarietiesFromRow(row);
    if (!selected.size) return true;
    return selected.has(v);
  }

  normalizeClassificationKey(value, labels) {
    if (value === 0 || value === 1 || value === 2) {
      const intMap = labels === this.gcbClassificationLabels
        ? { 0: 'small_beans', 1: 'medium_beans', 2: 'large_beans' }
        : { 0: 'ground_beans', 1: 'whole_beans' };
      if (intMap[value]) return intMap[value];
    }
    const key = String(value || '').trim().toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_');
    if (!key) return '';
    if (labels[key]) return key;
    for (const [code, label] of Object.entries(labels)) {
      if (key === String(label).toLowerCase().replace(/\s+/g, '_')) return code;
    }
    return key;
  }

  formatGcbClassification(row, variety) {
    const v = String(variety || '').trim().toLowerCase();
    const cap = v.toUpperCase();
    const camel = v.charAt(0).toUpperCase() + v.slice(1);
    const labeled = this.getValue(row, [
      `${cap} GCB CLASSIFICATION`,
      `${v}_gcb_classification`,
      `${v}_gcb_classification_code`,
      `${v}_gcb_class`,
      `${v}_gcb_type`,
      `${camel}GcbClassification`,
      `${camel}GcbClass`,
      `${camel}GcbType`,
    ]);
    if (labeled) {
      const key = this.normalizeClassificationKey(labeled, this.gcbClassificationLabels);
      return this.gcbClassificationLabels[key] || labeled;
    }
    const detail = row?.production_detail?.varieties?.[v]?.gcb?.classification_label
      || row?.production_detail?.varieties?.[v]?.gcb?.classification;
    if (detail) {
      const key = this.normalizeClassificationKey(detail, this.gcbClassificationLabels);
      return this.gcbClassificationLabels[key] || detail;
    }
    return '';
  }

  formatRoastedClassification(row, variety) {
    const v = String(variety || '').trim().toLowerCase();
    const cap = v.toUpperCase();
    const camel = v.charAt(0).toUpperCase() + v.slice(1);
    const labeled = this.getValue(row, [
      `${cap} ROASTED CLASSIFICATION`,
      `${v}_roasted_classification`,
      `${v}_roasted_classification_code`,
      `${v}_roasted_class`,
      `${v}_roasted_type`,
      `${camel}RoastedClassification`,
      `${camel}RoastedClass`,
      `${camel}RoastedType`,
    ]);
    if (labeled) {
      const key = this.normalizeClassificationKey(labeled, this.roastedClassificationLabels);
      return this.roastedClassificationLabels[key] || labeled;
    }
    const detail = row?.production_detail?.varieties?.[v]?.roasted?.classification_label
      || row?.production_detail?.varieties?.[v]?.roasted?.classification;
    if (detail) {
      const key = this.normalizeClassificationKey(detail, this.roastedClassificationLabels);
      return this.roastedClassificationLabels[key] || detail;
    }
    return '';
  }

  getVarietyProduction(row, variety) {
    const v = String(variety || '').trim().toLowerCase();
    const gcbDetail = this.getValue(row, [`${v}_gcb_qty_kg`, `${v.toUpperCase()} GCB QTY`]);
    if (gcbDetail !== '' && gcbDetail != null && Number.isFinite(Number(gcbDetail))) {
      return Number(gcbDetail);
    }
    const keysByVariety = {
      liberica: [
        'LIBERICA PRODUCTION',
        'Liberica_Production',
        'LIBERICA (KG)',
        'LIBERICA',
        'liberica_qty_kg',
        'liberica_production',
        'liberica_gcb_qty_kg',
      ],
      excelsa: [
        'EXCELSA PRODUCTION',
        'Excelsa_Production',
        'EXCELSA (KG)',
        'EXCELSA',
        'excelsa_qty_kg',
        'excelsa_production',
        'excelsa_gcb_qty_kg',
      ],
      robusta: [
        'ROBUSTA PRODUCTION',
        'Robusta_Production',
        'ROBUSTA (KG)',
        'ROBUSTA',
        'robusta_qty_kg',
        'robusta_production',
        'robusta_gcb_qty_kg',
      ],
    };
    const keys = keysByVariety[v] || [`${v.toUpperCase()} PRODUCTION`, `${v} (KG)`];
    const raw = this.getValue(row, keys);
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  getVarietyBearing(row, variety) {
    const v = String(variety || '').trim().toLowerCase();
    const keysByVariety = {
      liberica: ['LIBERICA BEARING', 'Liberica_Bearing', 'liberica_bearing'],
      excelsa: ['EXCELSA BEARING', 'Excelsa_Bearing', 'excelsa_bearing'],
      robusta: ['ROBUSTA BEARING', 'Robusta_Bearing', 'robusta_bearing'],
    };
    const keys = keysByVariety[v] || [`${v.toUpperCase()} BEARING`];
    const raw = this.getValue(row, keys);
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  getYieldGcbKgPerBearingTree(variety) {
    const rates = { liberica: 0.3, robusta: 1, excelsa: 1 };
    return rates[String(variety || '').trim().toLowerCase()] || 0;
  }

  getRoastedRecoveryFactor() {
    return 0.78;
  }

  getRoastedFromGcb(gcbKg) {
    return (Number(gcbKg) || 0) * this.getRoastedRecoveryFactor();
  }

  getVarietyRoastedProduction(row, variety) {
    const v = String(variety || '').trim().toLowerCase();
    const roastedDetail = this.getValue(row, [`${v}_roasted_qty_kg`, `${v.toUpperCase()} ROASTED QTY`]);
    const n = Number(roastedDetail);
    if (Number.isFinite(n) && n > 0) return n;
    return this.getRoastedFromGcb(this.getVarietyProduction(row, variety));
  }

  getVarietyHarvestProduction(row, variety) {
    const v = String(variety || '').trim().toLowerCase();
    const harvestDetail = this.getValue(row, [`${v}_harvest_qty_kg`, `${v.toUpperCase()} HARVEST QTY`]);
    const n = Number(harvestDetail);
    if (Number.isFinite(n) && n > 0) return n;
    const gcb = this.getVarietyProduction(row, variety);
    if (gcb > 0) {
      const factor = v === 'robusta' ? 5 : 10;
      return gcb * factor;
    }
    return 0;
  }

  getVarietyHarvestUnit(row, variety) {
    const v = String(variety || '').trim().toLowerCase();
    const cap = v.toUpperCase();
    const direct = this.getValue(row, [`${v}_harvest_unit`, `${cap} HARVEST UNIT`]);
    if (direct) return String(direct).trim();
    const nested = row?.production_detail?.varieties?.[v]?.harvest_unit
      || row?.production_detail?.varieties?.[v]?.harvest?.unit
      || row?.production_detail?.varieties?.[v]?.harvest?.unit_label;
    return nested ? String(nested).trim() : 'kg';
  }

  varietyValueOrBlank(row, variety, value, blankValue = '') {
    return this.hasVarietySelected(row, variety) ? value : blankValue;
  }

  formatAreaHa(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    if (Math.abs(n) >= 100) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }

  formatQtyWithUnit(value, unit) {
    const qty = this.formatKg(value);
    const cleanUnit = String(unit || '').trim();
    return cleanUnit ? `${qty} ${cleanUnit}` : qty;
  }

  getVarietyFlowQty(row, variety, flowKey) {
    const v = String(variety || '').trim().toLowerCase();
    const flow = String(flowKey || '').trim().toLowerCase();
    const nested = row?.production_detail?.varieties?.[v]?.allocation;
    if (nested && typeof nested === 'object') {
      const val = nested[`${flow}_qty_kg`] ?? nested[`${flow}_kg`] ?? nested[flow];
      const n = Number(val);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const flat = this.getValue(row, [`${v}_${flow}_qty_kg`, `${v}_${flow}_kg`, `${v.toUpperCase()} ${flow.toUpperCase()} QTY`]);
    const n = Number(flat);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  getDeliveryFlowSummary(row) {
    const selected = ['liberica', 'excelsa', 'robusta'].filter((v) => this.hasVarietySelected(row, v));
    const chunks = [];
    selected.forEach((v) => {
      const sell = this.getVarietyFlowQty(row, v, 'sell');
      const dropoff = this.getVarietyFlowQty(row, v, 'dropoff');
      if (sell <= 0 && dropoff <= 0) return;
      const label = v.charAt(0).toUpperCase() + v.slice(1);
      const parts = [];
      if (sell > 0) parts.push(`sell ${this.formatKg(sell)} kg`);
      if (dropoff > 0) parts.push(`drop-off ${this.formatKg(dropoff)} kg`);
      chunks.push(`${label}: ${parts.join(' / ')}`);
    });
    return chunks.join('; ');
  }

  formatVarietyFlowLine(row, variety) {
    if (!this.hasVarietySelected(row, variety)) return '—';
    const sell = this.getVarietyFlowQty(row, variety, 'sell');
    const dropoff = this.getVarietyFlowQty(row, variety, 'dropoff');
    if (sell <= 0 && dropoff <= 0) return 'No split quantity';
    const parts = [];
    if (sell > 0) parts.push(`Sell ${this.formatKg(sell)} kg`);
    if (dropoff > 0) parts.push(`Drop-off ${this.formatKg(dropoff)} kg`);
    return parts.join(' / ');
  }

  getHarvestUnitBadge(row) {
    const units = ['liberica', 'excelsa', 'robusta']
      .map((v) => this.getVarietyHarvestUnit(row, v))
      .map((u) => String(u || '').trim())
      .filter(Boolean);
    if (!units.length) return 'kg';
    const uniq = [...new Set(units.map((u) => u.toLowerCase()))];
    if (uniq.length === 1) return units[0];
    return 'mixed';
  }

  gcbFiMatchesTreeComputation(gcbFi, gcbAc) {
    const fi = Number(gcbFi) || 0;
    const ac = Number(gcbAc) || 0;
    return Math.abs(fi - ac) <= 0.01;
  }

  computeAutomatedVarietyYield(row, variety) {
    const bearingTrees = this.getVarietyBearing(row, variety);
    const rate = this.getYieldGcbKgPerBearingTree(variety);
    const gcbFi = this.getVarietyProduction(row, variety);
    const gcbAc = bearingTrees * rate;
    const roastedFi = this.getVarietyRoastedProduction(row, variety);
    const roastedAc = gcbAc * this.getRoastedRecoveryFactor();
    const matchesTreeComputation = this.gcbFiMatchesTreeComputation(gcbFi, gcbAc);
    return { bearingTrees, gcbFi, gcbAc, roastedFi, roastedAc, matchesTreeComputation };
  }

  buildYieldComparisonTooltip(y, variety) {
    const vLabel = String(variety || '').charAt(0).toUpperCase() + String(variety || '').slice(1);
    const rateLabel = String(variety || '').toLowerCase() === 'liberica' ? '0.3 kg per tree' : '1 kg per tree';
    const trees = Number(y.bearingTrees) || 0;
    const fi = this.formatKgWithUnit(y.gcbFi);
    const ac = this.formatKgWithUnit(y.gcbAc);
    if (y.matchesTreeComputation) {
      return (
        `${vLabel} — Green highlight: Farmer input (FI, ${fi}) matches the system computation (AC, ${ac}). ` +
        `AC is based on ${trees.toLocaleString()} bearing tree(s) × ${rateLabel}.`
      );
    }
    return (
      `${vLabel} — Red highlight: Farmer input (FI, ${fi}) does not match the system computation (AC, ${ac}). ` +
      `AC uses ${trees.toLocaleString()} bearing tree(s) × ${rateLabel}. ` +
      `Check tree counts or registration production if these should align.`
    );
  }

  buildAutomatedYieldVarietyCells(row, variety) {
    if (!this.hasVarietySelected(row, variety)) {
      return [
        this.createYieldCell('—'),
        this.createYieldCell('—'),
        this.createYieldCell('—'),
        this.createYieldCell('—'),
        this.createYieldCell('—'),
      ];
    }
    const y = this.computeAutomatedVarietyYield(row, variety);
    const cmp = y.matchesTreeComputation ? 'ay-match' : 'ay-mismatch';
    const cmpTitle = this.buildYieldComparisonTooltip(y, variety);
    return [
      this.createYieldCell(y.gcbAc, 'ay-bearing', cmp, cmpTitle, { withUnit: false }),
      this.createYieldCell(y.gcbFi, 'ay-fi', cmp, cmpTitle),
      this.createYieldCell(y.gcbAc, 'ay-ac', cmp, cmpTitle),
      this.createYieldCell(y.roastedFi, 'ay-roasted-fi', cmp, cmpTitle),
      this.createYieldCell(y.roastedAc, 'ay-roasted-ac', cmp, cmpTitle),
    ];
  }

  createYieldCell(value, highlightClass = '', comparisonClass = '', title = '', options = {}) {
    const withUnit = options.withUnit !== false;
    const isPlaceholder = typeof value === 'string' && value.trim() === '—';
    const formattedValue = isPlaceholder
      ? '—'
      : (withUnit ? this.formatKgWithUnit(value) : this.formatKg(value));
    const classes = [highlightClass, comparisonClass].filter(Boolean);
    const classAttr = classes.length ? ` class="${classes.join(' ')}"` : '';
    const titleAttr = title ? ` title="${title.replace(/"/g, '&quot;')}"` : '';
    return `<td${classAttr}${titleAttr}>${formattedValue}</td>`;
  }

  formatKgWithUnit(value) {
    return `${this.formatKg(value)} kg`;
  }

  formatKg(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    if (Math.abs(n - Math.round(n)) < 0.001) {
      return Math.round(n).toLocaleString();
    }
    return n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  }

  getTotalProduction(row) {
    return (
      this.getVarietyProduction(row, 'liberica') +
      this.getVarietyProduction(row, 'excelsa') +
      this.getVarietyProduction(row, 'robusta')
    );
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

  initAddFarmerModal() {
    const modal = document.getElementById('addFarmerModal');
    const closeBtn = document.getElementById('addFarmerModalClose');
    const cancelBtn = document.getElementById('addFarmerCancel');
    const form = document.getElementById('addFarmerForm');
    const backdrop = modal ? modal.querySelector('.add-farmer-modal__backdrop') : null;
    if (!modal || !form) return;

    if (closeBtn) closeBtn.addEventListener('click', () => this.closeAddFarmerModal());
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.closeAddFarmerModal());
    if (backdrop) backdrop.addEventListener('click', () => this.closeAddFarmerModal());
    const rsbsaSelect = document.getElementById('newFarmerRsbsa');
    const ncfrsInput = document.getElementById('newFarmerNcfrs');
    const rsbsaStatusContainer = document.getElementById('newFarmerRsbsaStatus')?.closest('label');

    if (rsbsaSelect && ncfrsInput) {
      rsbsaSelect.addEventListener('change', () => {
        const isYes = rsbsaSelect.value === 'YES';
        const isNo = rsbsaSelect.value === 'NO';
        
        ncfrsInput.required = isYes;
        if (!isYes) {
          ncfrsInput.setCustomValidity('');
        }

        // Toggle RSBSA Status visibility
        if (rsbsaStatusContainer) {
          rsbsaStatusContainer.style.display = isNo ? 'flex' : 'none';
          const statusSelect = document.getElementById('newFarmerRsbsaStatus');
          if (statusSelect) statusSelect.required = isNo;
        }
      });
    }
    this.setupAddFarmerInputGuards();
    form.addEventListener('input', () => this.clearAddFarmerValidation());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.addFarmer();
    });
  }

  setupAddFarmerInputGuards() {
    const textOnlyIds = [
      'newFarmerLastName',
      'newFarmerFirstName',
      'newFarmerBarangay',
      'newFarmerAssociation',
      'newFarmerOwnership',
    ];
    const alphaPattern = /[^A-Za-z .'-]/g;

    textOnlyIds.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const allowedKeys = ['Backspace', 'Delete', 'Tab', 'Enter', 'Escape', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
        if (allowedKeys.includes(e.key)) return;
        if (/^[A-Za-z .'-]$/.test(e.key)) return;
        e.preventDefault();
      });
      el.addEventListener('input', () => {
        const clean = (el.value || '').replace(alphaPattern, '');
        if (clean !== el.value) el.value = clean;
      });
    });

    const integerOnlyIds = [
      'newLibBearing',
      'newLibNonBearing',
      'newExcBearing',
      'newExcNonBearing',
      'newRobBearing',
      'newRobNonBearing',
    ];
    const decimalIds = ['newFarmerArea', 'newLibProduction', 'newExcProduction', 'newRobProduction'];

    const bindNumericGuard = (id, allowDecimal) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const allowedKeys = ['Backspace', 'Delete', 'Tab', 'Enter', 'Escape', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
        if (allowedKeys.includes(e.key)) return;
        if (/^\d$/.test(e.key)) return;
        if (allowDecimal && e.key === '.' && !el.value.includes('.')) return;
        e.preventDefault();
      });
      el.addEventListener('input', () => {
        let clean = (el.value || '').replace(allowDecimal ? /[^0-9.]/g : /[^0-9]/g, '');
        if (allowDecimal) {
          const firstDot = clean.indexOf('.');
          if (firstDot !== -1) {
            clean = clean.slice(0, firstDot + 1) + clean.slice(firstDot + 1).replace(/\./g, '');
          }
        }
        if (clean !== el.value) el.value = clean;
      });
    };

    integerOnlyIds.forEach((id) => bindNumericGuard(id, false));
    decimalIds.forEach((id) => bindNumericGuard(id, true));
  }

  openAddFarmerModal() {
    if (this.data.length >= this.maxFarmers) {
      this.showNotification(
        `Maximum of ${this.maxFarmers} farmers reached. Remove a row or export data before adding another.`,
        'primary',
        { placement: 'center' }
      );
      return;
    }

    const modal = document.getElementById('addFarmerModal');
    if (!modal) return;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('confirm-dialog-active');
    this.clearAddFarmerValidation();
    const firstInput = document.getElementById('newFarmerLastName');
    if (firstInput) setTimeout(() => firstInput.focus(), 50);
  }

  closeAddFarmerModal() {
    const modal = document.getElementById('addFarmerModal');
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('confirm-dialog-active');
    this.clearAddFarmerValidation();
    const form = document.getElementById('addFarmerForm');
    if (form) {
      form.reset();
      const statusContainer = document.getElementById('newFarmerRsbsaStatus')?.closest('label');
      if (statusContainer) statusContainer.style.display = 'none';
    }
  }

  clearAddFarmerValidation() {
    const errorEl = document.getElementById('addFarmerFormError');
    if (errorEl) {
      errorEl.hidden = true;
      errorEl.textContent = '';
    }
  }

  showAddFarmerValidationError(message, focusId = '') {
    const errorEl = document.getElementById('addFarmerFormError');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    }
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) el.focus();
    }
  }

  getNumberInputValue(id, { integer = false } = {}) {
    const raw = (document.getElementById(id)?.value || '').toString().trim();
    if (!raw) return 0;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 0;
    return integer ? Math.trunc(n) : n;
  }

  validateAddFarmerForm() {
    const form = document.getElementById('addFarmerForm');
    const rsbsa = (document.getElementById('newFarmerRsbsa')?.value || '').trim();
    const ncfrsInput = document.getElementById('newFarmerNcfrs');
    if (!form) return null;

    if (ncfrsInput) {
      ncfrsInput.setCustomValidity('');
      if (rsbsa === 'YES' && !ncfrsInput.value.trim()) {
        ncfrsInput.setCustomValidity('NCFRS is required when RSBSA is YES.');
      }
    }

    const birthdayInput = document.getElementById('newFarmerBirthday');
    if (birthdayInput) {
      birthdayInput.setCustomValidity('');
      if (birthdayInput.value) {
        const date = new Date(`${birthdayInput.value}T00:00:00`);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (date > today) {
          birthdayInput.setCustomValidity('Birthday cannot be in the future.');
        }
      }
    }

    if (!form.checkValidity()) {
      form.reportValidity();
      this.showAddFarmerValidationError('Please correct the highlighted fields before submitting.');
      return null;
    }

    const numberRanges = [
      ['newFarmerArea', 0, 10000, false],
      ['newLibBearing', 0, 50000, true],
      ['newLibNonBearing', 0, 50000, true],
      ['newExcBearing', 0, 50000, true],
      ['newExcNonBearing', 0, 50000, true],
      ['newRobBearing', 0, 50000, true],
      ['newRobNonBearing', 0, 50000, true],
      ['newLibProduction', 0, 1000000, false],
      ['newExcProduction', 0, 1000000, false],
      ['newRobProduction', 0, 1000000, false],
    ];

    for (const [id, min, max, integer] of numberRanges) {
      const value = this.getNumberInputValue(id, { integer });
      if (!Number.isFinite(value) || value < min || value > max) {
        this.showAddFarmerValidationError(`Value out of range for ${id.replace('new', '')}.`, id);
        return null;
      }
    }

    const lastName = (document.getElementById('newFarmerLastName')?.value || '').trim();
    const firstName = (document.getElementById('newFarmerFirstName')?.value || '').trim();
    const payload = {
      name: `${firstName} ${lastName}`.trim(),
      barangay: (document.getElementById('newFarmerBarangay')?.value || '').trim(),
      birthday: (document.getElementById('newFarmerBirthday')?.value || '').trim(),
      association: (document.getElementById('newFarmerAssociation')?.value || '').trim(),
      rsbsa,
      rsbsaNumber: (document.getElementById('newFarmerRsbsaNumber')?.value || '').trim(),
      ncfrs: (document.getElementById('newFarmerNcfrs')?.value || '').trim(),
      ownership: (document.getElementById('newFarmerOwnership')?.value || '').trim(),
      area: this.getNumberInputValue('newFarmerArea'),
      libBearing: this.getNumberInputValue('newLibBearing', { integer: true }),
      libNonBearing: this.getNumberInputValue('newLibNonBearing', { integer: true }),
      excBearing: this.getNumberInputValue('newExcBearing', { integer: true }),
      excNonBearing: this.getNumberInputValue('newExcNonBearing', { integer: true }),
      robBearing: this.getNumberInputValue('newRobBearing', { integer: true }),
      robNonBearing: this.getNumberInputValue('newRobNonBearing', { integer: true }),
      libProd: this.getNumberInputValue('newLibProduction'),
      excProd: this.getNumberInputValue('newExcProduction'),
      robProd: this.getNumberInputValue('newRobProduction'),
      prodUnit: (document.getElementById('newProductionUnit')?.value || 'kg').trim(),
      rsbsaStatus: (document.getElementById('newFarmerRsbsaStatus')?.value || '').trim(),
    };

    return payload;
  }

  addFarmer() {
    if (this.data.length >= this.maxFarmers) return;
    const payload = this.validateAddFarmerForm();
    if (!payload) return;

    const totalBearing = payload.libBearing + payload.excBearing + payload.robBearing;
    const totalNonBearing = payload.libNonBearing + payload.excNonBearing + payload.robNonBearing;
    const totalTrees = totalBearing + totalNonBearing;

    const newRow = {
      'NAME OF FARMER': payload.name,
      'ADDRESS (BARANGAY)': payload.barangay,
      'FA OFFICER / MEMBER': payload.association,
      'BIRTHDAY': payload.birthday,
      'RSBSA Registered (Yes/No)': payload.rsbsa,
      'STATUS OF OWNERSHIP': payload.ownership,
      'Total Area Planted (HA.)': payload.area,
      'LIBERICA BEARING': payload.libBearing,
      'LIBERICA NON-BEARING': payload.libNonBearing,
      'EXCELSA BEARING': payload.excBearing,
      'EXCELSA NON-BEARING': payload.excNonBearing,
      'ROBUSTA BEARING': payload.robBearing,
      'ROBUSTA NON-BEARING': payload.robNonBearing,
      'TOTAL BEARING': totalBearing,
      'TOTAL NON-BEARING': totalNonBearing,
      'TOTAL TREES': totalTrees,
      'LIBERICA PRODUCTION': payload.libProd,
      'EXCELSA PRODUCTION': payload.excProd,
      'ROBUSTA PRODUCTION': payload.robProd,
      'PRODUCTION UNIT': payload.prodUnit,
      'RSBSA NUMBER': payload.rsbsaNumber,
      'RSBSA STATUS': payload.rsbsaStatus,
      'NCFRS': payload.ncfrs
    };

    const nextNo =
      Math.max(0, ...this.data.map((r) => this.farmerIdFromRow(r))) + 1;
    newRow['NO.'] = nextNo;
    newRow.farmer_id = nextNo;

    this.data.push(newRow);
    this.filteredData = [...this.data];
    this.totalRecords = this.data.length;
    this.currentPage = Math.max(1, Math.ceil(this.filteredData.length / this.pageSize));
    this.updateTable();
    this.updateStats();
    this.closeAddFarmerModal();
    this.addLocalFarmerRegistrationNotification(newRow);
    this.showNotification('Bagong farmer row na-add sa records.', 'success');
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

  applyOwnershipFlags(row) {
    if (!row || typeof row !== 'object') return row;
    const status = String(
      this.getValue(row, ['STATUS OF OWNERSHIP', 'Status Ownership', 'ownership_status']) || ''
    )
      .trim()
      .toLowerCase();

    const out = { ...row };
    const mark = (col) => {
      out[col] = 'X';
    };

    const exact = {
      landowner: 'LANDOWNER',
      cloa_holder: 'CLOA',
      'cloa holder': 'CLOA',
      list_holder: 'LEASE',
      'list holder': 'LEASE',
      sessional_farm_worker: 'SEASONAL',
      'sessional farm worker': 'SEASONAL',
      others: 'OTHERS',
      owner: 'LANDOWNER',
      owned: 'LANDOWNER',
      tenant: 'SEASONAL',
      lessee: 'LEASE',
      'co-owner': 'CLOA',
      co_owner: 'CLOA',
      coowner: 'CLOA',
      other: 'OTHERS',
      a: 'LANDOWNER',
      b: 'CLOA',
      c: 'LEASE',
      d: 'SEASONAL',
      e: 'OTHERS',
    };

    if (exact[status]) {
      mark(exact[status]);
    } else if (status.includes('landowner')) {
      mark('LANDOWNER');
    } else if (status.includes('cloa')) {
      mark('CLOA');
    } else if (status.includes('lease') || status.includes('list') || status.includes('lessee')) {
      mark('LEASE');
    } else if (status.includes('seasonal') || status.includes('sessional')) {
      mark('SEASONAL');
    } else if (status) {
      mark('OTHERS');
    }

    if (out.LANDOWNER) {
      out.OWNER_OPERATOR = 'X';
      out.A = 'X';
    }
    if (out.CLOA) {
      out.LESSOR = 'X';
      out.B = 'X';
    }
    if (out.LEASE) {
      out.LESSEE = 'X';
      out.C = 'X';
    }
    if (out.SEASONAL) {
      out.SHAREHOLDER = 'X';
      out.D = 'X';
    }
    if (out.OTHERS) {
      out.E = 'X';
    }

    return out;
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
    // Treat the last token as surname so "Nyco Alec Balaogan"
    // maps to first="Nyco Alec", last="Balaogan".
    const last = parts.pop() || '';
    const first = parts.join(' ');
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
        const n = Number.parseInt(numericCandidate, 10);
        const row = this.farmerRowByDisplaySeq(n, this.data);
        this.filteredData = row ? [row] : [];
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
      'ROBUSTA PRODUCTION': 0,
      'NCFRS': ''
    };
    
    this.data.push(newRow);
    this.filteredData = [...this.data];
    this.totalRecords = this.data.length;
    
    this.currentPage = Math.ceil(this.totalRecords / this.pageSize);
    this.updateTable();
    this.updateStats();
    
    this.showNotification('New farmer row added!', 'success');
  }

  renderPagination() {
    const pagination = document.getElementById('pagination');
    const listPagination = document.getElementById('farmersListPagination');
    const totalPages = Math.max(1, Math.ceil(this.filteredData.length / this.pageSize));

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
    const totalPages = Math.max(1, Math.ceil(this.filteredData.length / this.pageSize));
    if (page >= 1 && page <= totalPages) {
      this.currentPage = page;
      this.updateTable();
      this.updateStats();
    }
  }

  updateRecordInfo() {
    const recordInfo = document.getElementById('recordInfo');
    const listRecordInfo = document.getElementById('farmersListRecordInfo');
    
    if (this.filteredData.length === 0) {
      if (recordInfo) recordInfo.textContent = 'No records found';
      if (listRecordInfo) listRecordInfo.textContent = 'No profiles found';
      return;
    }

    const startIndex = (this.currentPage - 1) * this.pageSize + 1;
    const endIndex = Math.min(this.currentPage * this.pageSize, this.filteredData.length);
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
    const totalProduction = this.data.reduce(
      (sum, farmer) => sum + this.getTotalProduction(farmer),
      0
    );

    // Update stat cards
    this.setText('totalFarmers', totalFarmers.toLocaleString());
    this.setText('totalTrees', totalTrees.toLocaleString());
    this.setText('totalArea', totalArea.toFixed(2));
    this.setText('totalProduction', totalProduction.toLocaleString());

    console.log('Stats updated:', { totalFarmers, totalTrees, totalArea, totalProduction });
    this.renderAnalyticsModule();
  }

  createCharts() {
    if (!window.Chart) return;
    this.updateRegistrationChart();
  }

  buildRegistrationVolumeSeries(rows = []) {
    const monthCount = 6;
    const now = new Date();
    const buckets = [];

    for (let i = monthCount - 1; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({
        key: `${d.getFullYear()}-${d.getMonth()}`,
        label: d.toLocaleString(undefined, { month: 'short' }),
        count: 0,
      });
    }

    const bucketIndex = new Map(buckets.map((bucket, index) => [bucket.key, index]));

    (Array.isArray(rows) ? rows : []).forEach((row) => {
      if (!this.isFarmerRegistrationComplete(row)) return;
      const raw = row.registered_at || row.created_at || row.updated_at || row.date_registered;
      if (!raw) return;
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) return;
      const key = `${parsed.getFullYear()}-${parsed.getMonth()}`;
      const index = bucketIndex.get(key);
      if (index === undefined) return;
      buckets[index].count += 1;
    });

    const values = buckets.map((bucket) => bucket.count);
    const labels = buckets.map((bucket) => bucket.label);
    const total = values.reduce((sum, value) => sum + value, 0);

    let trendPct = null;
    if (total > 0 && values.length >= 2) {
      const current = values[values.length - 1];
      const previous = values[values.length - 2];
      if (previous > 0) {
        trendPct = Math.round(((current - previous) / previous) * 100);
      } else if (current > 0) {
        trendPct = 100;
      } else {
        trendPct = 0;
      }
    }

    return { labels, values, total, trendPct };
  }

  updateRegistrationTrendBadge({ total, trendPct }) {
    const badge = document.getElementById('registrationTrendBadge');
    const textEl = document.getElementById('registrationTrendBadgeText');
    if (!badge || !textEl) return;

    if (total <= 0 || trendPct === null) {
      badge.hidden = true;
      return;
    }

    badge.hidden = false;
    badge.classList.remove('positive', 'negative', 'neutral');

    if (trendPct > 0) {
      badge.classList.add('positive');
      textEl.textContent = `${trendPct}%`;
      badge.querySelector('i')?.classList.replace('fa-arrow-down', 'fa-arrow-up');
      badge.querySelector('i')?.classList.replace('fa-minus', 'fa-arrow-up');
    } else if (trendPct < 0) {
      badge.classList.add('negative');
      textEl.textContent = `${Math.abs(trendPct)}%`;
      const icon = badge.querySelector('i');
      if (icon) {
        icon.classList.remove('fa-arrow-up', 'fa-minus');
        icon.classList.add('fa-arrow-down');
      }
    } else {
      badge.classList.add('neutral');
      textEl.textContent = '0%';
      const icon = badge.querySelector('i');
      if (icon) {
        icon.classList.remove('fa-arrow-up', 'fa-arrow-down');
        icon.classList.add('fa-minus');
      }
    }
  }

  updateRegistrationChart() {
    const canvas = document.getElementById('registrationVolumeChart');
    if (!canvas || !window.Chart) return;

    const { labels, values, total, trendPct } = this.buildRegistrationVolumeSeries(this.data);
    this.updateRegistrationTrendBadge({ total, trendPct });

    const maxVal = Math.max(...values, 0);
    const stepSize = maxVal <= 10 ? 1 : maxVal <= 50 ? 5 : 20;
    const suggestedMax = maxVal === 0 ? 5 : Math.max(stepSize * 2, Math.ceil((maxVal * 1.15) / stepSize) * stepSize);

    if (!this.charts.registrationChart) {
      this.charts.registrationChart = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'New Registrations',
            data: values,
            backgroundColor: 'rgba(34, 197, 94, 0.2)',
            borderColor: '#16a34a',
            borderWidth: 2,
            fill: true,
            tension: 0.4,
            pointBackgroundColor: '#16a34a',
            pointRadius: 4,
            pointHoverRadius: 6,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              mode: 'index',
              intersect: false,
              backgroundColor: '#ffffff',
              titleColor: '#0f172a',
              bodyColor: '#475569',
              borderColor: '#e2e8f0',
              borderWidth: 1,
              padding: 12,
              displayColors: false,
              callbacks: {
                label: (context) => `Registrations: ${context.parsed.y}`,
              },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: {
                font: { size: 11 },
                color: '#94a3b8',
              },
            },
            y: {
              beginAtZero: true,
              suggestedMax,
              grid: { color: '#f1f5f9' },
              ticks: {
                stepSize,
                font: { size: 11 },
                color: '#94a3b8',
              },
            },
          },
        },
      });
      return;
    }

    const chart = this.charts.registrationChart;
    chart.data.labels = labels;
    chart.data.datasets[0].data = values;
    chart.options.scales.y.ticks.stepSize = stepSize;
    chart.options.scales.y.suggestedMax = suggestedMax;
    chart.update();
  }

  createTreeDistributionChart() {
    const canvas = document.getElementById('treeChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
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
    const canvas = document.getElementById('productionChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    // Calculate production by type
    const libericaProduction = this.data.reduce(
      (sum, farmer) => sum + this.getVarietyProduction(farmer, 'liberica'),
      0
    );
    const excelsaProduction = this.data.reduce(
      (sum, farmer) => sum + this.getVarietyProduction(farmer, 'excelsa'),
      0
    );
    const robustaProduction = this.data.reduce(
      (sum, farmer) => sum + this.getVarietyProduction(farmer, 'robusta'),
      0
    );

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

      const checks = {
        treeCount: totalTrees >= 500,
        rsbsa: rsbsa === true,
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

  async ensureIpophlFilesFromServer() {
    this._ipophlDocumentItems = await this.fetchIpophlDocumentItems();
  }

  async fetchIpophlDocumentItems() {
    try {
      const res = await fetch(beanthenticApiUrl('/api/ipo-documents?limit=200'), {
        credentials: 'same-origin',
      });
      const data = await beanthenticParseJsonResponse(res).catch(() => ({}));
      const items = Array.isArray(data.items) ? data.items : [];
      if (!this.ipophlFiles) this.ipophlFiles = {};
      items.forEach((doc) => {
        const taskId = String(doc.task_id || '').trim();
        const id = String(doc.file_uuid || doc.id || '').trim();
        if (!taskId || !id || taskId === 'ipophl-other' || taskId === 'unknown') return;
        if (!this.getOfficialIpophlTaskIds().includes(taskId)) return;
        if (!this.ipophlFiles[taskId]) this.ipophlFiles[taskId] = [];
        const existing = this.ipophlFiles[taskId].find((f) => f.id === id);
        if (existing) {
          existing.name = doc.filename || doc.original_filename || existing.name || 'file';
          existing.ai_score = Number(doc.ai_score || 0);
          existing.ai_status = doc.ai_status || existing.ai_status || '';
          existing.upload_timestamp = doc.upload_timestamp || existing.upload_timestamp || '';
        } else {
          this.ipophlFiles[taskId].push({
            id,
            name: doc.filename || doc.original_filename || 'file',
            ai_score: Number(doc.ai_score || 0),
            ai_status: doc.ai_status || '',
            upload_timestamp: doc.upload_timestamp || '',
          });
        }
      });
      return items;
    } catch (err) {
      console.warn('Could not load IPOPHL files for analytics:', err);
      return this._ipophlDocumentItems || [];
    }
  }

  getIpophlGroupLabel(taskId) {
    const labels = {
      'phase1-introduction': 'Introduction & Reputation',
      'phase1-history': 'History of Kapeng Barako',
      'phase1-physical-link': 'Physical Link',
      'phase2-general': 'General Description',
      'phase2-specific': 'Specific Description',
      'phase2-production': 'Production Process',
      'phase3-control': 'Control & Traceability',
      // Legacy labels for older uploads
      'phase1-product': 'Qualifying Product',
      'phase1-entity': 'Applicant Entity',
      'phase1-stakeholders': 'Stakeholders',
      'phase2-mop': 'Manual of Prod.',
      'phase2-cert': 'Certification',
      'phase2-details': 'Product Details',
      'phase3-filing': 'Filing',
      'phase3-payment': 'Payment',
      'phase4-exam': 'Examination',
      'phase4-response': 'Deficiency Resp.',
      'phase4-pub': 'Publication',
      'phase5-cert': 'GI Certificate',
      'phase5-compliance': 'Compliance',
    };
    return labels[taskId] || taskId;
  }

  getIpophlPhaseMeta() {
    return {
      1: { short: 'Phase 1', title: 'Justification', sub: 'Reputation, history & territorial link' },
      2: { short: 'Phase 2', title: 'Technical Part', sub: 'General, specific & production process' },
      3: { short: 'Phase 3', title: 'Control & Traceability', sub: 'Internal control and records' },
      4: { short: 'Phase 4', title: 'Compile', sub: 'Merge all docs into one PDF or DOCX' },
    };
  }

  isIpophlFileReady(fileOrDoc) {
    const status = String(
      fileOrDoc?.ai_status || fileOrDoc?.status || fileOrDoc?.aiStatus || ''
    )
      .trim()
      .toLowerCase();
    if (status === 'ready' || status === 'pass') return true;
    if (
      status === 'not ready' ||
      status === 'not_ready' ||
      status === 'fail' ||
      status === 'failed'
    ) {
      return false;
    }
    // Pending / unreviewed uploads must not advance the GI process bar.
    if (
      !status ||
      status === 'uploaded' ||
      status === 'pending' ||
      status === 'analyzed' ||
      status === 'processing'
    ) {
      return false;
    }
    // Legacy rows that only store a percent
    return Number(fileOrDoc?.ai_score || 0) >= 100;
  }

  /** Sync Ready / Not Ready from visible file cards into ipophlFiles. */
  syncIpophlFileStatusesFromDom(service) {
    const container = document.getElementById(`${service}-files`);
    if (!container) return;
    if (!this.ipophlFiles) this.ipophlFiles = {};
    if (!this.ipophlFiles[service]) this.ipophlFiles[service] = [];

    container.querySelectorAll('.file-item').forEach((card) => {
      if (card.classList.contains('error') || card.classList.contains('pending')) return;
      const status = String(card.dataset.aiStatus || '').trim();
      if (!status) return;
      const uuid = String(card.dataset.fileUuid || card.dataset.fileId || '').trim();
      const name = String(card.querySelector('.file-name')?.textContent || '').trim();
      let row = null;
      if (uuid) {
        row = this.ipophlFiles[service].find(
          (f) => String(f.id || f.file_uuid || '') === uuid
        );
      }
      if (!row && name) {
        row = this.ipophlFiles[service].find((f) => String(f.name || '') === name);
      }
      if (row) {
        row.ai_status = status;
      } else if (uuid || name) {
        this.ipophlFiles[service].push({
          id: uuid || `${service}-${name}`,
          name: name || uuid,
          ai_status: status,
        });
      }
    });
  }

  isIpophlServiceComplete(service) {
    this.syncIpophlFileStatusesFromDom(service);
    const files = (this.ipophlFiles && this.ipophlFiles[service]) || [];
    // Only AI Ready files advance the top-right progress bar.
    if (files.some((f) => this.isIpophlFileReady(f))) return true;

    const container = document.getElementById(`${service}-files`);
    if (container) {
      const cards = [...container.querySelectorAll('.file-item')].filter(
        (card) => !card.classList.contains('error') && !card.classList.contains('pending')
      );
      if (cards.some((card) => this.isIpophlFileReady({ ai_status: card.dataset.aiStatus }))) {
        return true;
      }
    }
    return false;
  }

  /** True when the group has an uploaded file or link (for phase navigation only). */
  isIpophlServiceHasUpload(service) {
    this.syncIpophlFileStatusesFromDom(service);
    if ((this.ipophlFiles?.[service] || []).length > 0) return true;
    if ((this.ipophlLinks?.[service] || []).length > 0) return true;
    const container = document.getElementById(`${service}-files`);
    return Boolean(
      container?.querySelector(
        '.file-item[data-file-uuid], .file-item.success:not(.pending):not(.uploading), .file-item:not(.error):not(.pending)'
      )
    );
  }

  computeIpophlDocumentAnalytics(docs) {
    const items = Array.isArray(docs) ? docs : [];
    const servicesByPhase = this.getIpophlServicesByPhase();
    const allServices = Object.values(servicesByPhase).flat();
    const isReadyDoc = (d) => this.isIpophlFileReady(d);
    const scores = items.map((d) => Number(d.ai_score || 0)).filter((n) => !Number.isNaN(n));
    const avgScore = scores.length
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 0;
    const passedFiles = items.filter((d) => isReadyDoc(d)).length;
    const pendingAi = items.filter((d) => {
      const status = String(d.ai_status || '').toLowerCase();
      return !status || status === 'uploaded' || status === 'pending' || status === 'analyzed';
    }).length;

    const groupScores = allServices.map((service) => {
      const groupDocs = items.filter((d) => String(d.task_id || '') === service);
      const groupFileDocs = (this.ipophlFiles?.[service] || []).map((f) => ({
        ai_score: Number(f.ai_score || 0),
        ai_status: f.ai_status,
        status: f.ai_status,
      }));
      const source = groupDocs.length ? groupDocs : groupFileDocs;
      const anyReady = source.some((d) => isReadyDoc(d)) || this.isIpophlServiceComplete(service);
      // MoP Ready is authoritative — no keyword % scores in Analytics.
      const best = anyReady ? 100 : source.length ? 0 : 0;
      const phaseNum = Object.keys(servicesByPhase).find((p) =>
        servicesByPhase[p].includes(service)
      );
      return {
        service,
        label: this.getIpophlGroupLabel(service),
        score: best,
        mopReady: anyReady,
        complete: anyReady,
        phase: Number(phaseNum || 0),
        passed: anyReady,
        failed: source.length > 0 && !anyReady,
      };
    });

    const phaseStats = [1, 2, 3, 4].map((phase) => {
      const services = servicesByPhase[phase] || [];
      const mopReadyGroups = phase === 4
        ? (this._ipophlCompiledOnce ? 1 : 0)
        : services.filter((s) => this.isIpophlServiceComplete(s)).length;
      const totalGroups = phase === 4 ? 1 : services.length;
      const pending = Math.max(0, totalGroups - mopReadyGroups);
      const phaseDocs = items.filter((d) => String(d.ipophl_phase || '').includes(String(phase)) || services.includes(String(d.task_id || '')));
      const pass = phaseDocs.filter((d) => isReadyDoc(d)).length;
      const fail = phaseDocs.filter((d) => String(d.ai_status || d.status || '').trim() && !isReadyDoc(d)).length;
      const mopReadyPct = totalGroups > 0 ? Math.round((mopReadyGroups / totalGroups) * 100) : 0;
      return {
        phase,
        completed: mopReadyGroups,
        pending,
        pass,
        fail,
        totalGroups,
        mopReadyPct,
      };
    });

    let currentPhase = 4;
    let currentMeta = this.getIpophlPhaseMeta()[4];
    for (let p = 1; p <= 4; p += 1) {
      const services = servicesByPhase[p] || [];
      const allDone = p === 4
        ? Boolean(this._ipophlCompiledOnce)
        : services.every((s) => this.isIpophlServiceComplete(s));
      if (!allDone) {
        currentPhase = p;
        currentMeta = this.getIpophlPhaseMeta()[p];
        break;
      }
    }

    const monthCounts = new Map();
    items.forEach((doc) => {
      const raw = doc.upload_timestamp || '';
      const d = raw ? new Date(raw) : null;
      if (!d || Number.isNaN(d.getTime())) return;
      const key = d.toLocaleString(undefined, { month: 'short', year: '2-digit' });
      monthCounts.set(key, (monthCounts.get(key) || 0) + 1);
    });
    const timelineLabels = [...monthCounts.keys()].slice(-8);
    const timelineValues = timelineLabels.map((k) => monthCounts.get(k) || 0);

    return {
      avgScore,
      passedFiles,
      totalFiles: items.length,
      pendingAi,
      groupScores,
      phaseStats,
      currentPhase,
      currentPhaseLabel: `${currentMeta.short} — ${currentMeta.title}`,
      currentPhaseSub: currentMeta.sub,
      timelineLabels,
      timelineValues,
    };
  }

  isFarmerGiEligibleByRules(farmer) {
    const rsbsa = this.yesNo(farmer, [
      'RSBSA Registered (Yes/No)',
      'REGISTERED (YES/NO)',
      'Registered (Yes/No)',
      'registered',
    ]);
    const totalTrees =
      this.num(farmer, ['TOTAL TREES', 'TOTAL_TREES']) ||
      this.num(farmer, ['TOTAL BEARING', 'Total_Bearing']) +
        this.num(farmer, ['TOTAL NON-BEARING', 'Total_Non-bearing']);
    const ncfrs = (this.getValue(farmer, ['NCFRS', 'ncfrs']) || '').toString().trim();
    return totalTrees >= 500 && rsbsa === true && !!ncfrs;
  }

  countFarmersNeedingGiSupport(rows, predictions) {
    const farmers = Array.isArray(rows) ? rows : [];
    const preds = Array.isArray(predictions) ? predictions : [];
    let count = 0;
    farmers.forEach((farmer, idx) => {
      const ready = preds.length
        ? !!preds[idx]?.gi_ready
        : this.isFarmerGiEligibleByRules(farmer);
      if (ready) return;
      const trees =
        this.num(farmer, ['TOTAL TREES', 'TOTAL_TREES']) ||
        this.num(farmer, ['TOTAL BEARING', 'Total_Bearing']) +
          this.num(farmer, ['TOTAL NON-BEARING', 'Total_Non-bearing']);
      if (trees > 0) count += 1;
    });
    return count;
  }

  buildFarmerReadinessBuckets(predictions) {
    const buckets = [0, 0, 0, 0];
    (predictions || []).forEach((p) => {
      const score = Number(p.readiness_score || 0);
      if (score <= 25) buckets[0] += 1;
      else if (score <= 50) buckets[1] += 1;
      else if (score <= 75) buckets[2] += 1;
      else buckets[3] += 1;
    });
    return buckets;
  }

  destroyAnalyticsChart(key) {
    if (this.charts[key]) {
      this.charts[key].destroy();
      this.charts[key] = null;
    }
  }

  async renderAnalyticsModule() {
    const analyticsRoot = document.getElementById('analytics-module');
    if (!analyticsRoot || analyticsRoot.classList.contains('hidden')) return;
    if (!window.Chart) return;

    const docs = await this.fetchIpophlDocumentItems();
    const fromMonth = document.getElementById('analyticsFromMonth')?.value || '';
    const filteredDocs = fromMonth
      ? docs.filter((d) => String(d.upload_timestamp || d.created_at || '').slice(0, 7) >= fromMonth)
      : docs;
    const metrics = await this.computeGiAnalyticsAsync();
    const ipophl = this.computeIpophlDocumentAnalytics(filteredDocs);
    const ipophlSnapshot = this.getIpophlCompletionSnapshot();

    this.setText('analyticsDocsPassed', String(ipophl.passedFiles));
    this.setText(
      'analyticsDocsPassedSub',
      ipophl.totalFiles
        ? `${ipophl.passedFiles} of ${ipophl.totalFiles} files · Ready`
        : 'Ready documents'
    );
    this.setText('ipophlProgressRate', `${ipophlSnapshot.percentage}%`);
    this.setText(
      'ipophlProgressSub',
      `${ipophlSnapshot.completed} of ${ipophlSnapshot.total} groups Ready`
    );

    this.renderIpophlPhaseCompletionChart(ipophl);
    this.renderIpophlUploadTimelineChart(ipophl);
    this.renderTopBarangaysChart(metrics);
    this.renderGiGrowthTrendChart(metrics);
    this.renderGiReadinessGaugeChart(metrics);
    this.bindAnalyticsToolbar(docs);
  }

  bindAnalyticsToolbar(docs) {
    const fromEl = document.getElementById('analyticsFromMonth');
    const exportBtn = document.getElementById('analyticsExportBtn');
    if (fromEl && !fromEl.dataset.bound) {
      fromEl.dataset.bound = '1';
      fromEl.addEventListener('change', () => this.renderAnalyticsModule());
    }
    if (exportBtn && !exportBtn.dataset.bound) {
      exportBtn.dataset.bound = '1';
      exportBtn.addEventListener('click', () => this.exportAnalyticsCharts());
    }
  }

  exportAnalyticsCharts() {
    const ids = [
      'ipophlPhaseCompletionChart',
      'ipophlUploadTimelineChart',
      'topBarangaysChart',
      'giGrowthTrendChart',
      'giReadinessGaugeChart',
    ];
    ids.forEach((id) => {
      const canvas = document.getElementById(id);
      if (!canvas || typeof canvas.toDataURL !== 'function') return;
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = `${id}.png`;
      a.click();
    });
    this.showNotification('Chart images downloaded.', 'success');
  }

  async computeGiAnalyticsAsync() {
    // Rule-based farmer eligibility only — AI analysis is document/MoP focused.
    const base = this.computeGiAnalytics();
    const rows = Array.isArray(this.data) ? this.data : [];
    return {
      ...base,
      mlEnabled: false,
      predictions: [],
      readinessBuckets: this.buildFarmerReadinessBuckets([]),
      farmersNeedingSupport: this.countFarmersNeedingGiSupport(rows, []),
    };
  }

  async renderIpophlModule() {
    const ipophlRoot = document.getElementById('ipophl-module');
    if (!ipophlRoot || ipophlRoot.classList.contains('hidden')) return;

    await this.ensureIpophlFilesFromServer();
    
    // Initialize IPOPHL module functionality
    this.initializePhaseNavigation();
    this.initializePhaseButtons();
    this.initializeFileUpload();
    this.initializeLinkInputs();
    this.initializeProgressSteps();
    this.captureIpophlUploadZoneLabels();
    
    // Load and display submission status
    this.loadSubmissionStatus();
    this.updateSubmissionStatus();
    this.updateGiProcessIndicator();
    this.refreshIpophlMlBanner();
  }

  async refreshIpophlMlBanner() {
    const banner = document.getElementById('ipophlMlBanner');
    if (!banner) return;
    try {
      const res = await fetch(beanthenticApiUrl('/api/ml/status'), { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        banner.hidden = false;
        banner.textContent = 'AI status unavailable. Document review will use rules only.';
        return;
      }
      if (data.document_model_loaded) {
        banner.hidden = true;
        banner.textContent = '';
        return;
      }
      banner.hidden = false;
      banner.textContent = 'Document AI model is not loaded. Review still runs on GI filing rules; retrain if needed.';
    } catch (_) {
      banner.hidden = false;
      banner.textContent = 'Could not reach the AI status endpoint.';
    }
  }

  initializePhaseNavigation() {
    // Initialize current phase
    if (!this.currentPhase) this.currentPhase = 1;
    
    this.showPhase(this.currentPhase);
    this.updateProgress(this.currentPhase);
  }

  initializeProgressSteps() {
    const progressSteps = document.querySelectorAll('#giPhaseProgress .progress-step');

    progressSteps.forEach((step) => {
      step.addEventListener('click', (e) => {
        const phaseNum = parseInt(e.currentTarget.dataset.phase, 10);
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
        const nextPhase = parseInt(e.currentTarget.dataset.next, 10);
        this.navigateToPhase(nextPhase);
      });
    });
    
    prevPhaseBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const prevPhase = parseInt(e.currentTarget.dataset.prev, 10);
        this.navigateToPhase(prevPhase);
      });
    });

    this.initIpophlCompilePhase();
    
    // Complete Registration is bound once via initIpophlCompleteRegistration() (delegated).
  }

  initIpophlCompilePhase() {
    if (this._ipophlCompileBound) return;
    this._ipophlCompileBound = true;
    this._ipophlCompiledOnce = false;

    const panel = document.getElementById('ipophlCompilePanel');
    if (!panel) return;

    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      if (action === 'ipophl-compile-refresh') {
        e.preventDefault();
        this.refreshIpophlCompileSources();
      } else if (action === 'ipophl-compile-download') {
        e.preventDefault();
        this.downloadIpophlCompiledPackage();
      }
    });
  }

  getSelectedIpophlCompileFormat() {
    const checked = document.querySelector('input[name="ipophl-compile-format"]:checked');
    const fmt = String(checked?.value || 'pdf').toLowerCase();
    return fmt === 'docx' ? 'docx' : 'pdf';
  }

  async refreshIpophlCompileSources() {
    const listEl = document.getElementById('ipophlCompileList');
    const metaEl = document.getElementById('ipophlCompileMeta');
    const downloadBtn = document.getElementById('ipophlCompileDownloadBtn');
    if (!listEl || !metaEl) return;

    metaEl.textContent = 'Loading uploaded documents…';
    listEl.innerHTML = '';
    if (downloadBtn) downloadBtn.disabled = true;

    const clientFallback = () => {
      const items = [];
      const seen = new Set();
      (this.getOfficialIpophlTaskIds() || []).forEach((taskId) => {
        const files = this.ipophlFiles?.[taskId] || [];
        files.forEach((f) => {
          const id = String(f.id || f.file_uuid || '').trim();
          const key = id || `${taskId}:${f.name || ''}`;
          if (seen.has(key)) return;
          seen.add(key);
          items.push({
            file_uuid: id,
            task_id: taskId,
            label: this.getIpophlGroupLabel(taskId),
            original_filename: f.name || f.original_filename || id || 'Uploaded file',
          });
        });
      });
      return items;
    };

    try {
      const res = await fetch(beanthenticApiUrl('/api/ipophl/compile-preview'), {
        credentials: 'same-origin',
      });
      if (res.status === 401) {
        metaEl.textContent = 'Session expired. Sign in again, then reopen Phase 4.';
        listEl.innerHTML = '<li class="ipophl-compile-empty">Unauthorized — please log in again.</li>';
        return;
      }
      if (res.status === 404) {
        try {
          const check = await fetch(beanthenticApiUrl('/api/admin/system-check'), { credentials: 'same-origin' });
          const health = await check.json().catch(() => ({}));
          const hint = health && health.ok === false
            ? (health.error || 'System check reported a problem.')
            : 'Route missing — restart python web.py, then hard-refresh (Ctrl+F5).';
          throw new Error(`Compile API not found. ${hint}`);
        } catch (healthErr) {
          if (String(healthErr.message || '').startsWith('Compile API')) throw healthErr;
          throw new Error('Compile API not found. Restart python web.py, then hard-refresh (Ctrl+F5).');
        }
      }
      const data = await beanthenticParseJsonResponse(res).catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || 'Could not load compile sources.');
      }
      let items = Array.isArray(data.items) ? data.items : [];
      if (!items.length) {
        items = clientFallback();
      }
      this._ipophlCompileSources = items;
      metaEl.textContent = items.length
        ? `${items.length} file(s) will be combined into one package`
        : 'No Phase 1–3 uploads found yet. Add documents in earlier phases first.';

      listEl.innerHTML = items.length
        ? items
            .map(
              (item) =>
                `<li><span class="ipophl-compile-label">${this.escapeHtml(item.label || item.task_id || 'Document')}</span>` +
                `<span class="ipophl-compile-file">${this.escapeHtml(item.original_filename || item.file_uuid || '')}</span></li>`
            )
            .join('')
        : '<li class="ipophl-compile-empty">No source files available.</li>';

      if (downloadBtn) downloadBtn.disabled = items.length === 0;
    } catch (err) {
      const fallback = clientFallback();
      if (fallback.length) {
        this._ipophlCompileSources = fallback;
        metaEl.textContent = `${fallback.length} file(s) from this session (server list unavailable)`;
        listEl.innerHTML = fallback
          .map(
            (item) =>
              `<li><span class="ipophl-compile-label">${this.escapeHtml(item.label || item.task_id || 'Document')}</span>` +
              `<span class="ipophl-compile-file">${this.escapeHtml(item.original_filename || item.file_uuid || '')}</span></li>`
          )
          .join('');
        if (downloadBtn) downloadBtn.disabled = false;
        return;
      }
      metaEl.textContent = err?.message || 'Could not load compile sources.';
      listEl.innerHTML = '<li class="ipophl-compile-empty">Unable to load sources.</li>';
      if (downloadBtn) downloadBtn.disabled = true;
    }
  }

  async downloadIpophlCompiledPackage() {
    const fmt = this.getSelectedIpophlCompileFormat();
    const downloadBtn = document.getElementById('ipophlCompileDownloadBtn');
    const labelEl = downloadBtn?.querySelector('.ipophl-compile-download-label');
    const defaultLabel = labelEl?.textContent || 'Save / Download compiled file';
    if (downloadBtn) {
      downloadBtn.disabled = true;
      if (labelEl) labelEl.textContent = `Preparing ${fmt.toUpperCase()}…`;
    }

    try {
      const res = await fetch(
        beanthenticApiUrl(`/api/ipophl/compile-package?format=${encodeURIComponent(fmt)}`),
        { credentials: 'same-origin' }
      );
      const contentType = String(res.headers.get('content-type') || '');
      if (!res.ok) {
        let message = 'Compile failed.';
        if (contentType.includes('application/json')) {
          const data = await beanthenticParseJsonResponse(res).catch(() => ({}));
          message = data.error || message;
        }
        throw new Error(message);
      }

      const blob = await res.blob();
      let filename = `Kapeng_Barako_GI_Compiled.${fmt}`;
      const disposition = res.headers.get('content-disposition') || '';
      const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^\";]+)/i);
      if (match) {
        filename = decodeURIComponent(match[1].replace(/"/g, '').trim());
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      this._ipophlCompiledOnce = true;
      this.updateGiProcessIndicator();
      this.showIpophlNotification(
        `Compiled package saved as ${fmt.toUpperCase()}. Choose the other format anytime to download again.`
      );
    } catch (err) {
      this.showIpophlNotification(err?.message || 'Could not download compiled package.');
    } finally {
      if (downloadBtn) {
        const sources = this._ipophlCompileSources || [];
        downloadBtn.disabled = sources.length === 0;
        if (labelEl) labelEl.textContent = defaultLabel;
      }
    }
  }

  initIpophlCompleteRegistration() {
    // Click + loading handled by js/ipophl-complete-gi.js (capture phase).
    this._ipophlCompleteDelegated = true;
  }

  navigateToPhase(phaseNum) {
    const phase = Number(phaseNum);
    if (!Number.isFinite(phase) || phase < 1 || phase > 4) return;

    if (!this.canNavigateToPhase(phase)) {
      const blocked = this.getBlockedPhaseForNavigation(phase);
      this.showIpophlNotification(
        blocked
          ? `Upload all required documents in ${this.getPhaseTitle(blocked)} before continuing.`
          : 'Complete all document uploads in the current phase before continuing.'
      );
      return;
    }

    this.currentPhase = phase;
    this.showPhase(phase);
    this.updateProgress(phase);
    this.updateGiProcessIndicator();
    if (phase === 4) {
      this.refreshIpophlCompileSources();
    }
  }

  canNavigateToPhase(targetPhase) {
    const target = Number(targetPhase);
    if (!Number.isFinite(target) || target < 1 || target > 4) return false;
    const current = this.currentPhase || 1;
    if (target <= current) return true;
    for (let phase = current; phase < target; phase += 1) {
      if (!this.isIpophlPhaseComplete(phase)) return false;
    }
    return true;
  }

  getBlockedPhaseForNavigation(targetPhase) {
    const target = Number(targetPhase);
    const current = this.currentPhase || 1;
    if (!Number.isFinite(target) || target <= current) return null;
    for (let phase = current; phase < target; phase += 1) {
      if (!this.isIpophlPhaseComplete(phase)) return phase;
    }
    return null;
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

  // isIpophlServiceComplete is defined earlier (Ready AI only — Not Ready does not count).

  isIpophlPhaseComplete(phaseNum) {
    if (Number(phaseNum) === 4) {
      return Boolean(this._ipophlCompiledOnce);
    }
    const services = this.getIpophlServicesByPhase()[phaseNum];
    if (!services?.length) return false;
    // Phase stepper unlocks when uploads exist; top progress bar still needs AI Ready.
    return services.every((service) => this.isIpophlServiceHasUpload(service));
  }

  updateProgress(phaseNum) {
    const progressSteps = document.querySelectorAll('#giPhaseProgress .progress-step');

    progressSteps.forEach((step) => {
      const stepNum = parseInt(step.dataset.phase, 10);
      const isComplete = this.isIpophlPhaseComplete(stepNum);
      const isActive = stepNum === phaseNum;
      const reachable = this.canNavigateToPhase(stepNum);
      const baseLabel = step.getAttribute('aria-label')?.replace(/, completed$/i, '').replace(/, locked$/i, '') || `Phase ${stepNum}`;

      step.classList.toggle('active', isActive);
      step.classList.toggle('completed', isComplete);
      step.classList.toggle('locked', !reachable);
      step.setAttribute('aria-disabled', reachable ? 'false' : 'true');
      let label = baseLabel;
      if (isComplete) label += ', completed';
      else if (!reachable) label += ', locked';
      step.setAttribute('aria-label', label);
    });

    document.querySelectorAll('#ipophl-module .next-phase').forEach((btn) => {
      const next = parseInt(btn.dataset.next, 10);
      const allowed = Number.isFinite(next) && this.canNavigateToPhase(next);
      btn.disabled = !allowed;
      btn.classList.toggle('is-locked', !allowed);
      btn.setAttribute('aria-disabled', allowed ? 'false' : 'true');
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

  collectIpophlPublishEntriesFromState() {
    const entries = [];
    const filesByService = this.ipophlFiles || {};
    Object.keys(filesByService).forEach((taskId) => {
      (filesByService[taskId] || []).forEach((f) => {
        const id = String(f.id || f.file_uuid || '').trim();
        if (id) entries.push({ file_uuid: id, task_id: taskId });
      });
    });
    return entries;
  }

  collectIpophlPublishEntries() {
    const byUuid = new Map();

    const add = (fileUuid, taskId) => {
      const id = String(fileUuid || '').trim();
      if (!id) return;
      const tid = String(taskId || 'ipophl-other').trim() || 'ipophl-other';
      byUuid.set(id, { file_uuid: id, task_id: tid });
    };

    this.collectIpophlPublishEntriesFromState().forEach((e) => add(e.file_uuid, e.task_id));

    const zones = document.querySelectorAll('#ipophl-module .file-upload-zone[data-service]');
    zones.forEach((zone) => {
      const taskId = zone.dataset.service;
      if (!taskId) return;
      const container = document.getElementById(`${taskId}-files`);
      if (!container) return;
      container.querySelectorAll('.file-item').forEach((el) => {
        const id = el.dataset.fileUuid || el.getAttribute('data-file-uuid');
        const zoneTask = el.dataset.taskId || el.getAttribute('data-task-id') || taskId;
        add(id, zoneTask);
      });
      container.querySelectorAll('.file-action-btn.ai-analysis').forEach((btn) => {
        const match = (btn.getAttribute('onclick') || '').match(/loadAndShowFullAnalysis\('([^']+)'\)/);
        if (match) add(match[1], taskId);
      });
    });

    return Array.from(byUuid.values());
  }

  collectPhase5FileUuids() {
    const services = this.getOfficialIpophlTaskIds();
    const uuids = [];
    const seen = new Set();
    const addUuid = (id) => {
      const uid = String(id || '').trim();
      if (uid && !seen.has(uid)) {
        seen.add(uid);
        uuids.push(uid);
      }
    };

    services.forEach((service) => {
      (this.ipophlFiles?.[service] || []).forEach((f) => addUuid(f.id || f.file_uuid));

      const container = document.getElementById(`${service}-files`);
      if (!container) return;

      container.querySelectorAll('[data-file-uuid]').forEach((el) => addUuid(el.getAttribute('data-file-uuid')));

      container.querySelectorAll('.file-action-btn.ai-analysis').forEach((btn) => {
        const onclick = btn.getAttribute('onclick') || '';
        const match = onclick.match(/loadAndShowFullAnalysis\('([^']+)'\)/);
        if (match) addUuid(match[1]);
      });
    });

    return uuids;
  }

  async fetchAllIpophlFileEntriesFromServer() {
    const entries = [];
    const seen = new Set();
    try {
      const res = await fetch(beanthenticApiUrl('/api/ipo-documents?limit=300'), { credentials: 'same-origin' });
      const data = await beanthenticParseJsonResponse(res).catch(() => ({}));
      (data.items || []).forEach((doc) => {
        const id = String(doc.file_uuid || '').trim();
        const taskId = String(doc.task_id || '').trim();
        if (id && !seen.has(id)) {
          seen.add(id);
          entries.push({ file_uuid: id, task_id: taskId });
        }
      });
    } catch (e) {
      console.warn('Could not load IPOPHL documents:', e);
    }
    return entries;
  }

  async fetchPhase5FileUuidsFromServer() {
    const uuids = [];
    const seen = new Set();
    const add = (uid) => {
      const id = String(uid || '').trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        uuids.push(id);
      }
    };
    const official = new Set(this.getOfficialIpophlTaskIds());

    try {
      const res = await fetch(beanthenticApiUrl('/api/ipo-documents?limit=200'), { credentials: 'same-origin' });
      const data = await beanthenticParseJsonResponse(res).catch(() => ({}));
      const items = data.items || [];
      items.forEach((doc) => {
        const tid = String(doc.task_id || '');
        if (official.has(tid) || /^phase[1-3]-/.test(tid)) add(doc.file_uuid);
      });
      if (!uuids.length) {
        items.slice(0, 20).forEach((doc) => add(doc.file_uuid));
      }
    } catch (e) {
      console.warn('Could not load IPOPHL documents:', e);
    }
    return uuids;
  }

  setCompleteRegistrationLoading(isLoading) {
    const completeBtn = document.querySelector('#ipophl-module .complete-btn');
    if (!completeBtn) return;
    if (!completeBtn.dataset.defaultLabel) {
      completeBtn.dataset.defaultLabel = completeBtn.textContent.trim() || 'Complete Registration';
    }
    if (isLoading) {
      completeBtn.disabled = true;
      completeBtn.classList.add('is-completed');
      completeBtn.classList.remove('is-loading');
      completeBtn.removeAttribute('aria-busy');
      completeBtn.textContent = completeBtn.dataset.defaultLabel;
    } else {
      completeBtn.disabled = false;
      completeBtn.classList.remove('is-completed', 'is-loading');
      completeBtn.removeAttribute('aria-busy');
      completeBtn.textContent = completeBtn.dataset.defaultLabel;
    }
  }

  async completeRegistration() {
    if (!this.areAllRequiredIpophlDocsMopReady()) {
      const missing = (this.getIpophlCompletionSnapshot().missing || [])
        .map((s) => this.getIpophlGroupLabel(s))
        .join(', ');
      this.showIpophlNotification(
        missing
          ? `Complete Registration is blocked until Ready for: ${missing}.`
          : 'Complete Registration is blocked until all required phase docs are Ready.'
      );
      this.syncCompleteRegistrationButtonState();
      return;
    }
    if (typeof window.publishIpophlToGiUpdates === 'function') {
      return window.publishIpophlToGiUpdates();
    }
    // Fallback if ipophl-complete-gi.js did not load.
    this.setCompleteRegistrationLoading(true);

    const merged = new Map();
    const serverEntries = await this.fetchAllIpophlFileEntriesFromServer();
    serverEntries.forEach((e) => {
      if (e.file_uuid) merged.set(e.file_uuid, { ...e });
    });
    this.collectIpophlPublishEntries().forEach((e) => {
      if (!e.file_uuid) return;
      const prev = merged.get(e.file_uuid) || {};
      merged.set(e.file_uuid, {
        file_uuid: e.file_uuid,
        task_id: e.task_id || prev.task_id || 'ipophl-other',
      });
    });

    let fileEntries = Array.from(merged.values());
    let fileUuids = fileEntries.map((e) => e.file_uuid).filter(Boolean);

    if (!fileUuids.length) {
      const phase5Ids = this.collectPhase5FileUuids();
      fileUuids = phase5Ids;
      fileEntries = phase5Ids.map((id) => ({ file_uuid: id, task_id: 'ipophl-other' }));
    }

    try {
      const res = await fetch(beanthenticApiUrl('/api/ipophl/complete-registration'), {
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
      const data = await beanthenticParseJsonResponse(res).catch(() => ({}));
      if (res.status === 401) {
        throw new Error('Session expired. Log in again, then click Complete Registration.');
      }
      if (!res.ok || data.ok === false) {
        const err =
          data.error ||
          data.detail ||
          data.message ||
          `Save failed (HTTP ${res.status}). Check settings.json and MySQL on the app device.`;
        throw new Error(err);
      }
      const cards = data.cards_published || 0;
      const resolved = data.files_resolved != null ? data.files_resolved : cards;
      const requested = data.files_requested != null ? data.files_requested : fileUuids.length;
      const okMsg =
        data.message ||
        `Saved ${cards} of ${requested} document(s) to GI Updates on the mobile app. Farmer messages from the app appear in Farmer's Contribution.`;
      this.showIpophlNotification(okMsg);

      console.log('IPOPHL → GI Updates published:', {
        fileUuids,
        cards,
        resolved,
        requested,
        source: data.source,
        completedAt: new Date().toISOString(),
      });

      if (typeof this.loadContributionsFromApi === 'function') {
        await this.loadContributionsFromApi();
      }
    } catch (err) {
      console.error('Complete registration failed:', err);
      let msg = err.message || 'Failed to send files to GI Updates.';
      if (msg === 'Failed to fetch') {
        msg =
          'Could not reach web.py. Restart python web.py, hard-refresh the page (Ctrl+F5), and set settings.json app_server_base to the app device (e.g. http://192.168.x.x:8080).';
      }
      this.showIpophlNotification(msg);
      this.setCompleteRegistrationLoading(false);
    }
  }

  sendRegistrationEmail(_registrationData) {
    if (typeof window.publishIpophlToGiUpdates === 'function') {
      return window.publishIpophlToGiUpdates();
    }
    this.showIpophlNotification(
      'Reload the dashboard (Ctrl+F5), then click Complete Registration to save to GI Updates.'
    );
  }

  createEmailContent(registrationData) {
    let content = `GEographical Indication Registration Application\n`;
    content += `=========================================\n\n`;
    content += `Date: ${new Date().toLocaleDateString()}\n`;
    content += `Applicant: ${this.getCurrentUserIdentifier() || 'Not specified'}\n\n`;
    
    // Add phase summaries
    for (let i = 1; i <= 4; i++) {
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
      1: 'Justification for the Request for Protection',
      2: 'Technical Part',
      3: 'Control & Traceability',
      4: 'Compile GI Package',
    };
    return titles[phaseNum] || `Phase ${phaseNum}`;
  }

  getCurrentUserIdentifier() {
    // Try to get user phone from session or dashboard
    return session?.user_phone || null;
  }

  collectAllPhaseData() {
    const phases = {};
    
    for (let i = 1; i <= 4; i++) {
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
      
      // If it's an IPOPHL phase, the ipophl-analyzer.js handles it.
      // We only attach listeners here for non-phase zones.
      if (service && service.startsWith('phase')) {
        return;
      }
      
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
    
    // If it's an IPOPHL phase, let the AI Analyzer handle the rendering and upload
    if (service.startsWith('phase') && window.ipophlAnalyzer) {
      window.ipophlAnalyzer.handleFileUpload(file, service, filesContainer);
      return;
    }

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
        ${service.startsWith('phase') ? `
        <button class="file-action-btn ai-analysis" title="AI Analysis">
          <i class="fa-solid fa-brain"></i>
        </button>` : ''}
        <button class="file-action-btn delete" title="Delete">
          <i class="fa-solid fa-trash-can"></i>
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
    if (service.startsWith('phase')) {
      fileItem.querySelector('.ai-analysis').addEventListener('click', () => {
        if (window.ipophlAnalyzer) {
          // Use filename stem as UUID for the analysis fetch
          const filename = file.name;
          const fileUuid = filename.split('.')[0];
          
          const fileData = {
            file_info: { filename: filename },
            preview_url: URL.createObjectURL(file),
            file_uuid: fileUuid
          };
          
          window.ipophlAnalyzer.showFullAIAnalysis(fileData);
          
          if (file instanceof File) {
            window.ipophlAnalyzer.handleFileUpload(file, service, filesContainer);
          }
        } else {
          this.showIpophlNotification('AI Analysis system is not ready.');
        }
      });
    }
    
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
        <i class="fa-solid fa-trash-can"></i>
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

    if (service?.startsWith('phase')) {
      this.resetIpophlUploadZone(service);
    } else {
      this.syncIpophlUploadZoneCompactState();
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
      1: ['phase1-introduction', 'phase1-history', 'phase1-physical-link'],
      2: ['phase2-general', 'phase2-specific', 'phase2-production'],
      3: ['phase3-control'],
      // Phase 4 is compile/download only (no upload zones)
      4: [],
    };
  }

  getOfficialIpophlTaskIds() {
    return Object.values(this.getIpophlServicesByPhase()).flat();
  }

  getIpophlCompletionSnapshot() {
    const allServices = this.getOfficialIpophlTaskIds();
    const completedServices = allServices.filter((service) => this.isIpophlServiceComplete(service));

    const total = allServices.length;
    const completed = completedServices.length;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

    return { total, completed, percentage, missing: allServices.filter((s) => !completedServices.includes(s)) };
  }

  /** True when every required phase document group has at least one MoP Ready file. */
  areAllRequiredIpophlDocsMopReady() {
    const snapshot = this.getIpophlCompletionSnapshot();
    return snapshot.total > 0 && snapshot.completed === snapshot.total;
  }

  syncCompleteRegistrationButtonState() {
    const completeBtn = document.querySelector('#ipophl-module .complete-btn');
    if (!completeBtn) return;
    if (!completeBtn.dataset.defaultLabel) {
      completeBtn.dataset.defaultLabel = completeBtn.textContent.trim() || 'Complete Registration';
    }
    const ready = this.areAllRequiredIpophlDocsMopReady();
    const missing = this.getIpophlCompletionSnapshot().missing || [];
    if (!ready) {
      completeBtn.disabled = true;
      completeBtn.classList.add('is-blocked-mop');
      completeBtn.title =
        missing.length
          ? `Blocked until Ready for: ${missing.map((s) => this.getIpophlGroupLabel(s)).join(', ')}`
          : 'Blocked until all required phase docs are Ready.';
      completeBtn.setAttribute(
        'aria-label',
        'Complete registration blocked until all required phase docs are Ready'
      );
    } else {
      completeBtn.disabled = false;
      completeBtn.classList.remove('is-blocked-mop', 'is-completed', 'is-loading');
      completeBtn.removeAttribute('aria-busy');
      completeBtn.title = 'Publish MoP-ready package to GI Updates';
      completeBtn.setAttribute(
        'aria-label',
        'Complete registration and publish to GI Updates'
      );
      completeBtn.textContent = completeBtn.dataset.defaultLabel;
    }
  }

  getGiAiStatusDescriptor() {
    const allServices = this.getOfficialIpophlTaskIds();
    let readyGroups = 0;
    let notReadyGroups = 0;
    let pendingGroups = 0;
    allServices.forEach((service) => {
      this.syncIpophlFileStatusesFromDom(service);
      const files = (this.ipophlFiles && this.ipophlFiles[service]) || [];
      const container = document.getElementById(`${service}-files`);
      const domStatuses = container
        ? [...container.querySelectorAll('.file-item')]
            .filter((c) => !c.classList.contains('error'))
            .map((c) => String(c.dataset.aiStatus || '').trim())
        : [];
      const statuses = [
        ...files.map((f) => String(f.ai_status || '').trim()),
        ...domStatuses,
      ].filter(Boolean);
      if (!statuses.length && !files.length && !(container?.querySelector('.file-item'))) {
        pendingGroups += 1;
        return;
      }
      if (statuses.some((s) => this.isIpophlFileReady({ ai_status: s }))) {
        readyGroups += 1;
        return;
      }
      if (statuses.some((s) => /not\s*ready|fail/i.test(s))) {
        notReadyGroups += 1;
        return;
      }
      pendingGroups += 1;
    });

    if (readyGroups === allServices.length) {
      return { label: 'AI pass', className: 'gi-status-pill--pass' };
    }
    if (notReadyGroups > 0) {
      return { label: 'Needs revision', className: 'gi-status-pill--fail' };
    }
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

    this.syncIpophlUploadZoneCompactState();

    if (!percentEl || !metaEl || !fillEl || !trackEl || !aiStatusEl) return;

    const snapshot = this.getIpophlCompletionSnapshot();
    percentEl.textContent = `${snapshot.percentage}%`;
    metaEl.textContent = `${snapshot.completed} of ${snapshot.total} document groups completed`;
    if (snapshot.completed < snapshot.total && snapshot.missing?.length) {
      metaEl.title = `Missing upload: ${snapshot.missing.join(', ')}`;
    } else {
      metaEl.removeAttribute('title');
    }
    fillEl.style.width = `${snapshot.percentage}%`;
    trackEl.setAttribute('aria-valuenow', String(snapshot.percentage));

    const aiStatus = this.getGiAiStatusDescriptor();
    aiStatusEl.textContent = aiStatus.label;
    aiStatusEl.classList.remove('gi-status-pill--pending', 'gi-status-pill--pass', 'gi-status-pill--fail');
    aiStatusEl.classList.add(aiStatus.className);

    this.syncCompleteRegistrationButtonState();
    this.updateProgress(this.currentPhase || 1);
  }

  captureIpophlUploadZoneLabels() {
    document.querySelectorAll('#ipophl-module .file-upload-zone[data-service]').forEach((zone) => {
      if (zone.dataset.uploadLabel) return;
      const label = zone.querySelector(':scope > p');
      const text = label?.textContent?.trim() || '';
      if (text && text !== 'Add more files') {
        zone.dataset.uploadLabel = text;
      }
    });
  }

  applyIpophlUploadZoneState(zone, hasFiles) {
    if (!zone) return;
    zone.classList.toggle('has-files', hasFiles);
    zone.setAttribute('aria-label', hasFiles ? 'Add more files' : 'Upload document');
    const icon = zone.querySelector(':scope > i');
    if (icon) {
      icon.className = hasFiles ? 'fa-solid fa-plus' : 'fa-solid fa-cloud-upload-alt';
    }
    const label = zone.querySelector(':scope > p');
    if (!label) return;
    label.hidden = false;
    const uploadLabel = zone.dataset.uploadLabel || label.dataset.defaultUploadText || '';
    if (hasFiles) {
      label.textContent = 'Add more files';
    } else if (uploadLabel) {
      label.textContent = uploadLabel;
    }
  }

  resetIpophlUploadZone(service) {
    if (!service) return;
    this.captureIpophlUploadZoneLabels();
    const zone = document.querySelector(`#ipophl-module .file-upload-zone[data-service="${service}"]`);
    const listEl = document.getElementById(`${service}-files`);
    if (!zone) return;
    const listedCount = listEl
      ? listEl.querySelectorAll('.file-item:not(.error)').length
      : 0;
    this.applyIpophlUploadZoneState(zone, listedCount > 0);
  }

  syncIpophlUploadZoneCompactState() {
    this.captureIpophlUploadZoneLabels();
    const zones = document.querySelectorAll('#ipophl-module .file-upload-zone[data-service]');
    zones.forEach((zone) => {
      const service = zone.dataset.service;
      if (!service) return;
      const listEl = document.getElementById(`${service}-files`);
      const listedCount = listEl
        ? listEl.querySelectorAll('.file-item:not(.error)').length
        : 0;
      this.applyIpophlUploadZoneState(zone, listedCount > 0);
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
    const notification = document.createElement('div');
    notification.className = 'ipophl-notification';
    notification.textContent = message;
    document.body.appendChild(notification);
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 5000);
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
        labels: sorted.map(([k]) => this.formatBarangayLabel(k)),
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

  renderIpophlComplianceChart() {
    const canvas = document.getElementById('ipophlComplianceChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (this.charts.ipophlComplianceChart) this.charts.ipophlComplianceChart.destroy();
    
    const snapshot = this.getIpophlCompletionSnapshot();
    const completed = snapshot.completed;
    const pending = snapshot.total - completed;

    this.charts.ipophlComplianceChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Completed Groups', 'Pending Groups'],
        datasets: [
          {
            data: [completed, pending],
            backgroundColor: [
              'rgba(62, 166, 66, 0.85)',
              'rgba(230, 233, 237, 1)'
            ],
            borderColor: [
              'rgba(62, 166, 66, 1)',
              'rgba(230, 233, 237, 1)'
            ],
            borderWidth: 1.5,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '72%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              usePointStyle: false,
              boxWidth: 40,
              boxHeight: 12,
              padding: 20
            }
          },
          tooltip: {
            callbacks: {
              label: (ctxItem) => `${ctxItem.label}: ${ctxItem.raw} groups`,
            },
          },
        },
      },
    });
  }

  renderIpophlPhaseCompletionChart(ipophl) {
    const canvas = document.getElementById('ipophlPhaseCompletionChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    this.destroyAnalyticsChart('ipophlPhaseCompletionChart');
    const stats = ipophl?.phaseStats || [];
    this.charts.ipophlPhaseCompletionChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: stats.map((s) => `Phase ${s.phase} (${s.mopReadyPct || 0}%)`),
        datasets: [
          {
            label: 'Ready groups',
            data: stats.map((s) => s.completed),
            backgroundColor: 'rgba(62, 166, 66, 0.82)',
            stack: 'groups',
          },
          {
            label: 'Not Ready / pending',
            data: stats.map((s) => s.pending),
            backgroundColor: 'rgba(230, 233, 237, 1)',
            stack: 'groups',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } },
        scales: {
          x: { stacked: true },
          y: { stacked: true, beginAtZero: true, ticks: { precision: 0, max: 3 } },
        },
      },
    });
  }

  renderIpophlGroupScoreChart(ipophl) {
    const canvas = document.getElementById('ipophlGroupScoreChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    this.destroyAnalyticsChart('ipophlGroupScoreChart');
    const groups = (ipophl?.groupScores || []).filter((g) => g.complete || g.score > 0);
    const labels = groups.map((g) => g.label);
    const values = groups.map((g) => g.score);
    this.charts.ipophlGroupScoreChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Ready %',
            data: values,
            backgroundColor: values.map((v) =>
              v >= 100 ? 'rgba(62, 166, 66, 0.82)' : 'rgba(239, 68, 68, 0.75)'
            ),
            borderWidth: 0,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, max: 100, ticks: { callback: (v) => `${v}%` } },
        },
      },
    });
  }

  renderIpophlUploadTimelineChart(ipophl) {
    const canvas = document.getElementById('ipophlUploadTimelineChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    this.destroyAnalyticsChart('ipophlUploadTimelineChart');
    const labels = ipophl?.timelineLabels?.length ? ipophl.timelineLabels : ['No uploads'];
    const values = ipophl?.timelineValues?.length ? ipophl.timelineValues : [0];
    this.charts.ipophlUploadTimelineChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Files uploaded',
            data: values,
            borderColor: 'rgba(59, 130, 246, 0.95)',
            backgroundColor: 'rgba(59, 130, 246, 0.12)',
            fill: true,
            tension: 0.3,
            pointRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  }

  renderIpophlPassFailPhaseChart(ipophl) {
    const canvas = document.getElementById('ipophlPassFailPhaseChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    this.destroyAnalyticsChart('ipophlPassFailPhaseChart');
    const stats = ipophl?.phaseStats || [];
    this.charts.ipophlPassFailPhaseChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: stats.map((s) => `Phase ${s.phase}`),
        datasets: [
          {
            label: 'AI pass (≥70%)',
            data: stats.map((s) => s.pass),
            backgroundColor: 'rgba(62, 166, 66, 0.82)',
          },
          {
            label: 'AI fail (<70%)',
            data: stats.map((s) => s.fail),
            backgroundColor: 'rgba(239, 68, 68, 0.72)',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  }

  renderIpophlDocScoreScatterChart(ipophl) {
    const canvas = document.getElementById('ipophlDocScoreScatterChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    this.destroyAnalyticsChart('ipophlDocScoreScatterChart');
    const groups = ipophl?.groupScores || [];
    this.charts.ipophlDocScoreScatterChart = new Chart(ctx, {
      type: 'scatter',
      data: {
        datasets: [
          {
            label: 'Document group score',
            data: groups.map((g, idx) => ({ x: idx + 1, y: g.score })),
            backgroundColor: groups.map((g) =>
              g.score >= 70 ? 'rgba(62, 166, 66, 0.85)' : 'rgba(239, 68, 68, 0.75)'
            ),
            pointRadius: 6,
            pointHoverRadius: 8,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctxItem) => {
                const g = groups[ctxItem.dataIndex];
                return g ? `${g.label}: ${g.score}%` : `${ctxItem.parsed.y}%`;
              },
            },
          },
        },
        scales: {
          x: {
            title: { display: true, text: 'Document group (1–13)' },
            min: 0,
            max: 14,
            ticks: { stepSize: 1 },
          },
          y: {
            beginAtZero: true,
            max: 100,
            title: { display: true, text: 'AI score %' },
          },
        },
      },
    });
  }

  renderFarmerReadinessDistChart(metrics) {
    const canvas = document.getElementById('farmerReadinessDistChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    this.destroyAnalyticsChart('farmerReadinessDistChart');
    const buckets = [...(metrics.readinessBuckets || [0, 0, 0, 0])];
    if (!metrics.mlEnabled && metrics.total) {
      buckets[0] = metrics.notEligible || 0;
      buckets[1] = 0;
      buckets[2] = 0;
      buckets[3] = metrics.eligible || 0;
    }
    this.charts.farmerReadinessDistChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['0–25%', '26–50%', '51–75%', '76–100%'],
        datasets: [
          {
            label: 'Farmers',
            data: buckets,
            backgroundColor: [
              'rgba(239, 68, 68, 0.72)',
              'rgba(245, 158, 11, 0.78)',
              'rgba(59, 130, 246, 0.72)',
              'rgba(62, 166, 66, 0.82)',
            ],
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

  renderFarmerMlBlockersChart(metrics) {
    const canvas = document.getElementById('farmerMlBlockersChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    this.destroyAnalyticsChart('farmerMlBlockersChart');
    const failCounts = metrics.failCounts || new Map();
    const labels = [...failCounts.keys()];
    const values = labels.map((k) => failCounts.get(k) || 0);
    this.charts.farmerMlBlockersChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Farmers affected',
            data: values,
            backgroundColor: 'rgba(139, 74, 43, 0.82)',
            borderColor: 'rgba(139, 74, 43, 1)',
            borderWidth: 1,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  }

  renderCityReadinessCompareChart(metrics, ipophlSnapshot) {
    const canvas = document.getElementById('cityReadinessCompareChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    this.destroyAnalyticsChart('cityReadinessCompareChart');
    const farmerRate = metrics.total ? (metrics.eligible / metrics.total) * 100 : 0;
    const ipophlRate = ipophlSnapshot?.percentage || 0;
    this.charts.cityReadinessCompareChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['IPOPHL documents', 'GI-ready farmers'],
        datasets: [
          {
            label: 'Readiness %',
            data: [ipophlRate, farmerRate],
            backgroundColor: ['rgba(59, 130, 246, 0.82)', 'rgba(62, 166, 66, 0.82)'],
            borderRadius: 8,
            barThickness: 48,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctxItem) => `${ctxItem.parsed.y.toFixed(1)}%`,
            },
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            max: 100,
            ticks: { callback: (v) => `${v}%` },
          },
        },
      },
    });
  }

  updateMapLayers() {
    if (!this.leafletMap || !window.L) return;
    (this.leafletMarkers || []).forEach((marker) => {
      if (this.mapLayers.farmerLocations) {
        if (!this.leafletMap.hasLayer(marker)) marker.addTo(this.leafletMap);
      } else if (this.leafletMap.hasLayer(marker)) {
        this.leafletMap.removeLayer(marker);
      }
    });
    if (this.leafletBoundary) {
      if (this.mapLayers.farmBoundaries) {
        if (!this.leafletMap.hasLayer(this.leafletBoundary)) this.leafletBoundary.addTo(this.leafletMap);
      } else if (this.leafletMap.hasLayer(this.leafletBoundary)) {
        this.leafletMap.removeLayer(this.leafletBoundary);
      }
    }
    (this.leafletHeatLayers || []).forEach((layer) => {
      if (!this.leafletMap) return;
      if (this.mapLayers.densityHeatmap) {
        if (!this.leafletMap.hasLayer(layer)) layer.addTo(this.leafletMap);
      } else if (this.leafletMap.hasLayer(layer)) {
        this.leafletMap.removeLayer(layer);
      }
    });
  }

  isLocalMapHost() {
    const host = String(window.location.hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1';
  }

  getStadiaTileLayerConfig() {
    const key = String(window.__STADIA_MAPS_API_KEY__ || '').trim();
    const style = this.mapLayers.roadNetwork ? 'outdoors' : 'alidade_smooth';
    const base = `https://tiles.stadiamaps.com/tiles/${style}/{z}/{x}/{y}{r}.png`;
    const url = key ? `${base}?api_key=${encodeURIComponent(key)}` : base;
    return {
      url,
      useStadia: !!key || this.isLocalMapHost(),
      options: {
        maxZoom: 20,
        attribution:
          '&copy; <a href="https://stadiamaps.com/" target="_blank" rel="noopener">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      },
    };
  }

  getOsmTileLayerConfig() {
    return {
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      },
    };
  }

  applyLeafletBaseTiles() {
    if (!this.leafletMap || !window.L) return;
    const stadia = this.getStadiaTileLayerConfig();
    const next = stadia.useStadia ? stadia : this.getOsmTileLayerConfig();
    if (this.leafletTileLayer) {
      this.leafletMap.removeLayer(this.leafletTileLayer);
    }
    this.leafletTileLayer = window.L.tileLayer(next.url, next.options).addTo(this.leafletMap);
  }

  initMapLayerToggles() {
    const list = document.getElementById('mapLayersList');
    if (!list || list.dataset.bound === '1') return;
    list.dataset.bound = '1';

    const toggleLayer = (layerKey) => {
      if (!layerKey || !(layerKey in this.mapLayers)) return;
      this.mapLayers[layerKey] = !this.mapLayers[layerKey];
      this.syncMapLayerToggleUi();
      if (layerKey === 'roadNetwork' && this.leafletMap) {
        this.applyLeafletBaseTiles();
      }
      this.updateMapLayers();
    };

    list.addEventListener('click', (e) => {
      const row = e.target.closest('.map-layer-row[data-map-layer]');
      if (!row) return;
      e.preventDefault();
      toggleLayer(row.dataset.mapLayer);
    });

    list.addEventListener('keydown', (e) => {
      const row = e.target.closest('.map-layer-row[data-map-layer]');
      if (!row || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      toggleLayer(row.dataset.mapLayer);
    });

    this.syncMapLayerToggleUi();
    const zoomIn = document.getElementById('mapsZoomInBtn');
    const zoomOut = document.getElementById('mapsZoomOutBtn');
    if (zoomIn && !zoomIn.dataset.bound) {
      zoomIn.dataset.bound = '1';
      zoomIn.addEventListener('click', () => this.leafletMap && this.leafletMap.zoomIn());
    }
    if (zoomOut && !zoomOut.dataset.bound) {
      zoomOut.dataset.bound = '1';
      zoomOut.addEventListener('click', () => this.leafletMap && this.leafletMap.zoomOut());
    }
  }

  syncMapLayerToggleUi() {
    const layers = [
      { id: 'toggleFarmerLocations', key: 'farmerLocations' },
      { id: 'toggleFarmBoundaries', key: 'farmBoundaries' },
      { id: 'toggleDensityHeatmap', key: 'densityHeatmap' },
      { id: 'toggleRoadNetwork', key: 'roadNetwork' },
    ];
    layers.forEach(({ id, key }) => {
      const toggle = document.getElementById(id);
      const row = document.querySelector(`.map-layer-row[data-map-layer="${key}"]`);
      const on = !!this.mapLayers[key];
      if (toggle) toggle.classList.toggle('is-on', on);
      if (row) row.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
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
      adya: { lat: 13.9536, lng: 121.1542 },
      'antipolo del norte': { lat: 13.9492, lng: 121.1642 },
      'antipolo del sur': { lat: 13.9365, lng: 121.1601 },
      'bagong pook': { lat: 13.9398, lng: 121.1562 },
      balintawak: { lat: 13.9472, lng: 121.1719 },
      bulacnin: { lat: 13.9241, lng: 121.1748 },
      dagatan: { lat: 13.9618, lng: 121.1398 },
      halang: { lat: 13.9528, lng: 121.2098 },
      kayumanggi: { lat: 13.9473, lng: 121.1498 },
      latag: { lat: 13.9414, lng: 121.1454 },
      lodlod: { lat: 13.9271, lng: 121.1328 },
      lumbang: { lat: 13.9289, lng: 121.1476 },
      malagonlong: { lat: 13.9198, lng: 121.1541 },
      malitlit: { lat: 13.9154, lng: 121.1761 },
      'mataas na lupa': { lat: 13.9652, lng: 121.1825 },
      'pag olingin west': { lat: 13.9108, lng: 121.1876 },
      pangao: { lat: 13.9214, lng: 121.1657 },
      pinagkawitan: { lat: 13.9332, lng: 121.1968 },
      'pinagtong ulan': { lat: 13.8995, lng: 121.1861 },
      pusil: { lat: 13.9047, lng: 121.1699 },
      quezon: { lat: 13.9186, lng: 121.1834 },
      rizal: { lat: 13.9397, lng: 121.1934 },
      'san benito': { lat: 13.9559, lng: 121.1536 },
      'san celestino': { lat: 13.9586, lng: 121.1468 },
      'san carlos': { lat: 13.9523, lng: 121.1838 },
      'san isidro': { lat: 13.9496, lng: 121.1364 },
      'san jose': { lat: 13.9276, lng: 121.1568 },
      'san lucas': { lat: 13.9223, lng: 121.1789 },
      'san salvador': { lat: 13.9678, lng: 121.1498 },
      'sto nino': { lat: 13.9044, lng: 121.1628 },
      'sto toribio': { lat: 13.8976, lng: 121.1702 },
      talisay: { lat: 13.8884, lng: 121.1504 },
      tangob: { lat: 13.8859, lng: 121.1788 },
      tangway: { lat: 13.8958, lng: 121.1446 },
      tipakan: { lat: 13.8919, lng: 121.1862 },
      tibig: { lat: 13.9328, lng: 121.1447 },
      tambo: { lat: 13.9024, lng: 121.1599 },
      marauoy: { lat: 13.9138, lng: 121.1388 },
      bolbok: { lat: 13.9675, lng: 121.2064 },
      sabang: { lat: 13.9769, lng: 121.1712 },
      plaridel: { lat: 13.9714, lng: 121.1967 },
      'poblacion barangay 1': { lat: 13.9418, lng: 121.1638 },
      'poblacion barangay 2': { lat: 13.9427, lng: 121.1657 },
      'poblacion barangay 3': { lat: 13.9404, lng: 121.1617 },
      'poblacion barangay 4': { lat: 13.9395, lng: 121.1678 },
    };
  }

  getLipaPdfBarangayWhitelist() {
    // Based on coffee-database.pdf (Municipality: Lipa City)
    return new Set([
      'adya',
      'antipolo del sur',
      'bagong pook',
      'bulacnin',
      'halang',
      'kayumanggi',
      'latag',
      'lodlod',
      'lumbang',
      'malagonlong',
      'malitlit',
      'pag olingin west',
      'pangao',
      'pinagkawitan',
      'pinagtong ulan',
      'pusil',
      'quezon',
      'rizal',
      'san benito',
      'san celestino',
      'san isidro',
      'san salvador',
      'sto nino',
      'sto toribio',
      'talisay',
      'tangway',
      'tipakan',
      'tangob',
    ]);
  }

  getLipaPdfBarangayAliases() {
    return {
      'pinagtongulan': 'pinagtong ulan',
      'pinagtong-ulan': 'pinagtong ulan',
      'pinagtong ulan': 'pinagtong ulan',
      'sto. nino': 'sto nino',
      'sto nino': 'sto nino',
      'santo nino': 'sto nino',
      'sto. toribio': 'sto toribio',
      'sto toribio': 'sto toribio',
      'santo toribio': 'sto toribio',
      'rizal p bata': 'rizal',
      'rizal/ p bata': 'rizal',
      'pag-olingin west': 'pag olingin west',
      'pag olingin west': 'pag olingin west',
      pagolingin: 'pag olingin west',
      'pag olingin': 'pag olingin west',
      'pagolingin east': 'pag olingin west',
      'san jose': 'san jose',
      'san jose ': 'san jose',
    };
  }

  normalizeBarangayName(name) {
    const normalized = (name || '')
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[.,]/g, ' ')
      .replace(/-/g, ' ')
      .replace(/\bsto\b/g, 'sto')
      .replace(/\s+/g, ' ')
      .trim();
    return normalized;
  }

  getCanonicalLipaBarangay(name) {
    const key = this.normalizeBarangayName(name);
    if (!key) return null;
    const aliases = this.getLipaPdfBarangayAliases();
    const coords = this.getBarangayCoordinates();
    const candidate = aliases[key] || key;
    if (coords[candidate]) return candidate;
    for (const barangayKey of Object.keys(coords)) {
      if (barangayKey === candidate) return barangayKey;
      if (barangayKey.includes(candidate) || candidate.includes(barangayKey)) return barangayKey;
    }
    return this.getLipaPdfBarangayWhitelist().has(candidate) ? candidate : null;
  }

  formatBarangayLabel(name) {
    const label = (name || '')
      .split(' ')
      .filter(Boolean)
      .map((part) => {
        if (part === 'sto') return 'Sto.';
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(' ');
    return label || 'Unknown';
  }

  formatCoordinatePill(lat, lng) {
    const latVal = Number(lat);
    const lngVal = Number(lng);
    if (!Number.isFinite(latVal) || !Number.isFinite(lngVal)) return 'Coordinates unavailable';
    const ns = latVal >= 0 ? 'N' : 'S';
    const ew = lngVal >= 0 ? 'E' : 'W';
    return `${Math.abs(latVal).toFixed(6)}° ${ns}, ${Math.abs(lngVal).toFixed(6)}° ${ew}`;
  }

  updateMapCoordPill(lat, lng) {
    const pill = document.getElementById('mapsCoordPill');
    if (!pill) return;
    pill.textContent = this.formatCoordinatePill(lat, lng);
  }

  getMapVarietyLabel(variety) {
    const key = (variety || this.mapVarietyFilter || 'all').toString().trim().toLowerCase();
    if (key === 'all') return 'All varieties';
    if (key === 'robusta') return 'Robusta';
    if (key === 'excelsa') return 'Excelsa';
    return 'Liberica';
  }

  openPlaceInExternalMaps(lat, lng, barangay) {
    const latN = Number(lat);
    const lngN = Number(lng);
    const name = String(barangay || '').trim().replace(/^barangay\s+/i, '');
    if (Number.isFinite(latN) && Number.isFinite(lngN)) {
      window.open(
        `https://www.openstreetmap.org/?mlat=${latN}&mlon=${lngN}#map=15/${latN}/${lngN}`,
        '_blank',
        'noopener,noreferrer'
      );
      return;
    }
    const query = name
      ? `Barangay ${name}, Lipa City, Batangas, Philippines`
      : `${latN},${lngN}`;
    if (!query.trim()) return;
    window.open(
      `https://www.openstreetmap.org/search?query=${encodeURIComponent(query)}`,
      '_blank',
      'noopener,noreferrer'
    );
  }

  buildMapInfoWindowHtml(point) {
    const variety = (point.filteredVariety || this.mapVarietyFilter || 'all').toString().trim().toLowerCase();
    const varietyLabel = this.getMapVarietyLabel(variety);
    const title = this.escapeHtml(point.barangay || 'Unknown');
    const farmers = Number(point.count || 0);
    const coords = this.escapeHtml(this.formatCoordinatePill(point.lat, point.lng));
    const areaHa = Number(point.areaHa);
    const productionKg = Number(
      point.displayProductionKg != null ? point.displayProductionKg : this.getMapPointProductionKg(point, variety)
    );
    const totalFarmers = Number(point.totalFarmers || farmers);

    const stats = [
      {
        icon: 'fa-users',
        value: farmers.toLocaleString(),
        label: farmers === 1 ? 'Registered farmer' : 'Registered farmers',
      },
    ];
    if (Number.isFinite(areaHa) && areaHa > 0) {
      stats.push({
        icon: 'fa-chart-area',
        value: areaHa.toLocaleString(undefined, { maximumFractionDigits: 2 }),
        label: 'Area (ha)',
      });
    }
    if (Number.isFinite(productionKg) && productionKg > 0) {
      stats.push({
        icon: 'fa-seedling',
        value: `${productionKg.toLocaleString()} kg`,
        label: variety === 'all' ? 'Total production' : `${this.getMapVarietyLabel(variety)} production`,
      });
    } else if (Number.isFinite(totalFarmers) && totalFarmers > farmers) {
      stats.push({
        icon: 'fa-user-group',
        value: totalFarmers.toLocaleString(),
        label: 'Total farmers',
      });
    }

    const statsHtml = stats
      .map(
        (stat) => `<div class="map-info-popup__stat">
          <span class="map-info-popup__stat-icon" aria-hidden="true"><i class="fa-solid ${stat.icon}"></i></span>
          <span class="map-info-popup__stat-value">${this.escapeHtml(stat.value)}</span>
          <span class="map-info-popup__stat-label">${this.escapeHtml(stat.label)}</span>
        </div>`
      )
      .join('');

    return `<div class="map-info-popup map-info-popup--${this.escapeHtml(variety)}" role="dialog" aria-label="${title} barangay details">
      <div class="map-info-popup__accent" aria-hidden="true"></div>
      <div class="map-info-popup__header">
        <span class="map-info-popup__pin" aria-hidden="true"><i class="fa-solid fa-location-dot"></i></span>
        <div class="map-info-popup__heading">
          <p class="map-info-popup__eyebrow">Barangay · Lipa City, Batangas</p>
          <h3 class="map-info-popup__title">${title}</h3>
        </div>
      </div>
      <div class="map-info-popup__stats">${statsHtml}</div>
      <div class="map-info-popup__footer">
        <span class="map-info-popup__variety"><i class="fa-solid fa-mug-hot" aria-hidden="true"></i> ${this.escapeHtml(varietyLabel)}</span>
        <span class="map-info-popup__coords" title="Coordinates"><i class="fa-solid fa-crosshairs" aria-hidden="true"></i> ${coords}</span>
      </div>
    </div>`;
  }

  isLipaPdfBarangay(name) {
    return !!this.getCanonicalLipaBarangay(name);
  }

  getLipaPdfBarangaySummary() {
    // Aggregated from coffee-database.pdf (Lipa City, Batangas; June 2023).
    return {
      'adya': { farmers: 2, areaHa: 2.24, productionKg: { liberica: 1245, excelsa: 15, robusta: 122 }, varietyFarmers: { liberica: 2, excelsa: 1, robusta: 1 } },
      'antipolo del sur': { farmers: 2, areaHa: 1.04, productionKg: { liberica: 834, excelsa: 49, robusta: 189 }, varietyFarmers: { liberica: 2, excelsa: 1, robusta: 2 } },
      'bagong pook': { farmers: 6, areaHa: 2.36, productionKg: { liberica: 207, excelsa: 663, robusta: 1053 }, varietyFarmers: { liberica: 4, excelsa: 6, robusta: 6 } },
      'bulacnin': { farmers: 1, areaHa: 0.4, productionKg: { liberica: 24, excelsa: 0, robusta: 400 }, varietyFarmers: { liberica: 1, excelsa: 0, robusta: 1 } },
      'halang': { farmers: 1, areaHa: 0.14, productionKg: { liberica: 29, excelsa: 40, robusta: 66 }, varietyFarmers: { liberica: 1, excelsa: 1, robusta: 1 } },
      'kayumanggi': { farmers: 2, areaHa: 1.35, productionKg: { liberica: 180, excelsa: 460, robusta: 320 }, varietyFarmers: { liberica: 2, excelsa: 2, robusta: 2 } },
      'latag': { farmers: 1, areaHa: 2.33, productionKg: { liberica: 300, excelsa: 0, robusta: 200 }, varietyFarmers: { liberica: 1, excelsa: 0, robusta: 1 } },
      'lodlod': { farmers: 15, areaHa: 8.66, productionKg: { liberica: 2254, excelsa: 2025, robusta: 1083 }, varietyFarmers: { liberica: 12, excelsa: 12, robusta: 9 } },
      'lumbang': { farmers: 6, areaHa: 3.38, productionKg: { liberica: 13, excelsa: 233, robusta: 1674 }, varietyFarmers: { liberica: 2, excelsa: 5, robusta: 4 } },
      'malagonlong': { farmers: 1, areaHa: 0.41, productionKg: { liberica: 150, excelsa: 112, robusta: 99 }, varietyFarmers: { liberica: 1, excelsa: 1, robusta: 1 } },
      'malitlit': { farmers: 12, areaHa: 4.47, productionKg: { liberica: 693, excelsa: 1022, robusta: 1084 }, varietyFarmers: { liberica: 9, excelsa: 8, robusta: 11 } },
      'pag olingin west': { farmers: 9, areaHa: 3.14, productionKg: { liberica: 395, excelsa: 378, robusta: 258 }, varietyFarmers: { liberica: 7, excelsa: 5, robusta: 7 } },
      'pangao': { farmers: 5, areaHa: 0.88, productionKg: { liberica: 79, excelsa: 298, robusta: 290 }, varietyFarmers: { liberica: 3, excelsa: 4, robusta: 4 } },
      'pinagkawitan': { farmers: 3, areaHa: 1.08, productionKg: { liberica: 0, excelsa: 0, robusta: 708 }, varietyFarmers: { liberica: 0, excelsa: 0, robusta: 3 } },
      'pinagtong ulan': { farmers: 25, areaHa: 14.36, productionKg: { liberica: 1114, excelsa: 3131, robusta: 3098 }, varietyFarmers: { liberica: 8, excelsa: 10, robusta: 21 } },
      'pusil': { farmers: 1, areaHa: 0.33, productionKg: { liberica: 115, excelsa: 0, robusta: 0 }, varietyFarmers: { liberica: 1, excelsa: 0, robusta: 0 } },
      'quezon': { farmers: 14, areaHa: 4.39, productionKg: { liberica: 632, excelsa: 1013, robusta: 1690 }, varietyFarmers: { liberica: 9, excelsa: 10, robusta: 14 } },
      'rizal': { farmers: 13, areaHa: 3.63, productionKg: { liberica: 510, excelsa: 577, robusta: 1568 }, varietyFarmers: { liberica: 9, excelsa: 10, robusta: 13 } },
      'san benito': { farmers: 34, areaHa: 11.8, productionKg: { liberica: 2004, excelsa: 3361, robusta: 2896 }, varietyFarmers: { liberica: 24, excelsa: 30, robusta: 32 } },
      'san celestino': { farmers: 4, areaHa: 3.33, productionKg: { liberica: 393, excelsa: 600, robusta: 490 }, varietyFarmers: { liberica: 4, excelsa: 4, robusta: 4 } },
      'san isidro': { farmers: 25, areaHa: 19.1, productionKg: { liberica: 2355, excelsa: 8832, robusta: 3620 }, varietyFarmers: { liberica: 13, excelsa: 25, robusta: 22 } },
      'san salvador': { farmers: 25, areaHa: 28.29, productionKg: { liberica: 5620, excelsa: 5489, robusta: 5799 }, varietyFarmers: { liberica: 21, excelsa: 23, robusta: 20 } },
      'sto nino': { farmers: 34, areaHa: 22.86, productionKg: { liberica: 1647, excelsa: 9049, robusta: 2990 }, varietyFarmers: { liberica: 18, excelsa: 34, robusta: 28 } },
      'sto toribio': { farmers: 6, areaHa: 2.13, productionKg: { liberica: 265, excelsa: 875, robusta: 486 }, varietyFarmers: { liberica: 4, excelsa: 3, robusta: 5 } },
      'talisay': { farmers: 13, areaHa: 4.08, productionKg: { liberica: 437, excelsa: 789, robusta: 624 }, varietyFarmers: { liberica: 9, excelsa: 12, robusta: 8 } },
      'tangway': { farmers: 5, areaHa: 4.56, productionKg: { liberica: 775, excelsa: 740, robusta: 1579 }, varietyFarmers: { liberica: 4, excelsa: 3, robusta: 4 } },
      'tipakan': { farmers: 2, areaHa: 0.61, productionKg: { liberica: 10, excelsa: 150, robusta: 145 }, varietyFarmers: { liberica: 1, excelsa: 2, robusta: 2 } },
      'tangob': { farmers: 4, areaHa: 0.78, productionKg: { liberica: 65, excelsa: 0, robusta: 525 }, varietyFarmers: { liberica: 2, excelsa: 0, robusta: 4 } },
    };
  }

  getPdfVarietyKey() {
    const key = (this.mapVarietyFilter || 'all').toString().trim().toLowerCase();
    if (key === 'robusta') return 'robusta';
    if (key === 'excelsa') return 'excelsa';
    if (key === 'all') return 'all';
    return 'liberica';
  }

  getMapVarietyFilterKey() {
    return (this.mapVarietyFilter || 'all').toString().trim().toLowerCase();
  }

  getMapPointProductionKg(point, varietyKey) {
    if (!point) return 0;
    const key = (varietyKey || this.getMapVarietyFilterKey()).toLowerCase();
    if (key === 'all') {
      if (Number.isFinite(Number(point.totalProductionKg))) return Number(point.totalProductionKg);
      if (typeof point.productionKg === 'number') return Number(point.productionKg);
      const bucket = point.productionKg || {};
      return Number(bucket.liberica || 0) + Number(bucket.robusta || 0) + Number(bucket.excelsa || 0);
    }
    if (typeof point.productionKg === 'number') return Number(point.productionKg);
    return Number(point.productionKg?.[key] || 0);
  }

  applyMapVarietyFilter(points) {
    const varietyKey = this.getMapVarietyFilterKey();
    const list = Array.isArray(points) ? points : [];
    if (varietyKey === 'all') {
      return list
        .filter((point) => Number(point.count || 0) > 0)
        .map((point) => ({
          ...point,
          displayProductionKg: this.getMapPointProductionKg(point, 'all'),
          filteredVariety: 'all',
        }));
    }
    return list
      .filter((point) => this.getMapPointProductionKg(point, varietyKey) > 0)
      .map((point) => ({
        ...point,
        displayProductionKg: this.getMapPointProductionKg(point, varietyKey),
        filteredVariety: varietyKey,
      }));
  }

  buildMapBarangayPointsFromPdf() {
    const coordsByBarangay = this.getBarangayCoordinates();
    const bounds = this.getLipaCityBounds();
    const center = this.getLipaCityCenter();
    const summary = this.getLipaPdfBarangaySummary();
    const varietyKey = this.getPdfVarietyKey();
    const visibleBarangays = [...this.getLipaPdfBarangayWhitelist()].filter(
      (name) => !this.mapSearchTerm || name.includes(this.mapSearchTerm)
    );
    const toFallbackCoordinate = (name) => {
      let hash = 0;
      for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
      const lat = bounds.south + ((hash % 1000) / 1000) * (bounds.north - bounds.south);
      const lng = bounds.west + ((((hash >> 10) % 1000) / 1000) * (bounds.east - bounds.west));
      return { lat: Number.isFinite(lat) ? lat : center.lat, lng: Number.isFinite(lng) ? lng : center.lng };
    };

    return visibleBarangays
      .map((canonical) => {
        const coords = coordsByBarangay[canonical] || toFallbackCoordinate(canonical);
        const s = summary[canonical] || {
          farmers: 0,
          areaHa: 0,
          productionKg: { liberica: 0, excelsa: 0, robusta: 0 },
          varietyFarmers: { liberica: 0, excelsa: 0, robusta: 0 },
        };
        const productionKg = {
          liberica: Number(s.productionKg?.liberica || 0),
          excelsa: Number(s.productionKg?.excelsa || 0),
          robusta: Number(s.productionKg?.robusta || 0),
        };
        const totalProductionKg =
          productionKg.liberica + productionKg.excelsa + productionKg.robusta;
        const count =
          varietyKey === 'all'
            ? Number(s.farmers || 0)
            : Number(s.varietyFarmers?.[varietyKey] || 0);
        return {
          barangay: this.formatBarangayLabel(canonical),
          canonical,
          lat: coords.lat,
          lng: coords.lng,
          count,
          totalFarmers: Number(s.farmers || 0),
          areaHa: Number(s.areaHa || 0),
          productionKg,
          totalProductionKg,
        };
      })
      .filter((point) => {
        if (varietyKey === 'all') return point.count > 0 || point.totalProductionKg > 0;
        return this.getMapPointProductionKg(point, varietyKey) > 0;
      });
  }

  ensureLeafletMap() {
    if (this.leafletMap || !window.L) return;
    const canvas = document.getElementById('mapsLeafletCanvas');
    if (!canvas) return;
    const center = this.getLipaCityCenter();
    this.leafletMap = window.L.map(canvas, {
      center: [center.lat, center.lng],
      zoom: 12,
      minZoom: 10,
      maxZoom: 17,
    });
    this.applyLeafletBaseTiles();
    const bounds = this.getLipaCityBounds();
    this.leafletBoundary = window.L.rectangle(
      [
        [bounds.south, bounds.west],
        [bounds.north, bounds.east],
      ],
      {
        color: '#047857',
        weight: 2,
        fillOpacity: 0,
        interactive: false,
      }
    );
    if (this.mapLayers.farmBoundaries) {
      this.leafletBoundary.addTo(this.leafletMap);
    }
  }

  isVarietyMatch(row, variety) {
    const key = (variety || 'all').toString().trim().toLowerCase();
    if (key === 'all') return true;
    if (key === 'liberica') {
      return (
        this.getVarietyProduction(row, 'liberica') > 0 ||
        Number(this.getValue(row, ['LIBERICA BEARING', 'Liberica_Bearing']) || 0) > 0 ||
        Number(this.getValue(row, ['LIBERICA NON-BEARING', 'Liberica_Non-bearing']) || 0) > 0
      );
    }
    if (key === 'robusta') {
      return (
        this.getVarietyProduction(row, 'robusta') > 0 ||
        Number(this.getValue(row, ['ROBUSTA BEARING', 'Robusta_Bearing']) || 0) > 0 ||
        Number(this.getValue(row, ['ROBUSTA NON-BEARING', 'Robusta_Non-bearing']) || 0) > 0
      );
    }
    if (key === 'excelsa') {
      return (
        this.getVarietyProduction(row, 'excelsa') > 0 ||
        Number(this.getValue(row, ['EXCELSA BEARING', 'Excelsa_Bearing']) || 0) > 0 ||
        Number(this.getValue(row, ['EXCELSA NON-BEARING', 'Excelsa_Non-bearing']) || 0) > 0
      );
    }
    return true;
  }

  getFilteredMapRows() {
    return (this.data || []).filter((row) => {
      const isBlocked = row.is_blocked === true || row.is_blocked === 'true';
      if (isBlocked) return false;
      const rawBarangay = this.getValue(row, ['ADDRESS (BARANGAY)', 'BARANGAY', 'barangay', 'address']);
      const canonical = this.getCanonicalLipaBarangay(rawBarangay);
      if (!canonical) return false;
      const searchableBarangay = canonical;
      return (
        !this.mapSearchTerm ||
        searchableBarangay.includes(this.mapSearchTerm) ||
        this.normalizeBarangayName(rawBarangay).includes(this.mapSearchTerm)
      );
    });
  }

  buildMapFarmerPoints(rows) {
    const coordsByBarangay = this.getBarangayCoordinates();
    const bounds = this.getLipaCityBounds();
    const center = this.getLipaCityCenter();
    const points = [];

    const toFallbackCoordinate = (name, seed) => {
      let hash = Number(seed) || 0;
      for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
      const lat = bounds.south + ((hash % 1000) / 1000) * (bounds.north - bounds.south);
      const lng = bounds.west + ((((hash >> 10) % 1000) / 1000) * (bounds.east - bounds.west));
      return { lat: Number.isFinite(lat) ? lat : center.lat, lng: Number.isFinite(lng) ? lng : center.lng };
    };

    rows.forEach((row) => {
      const raw = this.getValue(row, ['ADDRESS (BARANGAY)', 'BARANGAY', 'barangay', 'address']) || '';
      const canonical = this.getCanonicalLipaBarangay(raw);
      if (!canonical) return;
      const fid = Number(row.farmer_id ?? row['NO.'] ?? 0);
      const base = coordsByBarangay[canonical] || toFallbackCoordinate(canonical, fid);
      const jitterLat = (((fid * 17) % 11) - 5) * 0.00028;
      const jitterLng = (((fid * 23) % 11) - 5) * 0.00028;
      points.push({
        barangay: this.formatBarangayLabel(canonical),
        canonical,
        lat: base.lat + jitterLat,
        lng: base.lng + jitterLng,
        count: 1,
        farmerId: fid,
        farmerName: this.farmerDisplayNameFromRow(row),
        isFarmerPin: true,
        areaHa: Number(
          this.getValue(row, ['TOTAL AREA PLANTED (HA.)', 'Total Area Planted (HA.)', 'farm_size_ha']) || 0
        ),
        productionKg: this.getTotalProduction(row),
      });
    });
    return points;
  }

  buildMapBarangayPoints(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      // Do not fall back to static PDF survey pins — empty registrations = empty map.
      return [];
    }

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
      const canonical = this.getCanonicalLipaBarangay(raw);
      if (!canonical) return;
      const gpsLat = Number(this.getValue(row, ['lat', 'latitude', 'gps_lat', 'farm_lat', 'LAT']));
      const gpsLng = Number(this.getValue(row, ['lng', 'lon', 'longitude', 'gps_lng', 'farm_lng', 'LNG']));
      const hasGps = Number.isFinite(gpsLat) && Number.isFinite(gpsLng) && Math.abs(gpsLat) > 1 && Math.abs(gpsLng) > 1;
      const coords = hasGps
        ? { lat: gpsLat, lng: gpsLng }
        : (coordsByBarangay[canonical] || toFallbackCoordinate(canonical));
      const pointKey = hasGps ? `gps:${this.farmerIdFromRow(row) || `${gpsLat},${gpsLng}`}` : canonical;
      const current = pointsMap.get(pointKey) || {
        barangay: this.formatBarangayLabel(canonical),
        canonical,
        lat: coords.lat,
        lng: coords.lng,
        count: 0,
        totalFarmers: 0,
        areaHa: 0,
        productionKg: { liberica: 0, excelsa: 0, robusta: 0 },
        varietyFarmers: { liberica: 0, excelsa: 0, robusta: 0 },
        isGps: hasGps,
      };
      current.count += 1;
      current.totalFarmers = current.count;
      current.areaHa += Number(
        this.getValue(row, ['TOTAL AREA PLANTED (HA.)', 'Total Area Planted (HA.)', 'farm_size_ha']) || 0
      );
      const libKg = this.getVarietyProduction(row, 'liberica');
      const robKg = this.getVarietyProduction(row, 'robusta');
      const excKg = this.getVarietyProduction(row, 'excelsa');
      current.productionKg.liberica += libKg;
      current.productionKg.robusta += robKg;
      current.productionKg.excelsa += excKg;
      if (libKg > 0 || this.isVarietyMatch(row, 'liberica')) current.varietyFarmers.liberica += 1;
      if (robKg > 0 || this.isVarietyMatch(row, 'robusta')) current.varietyFarmers.robusta += 1;
      if (excKg > 0 || this.isVarietyMatch(row, 'excelsa')) current.varietyFarmers.excelsa += 1;
      pointsMap.set(pointKey, current);
    });

    return Array.from(pointsMap.values()).map((point) => ({
      ...point,
      totalProductionKg:
        Number(point.productionKg.liberica || 0) +
        Number(point.productionKg.robusta || 0) +
        Number(point.productionKg.excelsa || 0),
    }));
  }

  updateMapInsights(points, rows) {
    const varietyKey = this.getMapVarietyFilterKey();
    const covered = points.length;
    const usePdf = !Array.isArray(rows) || rows.length === 0;
    const totalArea = usePdf
      ? points.reduce((sum, point) => sum + (Number(point.areaHa) || 0), 0)
      : rows.reduce(
          (sum, row) => sum + (Number(this.getValue(row, ['Total Area Planted (HA.)', 'TOTAL AREA PLANTED (HA.)']) || 0) || 0),
          0
        );
    const farmerBase = usePdf
      ? points.reduce((sum, point) => sum + (Number(point.totalFarmers) || Number(point.count) || 0), 0)
      : rows.length;
    const avgArea = farmerBase ? totalArea / farmerBase : 0;

    const statEls = document.querySelectorAll('#maps-module .maps-panel--overview .overview-stat strong');
    if (statEls[0]) statEls[0].textContent = String(covered);
    if (statEls[1]) statEls[1].textContent = `${totalArea.toLocaleString(undefined, { maximumFractionDigits: 1 })}ha`;
    if (statEls[2]) statEls[2].textContent = `${avgArea.toLocaleString(undefined, { maximumFractionDigits: 1 })}ha`;

    const topList = document.querySelector('#maps-module .top-barangays-list');
    const topHeading = document.querySelector('#maps-module .maps-panel h2');
    if (topHeading) {
      topHeading.textContent =
        varietyKey === 'all'
          ? 'Barangay Indications'
          : `Top ${this.getMapVarietyLabel(varietyKey)} Producers`;
    }
    if (topList) {
      const metricValue = (point) =>
        varietyKey === 'all'
          ? Number(point.displayProductionKg ?? point.totalProductionKg ?? 0) || Number(point.count || 0)
          : Number(point.displayProductionKg ?? this.getMapPointProductionKg(point, varietyKey) ?? 0);

      const sorted = points
        .map((point) => ({
          canonical: point.canonical || this.normalizeBarangayName(point.barangay),
          label: point.barangay || this.formatBarangayLabel(point.canonical),
          count: Number(point.count || 0),
          productionKg: metricValue(point),
          lat: Number(point.lat),
          lng: Number(point.lng),
        }))
        .sort(
          (a, b) =>
            b.productionKg - a.productionKg ||
            b.count - a.count ||
            a.label.localeCompare(b.label)
        );

      topList.innerHTML = sorted
        .map((p) => {
          const tier = this.densityTier(
            varietyKey === 'all' ? p.count : Math.max(1, Math.round(p.productionKg / 100))
          );
          const coords = this.formatCoordinatePill(p.lat, p.lng);
          const valueLabel =
            varietyKey === 'all'
              ? `${p.count} farmer${p.count === 1 ? '' : 's'}`
              : `${p.productionKg.toLocaleString(undefined, { maximumFractionDigits: 0 })} kg`;
          return `<li><span><em class="dot dot--${tier}"></em>${p.label}<small style="display:block; font-size:11px; color:#6b7280;">${coords}</small></span><strong>${valueLabel}</strong></li>`;
        })
        .join('');
      if (!sorted.length) {
        topList.innerHTML = `<li><span>No barangays with ${varietyKey === 'all' ? 'registered farmers' : `${this.getMapVarietyLabel(varietyKey)} production`}</span><strong>0</strong></li>`;
      }
    }

    const treesTotalEl = document.querySelector('#maps-module .trees-total-card strong');
    const treesTotalLabelEl = document.querySelector('#maps-module .trees-total-card span');
    const treesMini = document.querySelectorAll('#maps-module .trees-mini-grid strong');
    const treesMiniLabels = document.querySelectorAll('#maps-module .trees-mini-grid span');
    if (usePdf) {
      const activeVarietyProduction = points.reduce(
        (sum, point) => sum + (Number(point.displayProductionKg ?? this.getMapPointProductionKg(point, varietyKey)) || 0),
        0
      );
      const activeVarietyFarmers = points.reduce((sum, point) => sum + (Number(point.count) || 0), 0);
      if (treesTotalEl) treesTotalEl.textContent = `${activeVarietyProduction.toLocaleString()} kg`;
      if (treesTotalLabelEl) {
        treesTotalLabelEl.textContent =
          varietyKey === 'all' ? 'Total Production' : `${this.getMapVarietyLabel(varietyKey)} Production`;
      }
      if (treesMini[0]) {
        treesMini[0].textContent = activeVarietyFarmers
          ? (activeVarietyProduction / activeVarietyFarmers).toFixed(1)
          : '0';
      }
      if (treesMini[1]) treesMini[1].textContent = activeVarietyFarmers.toLocaleString();
      if (treesMiniLabels[0]) treesMiniLabels[0].textContent = 'kg/farmer';
      if (treesMiniLabels[1]) {
        treesMiniLabels[1].textContent = varietyKey === 'all' ? 'Barangays' : 'Producing barangays';
      }
    } else {
      if (treesTotalLabelEl) treesTotalLabelEl.textContent = 'Total Trees';
      if (treesMiniLabels[0]) treesMiniLabels[0].textContent = 'Trees/ha';
      if (treesMiniLabels[1]) treesMiniLabels[1].textContent = 'Avg/Farm';
    }
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

  clearLeafletMarkers() {
    if (!this.leafletMap) return;
    (this.leafletMarkers || []).forEach((marker) => {
      try {
        this.leafletMap.removeLayer(marker);
      } catch (_) {
        /* ignore */
      }
    });
    this.leafletMarkers = [];
    (this.leafletHeatLayers || []).forEach((layer) => {
      try {
        this.leafletMap.removeLayer(layer);
      } catch (_) {
        /* ignore */
      }
    });
    this.leafletHeatLayers = [];
  }

  getLeafletPinIcon() {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="32" height="46" viewBox="0 0 44 64">
        <path d="M22 2C11.5 2 3 10.5 3 21c0 14 19 41 19 41s19-27 19-41C41 10.5 32.5 2 22 2z" fill="#047857" stroke="#065f46" stroke-width="2"/>
        <circle cx="22" cy="21" r="9.5" fill="#ffffff"/>
      </svg>
    `.trim();
    return window.L.divIcon({
      className: 'farmer-leaflet-pin',
      html: svg,
      iconSize: [32, 46],
      iconAnchor: [16, 45],
      popupAnchor: [0, -40],
    });
  }

  renderLeafletMarkers(points) {
    if (!this.leafletMap || !window.L) return;
    this.clearLeafletMarkers();
    const pinIcon = this.getLeafletPinIcon();
    const latLngs = [];

    points.forEach((point) => {
      const marker = window.L.marker([point.lat, point.lng], {
        icon: pinIcon,
        title: `${point.barangay} (${point.count} farmer${Number(point.count) === 1 ? '' : 's'})`,
      });
      marker.bindPopup(this.buildMapInfoWindowHtml(point), { maxWidth: 320 });
      marker.on('click', () => {
        this.updateMapCoordPill(point.lat, point.lng);
        this.openPlaceInExternalMaps(point.lat, point.lng, point.barangay);
      });
      if (this.mapLayers.farmerLocations) {
        marker.addTo(this.leafletMap);
      }
      this.leafletMarkers.push(marker);
      latLngs.push([point.lat, point.lng]);
      const heat = window.L.circleMarker([point.lat, point.lng], {
        radius: Math.min(28, 8 + Number(point.count || 1) * 4),
        color: '#166534',
        weight: 1,
        fillColor: '#22c55e',
        fillOpacity: Math.min(0.55, 0.18 + Number(point.count || 1) * 0.08),
      });
      heat.bindPopup(this.buildMapInfoWindowHtml(point), { maxWidth: 320 });
      if (this.mapLayers.densityHeatmap) heat.addTo(this.leafletMap);
      this.leafletHeatLayers.push(heat);
    });

    if (latLngs.length > 1) {
      this.leafletMap.fitBounds(latLngs, { padding: [50, 50], maxZoom: 14 });
    } else if (latLngs.length === 1) {
      this.leafletMap.setView(latLngs[0], 14);
    } else {
      const center = this.getLipaCityCenter();
      this.leafletMap.setView([center.lat, center.lng], 12);
    }
    setTimeout(() => {
      try {
        this.leafletMap.invalidateSize();
      } catch (_) {
        /* ignore */
      }
    }, 120);
  }

  renderMapsModule() {
    const fallback = document.getElementById('mapsLeafletFallback');
    const canvas = document.getElementById('mapsLeafletCanvas');
    const rows = this.getFilteredMapRows();
    const aggregated = this.buildMapBarangayPoints(rows);
    const points = this.applyMapVarietyFilter(aggregated);

    this.updateMapInsights(points, rows);
    this.updateMapCoordPill(this.getLipaCityCenter().lat, this.getLipaCityCenter().lng);
    if (!canvas) return;

    canvas.classList.remove('is-hidden');

    if (!window.L) {
      if (fallback) {
        fallback.hidden = false;
        fallback.textContent = 'Map library failed to load. Check your network connection and refresh.';
      }
      return;
    }

    this.ensureLeafletMap();
    if (this.leafletMap) {
      try {
        this.leafletMap.invalidateSize();
      } catch (_) {
        /* ignore */
      }
    }
    this.renderLeafletMarkers(points);
    this.syncMapLayerToggleUi();
    this.updateMapLayers();

    if (fallback) {
      if (!points.length) {
        fallback.hidden = false;
        fallback.textContent =
          'No farmer pins yet. Complete farmer registrations with a Lipa City barangay, then refresh.';
      } else {
        fallback.hidden = true;
      }
    }
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
    return [];
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
    const { placement = 'center', duration = 3200 } = options;
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    if (placement === 'right') {
      notification.classList.add('notification--right');
    }
    notification.setAttribute('role', type === 'error' ? 'alert' : 'status');
    notification.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    notification.textContent = message;

    document.body.appendChild(notification);

    const dismiss = () => {
      if (!notification.isConnected) return;
      notification.classList.add('is-dismissed');
      const remove = () => notification.remove();
      notification.addEventListener('animationend', remove, { once: true });
      setTimeout(remove, 400);
    };

    notification.addEventListener('click', dismiss);
    setTimeout(dismiss, duration);
  }

  // New dashboard functionality
  initFarmerActionModal() {
    const root = document.getElementById('farmerActionModal');
    const cancelBtn = document.getElementById('farmerActionCancel');
    const okBtn = document.getElementById('farmerActionConfirm');
    if (!root || !cancelBtn || !okBtn) return;

    const backdrop = root.querySelector('.confirm-dialog__backdrop');
    cancelBtn.addEventListener('click', () => this.closeFarmerActionModal());
    if (backdrop) backdrop.addEventListener('click', () => this.closeFarmerActionModal());

    okBtn.addEventListener('click', async () => {
      const reason = (document.getElementById('farmerActionReason')?.value || '').trim();
      if (!reason) {
        this.showNotification('Please enter a reason for this action.', 'error');
        return;
      }

      const action = root.dataset.action;
      const idx = Number.parseInt(root.dataset.farmerIdx, 10);
      if (Number.isNaN(idx)) return;

      const loadingLabel =
        action === 'warning'
          ? 'Sending warning…'
          : action === 'suspend'
            ? 'Suspending…'
            : action === 'unsuspend'
              ? 'Unsuspending…'
              : 'Processing…';

      if (!okBtn.dataset.originalHtml) okBtn.dataset.originalHtml = okBtn.innerHTML;
      okBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ${loadingLabel}`;
      this.setBtnLoading(okBtn, true, { spinIcon: false });

      try {
        if (action === 'warning') {
          await this.handleWarningFarmer(idx, reason);
          this.closeFarmerActionModal();
          return;
        }
        if (action === 'suspend') {
          await this.handleBlockFarmer(idx, reason);
          this.updateProfileStatusButtons(true);
          this.renderFarmersListCards();
          this.renderTableBody();
          this.closeFarmerActionModal();
          return;
        }
        if (action === 'unsuspend') {
          await this.handleUnblockFarmer(idx, reason);
          this.updateProfileStatusButtons(false);
          this.renderFarmersListCards();
          this.renderTableBody();
          this.closeFarmerActionModal();
          return;
        }

        this.renderFarmersListCards();
        this.renderTableBody();
        this.closeFarmerActionModal();
      } catch (err) {
        console.error('Farmer action failed:', err);
      } finally {
        if (okBtn.dataset.originalHtml) {
          okBtn.innerHTML = okBtn.dataset.originalHtml;
          delete okBtn.dataset.originalHtml;
        }
        this.setBtnLoading(okBtn, false, { spinIcon: false });
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || root.hasAttribute('hidden')) return;
      this.closeFarmerActionModal();
    });
  }

  openFarmerActionModal(action, farmerIdx) {
    const root = document.getElementById('farmerActionModal');
    const titleEl = document.getElementById('farmerActionTitle');
    const subtitleEl = document.getElementById('farmerActionSubtitle');
    const iconEl = document.getElementById('farmerActionIcon');
    const iconWrap = document.getElementById('farmerActionIconWrap');
    const confirmBtn = document.getElementById('farmerActionConfirm');
    const reasonInput = document.getElementById('farmerActionReason');
    const reasonSelect = document.getElementById('farmerActionReasonSelect');

    if (!root || !titleEl || !subtitleEl || !iconEl || !iconWrap || !confirmBtn || !reasonSelect) return;

    if (reasonInput) reasonInput.value = '';
    root.dataset.action = action;
    root.dataset.farmerIdx = farmerIdx;

    // Reset suspension timeframe and countdown
    const timeframe = document.getElementById('suspensionTimeframe');
    const countdownMsg = document.getElementById('modalCountdownMsg');
    const cancelBtn = document.getElementById('farmerActionCancel');
    if (timeframe) timeframe.style.display = 'none';
    if (countdownMsg) countdownMsg.style.display = 'none';
    if (confirmBtn) confirmBtn.style.display = 'block';
    if (cancelBtn) cancelBtn.style.display = 'block';

    const farmer = this.data[farmerIdx];
    const farmerName = farmer ? (farmer['NAME OF FARMER'] || farmer.name || 'Farmer') : 'Farmer';

    // Define quick reasons based on action
    let reasons = [];
    if (action === 'warning' || action === 'suspend') {
      reasons = [
        'Select a reason...',
        'Misconduct',
        'Policy Violation',
        'Fraudulent Activity',
        'Incomplete Data',
        'Quality Standards',
        'Other'
      ];
    } else if (action === 'unsuspend') {
      reasons = [
        'Select a reason...',
        'Issue Resolved',
        'Requirements Met',
        'Suspension Lifted',
        'Error Correction',
        'Other'
      ];
    }

    // Populate select
    reasonSelect.innerHTML = reasons.map(r => `
      <option value="${r === 'Select a reason...' ? '' : r}">${r}</option>
    `).join('');

    // Remove previous listener to avoid duplicates
    const newReasonSelect = reasonSelect.cloneNode(true);
    reasonSelect.parentNode.replaceChild(newReasonSelect, reasonSelect);
    
    newReasonSelect.addEventListener('change', (e) => {
      const selectedReason = e.target.value;
      if (selectedReason === 'Other') {
        reasonInput.value = '';
        reasonInput.focus();
      } else if (selectedReason) {
        reasonInput.value = selectedReason;
      } else {
        reasonInput.value = '';
      }
    });

    if (action === 'warning') {
      titleEl.textContent = 'Warning Farmer';
      subtitleEl.textContent = ``;
      iconEl.className = 'fa-solid fa-triangle-exclamation';
      iconWrap.style.backgroundColor = '#fffbeb';
      iconEl.style.color = '#b45309';
      confirmBtn.textContent = 'Issue Warning';
      confirmBtn.style.backgroundColor = '#b45309';
    } else if (action === 'suspend') {
      // Calculate and show suspension dates
      const now = new Date();
      const liftDate = new Date();
      liftDate.setDate(now.getDate() + 3);

      const options = { 
        year: 'numeric', month: 'short', day: 'numeric', 
        hour: '2-digit', minute: '2-digit' 
      };
      
      const startText = document.getElementById('suspensionStartText');
      const liftText = document.getElementById('suspensionLiftText');
      if (startText) startText.textContent = now.toLocaleDateString(undefined, options);
      if (liftText) liftText.textContent = liftDate.toLocaleDateString(undefined, options);
      if (timeframe) timeframe.style.display = 'block';

      titleEl.textContent = 'Suspend Farmer (3 Days)';
      subtitleEl.textContent = `Suspending access for ${farmerName} for 3 days`;
      iconEl.className = 'fa-solid fa-user-slash';
      iconWrap.style.backgroundColor = '#fef2f2';
      iconEl.style.color = '#b91c1c';
      confirmBtn.textContent = 'Suspend for 3 Days';
      confirmBtn.style.backgroundColor = '#b91c1c';
    } else if (action === 'unsuspend') {
      titleEl.textContent = 'Unsuspend Farmer';
      subtitleEl.textContent = `Restoring access for ${farmerName}`;
      iconEl.className = 'fa-solid fa-user-check';
      iconWrap.style.backgroundColor = '#f0fdf4';
      iconEl.style.color = '#15803d';
      confirmBtn.textContent = 'Unsuspend Account';
      confirmBtn.style.backgroundColor = '#15803d';
    }

    root.removeAttribute('hidden');
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('confirm-dialog-active');
    if (reasonInput) reasonInput.focus();
  }

  closeFarmerActionModal() {
    const root = document.getElementById('farmerActionModal');
    if (root) {
      root.setAttribute('hidden', '');
      root.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('confirm-dialog-active');
  }

  initNewDashboardFeatures() {
    this.updateAdminGreeting(
      (window.__BEANTHENTIC_USER__ && window.__BEANTHENTIC_USER__.full_name) || ''
    );
    this.updateNotificationBadges();
    this.initCalendarWidget();
    this.initRegistrationChart();
  }

  initRegistrationChart() {
    this.updateRegistrationChart();
  }

  initCalendarWidget() {
    const monthEl = document.getElementById('calendarMonth');
    const daysEl = document.getElementById('calendarDays');
    const prevBtn = document.getElementById('prevMonth');
    const nextBtn = document.getElementById('nextMonth');
    const todayBtn = document.getElementById('calendarTodayBtn');
    const composer = document.getElementById('calendarNotesPanel');
    const notesDateLabel = document.getElementById('calendarNotesDateLabel');
    const form = document.getElementById('calendarNoteForm');
    const titleInput = document.getElementById('calendarNoteTitle');
    const bodyInput = document.getElementById('calendarNoteBody');
    const noteIdInput = document.getElementById('calendarNoteId');
    const cancelBtn = document.getElementById('calendarNoteCancelBtn');
    const deleteBtn = document.getElementById('calendarNoteDeleteBtn');
    const saveBtn = document.getElementById('calendarNoteSaveBtn');
    const closeBtn = document.getElementById('calendarComposerClose');
    const filterEl = document.getElementById('calendarFilterCategory');
    const sortEl = document.getElementById('calendarSortOrder');
    const searchEl = document.getElementById('calendarSearchInput');
    const scheduleList = document.getElementById('calendarScheduleList');
    const activitiesList = document.getElementById('calendarActivitiesList');
    const monthPanel = document.querySelector('[data-gcal-panel="month"]');
    const schedulePanel = document.querySelector('[data-gcal-panel="schedule"]');
    const activitiesPanel = document.querySelector('[data-gcal-panel="activities"]');
    const tabs = document.querySelectorAll('.gcal-tab[data-gcal-view]');
    if (!daysEl) return;

    const CAT_ICONS = {
      harvest: 'fa-seedling',
      delivery: 'fa-truck',
      meeting: 'fa-users',
      deadline: 'fa-flag',
      other: 'fa-note-sticky',
    };
    const MAX_EVENTS_PER_CELL = 2;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayKey = this._calendarDateKey(today);

    let viewDate = new Date(today.getFullYear(), today.getMonth(), 1);
    let selectedKey = todayKey;
    let notesByDate = {};
    let selectedCategory = 'harvest';
    let activeView = 'month';
    let filterCategory = 'all';
    let sortOrder = 'date-asc';
    let searchQuery = '';
    let allNotesLoaded = false;

    const categoryChips = document.querySelectorAll('#calendarNotesPanel .calendar-cat-chip');

    const setCategory = (category) => {
      selectedCategory = category || 'harvest';
      categoryChips.forEach((c) => {
        c.classList.toggle('active', c.dataset.category === selectedCategory);
      });
    };

    const openComposer = () => {
      if (composer) composer.hidden = false;
    };

    const closeComposer = () => {
      if (composer) composer.hidden = true;
      resetForm();
    };

    const resetForm = () => {
      if (noteIdInput) noteIdInput.value = '';
      if (titleInput) titleInput.value = '';
      if (bodyInput) bodyInput.value = '';
      setCategory('harvest');
      if (cancelBtn) cancelBtn.hidden = true;
      if (deleteBtn) deleteBtn.hidden = true;
      if (saveBtn) {
        saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Save note';
      }
    };

    const updateComposerLabel = () => {
      if (!notesDateLabel) return;
      const labelDate = this._calendarParseKey(selectedKey);
      notesDateLabel.textContent = labelDate
        ? labelDate.toLocaleDateString('en-US', {
            weekday: 'short',
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          })
        : 'Select a date';
    };

    const fillForm = (note) => {
      if (!note) return;
      if (noteIdInput) noteIdInput.value = note.id || '';
      if (titleInput) titleInput.value = note.title || '';
      if (bodyInput) bodyInput.value = note.body || '';
      setCategory(note.category || 'other');
      if (cancelBtn) cancelBtn.hidden = false;
      if (deleteBtn) deleteBtn.hidden = false;
      if (saveBtn) {
        saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Update note';
      }
    };

    const notePassesFilters = (note) => {
      const cat = String(note.category || 'other').toLowerCase();
      if (filterCategory !== 'all' && cat !== filterCategory) return false;
      if (!searchQuery) return true;
      const hay = `${note.title || ''} ${note.body || ''} ${cat}`.toLowerCase();
      return hay.includes(searchQuery);
    };

    const filteredNotesForDate = (key) => {
      const notes = Array.isArray(notesByDate[key]) ? notesByDate[key] : [];
      return notes.filter(notePassesFilters);
    };

    const flattenNotes = () => {
      const rows = [];
      Object.keys(notesByDate).forEach((dateKey) => {
        (notesByDate[dateKey] || []).forEach((note) => {
          if (!notePassesFilters(note)) return;
          rows.push({ ...note, date: dateKey });
        });
      });
      rows.sort((a, b) => {
        if (sortOrder === 'title') {
          return String(a.title || '').localeCompare(String(b.title || ''));
        }
        const cmp = String(a.date).localeCompare(String(b.date));
        if (cmp !== 0) return sortOrder === 'date-desc' ? -cmp : cmp;
        return String(a.title || '').localeCompare(String(b.title || ''));
      });
      return rows;
    };

    const catIcon = (cat) => CAT_ICONS[cat] || CAT_ICONS.other;

    const dayNumLabel = (cellDate, inMonth) => {
      const d = cellDate.getDate();
      if (d === 1 || !inMonth) {
        return cellDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      }
      return String(d);
    };

    const openNoteEditor = (dateKey, note) => {
      selectedKey = dateKey;
      resetForm();
      if (note) fillForm(note);
      updateComposerLabel();
      openComposer();
      renderMonth();
      titleInput?.focus();
    };

    const openNewNote = (dateKey) => {
      selectedKey = dateKey;
      resetForm();
      updateComposerLabel();
      openComposer();
      renderMonth();
      titleInput?.focus();
    };

    const renderActivityList = (listEl, rows, emptyText) => {
      if (!listEl) return;
      if (!rows.length) {
        listEl.innerHTML = `<li class="gcal-activity-empty">${this.escapeHtml(emptyText)}</li>`;
        return;
      }
      listEl.innerHTML = rows
        .map((note) => {
          const cat = this.escapeHtml(note.category || 'other');
          const title = this.escapeHtml(note.title || 'Untitled note');
          const body = this.escapeHtml(note.body || '');
          const dateLabel = this._calendarParseKey(note.date)?.toLocaleDateString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
          }) || note.date;
          const icon = catIcon(note.category || 'other');
          return `<li class="gcal-activity-item" data-date="${this.escapeHtml(note.date)}" data-id="${this.escapeHtml(note.id || '')}">
            <span class="gcal-activity-date">${this.escapeHtml(dateLabel || '')}</span>
            <div>
              <p class="gcal-activity-title"><i class="fa-solid ${icon} gcal-event__icon gcal-event__icon--${cat}" aria-hidden="true"></i> ${title}</p>
              ${body ? `<p class="gcal-activity-sub">${body}</p>` : ''}
            </div>
            <span class="calendar-note-cat calendar-note-cat--${cat}">${cat}</span>
          </li>`;
        })
        .join('');

      listEl.querySelectorAll('.gcal-activity-item').forEach((item) => {
        item.addEventListener('click', () => {
          const dateKey = item.dataset.date;
          const id = item.dataset.id;
          const note = (notesByDate[dateKey] || []).find((n) => String(n.id) === String(id));
          if (!dateKey) return;
          const parsed = this._calendarParseKey(dateKey);
          if (parsed) {
            viewDate = new Date(parsed.getFullYear(), parsed.getMonth(), 1);
          }
          setView('month');
          openNoteEditor(dateKey, note || null);
          loadNotes();
        });
      });
    };

    const renderLists = () => {
      const all = flattenNotes();
      const upcoming = all.filter((n) => String(n.date) >= todayKey);
      const scheduleRows = all.filter((n) => {
        const thin = !String(n.body || '').trim();
        const isDeadline = String(n.category || '') === 'deadline';
        return thin || (isDeadline && String(n.date) >= todayKey);
      });
      renderActivityList(
        scheduleList,
        scheduleRows.length ? scheduleRows : upcoming,
        'Nothing to schedule. Add harvest or delivery notes from the monthly calendar.'
      );
      renderActivityList(activitiesList, all, 'No activities yet. Click a day on the monthly calendar to add a note.');
    };

    const renderMonth = () => {
      const year = viewDate.getFullYear();
      const month = viewDate.getMonth();
      const firstOfMonth = new Date(year, month, 1);
      const startOffset = firstOfMonth.getDay();
      const gridStart = new Date(year, month, 1 - startOffset);

      if (monthEl) {
        monthEl.textContent = viewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      }

      daysEl.innerHTML = '';

      for (let i = 0; i < 42; i++) {
        const cellDate = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
        const key = this._calendarDateKey(cellDate);
        const inMonth = cellDate.getMonth() === month;
        const isToday = key === todayKey;
        const isSelected = selectedKey === key;
        const dayNotes = filteredNotesForDate(key);
        const visible = dayNotes.slice(0, MAX_EVENTS_PER_CELL);
        const moreCount = dayNotes.length - visible.length;

        const cell = document.createElement('div');
        cell.className = 'gcal-day';
        cell.setAttribute('role', 'gridcell');
        cell.dataset.date = key;
        if (!inMonth) cell.classList.add('is-outside');
        if (isToday) {
          cell.classList.add('is-today');
          cell.setAttribute('aria-current', 'date');
        }
        if (isSelected) cell.classList.add('is-selected');

        const num = document.createElement('span');
        num.className = 'gcal-day__num';
        num.textContent = dayNumLabel(cellDate, inMonth);
        cell.appendChild(num);

        const eventsWrap = document.createElement('div');
        eventsWrap.className = 'gcal-day__events';

        visible.forEach((note) => {
          const cat = note.category || 'other';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'gcal-event';
          btn.dataset.id = note.id || '';
          btn.innerHTML = `<span class="gcal-event__title"><i class="fa-solid ${catIcon(cat)} gcal-event__icon gcal-event__icon--${this.escapeHtml(cat)}" aria-hidden="true"></i><span>${this.escapeHtml(note.title || 'Untitled')}</span></span>${
            note.body
              ? `<span class="gcal-event__sub">${this.escapeHtml(note.body)}</span>`
              : ''
          }`;
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openNoteEditor(key, note);
          });
          eventsWrap.appendChild(btn);
        });
        cell.appendChild(eventsWrap);

        if (moreCount > 0) {
          const more = document.createElement('button');
          more.type = 'button';
          more.className = 'gcal-day__more';
          more.textContent = `+${moreCount} more`;
          more.addEventListener('click', (e) => {
            e.stopPropagation();
            openNewNote(key);
            const firstHidden = dayNotes[MAX_EVENTS_PER_CELL];
            if (firstHidden) fillForm(firstHidden);
          });
          cell.appendChild(more);
        }

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'gcal-day__add';
        addBtn.textContent = '+ Add';
        addBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openNewNote(key);
        });
        cell.appendChild(addBtn);

        cell.addEventListener('click', () => {
          if (!inMonth) {
            viewDate = new Date(cellDate.getFullYear(), cellDate.getMonth(), 1);
            selectedKey = key;
            loadNotes().then(() => openNewNote(key));
            return;
          }
          openNewNote(key);
        });

        daysEl.appendChild(cell);
      }
    };

    const render = () => {
      renderMonth();
      renderLists();
      updateComposerLabel();
    };

    const setView = (view) => {
      activeView = view || 'month';
      tabs.forEach((tab) => {
        const on = tab.dataset.gcalView === activeView;
        tab.classList.toggle('active', on);
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      if (monthPanel) monthPanel.hidden = activeView !== 'month';
      if (schedulePanel) schedulePanel.hidden = activeView !== 'schedule';
      if (activitiesPanel) activitiesPanel.hidden = activeView !== 'activities';
      if (activeView !== 'month') closeComposer();
      renderLists();
    };

    const loadNotes = async ({ all = false } = {}) => {
      try {
        const month = `${viewDate.getFullYear()}-${String(viewDate.getMonth() + 1).padStart(2, '0')}`;
        const url =
          all || !allNotesLoaded
            ? '/api/calendar-notes'
            : `/api/calendar-notes?month=${encodeURIComponent(month)}`;
        const res = await fetch(url, { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          if (all || !allNotesLoaded) {
            notesByDate = { ...(data.notes_by_date || {}) };
            allNotesLoaded = true;
          } else {
            notesByDate = { ...notesByDate, ...(data.notes_by_date || {}) };
          }
        }
      } catch (_) {
        /* keep cache */
      }
      render();
    };

    const deleteActiveNote = async () => {
      const id = noteIdInput?.value;
      if (!id || !selectedKey) return;
      const ok = window.confirm('Delete this calendar note?');
      if (!ok) return;
      try {
        const res = await fetch(
          `/api/calendar-notes/${encodeURIComponent(selectedKey)}/${encodeURIComponent(id)}`,
          { method: 'DELETE', credentials: 'same-origin' }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'Could not delete note.');
        notesByDate[selectedKey] = Array.isArray(data.notes) ? data.notes : [];
        if (!notesByDate[selectedKey].length) delete notesByDate[selectedKey];
        closeComposer();
        render();
        this.showNotification('Note deleted.', 'success');
      } catch (err) {
        this.showNotification(err.message || 'Could not delete note.', 'error');
      }
    };

    categoryChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        selectedCategory = chip.dataset.category || 'other';
        categoryChips.forEach((c) => c.classList.toggle('active', c === chip));
      });
    });

    tabs.forEach((tab) => {
      tab.addEventListener('click', async () => {
        const view = tab.dataset.gcalView || 'month';
        if (view !== 'month' && !allNotesLoaded) await loadNotes({ all: true });
        setView(view);
      });
    });

    if (filterEl) {
      filterEl.addEventListener('change', () => {
        filterCategory = filterEl.value || 'all';
        render();
      });
    }
    if (sortEl) {
      sortEl.addEventListener('change', () => {
        sortOrder = sortEl.value || 'date-asc';
        renderLists();
      });
    }
    if (searchEl) {
      searchEl.addEventListener('input', () => {
        searchQuery = String(searchEl.value || '').trim().toLowerCase();
        render();
      });
    }

    if (prevBtn) {
      prevBtn.onclick = () => {
        viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1);
        loadNotes();
      };
    }
    if (nextBtn) {
      nextBtn.onclick = () => {
        viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1);
        loadNotes();
      };
    }
    if (todayBtn) {
      todayBtn.onclick = () => {
        viewDate = new Date(today.getFullYear(), today.getMonth(), 1);
        selectedKey = todayKey;
        setView('month');
        resetForm();
        updateComposerLabel();
        loadNotes();
      };
    }

    if (cancelBtn) cancelBtn.addEventListener('click', () => resetForm());
    if (closeBtn) closeBtn.addEventListener('click', () => closeComposer());
    if (deleteBtn) deleteBtn.addEventListener('click', () => deleteActiveNote());

    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!selectedKey) {
          this.showNotification('Select a date first.', 'error');
          return;
        }
        const payload = {
          id: noteIdInput?.value || undefined,
          title: titleInput?.value || '',
          body: bodyInput?.value || '',
          category: selectedCategory,
        };
        if (saveBtn) {
          saveBtn.disabled = true;
          saveBtn.classList.add('is-loading');
        }
        try {
          const res = await fetch(`/api/calendar-notes/${encodeURIComponent(selectedKey)}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) throw new Error(data.error || 'Could not save note.');
          notesByDate[selectedKey] = Array.isArray(data.notes) ? data.notes : [];
          closeComposer();
          render();
          this.showNotification('Note saved.', 'success');
        } catch (err) {
          this.showNotification(err.message || 'Could not save note.', 'error');
        } finally {
          if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.classList.remove('is-loading');
          }
        }
      });
    }

    setView('month');
    loadNotes({ all: true });
  }

  _calendarDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  _calendarParseKey(key) {
    const parts = String(key || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  initThemeToggle() {
    const themeToggle = document.getElementById('themeToggle');
    if (!themeToggle) return;

    const savedTheme = localStorage.getItem('beanthentic-theme')
      || document.documentElement.getAttribute('data-theme')
      || 'light';
    this.applyTheme(savedTheme);

    themeToggle.addEventListener('click', () => {
      const currentTheme = document.body.getAttribute('data-theme')
        || document.documentElement.getAttribute('data-theme')
        || 'light';
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      this.applyTheme(newTheme);
      try {
        localStorage.setItem('beanthentic-theme', newTheme);
      } catch (e) { /* ignore */ }
    });
  }

  applyTheme(theme) {
    const next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    document.body.setAttribute('data-theme', next);

    const themeToggle = document.getElementById('themeToggle');
    const themeIcon = themeToggle && themeToggle.querySelector('.action-icon');
    if (themeIcon) {
      themeIcon.className = next === 'dark'
        ? 'action-icon fa-solid fa-sun'
        : 'action-icon fa-solid fa-moon';
    }
    if (themeToggle) {
      const label = next === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
      themeToggle.setAttribute('aria-label', label);
      themeToggle.setAttribute('title', label);
    }
  }

  updateAdminGreeting(fullName) {
    const el = document.getElementById('adminGreeting');
    if (!el) return;
    const raw = String(fullName || '').trim();
    const first = raw ? raw.split(/\s+/)[0] : 'Admin';
    el.textContent = `Good day, ${first}!`;
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
    const q = String(query || '').trim();
    if (!q) return;
    this.switchModule('farmers-list');
    const listSearch = document.getElementById('farmersListSearch');
    if (listSearch) {
      listSearch.value = q;
      listSearch.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  refreshOverviewData() {
    this.loadExcelData();
    this.updateLastUpdatedTime();
    this.showNotification('Dashboard data refreshed', 'success');
  }

  initMapsLiveRefresh() {
    const btn = document.getElementById('mapsRefreshLiveFarmersBtn');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => this.refreshMapFromLiveFarmers({ silent: false, reloadFarmers: true }));
  }

  async refreshMapFromLiveFarmers({ silent = false, reloadFarmers = true } = {}) {
    const btn = document.getElementById('mapsRefreshLiveFarmersBtn');
    if (btn) {
      if (!btn.dataset.originalHtml) btn.dataset.originalHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML =
        '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i><span>Refreshing…</span>';
    }
    try {
      if (reloadFarmers) {
        await this.loadExcelData();
      }
      this.renderMapsModule();
      if (!silent) {
        const pins = this.getFilteredMapRows().length;
        this.showNotification(
          `Map refreshed from live farmers (${pins} active pin${pins === 1 ? '' : 's'}).`,
          'success'
        );
      }
    } catch (err) {
      console.error('Map live refresh failed:', err);
      if (!silent) {
        this.showNotification(err.message || 'Could not refresh map from live farmers.', 'error');
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        if (btn.dataset.originalHtml) {
          btn.innerHTML = btn.dataset.originalHtml;
        }
      }
    }
  }

  updateNotificationBadges() {
    const headerBadge = document.getElementById('headerNotificationBadge');
    const navBadge = document.getElementById('navNotificationBadge');

    const unreadCount = this.notificationsFeed.filter(n => !n.read).length;

    if (headerBadge) {
      if (unreadCount > 0) {
        headerBadge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
        headerBadge.classList.add('is-visible');
      } else {
        headerBadge.textContent = '';
        headerBadge.classList.remove('is-visible');
      }
    }
    if (navBadge) navBadge.textContent = unreadCount > 0 ? String(unreadCount) : '';
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

  splitAccountDisplayName(user) {
    const u = user || {};
    const first = (u.first_name || '').trim();
    const last = (u.last_name || '').trim();
    if (first || last) {
      return {
        firstName: first,
        lastName: last,
        fullName: `${first} ${last}`.trim() || (u.full_name || 'Admin'),
      };
    }
    const fullName = (u.full_name || 'Admin').trim();
    const parts = fullName.split(/\s+/);
    return {
      firstName: parts[0] || '',
      lastName: parts.slice(1).join(' ') || '',
      fullName,
    };
  }

  applyAccountPersonalInfo(user) {
    const { firstName, lastName, fullName } = this.splitAccountDisplayName(user);
    const phone = user?.phone || '—';

    const heroNameEl = document.getElementById('accountHeroName');
    const firstNameEl = document.getElementById('accountFirstName');
    const lastNameEl = document.getElementById('accountLastName');
    const phoneEl = document.getElementById('accountPhone');
    const editFirstNameEl = document.getElementById('accountEditFirstName');
    const editLastNameEl = document.getElementById('accountEditLastName');
    const editPhoneEl = document.getElementById('accountEditPhone');
    const settingsNameEl = document.getElementById('accountSettingsDisplayName');
    const settingsPhoneEl = document.getElementById('accountSettingsPhone');

    if (heroNameEl) heroNameEl.textContent = fullName;
    if (firstNameEl) firstNameEl.textContent = firstName || '—';
    if (lastNameEl) lastNameEl.textContent = lastName || '—';
    if (phoneEl) phoneEl.textContent = phone;
    if (editFirstNameEl) editFirstNameEl.value = firstName;
    if (editLastNameEl) editLastNameEl.value = lastName;
    if (editPhoneEl) editPhoneEl.value = phone === '—' ? '' : phone;
    if (settingsNameEl) settingsNameEl.textContent = fullName;
    if (settingsPhoneEl) settingsPhoneEl.textContent = phone;

    if (window.__BEANTHENTIC_USER__) {
      window.__BEANTHENTIC_USER__.full_name = fullName;
      window.__BEANTHENTIC_USER__.phone = phone === '—' ? '' : phone;
    }
    this.updateAdminGreeting(fullName);
  }

  openEditProfileModal() {
    const editProfileModal = document.getElementById('editProfileModal');
    if (!editProfileModal) return;
    editProfileModal.removeAttribute('hidden');
    editProfileModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('confirm-dialog-active');
    document.getElementById('accountEditFirstName')?.focus();
  }

  closeEditProfileModal() {
    const editProfileModal = document.getElementById('editProfileModal');
    if (editProfileModal) {
      editProfileModal.setAttribute('hidden', '');
      editProfileModal.setAttribute('aria-hidden', 'true');
    }
    const photoModal = document.getElementById('profilePhotoModal');
    const logoutEl = document.getElementById('logoutConfirmModal');
    const deactivateEl = document.getElementById('deactivateAccountConfirmModal');
    const del = document.getElementById('deleteFarmerConfirmModal');
    const d2 = document.getElementById('disable2faConfirmModal');
    if (
      photoModal?.hasAttribute('hidden') &&
      logoutEl?.hasAttribute('hidden') &&
      deactivateEl?.hasAttribute('hidden') &&
      del?.hasAttribute('hidden') &&
      d2?.hasAttribute('hidden')
    ) {
      document.body.classList.remove('confirm-dialog-active');
    }
  }

  async saveAccountPersonalInfo() {
    const firstName = (document.getElementById('accountEditFirstName')?.value || '').trim();
    const lastName = (document.getElementById('accountEditLastName')?.value || '').trim();
    const phone = (document.getElementById('accountEditPhone')?.value || '').trim();
    const fullName = `${firstName} ${lastName}`.trim();

    if (!fullName) {
      this.showNotification('First and last name are required.', 'error');
      return;
    }
    if (!phone) {
      this.showNotification('Phone number is required.', 'error');
      return;
    }

    const saveBtn = document.getElementById('saveEditProfileModalBtn');
    if (saveBtn) saveBtn.disabled = true;

    const fd = new FormData();
    fd.append('first_name', firstName);
    fd.append('last_name', lastName);
    fd.append('full_name', fullName);
    fd.append('phone', phone);

    try {
      const res = await fetch(beanthenticApiUrl('/settings/profile'), {
        method: 'POST',
        body: fd,
        credentials: 'same-origin',
      });
      const result = await beanthenticParseJsonResponse(res);
      if (!res.ok || result.error) throw new Error(result.error || 'Could not update profile.');

      if (result.user) {
        this.applyAccountPersonalInfo(result.user);
      }
      await this.loadAccountData();

      this.showNotification(result.success || 'Profile updated successfully.', 'success');
      this.closeEditProfileModal();
    } catch (err) {
      this.showNotification(err.message || 'Could not update profile.', 'error');
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  applyAccountAppVersion(appInfo) {
    const versionEl = document.getElementById('accountAppVersion');
    const labelEl = document.getElementById('accountAppReleaseLabel');
    const version = String(appInfo?.version || '1.0.0').trim();
    const displayVersion = version.startsWith('v') ? version : `v${version}`;
    if (versionEl) versionEl.textContent = displayVersion;
    if (labelEl) {
      const release = String(appInfo?.release_label || '').trim();
      labelEl.textContent = release ? ` · ${release}` : '';
    }
  }

  async checkForAppUpdates() {
    const btn = document.getElementById('accountCheckUpdatesBtn');
    const statusEl = document.getElementById('accountUpdateStatus');
    if (!btn || !statusEl) return;

    btn.disabled = true;
    btn.classList.add('is-checking');
    statusEl.textContent = 'Checking for updates…';
    statusEl.classList.remove('account-updates-card__status--success', 'account-updates-card__status--warn');

    try {
      const res = await fetch(beanthenticApiUrl('/api/app/version'), { credentials: 'same-origin' });
      const data = await beanthenticParseJsonResponse(res);
      if (!res.ok) throw new Error(data.error || 'Could not check for updates.');

      this.applyAccountAppVersion(data);
      const current = String(data.version || '').trim();
      const latest = String(data.latest_version || current).trim();

      if (data.update_available && latest !== current) {
        statusEl.textContent = data.release_notes
          ? `Update available: v${latest}. ${data.release_notes}`
          : `A newer version is available (v${latest}). Contact your administrator to deploy the update.`;
        statusEl.classList.add('account-updates-card__status--warn');
      } else {
        statusEl.textContent = `You're on the latest version (v${current}).`;
        statusEl.classList.add('account-updates-card__status--success');
      }
    } catch (err) {
      statusEl.textContent = err.message || 'Could not check for updates.';
      statusEl.classList.add('account-updates-card__status--warn');
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-checking');
    }
  }

  async loadAccountData() {
    try {
      const response = await fetch(beanthenticApiUrl('/settings/state'), { credentials: 'same-origin' });
      if (!response.ok) throw new Error('Failed to load user data');
      const data = await beanthenticParseJsonResponse(response);

      const user = data.user || {};
      this.applyAccountPersonalInfo(user);
      this.applyAccountProfilePhoto(user.profile_photo_url || null, user.full_name || 'Admin');
      this.applyAccountAppVersion(data.app || {});
    } catch (error) {
      console.error('Failed to load account data:', error);
      const heroNameEl = document.getElementById('accountHeroName');
      const firstNameEl = document.getElementById('accountFirstName');
      const lastNameEl = document.getElementById('accountLastName');
      const phoneEl = document.getElementById('accountPhone');

      if (heroNameEl) heroNameEl.textContent = 'Admin';
      if (firstNameEl) firstNameEl.textContent = 'Admin';
      if (lastNameEl) lastNameEl.textContent = '';
      if (phoneEl) phoneEl.textContent = '—';
    }
  }

  initAccountModule() {
    const manageSettingsBtn = document.getElementById('manageSettingsBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const quickProfileForm = document.getElementById('accountQuickProfileForm');
    const quickPasswordForm = document.getElementById('accountQuickPasswordForm');
    const passwordToggles = document.querySelectorAll('.password-toggle[data-target]');
    const openEditModalBtn = document.getElementById('openEditProfileModalBtn');
    const closeEditModalBtn = document.getElementById('closeEditProfileModalBtn');
    const cancelEditModalBtn = document.getElementById('cancelEditProfileModalBtn');
    const editProfileModalBackdrop = document.getElementById('editProfileModalBackdrop');

    if (openEditModalBtn) {
      openEditModalBtn.addEventListener('click', async () => {
        await this.loadAccountData();
        this.openEditProfileModal();
      });
    }

    if (closeEditModalBtn) {
      closeEditModalBtn.addEventListener('click', () => this.closeEditProfileModal());
    }
    if (cancelEditModalBtn) {
      cancelEditModalBtn.addEventListener('click', () => this.closeEditProfileModal());
    }
    if (editProfileModalBackdrop) {
      editProfileModalBackdrop.addEventListener('click', () => this.closeEditProfileModal());
    }
    
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
        this.openLogoutConfirmModal();
      });
    }

    const deactivateBtn = document.getElementById('deactivateAccountBtn');
    if (deactivateBtn) {
      deactivateBtn.addEventListener('click', () => this.openDeactivateAccountModal());
    }

    const checkUpdatesBtn = document.getElementById('accountCheckUpdatesBtn');
    if (checkUpdatesBtn) {
      checkUpdatesBtn.addEventListener('click', () => this.checkForAppUpdates());
    }

    passwordToggles.forEach((toggleBtn) => {
      toggleBtn.addEventListener('click', () => {
        const targetId = toggleBtn.getAttribute('data-target');
        if (!targetId) return;
        const input = document.getElementById(targetId);
        if (!input) return;
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        const icon = toggleBtn.querySelector('i');
        if (icon) {
          icon.className = isPassword ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
        }
      });
    });

    if (quickProfileForm) {
      quickProfileForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.saveAccountPersonalInfo();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const editProfileModal = document.getElementById('editProfileModal');
      if (!editProfileModal || editProfileModal.hasAttribute('hidden')) return;
      e.preventDefault();
      this.closeEditProfileModal();
    });

    if (quickPasswordForm) {
      quickPasswordForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const currentPassword = (document.getElementById('accountCurrentPassword')?.value || '').trim();
        const newPassword = (document.getElementById('accountNewPassword')?.value || '').trim();
        const confirmPassword = (document.getElementById('accountConfirmPassword')?.value || '').trim();
        if (!currentPassword || !newPassword || !confirmPassword) {
          this.showNotification('All password fields are required.', 'error');
          return;
        }
        if (newPassword.length < 8) {
          this.showNotification('New password must be at least 8 characters.', 'error');
          return;
        }
        if (newPassword !== confirmPassword) {
          this.showNotification('New passwords do not match.', 'error');
          return;
        }
        const fd = new FormData();
        fd.append('action', 'change_password');
        fd.append('current_password', currentPassword);
        fd.append('new_password', newPassword);
        fd.append('confirm_password', confirmPassword);
        try {
          const res = await fetch('/settings/security', { method: 'POST', body: fd });
          const result = await res.json();
          if (!res.ok || result.error) throw new Error(result.error || 'Could not update password.');
          this.showNotification(result.success || 'Password updated successfully.', 'success');
          quickPasswordForm.reset();
        } catch (err) {
          this.showNotification(err.message || 'Could not update password.', 'error');
        }
      });
    }
  }

  // ═══════════════════════════════════════════════════
  // MESSAGING MODULE
  // ═══════════════════════════════════════════════════

  messagingApi(path, init = {}) {
    const headers = { Accept: 'application/json', ...(init.headers || {}) };
    return fetch(beanthenticApiUrl(path), { credentials: 'same-origin', ...init, headers });
  }

  messagingErrorMessage(data, status) {
    if (data?.error === 'APP_DB_UNREACHABLE' || data?.error === 'MESSAGES_LOAD_FAILED') {
      const detail = (data.detail || data.message || '').trim();
      return detail || (
        'Cannot load messages from the app database. Farmers may still load via the app server HTTP bridge. ' +
        'Copy deploy/xampp_api/admin_shared_messages.php to Beanthentic-App/api/ on the XAMPP PC, ' +
        'and check app_db_host / app_server_base in settings.json.'
      );
    }
    return data?.message || data?.error || `Request failed (HTTP ${status})`;
  }

  /**
   * Toggle loading state on a button (spinner + disabled).
   * @param {HTMLElement|null} btn
   * @param {boolean} loading
   * @param {{ spinIcon?: boolean, label?: string }} opts
   */
  setBtnLoading(btn, loading, opts = {}) {
    if (!btn) return;
    const spinIcon = opts.spinIcon !== false;
    if (loading) {
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.classList.add('is-loading');
      const icon = btn.querySelector('i');
      if (icon && spinIcon && !btn.dataset.btnLoadingSaved) {
        btn.dataset.btnLoadingIconClass = icon.className;
        if (
          icon.classList.contains('fa-rotate-right') ||
          icon.classList.contains('fa-pen-to-square')
        ) {
          icon.classList.add('fa-spin');
        } else {
          icon.className = 'fa-solid fa-spinner fa-spin';
        }
        btn.dataset.btnLoadingSaved = '1';
      }
      if (opts.label && !btn.dataset.btnLoadingLabelSaved) {
        btn.dataset.btnLoadingPrevLabel = btn.textContent.trim();
        const labelEl = btn.querySelector('span') || btn;
        if (labelEl.tagName === 'SPAN') {
          labelEl.textContent = opts.label;
        } else if (!icon) {
          btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ${opts.label}`;
        }
        btn.dataset.btnLoadingLabelSaved = '1';
      }
      return;
    }
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.classList.remove('is-loading');
    const icon = btn.querySelector('i');
    if (icon && btn.dataset.btnLoadingIconClass) {
      icon.className = btn.dataset.btnLoadingIconClass;
      delete btn.dataset.btnLoadingIconClass;
      delete btn.dataset.btnLoadingSaved;
    }
    if (btn.dataset.btnLoadingPrevLabel) {
      const labelEl = btn.querySelector('span');
      if (labelEl) labelEl.textContent = btn.dataset.btnLoadingPrevLabel;
      else btn.textContent = btn.dataset.btnLoadingPrevLabel;
      delete btn.dataset.btnLoadingPrevLabel;
      delete btn.dataset.btnLoadingLabelSaved;
    }
  }

  showMessagingConversationLoading(message = 'Loading conversation…') {
    const bodyEl = document.getElementById('messagingDetailBody');
    const pane = document.getElementById('messagingDetailPane');
    if (pane) pane.classList.add('is-loading-conversation');
    if (bodyEl) {
      bodyEl.innerHTML = `<div class="messaging-conversation-loading" role="status" aria-live="polite">
        <i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>
        <span>${this.escapeHtml(message)}</span>
      </div>`;
    }
    const sendBtn = document.getElementById('msgInlineReplySendBtn');
    const input = document.getElementById('msgInlineReplyInput');
    if (sendBtn) sendBtn.disabled = true;
    if (input) input.disabled = true;
  }

  hideMessagingConversationLoading() {
    const pane = document.getElementById('messagingDetailPane');
    if (pane) pane.classList.remove('is-loading-conversation');
  }

  initMessagingModule() {
    if (this._messagingInitialized) return;
    this._messagingInitialized = true;

    this.messagingFolder = 'inbox';
    this.messagingCategory = '';
    this.messagingSearchTerm = '';
    this.messagingMessages = [];
    this.messagingSelectedId = null;
    this._messagingOpenSeq = 0;

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
      searchInput.oninput = (e) => {
        this.messagingSearchTerm = (e.target.value || '').trim();
        this.loadMessagingFolder();
      };
    }

    // Refresh
    const refreshBtn = document.getElementById('messagingRefreshBtn');
    if (refreshBtn) {
      refreshBtn.onclick = () => this.loadMessagingFolder();
    }

    // Compose
    const composeBtn = document.getElementById('messagingComposeBtn');
    if (composeBtn) {
      composeBtn.onclick = () => this.openMessagingCompose();
    }
    const composeClose = document.getElementById('messagingComposeClose');
    if (composeClose) {
      composeClose.onclick = () => this.closeMessagingCompose();
    }
    const composeCancel = document.getElementById('messagingComposeCancel');
    if (composeCancel) {
      composeCancel.onclick = () => this.closeMessagingCompose();
    }
    const composeOverlay = document.getElementById('messagingComposeOverlay');
    if (composeOverlay) {
      composeOverlay.onclick = (e) => {
        if (e.target === composeOverlay) this.closeMessagingCompose();
      };
    }
    const composeForm = document.getElementById('messagingComposeForm');
    if (composeForm) {
      composeForm.onsubmit = (e) => {
        e.preventDefault();
        this.sendMessage();
      };
    }

    // Contact dropdown listeners
    const recipientInput = document.getElementById('msgComposeRecipientInput');
    if (recipientInput) {
      recipientInput.onfocus = () => this.showContactDropdown();
      recipientInput.oninput = (e) => this.filterContactDropdown(e.target.value);
    }
    
    document.addEventListener('click', (e) => {
      const dropdown = document.getElementById('messagingContactDropdown');
      const input = document.getElementById('msgComposeRecipientInput');
      if (dropdown && input && !dropdown.contains(e.target) && e.target !== input) {
        this.hideContactDropdown();
      }
    });

    const dropdownList = document.getElementById('messagingContactDropdownList');
    if (dropdownList) {
      dropdownList.onclick = (e) => {
        const item = e.target.closest('.messaging-contact-dropdown__item');
        if (item) {
          const phone = item.getAttribute('data-phone');
          const name = item.getAttribute('data-name');
          this.selectContact(name, phone);
        }
      };
    }

    // Message list clicks
    const listEl = document.getElementById('messagingList');
    if (listEl) {
      listEl.onclick = (e) => {
        const contactBtn = e.target.closest('.messaging-contact-message-btn');
        if (contactBtn) {
          e.stopPropagation();
          const phone = contactBtn.getAttribute('data-phone');
          if (phone) this.openMessagingCompose(phone);
          return;
        }

        const item = e.target.closest('.messaging-item');
        if (item) {
          if (this.messagingFolder === 'contacts') return;
          this.selectMessagingConversation(item);
        }
      };
    }

    // Detail actions
    const archiveBtn = document.getElementById('messagingDetailArchiveBtn');
    if (archiveBtn) {
      archiveBtn.onclick = () => {
        if (this.messagingSelectedId) {
          this.toggleMessagingArchive(this.messagingSelectedId);
          const menu = document.getElementById('messagingActionsMenu');
          if (menu) menu.classList.remove('is-visible');
        }
      };
    }
    const deleteBtn = document.getElementById('messagingDetailDeleteBtn');
    if (deleteBtn) {
      deleteBtn.onclick = () => {
        if (this.messagingSelectedId) {
          this.deleteMessagingMessage(this.messagingSelectedId);
          const menu = document.getElementById('messagingActionsMenu');
          if (menu) menu.classList.remove('is-visible');
        }
      };
    }

    // Dropdown toggle logic
    const toggleBtn = document.getElementById('messagingActionsToggle');
    const actionsMenu = document.getElementById('messagingActionsMenu');
    if (toggleBtn && actionsMenu) {
      toggleBtn.onclick = (e) => {
        e.stopPropagation();
        actionsMenu.classList.toggle('is-visible');
      };
      document.addEventListener('click', (e) => {
        if (!toggleBtn.contains(e.target) && !actionsMenu.contains(e.target)) {
          actionsMenu.classList.remove('is-visible');
        }
      });
    }

    // Inline Reply functionality
    const bindReplyEvents = () => {
      const inlineReplySendBtn = document.getElementById('msgInlineReplySendBtn');
      if (inlineReplySendBtn) {
        inlineReplySendBtn.onclick = () => {
          this.sendInlineReply();
        };
      }
      const inlineReplyInput = document.getElementById('msgInlineReplyInput');
      if (inlineReplyInput) {
        // Send on Enter (new line with Shift+Enter)
        inlineReplyInput.onkeydown = (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.sendInlineReply();
          }
        };
        // Auto-resize textarea and typing indicators
        inlineReplyInput.oninput = () => {
          this.autoResizeTextarea(inlineReplyInput);
        };
      }
    };
    
    bindReplyEvents();

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

    const refreshBtn = document.getElementById('messagingRefreshBtn');
    this.setBtnLoading(refreshBtn, true);

    listEl.innerHTML = '<li class="messaging-loading"><i class="fa-solid fa-spinner fa-spin"></i><span>Loading chats…</span></li>';

    try {
      // Unified Messenger view: Fetch all messages for the current admin
      let url = `/api/messages?folder=${encodeURIComponent(this.messagingFolder || 'inbox')}&limit=500`;
      if (this.messagingSearchTerm) url += `&search=${encodeURIComponent(this.messagingSearchTerm)}`;

      const res = await this.messagingApi(url);
      const data = await beanthenticParseJsonResponse(res);
      if (!res.ok) throw new Error(this.messagingErrorMessage(data, res.status));
      console.log('Fetched messages:', data);
      
      // Handle both {items: []} and [] formats
      const allMessages = Array.isArray(data) ? data : (data.items || []);

      // Normalize read flag (MySQL may return 0/1)
      allMessages.forEach((m) => {
        m.is_read = m.is_read === true || m.is_read === 1 || m.is_read === '1';
      });

      // Update local storage of messages
      this.messagingMessages = allMessages;

      // Group by farmer phone (same roles as mobile chat_thread.php)
      const conversations = new Map();

      allMessages.forEach((m) => {
        if (this.isAnnouncementMessage(m)) return;

        const role = String((m.sender_role || m.sender_type) || '').toLowerCase();
        let farmerPhoneRaw = '';
        let farmerName = '';
        if (role === 'farmer') {
          farmerPhoneRaw = m.sender_phone;
          farmerName = m.sender_name;
        } else if (role === 'admin') {
          farmerPhoneRaw = m.recipient_phone;
          farmerName = m.recipient_name;
        } else {
          return;
        }

        const key = this.messagingPhoneTail(farmerPhoneRaw);
        if (!key || key === 'system') return;

        if (!conversations.has(key)) {
          conversations.set(key, {
            phone: farmerPhoneRaw,
            name: this.resolveFarmerName(farmerPhoneRaw, farmerName),
            latest_message: m,
            unread_count: 0,
          });
        }
      });

      this.refreshConversationsLatest(conversations, allMessages);

      this.messagingConversations = Array.from(conversations.values())
        .filter((c) => {
          const p = this.messagingPhoneTail(c.phone);
          return p && p !== 'system' && !this.isAnnouncementMessage(c.latest_message);
        })
        .sort((a, b) => 
          new Date(b.latest_message.created_at) - new Date(a.latest_message.created_at)
        );

      // Ensure detail view is hidden if no conversation is selected
      if (!this.messagingSelectedId && !this.messagingSelectedPhone) {
        const detail = document.getElementById('messagingDetail');
        const placeholder = document.getElementById('messagingNoChatSelected');
        if (detail) detail.style.display = 'none';
        if (placeholder) placeholder.style.display = 'flex';
      }

      this.updateMessagingBadge();
      this.renderMessagingList();
    } catch (err) {
      console.warn('Failed to load chats:', err);
      const hint = String(err.message || 'Could not load chats.');
      listEl.innerHTML = `<li class="messaging-list-empty"><i class="fa-solid fa-circle-exclamation"></i><p>${this.escapeHtml(hint)}</p><p style="margin-top:0.5rem;font-size:0.85rem;"><a href="${beanthenticApiUrl('/connection-settings')}">Connection Settings</a></p></li>`;
    } finally {
      this.setBtnLoading(refreshBtn, false);
    }
  }

  renderMessagingList() {
    const listEl = document.getElementById('messagingList');
    if (!listEl) return;

    if (!this.messagingConversations || !this.messagingConversations.length) {
      listEl.innerHTML = window.BeanthenticUI
        ? `<li>${window.BeanthenticUI.emptyState({
            icon: 'fa-comment-slash',
            title: 'No conversations yet',
            hint: 'Start a new chat by searching for a farmer.',
          })}</li>`
        : `<li class="messaging-list-empty">
        <i class="fa-solid fa-comment-slash"></i>
        <p>No conversations yet. Start a new chat by searching for a farmer!</p>
      </li>`;
      return;
    }

    const esc = (s) => this.escapeHtml(s);
    
    const selectedTail = this.messagingPhoneTail(this.messagingSelectedPhone || '');

    listEl.innerHTML = this.messagingConversations.map(c => {
      const m = c.latest_message;
      const isUnread = c.unread_count > 0;
      const unreadClass = isUnread ? ' is-unread' : '';

      const currentConvPhone = this.messagingPhoneTail(c.phone);
      const activeClass =
        selectedTail && currentConvPhone === selectedTail ? ' is-active' : '';
      
      const displayName = c.name;
      const timeStr = this.formatChatListTime(m.created_at);
      
      const prefix = this.isAdminMessage(m) ? 'You: ' : '';
      const preview = prefix + (m.body || '').substring(0, 60);

      const latestId = this.parseMessagingMessageId(m.id ?? m.message_id);
      const idAttr = latestId ? ` data-msg-id="${latestId}"` : '';
      return `<li class="messaging-item${unreadClass}${activeClass}" data-phone="${esc(c.phone)}"${idAttr}>
        ${this.buildMessagingAvatarHtml({ phone: c.phone, name: displayName, className: 'messaging-item__avatar' })}
        <div class="messaging-item__content">
          <div class="messaging-item__top">
            <span class="messaging-item__sender">${esc(displayName)}</span>
            <span class="messaging-item__time">${esc(timeStr)}</span>
          </div>
          <div class="messaging-item__preview">${esc(preview)}</div>
        </div>
      </li>`;
    }).join('');

    this.hydrateMessagingAvatars(listEl);
  }

  /** Positive numeric message id only — ignore local-* / NaN placeholders from optimistic sends. */
  parseMessagingMessageId(raw) {
    if (raw == null || raw === '') return null;
    const s = String(raw).trim();
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /** Open a chat from the sidebar list (by phone + optional message id). */
  selectMessagingConversation(item) {
    if (!item) return;
    const phone = item.getAttribute('data-phone') || '';
    let msgId = this.parseMessagingMessageId(item.getAttribute('data-msg-id'));

    this.messagingSelectedPhone = phone;

    document.querySelectorAll('.messaging-item').forEach((el) => {
      el.classList.toggle('is-active', el === item);
    });

    const conv = (this.messagingConversations || []).find(
      (c) => this.messagingPhoneTail(c.phone) === this.messagingPhoneTail(phone)
    );
    if (!msgId && conv?.latest_message) {
      msgId = this.parseMessagingMessageId(conv.latest_message.id ?? conv.latest_message.message_id);
    }
    const contact = conv
      ? { phone: conv.phone || phone, name: conv.name }
      : phone
        ? { phone, name: this.resolveFarmerName(phone, '') }
        : null;

    // Always pass contact with phone so thread reload does not depend on a valid message id.
    void this.openMessagingDetail(msgId, contact);
  }

  renderMessagingContacts() {
    const listEl = document.getElementById('messagingList');
    if (!listEl) return;

    if (!this.data || !this.data.length) {
      listEl.innerHTML = `<li class="messaging-list-empty">
        <i class="fa-solid fa-users-slash"></i>
        <p>No contacts found in the system.</p>
      </li>`;
      return;
    }

    const sortedFarmers = [...this.data].sort((a, b) => {
      const nameA = this.getFarmerFullName(a).toLowerCase();
      const nameB = this.getFarmerFullName(b).toLowerCase();
      return nameA.localeCompare(nameB);
    });

    const esc = (s) => this.escapeHtml(s);
    listEl.innerHTML = sortedFarmers.map(f => {
      const fullName = this.getFarmerFullName(f);
      const phone = this.getValue(f, ['PHONE', 'phone', 'PHONE NO.', 'Phone No.']);
      const barangay = this.getValue(f, ['ADDRESS (BARANGAY)', 'barangay', 'BARANGAY', 'address']) || 'Address not set';
      const farmerId = this.farmerIdFromRow(f);
      
      return `<li class="messaging-item messaging-contact-item" data-phone="${esc(phone)}">
        ${this.buildMessagingAvatarHtml({
          phone,
          name: fullName,
          className: 'messaging-item__avatar messaging-category-dot--farmer',
          farmerId,
        })}
        <div class="messaging-item__content">
          <div class="messaging-item__top">
            <span class="messaging-item__sender">${esc(fullName)}</span>
            <span class="messaging-item__time">${esc(phone)}</span>
          </div>
          <div class="messaging-item__subject">${esc(barangay)}</div>
          <div class="messaging-item__preview">Farmer record from ${esc(barangay)}</div>
          <div class="messaging-item__meta">
            <button type="button" class="btn btn-sm btn-primary messaging-contact-message-btn" data-phone="${esc(phone)}">
              <i class="fa-solid fa-paper-plane"></i> Message
            </button>
          </div>
        </div>
      </li>`;
    }).join('');

    this.hydrateMessagingAvatars(listEl);
  }

  messagingNormalizePhone(p) {
    if (!p) return '';
    let d = String(p).replace(/\D/g, '');
    if (d.startsWith('0')) d = d.substring(1);
    if (d.startsWith('63')) d = d.substring(2);
    return d;
  }

  messagingPhoneTail(p) {
    const d = this.messagingNormalizePhone(p);
    return d.length >= 10 ? d.slice(-10) : d;
  }

  /** Admin UI: admin = sent (right), farmer = received (left) — same rule as the farmer app. */
  isAdminMessage(m) {
    if (!m) return false;
    const role = String((m.sender_role || m.sender_type) || '').toLowerCase();
    if (role === 'admin') return true;
    if (role === 'farmer') return false;
    const myPhone = this.messagingPhoneTail(
      (window.__BEANTHENTIC_USER__ && window.__BEANTHENTIC_USER__.phone) || ''
    );
    if (!myPhone) return false;
    return this.messagingPhoneTail(m.sender_phone) === myPhone;
  }

  /** Match shared_messages thread scope (chat_thread.php). */
  messageBelongsToFarmerPhone(m, farmerPhoneRaw) {
    if (!m || this.isAnnouncementMessage(m)) return false;
    const tail = this.messagingPhoneTail(farmerPhoneRaw);
    if (!tail) return false;
    const role = String((m.sender_role || m.sender_type) || '').toLowerCase();
    if (role === 'farmer' && this.messagingPhoneTail(m.sender_phone) === tail) return true;
    if (String(m.recipient_role || '').toLowerCase() === 'farmer' && this.messagingPhoneTail(m.recipient_phone) === tail) {
      return true;
    }
    return false;
  }

  isMessageUnread(m) {
    if (!m || this.isAdminMessage(m)) return false;
    const read = m.is_read === true || m.is_read === 1 || m.is_read === '1';
    return !read;
  }

  refreshConversationsLatest(conversations, allMessages) {
    for (const conv of conversations.values()) {
      let latest = null;
      let unread = 0;
      for (const m of allMessages) {
        if (!this.messageBelongsToFarmerPhone(m, conv.phone)) continue;
        if (!latest || new Date(m.created_at) > new Date(latest.created_at)) latest = m;
        if (this.isMessageUnread(m)) unread += 1;
      }
      if (latest) conv.latest_message = latest;
      conv.unread_count = unread;
    }
  }

  async markConversationRead(farmerPhoneRaw) {
    if (!farmerPhoneRaw) return;
    const tail = this.messagingPhoneTail(farmerPhoneRaw);

    try {
      await this.messagingApi(
        `/api/messages/mark-thread-read?phone=${encodeURIComponent(String(farmerPhoneRaw))}`,
        { method: 'POST' }
      );
    } catch (_err) {
      /* thread GET may have already marked read */
    }

    (this.messagingMessages || []).forEach((m) => {
      if (this.messageBelongsToFarmerPhone(m, farmerPhoneRaw) && !this.isAdminMessage(m)) {
        m.is_read = true;
      }
    });

    if (this.messagingConversations) {
      for (const c of this.messagingConversations) {
        if (this.messagingPhoneTail(c.phone) === tail) {
          c.unread_count = 0;
          if (c.latest_message && !this.isAdminMessage(c.latest_message)) {
            c.latest_message.is_read = true;
          }
        }
      }
    }

    document.querySelectorAll('.messaging-item').forEach((el) => {
      const p = el.getAttribute('data-phone');
      if (p && this.messagingPhoneTail(p) === tail) {
        el.classList.remove('is-unread');
      }
    });

    await this.updateMessagingBadge();
  }

  isAnnouncementMessage(m) {
    if (!m) return true;
    const cat = String(m.category || '').toLowerCase();
    if (cat === 'announcement') return true;
    const s = String(m.sender_phone || '').trim().toLowerCase();
    const r = String(m.recipient_phone || '').trim().toLowerCase();
    if (s === 'system' || r === 'system') return true;
    if (!s && !r) return true;
    return false;
  }

  buildConversationThreadForPhone(farmerPhoneRaw) {
    if (!farmerPhoneRaw || this.messagingPhoneTail(farmerPhoneRaw) === 'system') return [];

    const rows = (this.messagingMessages || []).filter((m) =>
      this.messageBelongsToFarmerPhone(m, farmerPhoneRaw)
    );

    return this.mapMessagesToThread(rows);
  }

  mapMessagesToThread(rows) {
    return (rows || [])
      .map((m) => {
        const role = String((m.sender_role || m.sender_type) || '').toLowerCase();
        return {
          id: m.id,
          body: m.body,
          sender_name: m.sender_name,
          sender_phone: m.sender_phone,
          sender_role: role,
          sender_type: role,
          recipient_role: String(m.recipient_role || '').toLowerCase(),
          recipient_phone: m.recipient_phone,
          recipient_name: m.recipient_name,
          created_at: m.created_at,
        };
      })
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }

  async fetchConversationThread(farmerPhoneRaw) {
    if (!farmerPhoneRaw) return [];
    try {
      const res = await this.messagingApi(
        `/api/messages/thread?phone=${encodeURIComponent(String(farmerPhoneRaw))}`
      );
      if (!res.ok) return [];
      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      return this.mapMessagesToThread(items);
    } catch (_err) {
      return [];
    }
  }

  renderConversation(message) {
    const esc = (s) => this.escapeHtml(s);

    let thread = [];
    if (message.conversation && Array.isArray(message.conversation) && message.conversation.length > 0) {
      thread = message.conversation;
    } else {
      const phoneForThread = this.messagingSelectedPhone || message.sender_phone || message.recipient_phone;
      const built = this.buildConversationThreadForPhone(phoneForThread);
      if (built.length > 0) {
        thread = built;
      } else if (message.body) {
        thread = [message];
      }
    }

    if (thread.length === 0) return '';

    return thread.map((msg) => {
      const isSentByMe = this.isAdminMessage(msg);
      const direction = isSentByMe ? 'sent' : 'received';
      const senderName = isSentByMe ? 'Administrator' : (msg.sender_name || 'Farmer');
      const timeStr = this.bubbleTimestamp(msg.created_at);
      const avatarHtml = isSentByMe
        ? this.buildMessagingAvatarHtml({
            name: 'Administrator',
            className: 'messaging-message__avatar',
            admin: true,
          })
        : this.buildMessagingAvatarHtml({
            phone: this.messagingSelectedPhone || msg.sender_phone,
            name: senderName,
            className: 'messaging-message__avatar',
          });

      return `
        <div class="messaging-message messaging-message--${direction}">
          ${avatarHtml}
          <div class="messaging-message__content">
            <div class="messaging-message__bubble">${esc(msg.body)}</div>
            <div class="messaging-message__timestamp" aria-label="Message time">${esc(timeStr)}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  scrollMessagingConversationToBottom(bodyEl) {
    const el = bodyEl || document.getElementById('messagingDetailBody');
    if (!el) return;
    const scrollToEnd = () => {
      el.scrollTop = el.scrollHeight;
    };
    scrollToEnd();
    requestAnimationFrame(() => {
      scrollToEnd();
      requestAnimationFrame(scrollToEnd);
    });
  }

  patchMessagingAfterSend(recipientPhone, replyData) {
    const tail = this.messagingPhoneTail(recipientPhone);
    if (!tail) return;

    const savedId = this.parseMessagingMessageId(replyData.id ?? replyData.message_id);
    const saved = {
      id: savedId || null,
      message_id: savedId || null,
      body: replyData.body,
      sender_name: replyData.sender_name || 'Administrator',
      sender_phone: replyData.sender_phone || '',
      sender_role: 'admin',
      sender_type: 'admin',
      recipient_phone: recipientPhone,
      recipient_name: replyData.recipient_name || '',
      recipient_role: 'farmer',
      created_at: replyData.created_at || new Date().toISOString(),
      is_read: true,
      category: 'farmers',
    };
    this.messagingMessages = this.messagingMessages || [];
    this.messagingMessages.push(saved);

    if (Array.isArray(this.messagingConversations)) {
      let conv = this.messagingConversations.find(
        (c) => this.messagingPhoneTail(c.phone) === tail
      );
      if (!conv) {
        conv = {
          phone: recipientPhone,
          name: replyData.recipient_name || this.resolveFarmerName(recipientPhone, ''),
          latest_message: saved,
          unread_count: 0,
        };
        this.messagingConversations.unshift(conv);
      } else {
        conv.latest_message = saved;
        conv.unread_count = 0;
      }
    }
    this.renderMessagingList();
    document.querySelectorAll('.messaging-item').forEach((el) => {
      const elTail = this.messagingPhoneTail(el.getAttribute('data-phone') || '');
      el.classList.toggle('is-active', elTail === tail);
    });
    void this.updateMessagingBadge();
  }

  async sendInlineReply() {
    // New conversations from search have messagingSelectedPhone but no message id yet
    if (!this.messagingSelectedId && !this.messagingSelectedPhone) return;

    const inlineReplyInput = document.getElementById('msgInlineReplyInput');
    const message = (inlineReplyInput?.value || '').trim();

    if (!message) {
      this.showNotification('Message is required.', 'error');
      return;
    }

    const sendBtn = document.getElementById('msgInlineReplySendBtn');
    if (sendBtn?.classList.contains('is-loading')) return;
    this.setBtnLoading(sendBtn, true);

    try {
      // Use the correctly identified farmer phone as the recipient
      const recipientPhone = this.messagingSelectedPhone;
      if (!recipientPhone) throw new Error('No recipient phone found. Select a conversation to reply.');

      const normalize = (p) => String(p || '').replace(/\D/g, '').replace(/^(0|63)/, '');
      const target = normalize(recipientPhone);

      // Get any existing message in this conversation to extract farmer_id if possible
      const originalMessage = this.messagingMessages.find(m => {
        return normalize(m.sender_phone) === target || normalize(m.recipient_phone) === target;
      });

      const subject = originalMessage
        ? ((originalMessage.subject && originalMessage.subject.toLowerCase().startsWith('re:'))
          ? originalMessage.subject
          : `Re: ${originalMessage.subject || 'Message'}`)
        : 'Message';

      // Get recipient name from header if originalMessage is missing (for new conversations)
      const headerName = document.getElementById('messagingDetailSenderName')?.textContent || '';

      const res = await this.messagingApi('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          subject,
          body: message,
          category: 'farmers',
          recipient_phone: recipientPhone,
          recipient_name: (originalMessage && (normalize(originalMessage.sender_phone) === target ? originalMessage.sender_name : originalMessage.recipient_name)) || headerName,
          farmer_id: (originalMessage && originalMessage.farmer_id) ?? this.lookupFarmerIdByPhone(recipientPhone),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      // Update UI immediately (append to conversation)
      const saved = data.message || {};
      const replyData = {
        body: saved.body || message,
        sender_name: saved.sender_name || 'Administrator',
        sender_phone: (window.__BEANTHENTIC_USER__ && window.__BEANTHENTIC_USER__.phone) || '',
        sender_role: 'admin',
        sender_type: 'admin',
        created_at: saved.created_at || new Date().toISOString(),
      };

      let currentMsg = originalMessage;
      if (!currentMsg) {
        // Create a new local message object if it doesn't exist
        currentMsg = {
          id: saved.id || Date.now(),
          sender_phone: recipientPhone,
          sender_name: saved.recipient_name || headerName,
          body: saved.body || message,
          created_at: saved.created_at || new Date().toISOString(),
          conversation: []
        };
        this.messagingMessages.push(currentMsg);
        this.messagingSelectedId = saved.id || currentMsg.id;
      }

      if (!currentMsg.conversation) {
        currentMsg.conversation = [];
      }
      
      // Don't push if it's the very first message we just put in the thread above
      if (currentMsg.conversation.length === 0 || currentMsg.conversation[currentMsg.conversation.length-1].body !== replyData.body) {
        currentMsg.conversation.push(replyData);
      }

      // Update the conversation view
      const bodyEl = document.getElementById('messagingDetailBody');
      if (bodyEl) {
        bodyEl.innerHTML = this.renderConversation(currentMsg);
        this.scrollMessagingConversationToBottom(bodyEl);
      }

      if (inlineReplyInput) {
        inlineReplyInput.value = '';
        inlineReplyInput.style.height = 'auto';
      }

      this.setBtnLoading(sendBtn, false);
      this.showNotification('Message sent!', 'success');
      this.patchMessagingAfterSend(recipientPhone, {
        ...replyData,
        id: saved.id ?? saved.message_id,
        message_id: saved.message_id ?? saved.id,
        recipient_name:
          (originalMessage &&
            (normalize(originalMessage.sender_phone) === target
              ? originalMessage.sender_name
              : originalMessage.recipient_name)) ||
          headerName,
      });
    } catch (err) {
      console.warn('Send reply failed:', err);
      this.showNotification(err.message || 'Could not send reply.', 'error');
    } finally {
      this.setBtnLoading(sendBtn, false);
    }
  }

  autoResizeTextarea(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  }

  getSampleFarmerMessages() {
    const now = new Date();
    return [
      {
        id: 1001,
        subject: "Question about coffee bean pricing",
        body: "Good day! I would like to inquire about the current pricing for our coffee beans.",
        sender_name: "Juan Santos",
        sender_phone: "9123456789",
        category: "farmers",
        sender_type: "farmer",
        is_read: false,
        is_starred: false,
        created_at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
        conversation: [
          {
            body: "Good day! I would like to inquire about the current pricing for our coffee beans. I noticed that the market price has been fluctuating lately and I want to make sure we're getting the right rates for our premium Arabica beans.",
            sender_name: "Juan Santos",
            sender_type: "farmer",
            created_at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString()
          },
          {
            body: "Hello Juan! Thank you for reaching out. The current price for premium Arabica beans is ₱120 per kilogram. We've recently updated our pricing structure to better reflect market conditions. Would you like me to send you the complete price list?",
            sender_name: "Admin User",
            sender_type: "admin",
            created_at: new Date(now.getTime() - 1.5 * 60 * 60 * 1000).toISOString()
          },
          {
            body: "That sounds reasonable. Yes, please send me the complete price list. Also, are there any bonuses for quality this season?",
            sender_name: "Juan Santos",
            sender_type: "farmer",
            created_at: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString()
          }
        ]
      },
      {
        id: 1002,
        subject: "Request for farm visit next week",
        body: "Hi admin team, I would like to request a farm visit next Tuesday morning.",
        sender_name: "Maria Reyes",
        sender_phone: "9234567890",
        category: "farmers",
        sender_type: "farmer",
        is_read: false,
        is_starred: false,
        created_at: new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString(), // 5 hours ago
        conversation: [
          {
            body: "Hi admin team, I would like to request a farm visit next Tuesday morning. I need guidance on the new organic certification requirements and would appreciate it if someone could come by to inspect our current setup. Our farm is located in Batangas and we have about 2 hectares of coffee plants.",
            sender_name: "Maria Reyes",
            sender_type: "farmer",
            created_at: new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString()
          }
        ]
      },
      {
        id: 1003,
        subject: "Issue with recent delivery",
        body: "I received the delivery from last week but there seems to be an issue with the packaging.",
        sender_name: "Carlos Mendoza",
        sender_phone: "9345678901",
        category: "farmers",
        sender_type: "farmer",
        is_read: true,
        is_starred: true,
        created_at: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), // 1 day ago
        conversation: [
          {
            body: "I received the delivery from last week but there seems to be an issue with the packaging. Some of the bags were torn and the quality was affected.",
            sender_name: "Carlos Mendoza",
            sender_type: "farmer",
            created_at: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
          },
          {
            body: "Hi Carlos, I'm sorry to hear about the packaging issue. We take quality seriously. Can you please send photos of the damaged goods? We'll arrange for a replacement immediately.",
            sender_name: "Admin User",
            sender_type: "admin",
            created_at: new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString()
          },
          {
            body: "I've already sent the photos via email. Thank you for the quick response. When can we expect the replacement?",
            sender_name: "Carlos Mendoza",
            sender_type: "farmer",
            created_at: new Date(now.getTime() - 22 * 60 * 60 * 1000).toISOString()
          },
          {
            body: "We've received your photos and processed the replacement. You should receive it within 2-3 business days. We've also added a 10% credit for the inconvenience.",
            sender_name: "Admin User",
            sender_type: "admin",
            created_at: new Date(now.getTime() - 20 * 60 * 60 * 1000).toISOString()
          }
        ]
      },
      {
        id: 1004,
        subject: "Thank you for the training session",
        body: "I just wanted to express my gratitude for the excellent training session last week.",
        sender_name: "Elena Cruz",
        sender_phone: "9456789012",
        category: "farmers",
        sender_type: "farmer",
        is_read: true,
        is_starred: false,
        created_at: new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString(), // 2 days ago
        conversation: [
          {
            body: "I just wanted to express my gratitude for the excellent training session last week. The new harvesting techniques you taught us have already improved our yield quality.",
            sender_name: "Elena Cruz",
            sender_type: "farmer",
            created_at: new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString()
          },
          {
            body: "Thank you for the feedback, Elena! We're thrilled to hear the techniques are working well. Keep up the great work!",
            sender_name: "Admin User",
            sender_type: "admin",
            created_at: new Date(now.getTime() - 47 * 60 * 60 * 1000).toISOString()
          }
        ]
      },
      {
        id: 1005,
        subject: "Test Chat - Simple Conversation",
        body: "Hello! This is a test message to verify chat functionality.",
        sender_name: "Test Farmer",
        sender_phone: "9999999999",
        category: "farmers",
        sender_type: "farmer",
        is_read: false,
        is_starred: false,
        created_at: new Date(now.getTime() - 10 * 60 * 1000).toISOString(), // 10 minutes ago
        conversation: [
          {
            body: "Hello! This is a test message to verify chat functionality.",
            sender_name: "Test Farmer",
            sender_type: "farmer",
            created_at: new Date(now.getTime() - 10 * 60 * 1000).toISOString()
          },
          {
            body: "Hi Test Farmer! This is a reply from admin. The chat system is working perfectly!",
            sender_name: "Admin User",
            sender_type: "admin",
            created_at: new Date(now.getTime() - 8 * 60 * 1000).toISOString()
          },
          {
            body: "Great! I can see the chat bubbles and they look amazing. The green and white theme is perfect!",
            sender_name: "Test Farmer",
            sender_type: "farmer",
            created_at: new Date(now.getTime() - 5 * 60 * 1000).toISOString()
          }
        ]
      },
      {
        id: 2001,
        subject: "System Maintenance Notice",
        body: "The system will be undergoing maintenance this weekend from 2AM to 6AM. Please save your work and log out before the maintenance window.",
        sender_name: "System Admin",
        sender_phone: "",
        category: "announcement",
        sender_type: "admin",
        is_read: false,
        is_starred: false,
        created_at: new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString(), // 3 hours ago
      },
      {
        id: 2002,
        subject: "Monthly Report Available",
        body: "The monthly coffee production report is now available for download. Please check the reports section for detailed analytics.",
        sender_name: "Admin Team",
        sender_phone: "",
        category: "general",
        sender_type: "admin",
        is_read: true,
        is_starred: false,
        created_at: new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString(), // 6 hours ago
      },
      {
        id: 2003,
        subject: "Farmer Training Reminder",
        body: "Reminder: Advanced coffee farming techniques training is scheduled for next Monday at 10AM. All registered farmers should attend.",
        sender_name: "Training Coordinator",
        sender_phone: "",
        category: "farmer-update",
        sender_type: "admin",
        is_read: true,
        is_starred: true,
        created_at: new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString(), // 12 hours ago
      }
    ];
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
      'farmers': 'messaging-item__avatar--farmer-message',
      'reminder': 'messaging-item__avatar--reminder',
    };
    return map[category] || '';
  }

  getCategoryTag(category) {
    const labels = {
      'general': 'General',
      'farmer-update': 'Farmer Update',
      'farmers': 'Farmer',
      'announcement': 'Announcement',
      'reminder': 'Reminder',
    };
    const label = labels[category] || '';
    if (!label) return '';
    const cssClass = `messaging-item__category-tag--${category}`;
    return `<span class="messaging-item__category-tag ${cssClass}">${this.escapeHtml(label)}</span>`;
  }

  /** Same datetime helpers as Beanthentic app (js/beanthentic_datetime.js). */
  parseMessageDate(isoStr) {
    const DT = window.BeanthenticDateTime;
    if (DT && typeof DT.parseAppDateTime === 'function') {
      return DT.parseAppDateTime(isoStr);
    }
    return null;
  }

  deviceSqlDateTime() {
    const DT = window.BeanthenticDateTime;
    if (DT && typeof DT.deviceSqlDateTime === 'function') {
      return DT.deviceSqlDateTime();
    }
    return '';
  }

  formatMessageTime(isoStr) {
    const DT = window.BeanthenticDateTime;
    if (DT && typeof DT.formatHomeDateTime === 'function') {
      const fmt = DT.formatHomeDateTime(isoStr);
      if (fmt) return fmt;
    }
    const raw = String(isoStr || '').trim().replace(/\s+GMT\s*$/i, '').replace(/\s+UTC\s*$/i, '');
    const m = raw.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (!m) return '';
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    const h = +m[4];
    const mi = +m[5];
    const cal = new Date(y, mo - 1, d);
    const dow = cal.toLocaleDateString('en-US', { weekday: 'short' });
    const month = cal.toLocaleDateString('en-US', { month: 'short' });
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    const pad = (n) => String(n).padStart(2, '0');
    return `${dow} - ${month} ${d}, ${y} · ${h12}:${pad(mi)} ${ampm}`;
  }

  formatChatListTime(isoStr) {
    const DT = window.BeanthenticDateTime;
    if (DT && typeof DT.formatChatListTime === 'function') {
      const fmt = DT.formatChatListTime(isoStr);
      if (fmt) return fmt;
    }
    return this.formatMessageTime(isoStr);
  }

  sameMessageMinute(a, b) {
    const DT = window.BeanthenticDateTime;
    if (DT && typeof DT.sameWallClockMinute === 'function') {
      return DT.sameWallClockMinute(a, b);
    }
    return false;
  }

  /** Short timestamp under chat bubble (Messenger-style). */
  bubbleTimestamp(createdAt) {
    const DT = window.BeanthenticDateTime;
    if (DT && typeof DT.formatChatBubbleTime === 'function') {
      const t = DT.formatChatBubbleTime(createdAt);
      if (t) return t;
    }
    return this.formatMessageTime(createdAt);
  }

  formatMessageDateTime(isoStr) {
    return this.bubbleTimestamp(isoStr);
  }

  async openMessagingDetail(id, newContact = null) {
    const openSeq = ++this._messagingOpenSeq;
    this._messagingDetailBusy = true;

    this.closeMessagingCompose(); // Close compose if open
    this.messagingSelectedId = id;
    if (newContact?.phone) {
      this.messagingSelectedPhone = newContact.phone;
    }

    const main = document.getElementById('messagingMain');
    const detail = document.getElementById('messagingDetail');
    const placeholder = document.getElementById('messagingNoChatSelected');

    if (main) main.classList.add('has-detail');
    if (placeholder) placeholder.style.display = 'none';
    if (detail) {
      detail.style.display = 'flex';
      detail.classList.add('is-visible');
    }

    const displayNameHint =
      newContact?.name ||
      document.getElementById('messagingDetailSenderName')?.textContent ||
      '';
    this.showMessagingConversationLoading(
      displayNameHint
        ? `Loading chat with ${displayNameHint}…`
        : 'Loading conversation…'
    );

    const selectedTail = this.messagingPhoneTail(
      this.messagingSelectedPhone || newContact?.phone || ''
    );
    document.querySelectorAll('.messaging-item').forEach((el) => {
      const elTail = this.messagingPhoneTail(el.getAttribute('data-phone') || '');
      el.classList.toggle('is-active', !!selectedTail && elTail === selectedTail);
    });

    // Find the message to get the phone number
    let msg = id ? this.messagingMessages.find(m => String(m.id) === String(id)) : null;

    try {
      if (openSeq !== this._messagingOpenSeq) return;
      // If we have a new contact but no ID yet, create a dummy message object for rendering
      if (!id && newContact) {
        msg = {
          sender_phone: newContact.phone,
          sender_name: newContact.name,
          body: '',
          created_at: new Date().toISOString(),
          conversation: []
        };
      }

      if (openSeq !== this._messagingOpenSeq) return;

      // If not found in local data and we have an ID, try API
      if (!msg && id) {
        const res = await this.messagingApi(`/api/messages/${id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        msg = data.message;
        if (!msg) throw new Error('No message data');
      }

      if (!msg && (this.messagingSelectedPhone || newContact?.phone)) {
        const phone = this.messagingSelectedPhone || newContact.phone;
        const name = newContact?.name || this.resolveFarmerName(phone, '');
        msg = {
          sender_phone: phone,
          sender_name: name,
          recipient_phone: phone,
          recipient_name: name,
          body: '',
          created_at: new Date().toISOString(),
          conversation: [],
        };
      }

      if (!msg) throw new Error('Message not found');

      if (openSeq !== this._messagingOpenSeq) return;

      // Now that we have the message, set the selected phone correctly
      if (newContact) {
        this.messagingSelectedPhone = newContact.phone;
      } else {
        const isSentByMe = this.isAdminMessage(msg);
        this.messagingSelectedPhone = isSentByMe ? msg.recipient_phone : msg.sender_phone;
      }

      // Populate detail pane
      const avatarEl = document.getElementById('messagingDetailAvatar');
      const nameEl = document.getElementById('messagingDetailSenderName');
      const phoneEl = document.getElementById('messagingDetailSenderPhone');
      const tsEl = document.getElementById('messagingDetailTimestamp');
      const bodyEl = document.getElementById('messagingDetailBody');

      // Determine who to show in the header (the farmer)
      const isSentByMe = this.isAdminMessage(msg);

      const displayPhone = newContact ? newContact.phone : (
        isSentByMe ? msg.recipient_phone : msg.sender_phone
      );
      const rawName = newContact ? newContact.name : (
        isSentByMe 
        ? (msg.recipient_name || msg.recipient_phone || 'Unknown Farmer')
        : (msg.sender_name || msg.sender_phone || 'Unknown Farmer')
      );
      
      const displayName = this.resolveFarmerName(displayPhone, rawName);

      if (avatarEl) {
        avatarEl.className = 'messaging-detail__sender-avatar messaging-detail__sender-avatar--farmer';
        const fid = this.farmerIdFromPhone(displayPhone);
        avatarEl.innerHTML =
          '<img class="messaging-avatar__img" alt="" hidden /><span class="messaging-avatar__fallback"></span>';
        avatarEl.querySelector('.messaging-avatar__fallback').textContent = this.getInitials(displayName);
        if (fid) avatarEl.setAttribute('data-farmer-id', String(fid));
        else avatarEl.removeAttribute('data-farmer-id');
        const farmer = this.findFarmerByPhone(displayPhone);
        const photoUrl = farmer ? this.farmerProfilePhotoUrl(farmer) : '';
        if (photoUrl && /^https?:\/\//i.test(photoUrl)) {
          avatarEl.setAttribute('data-photo-url', photoUrl);
        } else {
          avatarEl.removeAttribute('data-photo-url');
        }
        this.hydrateMessagingAvatars(avatarEl);
      }
      if (nameEl) nameEl.textContent = displayName;
      if (phoneEl) {
        let p = displayPhone || '';
        if (p && !p.startsWith('+') && p !== 'system') p = `+63${p}`;
        phoneEl.textContent = p;
      }
      if (tsEl) {
        if (newContact && !id) {
          tsEl.textContent = 'New Conversation';
        } else {
          try {
            const d = new Date(msg.created_at);
            tsEl.textContent = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
          } catch {
            tsEl.textContent = msg.created_at || '';
          }
        }
      }
      
      if (bodyEl) {
        const phoneForThread =
          this.messagingSelectedPhone || newContact?.phone || msg.recipient_phone || msg.sender_phone || '';
        let thread = [];
        if (phoneForThread) {
          thread = await this.fetchConversationThread(phoneForThread);
          if (openSeq !== this._messagingOpenSeq) return;
          if (!thread.length) {
            thread = this.buildConversationThreadForPhone(phoneForThread);
          }
        }
        if (!thread.length && msg.body) {
          thread = this.mapMessagesToThread([msg]);
        }
        if (!thread.length) {
          bodyEl.innerHTML = window.BeanthenticUI
            ? window.BeanthenticUI.emptyState({
                icon: 'fa-comments',
                title: 'No messages yet',
                hint: 'Send a message to start the conversation.',
              })
            : '<div class="messaging-list-empty"><p>No messages yet. Send a message to start the conversation!</p></div>';
          msg.conversation = [];
        } else {
          thread.forEach((t) => {
            if (!this.isAdminMessage(t)) t.is_read = true;
          });
          msg.conversation = thread;
          if (!this.parseMessagingMessageId(id) && thread[thread.length - 1]) {
            this.messagingSelectedId = this.parseMessagingMessageId(
              thread[thread.length - 1].id ?? thread[thread.length - 1].message_id
            );
          }
          bodyEl.innerHTML = this.renderConversation(msg);
          this.hydrateMessagingAvatars(bodyEl);
          this.scrollMessagingConversationToBottom(bodyEl);
        }
      }

      if (openSeq !== this._messagingOpenSeq) return;

      // Inline reply is always visible; enable only when we have a recipient
      const inlineReplySection = document.getElementById('messagingConversationReply');
      if (inlineReplySection) {
        const replyable = !!this.messagingSelectedPhone;

        inlineReplySection.classList.add('messaging-conversation__reply--visible');

        const inlineReplyInput = document.getElementById('msgInlineReplyInput');
        const inlineReplySendBtn = document.getElementById('msgInlineReplySendBtn');

        if (inlineReplyInput) {
          inlineReplyInput.disabled = !replyable;
          inlineReplyInput.placeholder = replyable
            ? 'Type your message here...'
            : 'Select a conversation to reply...';
          if (replyable) inlineReplyInput.focus();
        }
        if (inlineReplySendBtn) {
          inlineReplySendBtn.disabled = !replyable;
          inlineReplySendBtn.title = replyable ? 'Send message' : 'Select a conversation to reply';
        }
      }

      if (this.messagingSelectedPhone) {
        await this.markConversationRead(this.messagingSelectedPhone);
        if (openSeq !== this._messagingOpenSeq) return;
        this.renderMessagingList();
        document.querySelectorAll('.messaging-item').forEach((el) => {
          const elTail = this.messagingPhoneTail(el.getAttribute('data-phone') || '');
          el.classList.toggle(
            'is-active',
            elTail === this.messagingPhoneTail(this.messagingSelectedPhone)
          );
        });
      }
    } catch (err) {
      if (openSeq !== this._messagingOpenSeq) return;
      console.warn('Failed to load message detail:', err);
      const bodyEl = document.getElementById('messagingDetailBody');
      if (bodyEl) bodyEl.innerHTML = '<div class="messaging-list-empty"><i class="fa-solid fa-circle-exclamation"></i><p>Could not load this message.</p></div>';
    } finally {
      if (openSeq === this._messagingOpenSeq) {
        this._messagingDetailBusy = false;
        this.startMessagingConversationPoll();
      }
      if (typeof this.hideMessagingConversationLoading === 'function') {
        this.hideMessagingConversationLoading();
      }
    }
  }

  /**
   * Navigate to messaging module and open a specific farmer's conversation
   */
  async openLatestUnreadMessageThread() {
    try {
      await this.loadMessagingFolder();
    } catch (err) {
      console.warn('Could not load messaging folder for unread deep-link:', err);
      return false;
    }
    const conversations = Array.isArray(this.messagingConversations)
      ? this.messagingConversations
      : [];
    const unread = conversations.find((c) => Number(c.unread_count || 0) > 0);
    if (!unread?.phone) return false;
    await this.goToFarmerMessage(unread.phone);
    return true;
  }

  async goToFarmerMessage(phone) {
    if (!phone) return;

    this.switchModule('messaging');

    const targetPhone = String(phone).replace(/^\+63|^63|^0/, '');
    const messagingBtn = document.getElementById('messagingBtn');
    this.setBtnLoading(messagingBtn, true);

    try {
      await this.loadMessagingFolder();
    } finally {
      this.setBtnLoading(messagingBtn, false);
    }
    
    // Search for a conversation with this farmer
    const conv = this.messagingConversations.find(c => {
      const convPhone = String(c.phone || '').replace(/^\+63|^63|^0/, '');
      return convPhone === targetPhone;
    });
    
    if (conv) {
      this.messagingSelectedPhone = conv.phone;
      const listEl = document.getElementById('messagingList');
      if (listEl) {
        const tail = this.messagingPhoneTail(conv.phone);
        listEl.querySelectorAll('.messaging-item').forEach((el) => el.classList.remove('is-active'));
        const matchItem = [...listEl.querySelectorAll('.messaging-item')].find(
          (el) => this.messagingPhoneTail(el.getAttribute('data-phone') || '') === tail
        );
        if (matchItem) matchItem.classList.add('is-active');
      }
      void this.openMessagingDetail(
        this.parseMessagingMessageId(conv.latest_message?.id ?? conv.latest_message?.message_id),
        {
          phone: conv.phone,
          name: conv.name,
        }
      );
    } else {
      // If no conversation exists, open the compose panel
      this.openMessagingCompose(phone);
    }
  }

  closeMessagingDetail() {
    this.messagingSelectedId = null;
    this.stopMessagingConversationPoll();
    const main = document.getElementById('messagingMain');
    const detail = document.getElementById('messagingDetail');
    if (main) main.classList.remove('has-detail');
    if (detail) detail.classList.remove('is-visible');
    document.querySelectorAll('.messaging-item').forEach(el => el.classList.remove('is-active'));
  }

  startMessagingConversationPoll() {
    this.stopMessagingConversationPoll();
    this._messagingPoll = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (!this.messagingSelectedPhone && !this.messagingSelectedId) return;
      this.loadMessagingFolder();
    }, 20000);
  }

  stopMessagingConversationPoll() {
    if (this._messagingPoll) {
      clearInterval(this._messagingPoll);
      this._messagingPoll = null;
    }
  }

  async toggleMessagingArchive(id) {
    const archiveBtn = document.getElementById('messagingDetailArchiveBtn');
    const prevHtml = archiveBtn ? archiveBtn.innerHTML : '';
    if (archiveBtn) {
      archiveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Archiving…</span>';
      this.setBtnLoading(archiveBtn, true, { spinIcon: false });
    }
    try {
      const res = await this.messagingApi(`/api/messages/${id}/archive`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      this.showNotification(data.is_archived ? 'Message archived.' : 'Message unarchived.', 'success');
      this.closeMessagingDetail();
      await this.loadMessagingFolder();
    } catch (err) {
      console.warn('Archive toggle failed:', err);
      this.showNotification('Could not archive message.', 'error');
    } finally {
      if (archiveBtn) {
        archiveBtn.innerHTML = prevHtml;
        this.setBtnLoading(archiveBtn, false, { spinIcon: false });
      }
    }
  }

  async deleteMessagingMessage(id) {
    const modal = document.getElementById('deleteMsgModal');
    const confirmBtn = document.getElementById('confirmDeleteBtn');
    const cancelBtn = document.getElementById('cancelDeleteBtn');
    const closeBtn = document.getElementById('closeDeleteModal');

    if (!modal || !confirmBtn) {
      // Fallback to native confirm if modal is missing
      if (!confirm('Delete this conversation permanently?')) return;
      return this._performDelete(id);
    }

    modal.removeAttribute('hidden');

    // Cleanup helper
    const hideModal = () => {
      modal.setAttribute('hidden', '');
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      closeBtn.onclick = null;
    };

    confirmBtn.onclick = async () => {
      this.setBtnLoading(confirmBtn, true, { label: 'Deleting…' });
      try {
        await this._performDelete(id);
        hideModal();
      } finally {
        this.setBtnLoading(confirmBtn, false);
      }
    };

    cancelBtn.onclick = hideModal;
    closeBtn.onclick = hideModal;
    
    // Close on overlay click
    modal.onclick = (e) => {
      if (e.target === modal) hideModal();
    };
  }

  async _performDelete(id) {
    try {
      const res = await this.messagingApi(`/api/messages/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      this.showNotification('Message deleted.', 'success');
      this.closeMessagingDetail();
      await this.loadMessagingFolder();
    } catch (err) {
      console.warn('Delete failed:', err);
      this.showNotification('Could not delete message.', 'error');
      throw err;
    }
  }

  async messagingMarkAllRead() {
    try {
      const res = await this.messagingApi('/api/messages/mark-all-read', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      this.showNotification('All messages marked as read.', 'success');
      this.loadMessagingFolder();
    } catch (err) {
      console.warn('Mark all read failed:', err);
    }
  }

  openMessagingCompose(recipientPhone = '') {
    this.populateContactDropdown(); // Initial population
    
    // Hide other panes in the detail area
    const noChatPlaceholder = document.getElementById('messagingNoChatSelected');
    const detailPane = document.getElementById('messagingDetail');
    if (noChatPlaceholder) noChatPlaceholder.style.display = 'none';
    if (detailPane) detailPane.style.display = 'none';

    const overlay = document.getElementById('messagingComposeOverlay');
    if (overlay) {
      overlay.removeAttribute('hidden');
      overlay.classList.add('is-visible');
    }
    
    const hiddenRecipient = document.getElementById('msgComposeRecipient');
    const visibleInput = document.getElementById('msgComposeRecipientInput');
    
    if (recipientPhone && hiddenRecipient && visibleInput) {
      hiddenRecipient.value = recipientPhone;
      // Try to find the name for this phone number
      const farmer = (this.data || []).find(f => this.getValue(f, ['PHONE', 'phone', 'PHONE NO.', 'Phone No.']) === recipientPhone);
      if (farmer) {
        this.selectContact(this.getFarmerFullName(farmer), recipientPhone);
        return; // selectContact handles opening the detail
      }
    } else if (visibleInput) {
      visibleInput.value = '';
      if (hiddenRecipient) hiddenRecipient.value = '';
    }

    if (visibleInput) setTimeout(() => visibleInput.focus(), 100);
  }

  showContactDropdown() {
    const dropdown = document.getElementById('messagingContactDropdown');
    if (dropdown) dropdown.classList.add('is-visible');
    this.filterContactDropdown(''); // Show all on focus
  }

  hideContactDropdown() {
    const dropdown = document.getElementById('messagingContactDropdown');
    if (dropdown) dropdown.classList.remove('is-visible');
  }

  populateContactDropdown() {
    const list = document.getElementById('messagingContactDropdownList');
    if (!list) return;

    if (!this.data || !this.data.length) {
      list.innerHTML = '<div class="messaging-contact-dropdown__item">No contacts found</div>';
      return;
    }

    const sortedFarmers = [...this.data].sort((a, b) => {
      const nameA = this.getFarmerFullName(a).toLowerCase();
      const nameB = this.getFarmerFullName(b).toLowerCase();
      return nameA.localeCompare(nameB);
    });

    const esc = (s) => this.escapeHtml(s);
    list.innerHTML = sortedFarmers.map(f => {
      const fullName = this.getFarmerFullName(f);
      const phone = this.getValue(f, ['PHONE', 'phone', 'PHONE NO.', 'Phone No.']);
      const farmerId = this.farmerIdFromRow(f);
      
      return `
        <div class="messaging-contact-dropdown__item" data-phone="${esc(phone)}" data-name="${esc(fullName)}">
          ${this.buildMessagingAvatarHtml({
            phone,
            name: fullName,
            className: 'messaging-contact-dropdown__avatar',
            farmerId,
          })}
          <div class="messaging-contact-dropdown__name">
            ${esc(fullName)}
          </div>
        </div>
      `;
    }).join('');

    this.hydrateMessagingAvatars(list);
  }

  filterContactDropdown(query) {
    const items = document.querySelectorAll('.messaging-contact-dropdown__item');
    const q = query.toLowerCase();
    let hasResults = false;

    items.forEach(item => {
      const name = (item.getAttribute('data-name') || '').toLowerCase();
      const phone = (item.getAttribute('data-phone') || '').toLowerCase();
      if (name.includes(q) || phone.includes(q)) {
        item.style.display = 'flex';
        hasResults = true;
      } else {
        item.style.display = 'none';
      }
    });

    const dropdown = document.getElementById('messagingContactDropdown');
    if (dropdown) {
      if (hasResults) dropdown.classList.add('is-visible');
      else dropdown.classList.remove('is-visible');
    }
  }

  selectContact(name, phone) {
    this.closeMessagingCompose();
    this.messagingSelectedPhone = phone;

    // Find if we already have a conversation with this phone
    const normalize = (p) => String(p || '').replace(/\D/g, '').replace(/^(0|63)/, '');
    const target = normalize(phone);
    const existingMsg = this.messagingMessages.find(m => 
      normalize(m.sender_phone) === target || normalize(m.recipient_phone) === target
    );

    if (existingMsg) {
      this.openMessagingDetail(
        this.parseMessagingMessageId(existingMsg.id ?? existingMsg.message_id),
        { phone, name }
      );
    } else {
      // Open a "virtual" conversation for this new contact
      this.openMessagingDetail(null, { phone, name });
    }
  }

  lookupFarmerIdByPhone(phone) {
    if (!phone || !Array.isArray(this.data)) return null;
    const normalize = (p) => String(p || '').replace(/\D/g, '').replace(/^(0|63)/, '');
    const target = normalize(phone);
    const farmer = this.data.find((row) => {
      const rowPhone = normalize(
        this.getValue(row, ['PHONE', 'phone_number', 'CONTACT NUMBER', 'contact_number'])
      );
      return rowPhone && rowPhone === target;
    });
    if (!farmer) return null;
    const fid = farmer.farmer_id ?? farmer['NO.'] ?? farmer.no ?? farmer.id;
    const n = parseInt(fid, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  resolveFarmerName(phone, fallbackName) {
    if (!phone) return fallbackName || 'Unknown Farmer';
    
    const normalize = (p) => String(p || '').replace(/\D/g, '').replace(/^(0|63)/, '');
    const target = normalize(phone);
    
    // Search in the main farmers data (this.data)
    if (this.data && Array.isArray(this.data)) {
      const farmer = this.data.find(f => {
        const fPhone = this.getValue(f, ['PHONE', 'phone', 'PHONE NO.', 'Phone No.']);
        return normalize(fPhone) === target;
      });
      if (farmer) return this.getFarmerFullName(farmer);
    }
    
    return fallbackName || phone;
  }

  getFarmerFullName(row) {
    return (
      this.getValue(row, ['NAME OF FARMER', 'name', 'FULL NAME', 'full_name', 'Name']) ||
      [this.getValue(row, ['FIRST NAME', 'first_name', 'firstName']), this.getValue(row, ['LAST NAME', 'last_name', 'lastName'])]
        .filter(Boolean)
        .join(' ')
        .trim()
    );
  }

  closeMessagingCompose() {
    const overlay = document.getElementById('messagingComposeOverlay');
    if (overlay) {
      overlay.classList.remove('is-visible');
      overlay.setAttribute('hidden', '');
    }
    
    // Restore the appropriate pane
    if (this.messagingSelectedId) {
      const detailPane = document.getElementById('messagingDetail');
      if (detailPane) detailPane.style.display = 'flex';
    } else {
      const noChatPlaceholder = document.getElementById('messagingNoChatSelected');
      if (noChatPlaceholder) noChatPlaceholder.style.display = 'flex';
    }

    const form = document.getElementById('messagingComposeForm');
    if (form) form.reset();
  }

  async sendMessage() {
    const body = (document.getElementById('msgComposeBody')?.value || '').trim();
    const category = document.getElementById('msgComposeCategory')?.value || 'general';
    const recipientPhone = (document.getElementById('msgComposeRecipient')?.value || '').trim();
    const recipientName = (document.getElementById('msgComposeRecipientInput')?.value || '').trim();
    const subject = "Message from Admin";

    if (!body) {
      this.showNotification('Message body is required.', 'error');
      return;
    }

    const sendBtn = document.getElementById('messagingComposeSend');
    this.setBtnLoading(sendBtn, true);

    try {
      const res = await this.messagingApi('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ 
          subject, 
          body, 
          category, 
          recipient_phone: recipientPhone,
          recipient_name: recipientName
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      this.showNotification('Message sent!', 'success');
      this.closeMessagingCompose();
      
      // Update selected state so the new conversation is highlighted
      if (data.message && data.message.id) {
        this.messagingSelectedId = data.message.id;
        this.messagingSelectedPhone = recipientPhone;
      }
      
      await this.loadMessagingFolder();
      
      // If we have a selected ID, open the detail view
      if (this.messagingSelectedId) {
        this.openMessagingDetail(this.messagingSelectedId);
      }
    } catch (err) {
      console.warn('Send message failed:', err);
      this.showNotification(err.message || 'Could not send message.', 'error');
    } finally {
      this.setBtnLoading(sendBtn, false);
    }
  }

  showMessagingReply() {
    const replySection = document.getElementById('messagingDetailReply');
    if (replySection) {
      replySection.style.display = 'block';
      // Focus on the reply textarea
      const textarea = document.getElementById('msgReplyMessage');
      if (textarea) {
        textarea.focus();
        textarea.value = '';
      }
    }
  }

  hideMessagingReply() {
    const replySection = document.getElementById('messagingDetailReply');
    if (replySection) {
      replySection.style.display = 'none';
      const textarea = document.getElementById('msgReplyMessage');
      if (textarea) textarea.value = '';
    }
  }

  async sendMessagingReply() {
    if (!this.messagingSelectedId) return;

    const message = (document.getElementById('msgReplyMessage')?.value || '').trim();
    if (!message) {
      this.showNotification('Reply message is required.', 'error');
      return;
    }

    const sendBtn = document.getElementById('msgReplySendBtn');
    this.setBtnLoading(sendBtn, true);

    try {
      // Get the original message to extract recipient info
      const originalMessage = this.messagingMessages.find(m => m.id === this.messagingSelectedId);
      if (!originalMessage) throw new Error('Original message not found');

      // For demo purposes, append the reply to the conversation immediately
      const replyData = {
        body: message,
        sender_name: "Administrator",
        sender_type: "admin",
        created_at: new Date().toISOString()
      };

      // Initialize conversation array if it doesn't exist
      if (!originalMessage.conversation) {
        originalMessage.conversation = [];
      }

      // Add the reply to the conversation
      originalMessage.conversation.push(replyData);

      // Update the conversation view
      const bodyEl = document.getElementById('messagingDetailBody');
      if (bodyEl) {
        bodyEl.innerHTML = this.renderConversation(originalMessage);
        this.scrollMessagingConversationToBottom(bodyEl);
      }

      // In a real implementation, this would send to the API
      // const res = await fetch('/api/messages', {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      //   body: JSON.stringify({ 
      //     body: message,
      //     category: 'general',
      //     recipient_phone: originalMessage.sender_phone,
      //     reply_to_message_id: this.messagingSelectedId
      //   }),
      // });
      // const data = await res.json().catch(() => ({}));
      // if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      this.showNotification('Reply sent successfully!', 'success');
      this.hideMessagingReply();
      this.loadMessagingFolder();
    } catch (err) {
      console.warn('Send reply failed:', err);
      this.showNotification(err.message || 'Could not send reply.', 'error');
    } finally {
      this.setBtnLoading(sendBtn, false);
    }
  }

  async updateMessagingBadge() {
    try {
      const res = await this.messagingApi('/api/messages/unread-count');
      if (!res.ok) return;
      const data = await beanthenticParseJsonResponse(res);
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
        if (count > 0) {
          inboxBadge.textContent = count > 99 ? '99+' : String(count);
          inboxBadge.classList.add('is-visible');
        } else {
          inboxBadge.textContent = '';
          inboxBadge.classList.remove('is-visible');
        }
      }
    } catch {
      // Silently fail
    }
  }

  // Farmer's Contribution Module Functionality
  initBeanthenticContributions() {
    this.contributions = [];
    this.contributionsLoading = false;
    this.contributionsLoadError = '';
    this.currentFilter = 'all';
    this.searchTerm = '';
    this.selectedContributions = new Set();

    this.bindBeanthenticEvents();
    this.loadContributionsFromApi();
  }

  formatContributionDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  isTruthyDbFlag(value) {
    return value === true || value === 1 || value === '1';
  }

  mapGiContributionItem(item) {
    const status = String(item.upload_status || item.status || 'pending').toLowerCase();
    const phase = String(item.current_phase || '').trim();
    const fromAdmin =
      item.direction === 'outbound' ||
      phase === 'admin_submission' ||
      !!item.from_admin;
    const readAdmin =
      this.isTruthyDbFlag(item.is_read_admin) || this.isTruthyDbFlag(item.seen);
    let unread;
    if (item.unread != null && item.unread !== '') {
      unread = this.isTruthyDbFlag(item.unread);
    } else {
      unread = !readAdmin;
    }
    if (fromAdmin) unread = false;
    return {
      id: Number(item.gi_update_id || item.id || 0),
      farmer_id: Number(item.farmer_id || 0),
      fromAdmin,
      farmer: fromAdmin
        ? String(item.sender_name || item.farmer_name || 'IPOPHL Administrator')
        : String(item.farmer_name || item.farmer || 'Farmer'),
      farmer_email: String(item.farmer_email || ''),
      subject: String(item.title || item.subject || 'GI Update'),
      preview: String(item.preview || item.content || '').replace(/\s+/g, ' ').trim(),
      content: String(item.content || ''),
      date: this.formatContributionDate(item.created_at),
      status: status === 'archived' ? 'archived' : (status === 'approved' ? 'approved' : 'pending'),
      category: String(item.category || 'general'),
      starred: !!(item.is_starred || item.starred),
      unread,
      seen: readAdmin,
      attachments: Array.isArray(item.attachments) ? item.attachments : [],
    };
  }

  async loadContributionsFromApi() {
    if (this.contributionsLoading) return;
    this.contributionsLoading = true;
    this.contributionsLoadError = '';
    try {
      const res = await fetch(beanthenticApiUrl('/api/gi-contributions-list?limit=500&phase=inbox'), {
        credentials: 'same-origin',
      });
      const data = await beanthenticParseJsonResponse(res).catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(
          this.formatAppLoadError(data, `Could not load contributions (HTTP ${res.status}).`)
        );
      }
      if (!Array.isArray(data.items)) {
        throw new Error('Invalid response from server.');
      }
      this.contributions = data.items
        .map((item) => this.mapGiContributionItem(item))
        .filter((c) => !c.fromAdmin);
    } catch (err) {
      this.contributionsLoadError =
        err && err.message
          ? this.formatAppLoadError(err.message, 'Could not load contributions.')
          : 'Could not load contributions.';
      console.warn('GI contributions load failed:', err);
    } finally {
      this.contributionsLoading = false;
      this.renderContributions();
    }
  }

  async patchGiContribution(id, fields) {
    const res = await fetch(beanthenticApiUrl(`/api/gi-contributions/${id}`), {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Update failed (${res.status})`);
    }
    return data;
  }

  async deleteGiContribution(id) {
    const res = await fetch(beanthenticApiUrl(`/api/gi-contributions/${id}`), {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Delete failed (${res.status})`);
    }
    return data;
  }

  bindBeanthenticEvents() {
    // Tab / folder navigation
    const tabs = document.querySelectorAll('.contributions-tab');
    tabs.forEach((tab) => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        const filter = tab.dataset.filter;
        if (filter) {
          this.setActiveFilter(filter);
        }
      });
    });

    // Gmail-style search
    const searchInput = document.getElementById('contributionsSearchInput');
    if (searchInput && !searchInput.dataset.bound) {
      searchInput.dataset.bound = '1';
      let searchTimer = null;
      searchInput.addEventListener('input', () => {
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => {
          this.searchTerm = String(searchInput.value || '').trim().toLowerCase();
          this.renderContributions();
        }, 160);
      });
    }

    // Toolbar buttons
    const selectAllCheckbox = document.getElementById('beanthenticSelectAll');
    if (selectAllCheckbox) {
      selectAllCheckbox.addEventListener('change', (e) => this.selectAllContributions(e.target.checked));
    }

    // Toolbar action buttons
    const toolbarBtns = document.querySelectorAll('.beanthentic-toolbar-btn');
    toolbarBtns.forEach(btn => {
      btn.addEventListener('click', () => this.handleToolbarAction(btn));
    });

    // Detail modal controls
    const detailModal = document.getElementById('beanthenticContributionDetailModal');
    const detailCloseBtn = document.getElementById('beanthenticContributionDetailClose');
    const detailBackdrop = detailModal ? detailModal.querySelector('.beanthentic-detail-dialog__backdrop') : null;

    if (detailCloseBtn) {
      detailCloseBtn.addEventListener('click', () => this.closeContributionDetailModal());
    }
    if (detailBackdrop) {
      detailBackdrop.addEventListener('click', () => this.closeContributionDetailModal());
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeContributionDetailModal();
      }
    });

    // Contribution item interactions
    this.bindContributionItemEvents();
  }

  bindContributionItemEvents() {
    // Checkbox interactions
    const checkboxes = document.querySelectorAll('.beanthentic-contribution-checkbox input');
    checkboxes.forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        const id = parseInt(e.target.closest('.beanthentic-contribution-item').dataset.id);
        if (e.target.checked) {
          this.selectedContributions.add(id);
        } else {
          this.selectedContributions.delete(id);
        }
        this.updateSelectAllState();
      });
    });

    // Star interactions
    const stars = document.querySelectorAll('.beanthentic-contribution-star');
    stars.forEach(star => {
      star.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = e.target.closest('.beanthentic-contribution-item');
        const id = parseInt(item.dataset.id);
        this.toggleStar(id);
      });
    });

    // Item click interactions
    const items = document.querySelectorAll('.beanthentic-contribution-item');
    items.forEach(item => {
      item.addEventListener('click', (e) => {
        if (!e.target.closest('.beanthentic-contribution-checkbox') && 
            !e.target.closest('.beanthentic-contribution-star')) {
          const id = parseInt(item.dataset.id);
          this.openContribution(id);
        }
      });
    });
  }

  toggleSidebar() {
    const sidebar = document.getElementById('beanthenticSidebar');
    if (sidebar) {
      sidebar.classList.toggle('open');
    }
  }

  setActiveFilter(filter) {
    this.currentFilter = filter;
    
    // Update active state
    const tabs = document.querySelectorAll('.contributions-tab');
    tabs.forEach(tab => {
      tab.classList.remove('active');
      if (tab.dataset.filter === filter) {
        tab.classList.add('active');
      }
    });
    
    this.renderContributions();
  }

  getFilteredContributions() {
    let filtered = this.contributions;

    // Apply status/category/seen filter
    if (this.currentFilter !== 'all') {
      if (this.currentFilter === 'starred') {
        filtered = filtered.filter(c => c.starred && c.status !== 'archived');
      } else if (this.currentFilter === 'approved') {
        filtered = filtered.filter(c => c.status === 'approved');
      } else if (this.currentFilter === 'documents' || this.currentFilter === 'images') {
        filtered = filtered.filter(c => c.category === this.currentFilter && c.status !== 'archived');
      } else {
        filtered = filtered.filter(c => c.status === this.currentFilter);
      }
    } else {
      // Inbox filter: active contributions
      filtered = filtered.filter(c => c.status !== 'archived');
    }

    // Apply search filter
    if (this.searchTerm) {
      filtered = filtered.filter(c =>
        c.farmer.toLowerCase().includes(this.searchTerm) ||
        c.subject.toLowerCase().includes(this.searchTerm) ||
        c.preview.toLowerCase().includes(this.searchTerm)
      );
    }

    return filtered;
  }

  getContributionCategoryLabel(category) {
    const labels = {
      documents: 'Document',
      images: 'Image',
    };
    return labels[category] || category;
  }

  updateTabCounts() {
    const totalInbox = this.contributions.filter(c => c.status !== 'archived').length;
    const totalStarred = this.contributions.filter(c => c.starred && c.status !== 'archived').length;
    const totalApproved = this.contributions.filter(c => c.status === 'approved').length;

    this.setText('inboxCountBadge', String(totalInbox));
    this.setText('starredCountBadge', String(totalStarred));
    this.setText('approvedCountBadge', String(totalApproved));
  }

  renderContributions() {
    const container = document.getElementById('beanthenticContributionList');
    if (!container) return;

    this.updateTabCounts();

    const filtered = this.getFilteredContributions();

    const paginationLabel = document.getElementById('contributionsPaginationLabel');
    if (paginationLabel) {
      if (filtered.length > 0) {
        paginationLabel.textContent = `1-${filtered.length} of ${filtered.length}`;
      } else {
        paginationLabel.textContent = `0-0 of 0`;
      }
    }

    if (this.contributionsLoading) {
      container.innerHTML = window.BeanthenticUI
        ? `<div class="beanthentic-contribution-empty">${window.BeanthenticUI.loadingPanel('Loading mail')}</div>`
        : `
        <div class="beanthentic-contribution-empty" role="status" aria-live="polite">
          <h3>Loading contributions…</h3>
        </div>
      `;
      return;
    }

    if (filtered.length === 0) {
      let errorHtml = '';
      if (this.contributionsLoadError) {
        const safeMsg = this.escapeHtml(
          this.formatAppLoadError(this.contributionsLoadError, 'Could not load contributions.')
        );
        const low = String(this.contributionsLoadError || '').toLowerCase();
        const supabaseHint =
          low.includes('supabase') ||
          low.includes('10035') ||
          low.includes('non-blocking socket') ||
          low.includes('beanthentic_supabase');
        const hintText = supabaseHint
          ? 'Check <code>BEANTHENTIC_SUPABASE_URL</code> and <code>BEANTHENTIC_SUPABASE_ANON_KEY</code> in <code>.env</code>, then restart <code>web.py</code>.'
          : 'Check <code>app_db_host</code>, <code>app_db_pass</code>, and <code>app_server_base</code> in <code>settings.json</code> or open <a href="/connection-settings">Connection Settings</a>.';
        errorHtml =
          `<p style="color:#b91c1c;line-height:1.5;">${safeMsg}</p>` +
          `<p style="color:#64748b;font-size:0.9rem;margin-top:0.5rem;">${hintText}</p>`;
      }

      const emptyHint = this.searchTerm
        ? 'No messages matched your search.'
        : 'When farmers send GI updates from the mobile app, they will appear here.';

      if (errorHtml) {
        container.innerHTML = `
        <div class="beanthentic-contribution-empty" role="status" aria-live="polite">
          <div class="bt-empty__icon" style="margin-bottom:8px;"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i></div>
          <h3>Couldn’t load mail</h3>
          ${errorHtml}
        </div>
      `;
      } else if (window.BeanthenticUI) {
        container.innerHTML = `<div class="beanthentic-contribution-empty">${window.BeanthenticUI.emptyState({
          icon: this.searchTerm ? 'fa-magnifying-glass' : 'fa-inbox',
          title: this.searchTerm ? 'No results' : 'Your inbox is empty',
          hint: emptyHint,
        })}</div>`;
      } else {
        container.innerHTML = `
        <div class="beanthentic-contribution-empty" role="status" aria-live="polite">
          <h3>${this.searchTerm ? 'No results' : 'Your inbox is empty'}</h3>
          <p>${emptyHint}</p>
        </div>
      `;
      }
      return;
    }

    const esc = (s) => this.escapeHtml(s);
    container.innerHTML = filtered.map((contribution) => {
      const selected = this.selectedContributions.has(contribution.id);
      return `
      <div class="beanthentic-contribution-item ${contribution.unread ? 'unread' : 'is-read'}${selected ? ' is-selected' : ''}" data-id="${contribution.id}" role="listitem">
        <div class="beanthentic-contribution-left">
          <div class="beanthentic-contribution-checkbox">
            <input type="checkbox" ${selected ? 'checked' : ''} aria-label="Select contribution">
          </div>
          <div class="beanthentic-contribution-star ${contribution.starred ? 'starred' : ''}" title="${contribution.starred ? 'Unstar' : 'Star'}">
            <i class="${contribution.starred ? 'fa-solid' : 'fa-regular'} fa-star"></i>
          </div>
          <div class="beanthentic-contribution-farmer">${contribution.fromAdmin ? '<i class="fa-solid fa-paper-plane" aria-hidden="true"></i> ' : ''}${esc(contribution.farmer)}</div>
        </div>
        <div class="beanthentic-contribution-subject">
          <span class="beanthentic-contribution-subject-text">${esc(contribution.subject)}</span>
          <span class="beanthentic-contribution-preview-inline">${esc(contribution.preview)}</span>
        </div>
        <div class="beanthentic-contribution-date">${esc(contribution.date)}</div>
      </div>
    `;
    }).join('');

    // Re-bind events after rendering
    this.bindContributionItemEvents();
  }

  async toggleStar(id) {
    const contribution = this.contributions.find(c => c.id === id);
    if (!contribution) return;
    const next = !contribution.starred;
    try {
      await this.patchGiContribution(id, { is_starred: next });
      contribution.starred = next;
      this.renderContributions();
      this.showNotification(next ? 'Contribution starred' : 'Contribution unstarred', 'success');
    } catch (err) {
      this.showNotification(err.message || 'Could not update star.', 'error');
    }
  }

  selectAllContributions(checked) {
    const filtered = this.getFilteredContributions();
    if (checked) {
      filtered.forEach(c => this.selectedContributions.add(c.id));
    } else {
      this.selectedContributions.clear();
    }
    this.renderContributions();
  }

  updateSelectAllState() {
    const selectAllCheckbox = document.getElementById('beanthenticSelectAll');
    const filtered = this.getFilteredContributions();
    const allSelected = filtered.length > 0 && filtered.every(c => this.selectedContributions.has(c.id));
    
    if (selectAllCheckbox) {
      selectAllCheckbox.checked = allSelected;
    }
  }

  handleToolbarAction(btn) {
    const title = btn.getAttribute('title');
    const selectedCount = this.selectedContributions.size;

    if (selectedCount === 0 && title !== 'Refresh' && title !== 'More') {
      this.showNotification('Please select contributions first', 'warning');
      return;
    }

    switch (title) {
      case 'Archive':
        this.archiveContributions();
        break;
      case 'Report Issue':
        this.reportIssues();
        break;
      case 'Delete':
        this.deleteContributions();
        break;
      case 'Mark as Reviewed':
        this.markAsReviewed();
        break;
      case 'Mark as New':
        this.markAsNew();
        break;
      case 'Snooze':
        this.snoozeContributions();
        break;
      case 'Refresh':
        this.refreshContributions();
        break;
      case 'More':
        this.showMoreOptions();
        break;
    }
  }

  async archiveContributions() {
    const selected = Array.from(this.selectedContributions);
    try {
      await Promise.all(selected.map((id) => this.patchGiContribution(id, { upload_status: 'archived' })));
      selected.forEach((id) => {
        const contribution = this.contributions.find(c => c.id === id);
        if (contribution) contribution.status = 'archived';
      });
      this.selectedContributions.clear();
      this.renderContributions();
      this.showNotification(`${selected.length} contribution(s) archived`, 'success');
    } catch (err) {
      this.showNotification(err.message || 'Archive failed.', 'error');
    }
  }

  async deleteContributions() {
    const confirmed = await this.showConfirmDialog(
      `Are you sure you want to delete ${this.selectedContributions.size} contribution(s)?`,
      'Delete Contributions',
      'danger'
    );

    if (!confirmed) return;
    const selected = Array.from(this.selectedContributions);
    try {
      await Promise.all(selected.map((id) => this.deleteGiContribution(id)));
      this.contributions = this.contributions.filter(c => !selected.includes(c.id));
      this.selectedContributions.clear();
      this.renderContributions();
      this.showNotification(`${selected.length} contribution(s) deleted`, 'success');
    } catch (err) {
      this.showNotification(err.message || 'Delete failed.', 'error');
    }
  }

  async markAsReviewed() {
    const selected = Array.from(this.selectedContributions);
    try {
      await Promise.all(selected.map((id) => this.patchGiContribution(id, { is_read_admin: true })));
      selected.forEach((id) => {
        const contribution = this.contributions.find(c => c.id === id);
        if (contribution) {
          contribution.unread = false;
          contribution.seen = true;
        }
      });
      this.selectedContributions.clear();
      this.renderContributions();
      this.showNotification(`${selected.length} contribution(s) marked as reviewed`, 'success');
    } catch (err) {
      this.showNotification(err.message || 'Update failed.', 'error');
    }
  }

  async markAsNew() {
    const selected = Array.from(this.selectedContributions);
    try {
      await Promise.all(selected.map((id) => this.patchGiContribution(id, { is_read_admin: false })));
      selected.forEach((id) => {
        const contribution = this.contributions.find(c => c.id === id);
        if (contribution) {
          contribution.unread = true;
          contribution.seen = false;
        }
      });
      this.selectedContributions.clear();
      this.renderContributions();
      this.showNotification(`${selected.length} contribution(s) marked as new`, 'success');
    } catch (err) {
      this.showNotification(err.message || 'Update failed.', 'error');
    }
  }

  snoozeContributions() {
    this.showNotification('Contributions snoozed for 1 week', 'success');
    this.selectedContributions.clear();
    this.renderContributions();
  }

  async refreshContributions() {
    await this.loadContributionsFromApi();
    this.showNotification('Contributions refreshed', 'success');
  }

  reportIssues() {
    this.showNotification('Issue reported to admin', 'success');
  }

  showMoreOptions() {
    this.showNotification('More options menu', 'info');
  }

  async openContribution(id) {
    const contribution = this.contributions.find(c => c.id === id);
    if (!contribution) return;
    if (!contribution.fromAdmin) {
      try {
        await this.patchGiContribution(id, { is_read_admin: true });
      } catch (err) {
        console.warn('Could not mark contribution as read:', err);
      }
    }
    contribution.unread = false;
    contribution.seen = true;
    this.renderContributions();
    this.openContributionDetailModal(contribution);
  }

  async openContributionDetailModal(contribution) {
    const modal = document.getElementById('beanthenticContributionDetailModal');
    if (!modal || !contribution) return;

    // Store previous focus
    this.__previousFocus = document.activeElement;

    const avatarEl = document.getElementById('beanthenticContributionAvatar');
    const farmerEl = document.getElementById('beanthenticContributionDetailFarmer');
    const emailEl = document.getElementById('beanthenticContributionDetailEmail');
    const dateEl = document.getElementById('beanthenticContributionDetailDate');
    const subjectEl = document.getElementById('beanthenticContributionDetailSubject');
    const previewEl = document.getElementById('beanthenticContributionDetailPreview');
    const attachSectionEl = document.getElementById('beanthenticAttachmentsSection');
    const attachCountEl = document.getElementById('beanthenticAttachmentCount');
    const attachGridEl = document.getElementById('beanthenticAttachmentGrid');

    const attachments = Array.isArray(contribution.attachments) ? contribution.attachments : [];
    const farmerName = String(contribution.farmer || 'Farmer').trim();
    const subjectRaw = String(contribution.subject || contribution.preview || 'Farmer contribution').trim();
    const message = String(contribution.content || contribution.preview || 'No message provided.').trim();

    if (avatarEl) avatarEl.textContent = farmerName.charAt(0).toUpperCase() || 'F';
    if (farmerEl) farmerEl.textContent = farmerName || '—';
    if (emailEl) {
      const email = String(contribution.farmer_email || '').trim();
      emailEl.textContent = email;
      emailEl.hidden = !email;
    }
    if (dateEl) dateEl.textContent = contribution.date || '—';
    const duplicateSubject = subjectRaw.toLowerCase() === message.toLowerCase();
    if (subjectEl) {
      if (duplicateSubject) {
        subjectEl.textContent = '';
        subjectEl.hidden = true;
      } else {
        subjectEl.textContent = subjectRaw;
        subjectEl.hidden = false;
      }
    }
    if (previewEl) previewEl.textContent = message;

    if (attachSectionEl) attachSectionEl.hidden = false;
    if (attachCountEl) {
      attachCountEl.textContent = attachments.length
        ? (attachments.length === 1 ? '1 attachment' : `${attachments.length} attachments`)
        : 'Attachments';
    }
    if (attachGridEl) {
      if (!attachments.length) {
        attachGridEl.innerHTML =
          '<p class="fc-detail-attachments-empty">No files were attached to this message.</p>';
      } else {
        const resolved = await Promise.all(
          attachments.map(async (a) => {
            const url = await ensureGiAttachmentUrl(a);
            return { attachment: a, url };
          })
        );
        attachGridEl.innerHTML = resolved
          .map(({ attachment: a, url: resolvedUrl }) => {
            const rawName = String(a.name || a.filename || 'file');
            const name = this.escapeHtml(rawName);
            const url = this.escapeHtml(resolvedUrl || '#');
            const mime = String(a.mime || a.type || '').toLowerCase();
            const isImg =
              mime.indexOf('image/') === 0 || /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(rawName);
            const preview = isImg
              ? `<img class="fc-detail-attachment-img" src="${url}" alt="${name}" loading="lazy" decoding="async" data-fallback-name="${name}" />`
              : `<div class="fc-detail-attachment-doc" aria-hidden="true"><i class="fa-solid fa-file-lines"></i></div>`;
            return `
            <a class="fc-detail-attachment-thumb${isImg ? ' fc-detail-attachment-thumb--image' : ''}" href="${url}" target="_blank" rel="noopener noreferrer" title="Open ${name} in a new tab">
              ${preview}
              <span class="fc-detail-attachment-name">${name}</span>
            </a>`;
          })
          .join('');
        attachGridEl.querySelectorAll('img.fc-detail-attachment-img').forEach((img) => {
          img.addEventListener('error', async () => {
            const rawName = String(img.getAttribute('data-fallback-name') || img.alt || '').trim();
            if (!rawName || img.dataset.retried === '1') {
              img.replaceWith(
                Object.assign(document.createElement('div'), {
                  className: 'fc-detail-attachment-doc fc-detail-attachment-doc--broken',
                  innerHTML: '<i class="fa-solid fa-image" aria-hidden="true"></i><span>Preview unavailable</span>',
                })
              );
              return;
            }
            img.dataset.retried = '1';
            const retryUrl = await ensureGiAttachmentUrl({ filename: rawName, name: rawName });
            if (retryUrl) img.src = retryUrl;
          });
        });
        attachGridEl.querySelectorAll('a.fc-detail-attachment-thumb').forEach((link) => {
          link.addEventListener('click', (ev) => {
            const openUrl = link.getAttribute('href');
            if (!openUrl || openUrl === '#') return;
            ev.preventDefault();
            window.open(openUrl, '_blank', 'noopener,noreferrer');
          });
        });
      }
    }

    modal.removeAttribute('hidden');
    modal.removeAttribute('aria-hidden');
    modal.removeAttribute('inert');
    document.body.classList.add('beanthentic-dialog-open');

    // Focus close button for accessibility
    const closeBtn = document.getElementById('beanthenticContributionDetailClose');
    if (closeBtn) setTimeout(() => closeBtn.focus(), 100);
  }

  closeContributionDetailModal() {
    const modal = document.getElementById('beanthenticContributionDetailModal');
    if (!modal || modal.hasAttribute('hidden')) return;

    // Remove focus
    if (document.activeElement && modal.contains(document.activeElement)) {
      document.activeElement.blur();
    }

    modal.setAttribute('hidden', '');
    modal.setAttribute('aria-hidden', 'true');
    modal.setAttribute('inert', '');
    document.body.classList.remove('beanthentic-dialog-open');

    // Return focus
    if (this.__previousFocus && typeof this.__previousFocus.focus === 'function') {
      this.__previousFocus.focus();
      this.__previousFocus = null;
    }
  }

  // Custom Confirmation Dialog System
  showConfirmDialog(message, title = 'Delete Document') {
    return new Promise((resolve) => {
      const dialog = document.getElementById('beanthenticConfirmDialog');
      const messageEl = document.getElementById('beanthenticConfirmMessage');
      const titleEl = dialog.querySelector('.beanthentic-confirm-title');
      const cancelBtn = document.getElementById('beanthenticConfirmCancel');
      const okBtn = document.getElementById('beanthenticConfirmOk');
      
      if (!dialog || !messageEl || !cancelBtn || !okBtn) {
        resolve(window.confirm(message));
        return;
      }
      
      messageEl.textContent = message;
      if (titleEl) titleEl.textContent = title;
      
      dialog.style.display = 'flex';
      dialog.removeAttribute('hidden');
      
      const cleanup = () => {
        okBtn.removeEventListener('click', handleOk);
        cancelBtn.removeEventListener('click', handleCancel);
        document.removeEventListener('keydown', handleKeydown);
      };
      
      const handleOk = () => {
        cleanup();
        dialog.style.display = 'none';
        dialog.setAttribute('hidden', '');
        resolve(true);
      };
      
      const handleCancel = () => {
        cleanup();
        dialog.style.display = 'none';
        dialog.setAttribute('hidden', '');
        resolve(false);
      };

      const handleKeydown = (e) => {
        if (e.key === 'Escape') handleCancel();
        if (e.key === 'Enter') handleOk();
      };
      
      okBtn.addEventListener('click', handleOk);
      cancelBtn.addEventListener('click', handleCancel);
      document.addEventListener('keydown', handleKeydown);
    });
  }
}

// Initialize dashboard when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.dashboardApp = new DashboardApp();
});

// Export for potential module usage
window.DashboardApp = DashboardApp;
