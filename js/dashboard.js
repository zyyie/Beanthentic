// Dashboard functionality for coffee database
const NOTIFICATIONS_READ_STORAGE_KEY = 'beanthentic_dashboard_notification_read';

/** Prefix for API paths when the app is mounted under a subpath (e.g. /Beanthentic). */
function beanthenticApiUrl(path) {
  const base = (typeof window.__BEANTHENTIC_API_BASE__ === 'string' ? window.__BEANTHENTIC_API_BASE__ : '').replace(/\/$/, '');
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${normalized}` : normalized;
}

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
    this.lipaBoundaryOverlay = null;
    this.googleHeatmap = null;
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
    
    // Explicitly hide the receipt modal on startup
    this.closeReceipt();
    
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
        targetModule: 'farmers',
      },
      {
        id: 'feed-reminder-1',
        icon: 'fa-triangle-exclamation',
        title: 'Reminder: Complete profile details',
        meta: 'Mar 26 · 11:00 AM',
        detail:
          'Some rows still have empty or incomplete information in the Farmer Records (Basic Info tab). Review and add clear notes for follow-up—for example planting status, visits, or data issues. Saving the table stores updates in your browser for next session.',
        targetModule: 'farmers',
      },
      {
        id: 'feed-misconduct-1',
        icon: 'fa-gavel',
        title: 'New Misconduct Report',
        meta: 'May 23 · 2:15 PM',
        detail:
          'A new report regarding farmer misconduct has been submitted. Please review the details in the Client Report module and take appropriate action if necessary.',
        targetModule: 'client-report',
      },
      {
        id: 'feed-message-1',
        icon: 'fa-message',
        title: 'New message from Romeo Montoya',
        meta: 'Today · 1:30 PM',
        detail: 'Good afternoon, I would like to inquire about the upcoming GI registration process for my farm.',
        targetModule: 'messaging',
        targetPayload: { phone: '+63 912 345 6789' },
      },
      {
        id: 'feed-profile-1',
        icon: 'fa-user-check',
        title: 'Profile Verified: Maria Santos',
        meta: 'Yesterday · 10:00 AM',
        detail: 'The profile for farmer Maria Santos (No. #5) has been successfully verified and added to the registry.',
        targetModule: 'farmers-list',
        targetPayload: { farmerNo: 5 },
      },
      {
        id: 'feed-system-1',
        icon: 'fa-server',
        title: 'System Maintenance Completed',
        meta: 'May 22 · 11:30 PM',
        detail:
          'The scheduled system maintenance and database optimization have been completed successfully. All services are fully operational.',
        targetModule: 'overview',
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
      detail: row.detail || row.message || '',
      category: row.category || '',
      categoryLabel: row.category_label || '',
      targetModule: row.targetModule || row.target_module || '',
      targetId: row.targetId || row.target_id || '',
      targetPayload: row.targetPayload || row.target_payload || null,
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
    const detail = row.details || '';
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

  deleteNotification(id) {
    const idx = this.notificationsFeed.findIndex((n) => n.id === id);
    if (idx === -1) return;
    this.notificationsFeed.splice(idx, 1);
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

    // Handle navigation action if targetModule exists
    if (n.targetModule) {
      this.switchModule(n.targetModule);
      
      // Additional logic for specific modules
      if (n.targetModule === 'messaging' && n.targetPayload?.phone) {
        this.goToFarmerMessage(n.targetPayload.phone);
      } else if (n.targetModule === 'farmers-list' && n.targetPayload?.farmerNo) {
        this.openFarmerProfile(n.targetPayload.farmerNo);
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

  applyAccountProfilePhoto(photoUrl, displayName) {
    const avatar = document.getElementById('accountProfileAvatar');
    const img = document.getElementById('accountProfileAvatarImg');
    const placeholder = document.getElementById('accountProfileAvatarPlaceholder');
    if (!avatar || !img) return;

    if (photoUrl) {
      const resolved = beanthenticApiUrl(photoUrl.split('?')[0]);
      const query = photoUrl.includes('?') ? photoUrl.slice(photoUrl.indexOf('?')) : '';
      const cacheBust = query ? `${resolved}${query}&t=${Date.now()}` : `${resolved}?t=${Date.now()}`;
      img.src = cacheBust;
      img.alt = displayName ? `${displayName} profile photo` : 'Profile photo';
      img.removeAttribute('hidden');
      avatar.classList.add('has-photo');
      if (placeholder) placeholder.style.display = 'none';
    } else {
      img.removeAttribute('src');
      img.setAttribute('hidden', '');
      avatar.classList.remove('has-photo');
      if (placeholder) placeholder.style.display = '';
    }
  }

  openProfilePhotoModal() {
    const root = document.getElementById('profilePhotoModal');
    if (!root) return;
    root.removeAttribute('hidden');
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('confirm-dialog-active');
    document.getElementById('profilePhotoUploadBtn')?.focus();
  }

  closeProfilePhotoModal() {
    this.stopProfilePhotoCamera();
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

  async startProfilePhotoCamera(deviceId) {
    const panel = document.getElementById('profilePhotoCameraPanel');
    const video = document.getElementById('profilePhotoVideo');
    const select = document.getElementById('profilePhotoCameraSelect');
    if (!panel || !video) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      this.showNotification('Camera is not supported in this browser.', 'error');
      return;
    }

    try {
      this.stopProfilePhotoCamera();
      panel.removeAttribute('hidden');

      let cameras = await this.listProfilePhotoCameras();
      const needsPermission = cameras.every((d) => !(d.label || '').trim());
      if (needsPermission) {
        const bootstrap = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
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
        ? { deviceId: { exact: chosenId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } };

      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false,
      });
      this._profilePhotoStream = stream;
      video.srcObject = stream;
      await video.play();

      const active = cameras.find((d) => d.deviceId === chosenId);
      this.updateProfilePhotoCameraHint(active?.label || stream.getVideoTracks()[0]?.label || '');
    } catch (err) {
      this.showNotification('Could not access the camera. Check permissions and try again.', 'error');
      console.error(err);
    }
  }

  async uploadProfilePhotoBlob(blob, filename) {
    if (!blob) {
      this.showNotification('No photo to upload.', 'error');
      return;
    }
    const fd = new FormData();
    const uploadName =
      filename ||
      (blob.type === 'image/png' ? 'profile.png' : blob.type === 'image/webp' ? 'profile.webp' : 'profile.jpg');
    fd.append('action', 'upload_profile_photo');
    fd.append('photo', blob, uploadName);
    try {
      const res = await fetch(beanthenticApiUrl('/api/admin-profile-photo'), {
        method: 'POST',
        body: fd,
        credentials: 'same-origin',
      });
      const result = await beanthenticParseJsonResponse(res);
      if (!res.ok || result.error) throw new Error(result.error || 'Could not update profile photo.');
      const heroName = document.getElementById('accountHeroName')?.textContent || 'Admin';
      this.applyAccountProfilePhoto(result.profile_photo_url, heroName);
      this.showNotification(result.success || 'Profile photo updated.', 'success');
      this.closeProfilePhotoModal();
    } catch (err) {
      this.showNotification(err.message || 'Could not update profile photo.', 'error');
    }
  }

  async captureProfilePhotoFromCamera() {
    const video = document.getElementById('profilePhotoVideo');
    const canvas = document.getElementById('profilePhotoCanvas');
    if (!video || !canvas || !video.videoWidth) {
      this.showNotification('Camera is not ready yet.', 'error');
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

    if (editBtn) editBtn.addEventListener('click', () => this.openProfilePhotoModal());
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
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!root || root.hasAttribute('hidden')) return;
      e.preventDefault();
      this.closeProfilePhotoModal();
    });
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
      const res = await fetch('/api/admin-account/deactivate', { method: 'POST', body: fd });
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
    // Initialize new dashboard features
    this.initNewDashboardFeatures();
    // Initialize Account module
    this.initAccountModule();
    // Initialize Farmer's Contribution module
    this.initBeanthenticContributions();
    // Initialize Farmer Profile tabs
    this.initFarmerProfileTabs();
    // Initialize Map Layer Toggles
    this.initMapLayerToggles();
    // Initialize Farmer Admin Actions Modal
    this.initFarmerActionModal();
    // Start global suspension timers
    this.startSuspensionTimers();

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
    const anyUnread = (this.notificationsFeed || []).some((n) => !n.read && n.targetModule);
    markAllBtn.disabled = !anyUnread;
  }

  updateHeaderNotificationBadge() {
    const badge = document.getElementById('headerNotificationBadge');
    if (!badge) return;
    const unread = (this.notificationsFeed || []).filter((n) => !n.read && n.targetModule).length;
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

    const rows = (this.notificationsFeed || []).filter(n => n.targetModule);
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
    return msg;
  }

  varietyLabel(variety) {
    const v = String(variety || '').toLowerCase();
    if (v === 'liberica') return 'Liberica';
    if (v === 'excelsa') return 'Excelsa';
    if (v === 'robusta') return 'Robusta';
    return variety || '—';
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

  applyTransactionsFiltersAndRender() {
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
      const res = await fetch('/api/farmer-picker');
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
    tbody.innerHTML = '<tr><td colspan="9" class="transactions-loading-cell">Loading...</td></tr>';

    try {
      const res = await fetch('/api/transactions-list?limit=500');
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
    const productText =
      (row.product || this.varietyLabel(row.variety) || row.variety || '-').toString();
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
    tbody.innerHTML = '<tr><td colspan="5" class="transactions-loading-cell">Loading...</td></tr>';

    try {
      const res = await fetch('/api/client-reports-list?limit=1000', { credentials: 'same-origin' });
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
      this.applyClientReportFiltersAndRender();
    } catch (e) {
      console.warn('Misconduct reports load failed:', e);
      const msg = this.escapeHtml(String(e.message || e));
      tbody.innerHTML =
        '<tr><td colspan="5" class="transactions-error-cell">Could not load reports.<br>' +
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
      tbody.innerHTML = '<tr><td colspan="5" class="transactions-error-cell">No reports found.</td></tr>';
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

    return `<tr>
      <td>${this.escapeHtml(dateStr)}</td>
      <td>${this.escapeHtml(timeStr)}</td>
      <td>${farmerLabel}</td>
      <td>${this.escapeHtml(r.allegation || '')}</td>
      <td>
        <div class="report-action-container">
          <button class="take-action-btn" onclick="dashboardApp.openReportActionModal(${r.id})">
            Take Action
          </button>
        </div>
      </td>
    </tr>`;
  }

  async updateMisconductStatus(reportId, newStatus) {
    try {
      const res = await fetch(`/api/misconduct-reports/${reportId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      this.showNotification(`Report #${reportId} updated to ${newStatus}`, 'success');
      await this.loadMisconductReports();
    } catch (e) {
      console.warn('Status update failed:', e);
      this.showNotification('Could not update status.', 'error');
      await this.loadMisconductReports(); // Refresh to revert UI
    }
  }

  openReportActionModal(reportId) {
    const report = (this.misconductReportRows || []).find(r => r.id === reportId);
    if (!report) return;

    if (report.farmer_no) {
      // First switch to the farmers list module
      this.switchModule('farmers-list');
      // Then open the specific farmer's profile
      this.openFarmerProfile(report.farmer_no, 'client-report');
      this.showNotification(`Reviewing report for ${report.farmer_name}`, 'info');
    } else {
      this.showNotification('Farmer record not found for this report.', 'error');
    }
  }

  clientReportStatusLabel(value) {
    const v = String(value || '').toLowerCase();
    if (v === 'blocked') return 'Blocked';
    if (v === 'resolved') return 'Resolved';
    if (v === 'dismissed') return 'Dismissed';
    return 'Open';
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
      messagingBtn.addEventListener('click', () => {
        this.switchModule('messaging');
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
          const n = Number(actionBtn.getAttribute('data-farmer-no'));
          const idx = this.data.findIndex(f => Number(f['NO.']) === n);
          
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

    const farmerProfileMessageBtn = document.getElementById('farmerProfileMessageBtn');
    if (farmerProfileMessageBtn) {
      farmerProfileMessageBtn.addEventListener('click', () => {
        if (!this.currentFarmerNo) return;
        const farmer = (this.data || []).find(f => Number(f['NO.']) === Number(this.currentFarmerNo));
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

    // Farmer Profile Admin Actions
    const profileWarningBtn = document.getElementById('profileWarningBtn');
    if (profileWarningBtn) {
      profileWarningBtn.addEventListener('click', () => {
        // Automatically close dropdown on click
        const profileActionsContent = document.getElementById('profileActionsContent');
        if (profileActionsContent) profileActionsContent.classList.remove('active');

        if (this.currentFarmerNo) {
          const idx = this.data.findIndex(f => Number(f['NO.']) === this.currentFarmerNo);
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
          const idx = this.data.findIndex(f => Number(f['NO.']) === this.currentFarmerNo);
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
    if (resolvedModuleName === 'ipophl') {
      this.renderIpophlModule();
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
      const response = await fetch('/api/farmer-data');
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
        ? apiData.slice(0, this.maxFarmers).map((row) => this.applyOwnershipFlags(row))
        : [];

      if (this.data.length === 0) {
        this.showNotification(
          'Walang farmer records mula sa database (0 rows). Check app_db_host sa settings.json at XAMPP MySQL.',
          'brown'
        );
      }
      
      this.filteredData = [...this.data];
      this.totalRecords = this.data.length;
      
      console.log('Successfully loaded farmer data:', this.data.length, 'records');
      console.log('First farmer:', this.data[0]);
      console.log('Sample of farmers:', this.data.slice(0, 3));
      
      this.updateStats();
      this.createCharts();
      this.updateTable();
      
    } catch (error) {
      console.error('Error loading farmer data:', error);
      
      // 1. Try to fallback to browser backup first
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

      // 2. If no backup, fallback to sample data for demo purposes
      console.log('API and Backup unavailable. Falling back to sample data...');
      this.loadSampleData();
      this.showNotification('Database unreachable. Showing sample farmer records.', 'brown');
      
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
            const n = Number(el.dataset.farmerNo);
            const idx = this.data.findIndex(f => Number(f['NO.']) === n);
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
        if (this.currentFarmerNo) {
          const idx = this.data.findIndex(f => Number(f['NO.']) === this.currentFarmerNo);
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
        grid.innerHTML = `
          <div class="placeholder-content" style="grid-column: 1 / -1; padding: 4rem 2rem;">
            <div class="placeholder-icon"><i class="fa-solid fa-people-group"></i></div>
            <h3>No Farmers Found</h3>
            <p>There are currently no farmer records in the database.</p>
          </div>
        `;
        return;
      }
      grid.innerHTML = Array.from({ length: 6 }, (_, idx) => {
        const n = idx + 1;
        return `<article class="farmer-card" aria-label="Placeholder farmer card ${n}">
  <div class="farmer-card__header">
    <div class="farmer-card__status-badge">Active</div>
    <div class="farmer-card__menu-dots"><i class="fa-solid fa-ellipsis"></i></div>
  </div>
  <div class="farmer-card__media">
    <div class="farmer-card__avatar-circle">
      <i class="fa-solid fa-user" style="font-size: 2rem; color: #cbd5e1;"></i>
    </div>
  </div>
  <div class="farmer-card__identity">
    <h3 class="farmer-card__name">Name</h3>
  </div>
  <div class="farmer-card__inner-box" style="background: #ffffff; border: 1px solid #f1f5f9;">
    <div class="farmer-card__detail-row">
      <i class="fa-solid fa-hashtag"></i>
      <span>#${n}</span>
    </div>
    <div class="farmer-card__detail-row">
      <i class="fa-solid fa-cake-candles"></i>
      <span>Month/Date/Year</span>
    </div>
    <div class="farmer-card__detail-row">
      <i class="fa-solid fa-location-dot"></i>
      <span>Barangay, Municipality, Province</span>
    </div>
    <div class="farmer-card__detail-row">
      <i class="fa-solid fa-phone"></i>
      <span class="farmer-card__pill" style="background: #f8fafc; border: 1px solid #e2e8f0; color: #475569;">+63 900 XXXX XXXX</span>
    </div>
  </div>
  <div class="farmer-card__footer">
    <span class="farmer-card__joined">Joined at 2024</span>
    <button type="button" class="view-details-btn" data-action="open-farmer-placeholder-profile" data-farmer-no="${n}">
      View details <i class="fa-solid fa-chevron-right"></i>
    </button>
  </div>
</article>`;
      }).join('');
      return;
    }

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
        const photo = this.getValue(row, ['PHOTO', 'photo', 'photo_url', 'image']);
        const isBlocked = row.is_blocked === true || row.is_blocked === 'true';
        
        return `<article class="farmer-card" aria-label="${esc(fullName)}">
  <div class="farmer-card__header">
    <div class="farmer-card__status-badge ${isBlocked ? 'is-blocked' : ''}">
      ${isBlocked ? 'Suspended' : 'Active'}
      ${isBlocked && row.suspended_until ? `<span class="suspension-countdown" data-until="${row.suspended_until}" data-farmer-no="${esc(n)}">${this.getSuspensionCountdown(row.suspended_until)}</span>` : ''}
    </div>
    <div class="profile-actions-dropdown">
      <button type="button" class="profile-actions-toggle card-menu-toggle" aria-label="More actions">
        <i class="fa-solid fa-ellipsis"></i>
      </button>
      <div class="profile-actions-content card-menu-content">
        <button type="button" class="profile-action-item warning" data-card-action="warning" data-farmer-no="${esc(n)}">
          <i class="fa-solid fa-triangle-exclamation"></i> Warning
        </button>
        ${!isBlocked ? `
          <button type="button" class="profile-action-item suspend" data-card-action="suspend" data-farmer-no="${esc(n)}">
            <i class="fa-solid fa-user-slash"></i> Suspend
          </button>
        ` : `
          <button type="button" class="profile-action-item unsuspend" data-card-action="unsuspend" data-farmer-no="${esc(n)}">
            <i class="fa-solid fa-user-check"></i> Unsuspend
          </button>
        `}
      </div>
    </div>
  </div>
  <div class="farmer-card__media">
    <div class="farmer-card__avatar-circle">
      ${photo ? `<img class="farmer-card__image" src="${esc(photo)}" alt="${esc(fullName)}" loading="lazy" />` : `<i class="fa-solid fa-user" style="font-size: 2rem; color: #cbd5e1;"></i>`}
    </div>
  </div>
  <div class="farmer-card__identity">
    <h3 class="farmer-card__name">${esc(fullName)}</h3>
  </div>
  <div class="farmer-card__inner-box" style="background: #ffffff; border: 1px solid #f1f5f9;">
    <div class="farmer-card__detail-row">
      <i class="fa-solid fa-hashtag"></i>
      <span>#${esc(n)}</span>
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
    <span class="farmer-card__joined">Joined at 2024</span>
    <button type="button" class="view-details-btn" data-action="open-farmer-profile" data-farmer-no="${esc(n)}">
      View details <i class="fa-solid fa-chevron-right"></i>
    </button>
  </div>
</article>`;
      })
      .join('');
  }

  openFarmerProfile(farmerNo, source = 'profiles') {
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

    const farmer = (this.data || []).find((r) => Number(r['NO.']) === Number(farmerNo));
    if (!farmer) {
      this.showNotification('Farmer not found.', 'error');
      return;
    }

    this.currentFarmerNo = Number(farmerNo);
    this.updateProfileStatusButtons(farmer.is_blocked === true || farmer.is_blocked === 'true');

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

    setText('farmerProfileLastNameText', this.getValue(farmer, ['LAST NAME', 'last_name']) || nameParts.last);
    setText('farmerProfileFirstNameText', this.getValue(farmer, ['FIRST NAME', 'first_name']) || nameParts.first);
    setText('farmerProfileProvinceText', this.getValue(farmer, ['PROVINCE', 'province']) || 'Batangas');
    setText('farmerProfileMunicipalityText', this.getValue(farmer, ['MUNICIPALITY', 'municipality', 'CITY']) || 'Lipa City');
    setText('farmerProfileBarangayText', this.getValue(farmer, ['BARANGAY', 'ADDRESS (BARANGAY)', 'barangay']) || '');
    setText('farmerProfileFederationText', this.getValue(farmer, ['FA OFFICER / MEMBER', 'FEDERATION', 'Federation Association']) || '');
    setText('farmerProfileRsbsaText', this.getValue(farmer, ['REGISTERED (YES/NO)', 'RSBSA Registered']) || '');
    setText('farmerProfileRsbsaNumberText', this.getValue(farmer, ['NCFRS', 'RSBSA Registered Number']) || '');
    setText('farmerProfileOwnershipText', this.getValue(farmer, ['STATUS OF OWNERSHIP', 'Status Ownership']) || '');
    setText(
      'farmerProfileTotalAreaText',
      this.formatValue(this.getValue(farmer, ['TOTAL AREA PLANTED (HA.)', 'Total Plant Area', 'TOTAL AREA']) || '')
    );

    // Populate Detailed Registration Fields
    setText('farmerProfileLibBearingText', this.getValue(farmer, ['LIBERICA BEARING', 'Liberica_Bearing']) || '0');
    setText('farmerProfileLibNonBearingText', this.getValue(farmer, ['LIBERICA NON-BEARING', 'Liberica_Non-bearing']) || '0');
    setText('farmerProfileRobBearingText', this.getValue(farmer, ['ROBUSTA BEARING', 'Robusta_Bearing']) || '0');
    setText('farmerProfileRobNonBearingText', this.getValue(farmer, ['ROBUSTA NON-BEARING', 'Robusta_Non-bearing']) || '0');
    setText('farmerProfileExcBearingText', this.getValue(farmer, ['EXCELSA BEARING', 'Excelsa_Bearing']) || '0');
    setText('farmerProfileExcNonBearingText', this.getValue(farmer, ['EXCELSA NON-BEARING', 'Excelsa_Non-bearing']) || '0');

    setText('farmerProfileLibProdText', this.getValue(farmer, ['LIBERICA PRODUCTION', 'Liberica_Production']) || '0');
    setText('farmerProfileRobProdText', this.getValue(farmer, ['ROBUSTA PRODUCTION', 'Robusta_Production']) || '0');
    setText('farmerProfileExcProdText', this.getValue(farmer, ['EXCELSA PRODUCTION', 'Excelsa_Production']) || '0');
    setText('farmerProfileProdUnitText', this.getValue(farmer, ['PRODUCTION UNIT', 'Production_Unit']) || 'kg');

    // Populate Bean Summary
    this.initBeanVarietyFilters(farmer);

    // Populate Transactions for this specific farmer
    const farmerId = this.getValue(farmer, ['farmer_id', 'id', 'NO.', 'NO']);
    this.populateFarmerTransactions(farmerId, fullName);

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

    // Fallback to placeholder if no data
    if (initialBeans === 0) initialBeans = variety === 'All' ? 50 : 15;

    // Example calculation for remaining: 85% of initial or fixed offset
    const beansRemaining = Math.max(0, Math.floor(initialBeans * 0.14)); // Roughly 7KG if 50KG

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
        `/api/transactions-list?farmer_id=${encodeURIComponent(farmerId)}&limit=100`
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
            <td style="background: #ffffff;">${this.escapeHtml(t.variety || 'Coffee Beans')}</td>
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
    setText('farmerProfileRsbsaNumberText', 'NCFRS-0000');
    setText('farmerProfileOwnershipText', 'Landowner / Lease / Others');
    setText('farmerProfileTotalAreaText', '0.00');

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
            ? 6
            : this.farmerTableView === 'affiliation'
              ? 8
              : this.farmerTableView === 'farm'
                ? 9
              : 5;
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
              this.createInputCell(this.getValue(row, ['TOTAL TREES', 'TOTAL_TREES']), 'number', 'highlight-green')
            ]
          : this.farmerTableView === 'production'
            ? [
                this.createInputCell(displayNo, 'number'),
                this.createInputCell(nameParts.last, 'text'),
                this.createInputCell(nameParts.first, 'text'),
                this.createInputCell(this.getValue(row, ['LIBERICA PRODUCTION', 'Liberica_Production']), 'number', 'highlight-blue'),
                this.createInputCell(this.getValue(row, ['EXCELSA PRODUCTION', 'Excelsa_Production']), 'number', 'highlight-blue'),
                this.createInputCell(this.getValue(row, ['ROBUSTA PRODUCTION', 'Robusta_Production']), 'number', 'highlight-blue')
              ]
          : this.farmerTableView === 'affiliation'
            ? [
                this.createInputCell(displayNo, 'number'),
                this.createInputCell(nameParts.last, 'text'),
                this.createInputCell(nameParts.first, 'text'),
                this.createInputCell(this.getValue(row, ['FA OFFICER / MEMBER', 'FA Officer / member', 'officer']), 'text'),
                this.createRSBSABadge(this.getValue(row, ['RSBSA Registered (Yes/No)', 'REGISTERED (YES/NO)', 'Registered (Yes/No)', 'registered'])),
                this.createInputCell(this.getValue(row, ['RSBSA NUMBER', 'rsbsa_number']), 'text'),
                this.createRSBSAStatusBadge(
                  this.getValue(row, ['RSBSA Registered (Yes/No)', 'REGISTERED (YES/NO)', 'Registered (Yes/No)', 'registered']),
                  this.getValue(row, ['RSBSA STATUS', 'RSBSA Status', 'rsbsa_status', 'status'])
                ),
                this.createInputCell(this.getValue(row, ['NCFRS', 'ncfrs']), 'text')
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
                this.createInputCell(this.getValue(row, ['Total Area Planted (HA.)', 'TOTAL AREA PLANTED (HA.)', 'area']), 'number')
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
    const res = await fetch('/api/farmer-account-action', {
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
      throw new Error(data.error || data.detail || `HTTP ${res.status}`);
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
      const farmer = (this.data || []).find(f => {
        const no = f['NO.'] || f['no'] || f['No'] || f['id'] || f['ID'];
        return Number(no) === Number(this.currentFarmerNo);
      });

      if (farmer && farmer.suspended_until && countdownContainer && timerEl) {
        countdownContainer.hidden = false;
        countdownContainer.style.setProperty('display', 'flex', 'important');
        timerEl.dataset.until = farmer.suspended_until;
        timerEl.dataset.farmerNo = this.currentFarmerNo;
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

    this.data.push(newRow);
    this.filteredData = [...this.data];
    this.totalRecords = this.data.length;
    this.currentPage = Math.max(1, Math.ceil(this.filteredData.length / this.pageSize));
    this.updateTable();
    this.updateStats();
    this.closeAddFarmerModal();
    this.showNotification('New farmer row added!', 'success');
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
    const map = {
      landowner: { LANDOWNER: 'X' },
      cloa_holder: { CLOA: 'X' },
      'cloa holder': { CLOA: 'X' },
      list_holder: { LEASE: 'X' },
      'list holder': { LEASE: 'X' },
      sessional_farm_worker: { SEASONAL: 'X' },
      'sessional farm worker': { SEASONAL: 'X' },
      others: { OTHERS: 'X' },
      owner: { LANDOWNER: 'X' },
      owned: { LANDOWNER: 'X' },
      tenant: { SEASONAL: 'X' },
      lessee: { LEASE: 'X' },
      'co-owner': { CLOA: 'X' },
      co_owner: { CLOA: 'X' },
      coowner: { CLOA: 'X' },
      other: { OTHERS: 'X' },
    };
    const flags = map[status];
    if (!flags) return row;
    return { ...row, ...flags };
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
    const totalProduction = this.data.reduce((sum, farmer) => 
      sum + (farmer['LIBERICA PRODUCTION'] || 0) + (farmer['EXCELSA PRODUCTION'] || 0) + (farmer['ROBUSTA PRODUCTION'] || 0), 0
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
    this.createTreeDistributionChart();
    this.createProductionChart();
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

  async renderAnalyticsModule() {
    const analyticsRoot = document.getElementById('analytics-module');
    if (!analyticsRoot || analyticsRoot.classList.contains('hidden')) return;
    if (!window.Chart) return;

    const metrics = await this.computeGiAnalyticsAsync();
    const total = Math.max(metrics.total, 1);
    const eligibleRate = (metrics.eligible / total) * 100;
    const mlNote = metrics.mlEnabled ? ' · ML' : '';

    this.setText('giEligibleCount', metrics.eligible.toLocaleString());
    this.setText('giEligibleRate', `${eligibleRate.toFixed(1)}% of farmers${mlNote}`);
    this.setText('cityGiReadinessRate', `${eligibleRate.toFixed(1)}%`);

    const ipophlSnapshot = this.getIpophlCompletionSnapshot();
    this.setText('ipophlProgressRate', `${ipophlSnapshot.percentage}%`);
    this.setText('ipophlProgressSub', `${ipophlSnapshot.completed} of ${ipophlSnapshot.total} groups`);

    this.renderTopBarangaysChart(metrics);
    this.renderGiGrowthTrendChart(metrics);
    this.renderIpophlComplianceChart();
  }

  async computeGiAnalyticsAsync() {
    const base = this.computeGiAnalytics();
    const rows = Array.isArray(this.data) ? this.data : [];
    if (!rows.length) {
      return { ...base, mlEnabled: false };
    }

    try {
      const res = await fetch(beanthenticApiUrl('/api/ml/farmer-readiness'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ farmers: rows }),
      });
      const data = await beanthenticParseJsonResponse(res);
      if (!res.ok || !data.success || !Array.isArray(data.predictions)) {
        return { ...base, mlEnabled: false };
      }

      let eligible = 0;
      const eligibilityByIndex = data.predictions.map((p) => {
        const ready = !!p.gi_ready;
        if (ready) eligible += 1;
        return ready;
      });
      const notEligible = rows.length - eligible;

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
          trendLabels.push(d.toLocaleString(undefined, { month: 'short', year: '2-digit' }));
          trendValues.push(cumulativeReady);
        }
      }

      return {
        ...base,
        eligible,
        notEligible,
        eligibilityByIndex,
        trendLabels,
        trendValues,
        mlEnabled: true,
        analysisMethod: data.analysis_method || 'ml_farmer',
      };
    } catch (err) {
      console.warn('ML analytics fallback to rules:', err);
      return { ...base, mlEnabled: false };
    }
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

    const total = 13; // Explicitly set to 13 document groups
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

  onGoogleMapsReady() {
    this.googleMapsReady = true;
    this.renderMapsModule();
  }

  initMapLayerToggles() {
    const toggles = [
      { id: 'toggleFarmerLocations', layer: 'farmerLocations' },
      { id: 'toggleFarmBoundaries', layer: 'farmBoundaries' },
      { id: 'toggleDensityHeatmap', layer: 'densityHeatmap' },
      { id: 'toggleRoadNetwork', layer: 'roadNetwork' },
    ];

    toggles.forEach(({ id, layer }) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('click', (e) => {
          e.preventDefault();
          this.mapLayers[layer] = !this.mapLayers[layer];
          el.classList.toggle('is-on', this.mapLayers[layer]);
          this.updateMapLayers();
        });
      }
    });
  }

  updateMapLayers() {
    if (!this.googleMap || !window.google?.maps) return;

    // 1. Farmer Locations
    this.googleMapMarkers.forEach((m) => m.setMap(this.mapLayers.farmerLocations ? this.googleMap : null));

    // 2. Farm Boundaries
    if (this.lipaBoundaryOverlay) {
      this.lipaBoundaryOverlay.setMap(this.mapLayers.farmBoundaries ? this.googleMap : null);
    }

    // 3. Density Heatmap
    if (this.mapLayers.densityHeatmap) {
      this.showDensityHeatmap();
    } else if (this.googleHeatmap) {
      this.googleHeatmap.setMap(null);
    }

    // 4. Road Network
    this.googleMap.setOptions({
      styles: this.mapLayers.roadNetwork
        ? []
        : [{ featureType: 'road', elementType: 'all', stylers: [{ visibility: 'off' }] }],
    });
  }

  showDensityHeatmap() {
    if (!window.google?.maps?.visualization) {
      console.warn('Google Maps Visualization library not loaded.');
      return;
    }

    const rows = this.getFilteredMapRows();
    const heatmapData = rows
      .map((row) => {
        const raw = this.getValue(row, ['ADDRESS (BARANGAY)', 'BARANGAY', 'barangay', 'address']);
        const canonical = this.getCanonicalLipaBarangay(raw);
        if (!canonical) return null;
        const coords = this.getBarangayCoordinates()[canonical];
        return coords ? new window.google.maps.LatLng(coords.lat, coords.lng) : null;
      })
      .filter(Boolean);

    if (!this.googleHeatmap) {
      this.googleHeatmap = new window.google.maps.visualization.HeatmapLayer({
        data: heatmapData,
        map: this.googleMap,
        radius: 30,
      });
    } else {
      this.googleHeatmap.setData(heatmapData);
      this.googleHeatmap.setMap(this.googleMap);
    }
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
    const canonical = aliases[key] || key;
    return this.getLipaPdfBarangayWhitelist().has(canonical) ? canonical : null;
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
    const key = (this.mapVarietyFilter || 'liberica').toString().trim().toLowerCase();
    if (key === 'robusta') return 'robusta';
    if (key === 'excelsa') return 'excelsa';
    return 'liberica';
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

    return visibleBarangays.map((canonical) => {
      const coords = coordsByBarangay[canonical] || toFallbackCoordinate(canonical);
      const s = summary[canonical] || {
        farmers: 0,
        areaHa: 0,
        productionKg: { liberica: 0, excelsa: 0, robusta: 0 },
        varietyFarmers: { liberica: 0, excelsa: 0, robusta: 0 },
      };
      return {
        barangay: this.formatBarangayLabel(canonical),
        canonical,
        lat: coords.lat,
        lng: coords.lng,
        count: Number(s.varietyFarmers?.[varietyKey] || 0),
        totalFarmers: Number(s.farmers || 0),
        areaHa: Number(s.areaHa || 0),
        productionKg: Number(s.productionKg?.[varietyKey] || 0),
      };
    }).filter((point) => point.count > 0);
  }

  drawLipaCityBoundary() {
    if (!this.googleMap || !window.google?.maps) return;
    if (this.lipaBoundaryOverlay) {
      this.lipaBoundaryOverlay.setMap(this.mapLayers.farmBoundaries ? this.googleMap : null);
      return;
    }
    this.lipaBoundaryOverlay = new window.google.maps.Rectangle({
      bounds: this.getLipaCityBounds(),
      strokeColor: '#047857',
      strokeOpacity: 1.0,
      strokeWeight: 2,
      fillColor: 'transparent',
      fillOpacity: 0,
      clickable: false,
      map: this.mapLayers.farmBoundaries ? this.googleMap : null,
    });
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
      const rawBarangay = this.getValue(row, ['ADDRESS (BARANGAY)', 'BARANGAY', 'barangay', 'address']);
      const barangay = this.normalizeBarangayName(rawBarangay);
      const canonical = this.getCanonicalLipaBarangay(rawBarangay);
      const searchableBarangay = canonical || barangay;
      const lipaBarangayOk = !!canonical;
      const searchOk = !this.mapSearchTerm || searchableBarangay.includes(this.mapSearchTerm);
      const varietyOk = this.isVarietyMatch(row, this.mapVarietyFilter || 'liberica');
      return lipaBarangayOk && searchOk && varietyOk;
    });
  }

  buildMapBarangayPoints(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return this.buildMapBarangayPointsFromPdf();
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
      const coords = coordsByBarangay[canonical] || toFallbackCoordinate(canonical);
      const current = pointsMap.get(canonical) || {
        barangay: this.formatBarangayLabel(canonical),
        canonical,
        lat: coords.lat,
        lng: coords.lng,
        count: 0,
      };
      current.count += 1;
      pointsMap.set(canonical, current);
    });

    return Array.from(pointsMap.values());
  }

  updateMapInsights(points, rows) {
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
    if (topList) {
      const sorted = points
        .map((point) => ({
          canonical: point.canonical || this.normalizeBarangayName(point.barangay),
          label: point.barangay || this.formatBarangayLabel(point.canonical),
          count: Number(point.count || 0),
          lat: Number(point.lat),
          lng: Number(point.lng),
        }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

      topList.innerHTML = sorted
        .map((p) => {
          const tier = this.densityTier(p.count);
          const coords = this.formatCoordinatePill(p.lat, p.lng);
          return `<li><span><em class="dot dot--${tier}"></em>${p.label}<small style="display:block; font-size:11px; color:#6b7280;">${coords}</small></span><strong>${p.count}</strong></li>`;
        })
        .join('');
      if (!sorted.length) topList.innerHTML = '<li><span>No matching barangays</span><strong>0</strong></li>';
    }

    const treesTotalEl = document.querySelector('#maps-module .trees-total-card strong');
    const treesTotalLabelEl = document.querySelector('#maps-module .trees-total-card span');
    const treesMini = document.querySelectorAll('#maps-module .trees-mini-grid strong');
    const treesMiniLabels = document.querySelectorAll('#maps-module .trees-mini-grid span');
    if (usePdf) {
      const activeVarietyFarmers = points.reduce((sum, point) => sum + (Number(point.count) || 0), 0);
      const activeVarietyProduction = points.reduce((sum, point) => sum + (Number(point.productionKg) || 0), 0);
      if (treesTotalEl) treesTotalEl.textContent = `${activeVarietyProduction.toLocaleString()} kg`;
      if (treesTotalLabelEl) treesTotalLabelEl.textContent = `${this.getPdfVarietyKey().toUpperCase()} Production`;
      if (treesMini[0]) treesMini[0].textContent = activeVarietyFarmers ? (activeVarietyProduction / activeVarietyFarmers).toFixed(1) : '0';
      if (treesMini[1]) treesMini[1].textContent = activeVarietyFarmers.toLocaleString();
      if (treesMiniLabels[0]) treesMiniLabels[0].textContent = 'kg/farmer';
      if (treesMiniLabels[1]) treesMiniLabels[1].textContent = 'Variety Farmers';
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

  getBarangayPinIcon(point) {
    const opacity = point.count > 0 ? 1 : 0.72;
    // Simple green map-pin SVG with white center.
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="44" height="64" viewBox="0 0 44 64">
        <path d="M22 2C11.5 2 3 10.5 3 21c0 14 19 41 19 41s19-27 19-41C41 10.5 32.5 2 22 2z" fill="#047857" stroke="#065f46" stroke-width="2"/>
        <circle cx="22" cy="21" r="9.5" fill="#ffffff"/>
      </svg>
    `.trim();
    const encoded = encodeURIComponent(svg);
    return {
      url: `data:image/svg+xml;charset=UTF-8,${encoded}`,
      scaledSize: new window.google.maps.Size(32, 46),
      anchor: new window.google.maps.Point(16, 45),
      labelOrigin: new window.google.maps.Point(16, 20),
      opacity,
    };
  }

  ensureGoogleMap() {
    if (this.googleMap || !window.google?.maps) return;
    const canvas = document.getElementById('mapsGoogleCanvas');
    if (!canvas) return;
    this.googleMap = new window.google.maps.Map(canvas, {
      center: this.getLipaCityCenter(),
      zoom: 12,
      minZoom: 6,
      maxZoom: 18,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      styles: this.mapLayers.roadNetwork
        ? []
        : [{ featureType: 'road', elementType: 'all', stylers: [{ visibility: 'off' }] }],
    });
    this.googleInfoWindow = new window.google.maps.InfoWindow();
    this.drawLipaCityBoundary();
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
      const pinIcon = this.getBarangayPinIcon(point);
      const marker = new window.google.maps.Marker({
        position: { lat: point.lat, lng: point.lng },
        map: this.mapLayers.farmerLocations ? this.googleMap : null,
        title: `${point.barangay} (${point.count})`,
        icon: {
          url: pinIcon.url,
          scaledSize: pinIcon.scaledSize,
          anchor: pinIcon.anchor,
          labelOrigin: pinIcon.labelOrigin,
        },
        opacity: pinIcon.opacity,
        // No label (number) on pin
      });
      marker.addListener('click', () => {
        if (!this.googleInfoWindow) return;
        this.updateMapCoordPill(point.lat, point.lng);
        this.googleInfoWindow.setContent(
          `<div style="min-width:190px"><strong>${point.barangay}</strong><br/>Farmers: ${point.count}<br/>Coordinates: ${this.formatCoordinatePill(
            point.lat,
            point.lng
          )}<br/>Variety: ${(
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


  renderMapsModule() {
    const fallback = document.getElementById('mapsGoogleFallback');
    const canvas = document.getElementById('mapsGoogleCanvas');
    const embed = document.getElementById('mapsGoogleEmbed');
    const hasKey = !!(window.__GOOGLE_MAPS_API_KEY__ || '').trim();
    const ready = this.googleMapsReady || !!window.__BEANTHENTIC_GOOGLE_MAPS_READY__;
    const rows = this.getFilteredMapRows();
    const points = this.buildMapBarangayPoints(rows);

    this.updateMapInsights(points, rows);
    this.updateMapCoordPill(this.getLipaCityCenter().lat, this.getLipaCityCenter().lng);
    if (!canvas) return;

    // No API key: fall back to Google Maps embed centered on Lipa City.
    if (!hasKey) {
      if (fallback) fallback.hidden = true;
      canvas.classList.add('is-hidden');
      if (embed) embed.classList.remove('is-hidden');
      return;
    }

    if (!ready || !window.google?.maps) {
      if (fallback) fallback.hidden = false;
      if (embed) embed.classList.add('is-hidden');
      canvas.classList.add('is-hidden');
      return;
    }

    if (fallback) fallback.hidden = true;
    if (embed) embed.classList.add('is-hidden');
    canvas.classList.remove('is-hidden');
    this.ensureGoogleMap();
    if (this.googleMap && window.google?.maps?.event) {
      window.google.maps.event.trigger(this.googleMap, 'resize');
    }
    this.renderGoogleMapMarkers(points);
    if (this.mapLayers.densityHeatmap) {
      this.showDensityHeatmap();
    } else if (this.googleHeatmap) {
      this.googleHeatmap.setMap(null);
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
  initFarmerActionModal() {
    const root = document.getElementById('farmerActionModal');
    const cancelBtn = document.getElementById('farmerActionCancel');
    const okBtn = document.getElementById('farmerActionConfirm');
    if (!root || !cancelBtn || !okBtn) return;

    const backdrop = root.querySelector('.confirm-dialog__backdrop');
    cancelBtn.addEventListener('click', () => this.closeFarmerActionModal());
    if (backdrop) backdrop.addEventListener('click', () => this.closeFarmerActionModal());

    okBtn.addEventListener('click', () => {
      const reason = (document.getElementById('farmerActionReason')?.value || '').trim();
      if (!reason) {
        this.showNotification('Please enter a reason for this action.', 'error');
        return;
      }

      const action = root.dataset.action;
      const idx = Number.parseInt(root.dataset.farmerIdx, 10);
      if (Number.isNaN(idx)) return;

      if (action === 'warning') {
        this.handleWarningFarmer(idx, reason).then(() => this.closeFarmerActionModal());
        return;
      }
      if (action === 'suspend') {
        this.handleBlockFarmer(idx, reason).then(() => {
          this.updateProfileStatusButtons(true);
          this.renderFarmersListCards();
          this.renderTableBody();
          this.closeFarmerActionModal();
        });
        return;
      }

      this.renderFarmersListCards();
      this.renderTableBody();
      this.closeFarmerActionModal();
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
    this.initThemeToggle();
    this.initGlobalSearch();
    this.updateNotificationBadges();
    this.initLastUpdatedTime();
    this.initCalendarWidget();
    this.initRegistrationChart();
  }

  initRegistrationChart() {
    const ctx = document.getElementById('registrationVolumeChart');
    if (!ctx) return;

    const data = {
      labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
      datasets: [{
        label: 'New Registrations',
        data: [65, 78, 92, 85, 110, 125],
        backgroundColor: 'rgba(34, 197, 94, 0.2)',
        borderColor: '#16a34a',
        borderWidth: 2,
        fill: true,
        tension: 0.4,
        pointBackgroundColor: '#16a34a',
        pointRadius: 4,
        pointHoverRadius: 6
      }]
    };

    const config = {
      type: 'line',
      data: data,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false
          },
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
              label: (context) => `Registrations: ${context.parsed.y}`
            }
          }
        },
        scales: {
          x: {
            grid: {
              display: false
            },
            ticks: {
              font: {
                size: 11
              },
              color: '#94a3b8'
            }
          },
          y: {
            beginAtZero: true,
            grid: {
              color: '#f1f5f9'
            },
            ticks: {
              stepSize: 20,
              font: {
                size: 11
              },
              color: '#94a3b8'
            }
          }
        }
      }
    };

    this.charts.registrationChart = new Chart(ctx, config);
  }

  initCalendarWidget() {
    const monthEl = document.getElementById('calendarMonth');
    const daysEl = document.getElementById('calendarDays');
    const prevBtn = document.getElementById('prevMonth');
    const nextBtn = document.getElementById('nextMonth');
    if (!daysEl) return;

    const today = new Date();
    let viewDate = new Date(today.getFullYear(), today.getMonth(), 1);
    let selectedDay = null;

    const render = () => {
      const year = viewDate.getFullYear();
      const month = viewDate.getMonth();
      const firstDay = new Date(year, month, 1).getDay();
      const daysInMonth = new Date(year, month + 1, 0).getDate();

      if (monthEl) {
        monthEl.textContent = viewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      }

      daysEl.innerHTML = '';

      for (let i = 0; i < firstDay; i++) {
        daysEl.insertAdjacentHTML('beforeend', '<div class="calendar-day empty" aria-hidden="true"></div>');
      }

      for (let d = 1; d <= daysInMonth; d++) {
        const cellDate = new Date(year, month, d);
        const dow = cellDate.getDay();
        const isToday =
          today.getDate() === d && today.getMonth() === month && today.getFullYear() === year;
        const isWeekend = dow === 0 || dow === 6;
        const isSelected = selectedDay === d;
        const classes = ['calendar-day'];
        if (isToday) classes.push('today');
        if (isWeekend) classes.push('weekend');
        if (isSelected) classes.push('selected');

        const cell = document.createElement('div');
        cell.className = classes.join(' ');
        cell.textContent = String(d);
        cell.setAttribute('role', 'gridcell');
        if (isToday) cell.setAttribute('aria-current', 'date');
        cell.addEventListener('click', () => {
          selectedDay = d;
          render();
        });
        daysEl.appendChild(cell);
      }
    };

    if (prevBtn) {
      prevBtn.onclick = () => {
        viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1);
        selectedDay = null;
        render();
      };
    }
    if (nextBtn) {
      nextBtn.onclick = () => {
        viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1);
        selectedDay = null;
        render();
      };
    }

    render();
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

  async loadAccountData() {
    try {
      const response = await fetch(beanthenticApiUrl('/settings/state'), { credentials: 'same-origin' });
      if (!response.ok) throw new Error('Failed to load user data');
      const data = await beanthenticParseJsonResponse(response);

      const user = data.user || {};
      this.applyAccountPersonalInfo(user);
      this.applyAccountProfilePhoto(user.profile_photo_url || null, user.full_name || 'Admin');
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
          const id = Number(item.getAttribute('data-msg-id'));
          if (id) this.openMessagingDetail(id);
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

    listEl.innerHTML = '<li class="messaging-loading"><i class="fa-solid fa-spinner fa-spin"></i><span>Loading chats…</span></li>';

    try {
      // Unified Messenger view: Fetch all messages for the current admin
      let url = `/api/messages?folder=all&limit=500`;
      if (this.messagingSearchTerm) url += `&search=${encodeURIComponent(this.messagingSearchTerm)}`;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
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
      if (!this.messagingSelectedId) {
        const detail = document.getElementById('messagingDetail');
        const placeholder = document.getElementById('messagingNoChatSelected');
        if (detail) detail.style.display = 'none';
        if (placeholder) placeholder.style.display = 'flex';
      }

      this.updateMessagingBadge();
      this.renderMessagingList();
    } catch (err) {
      console.warn('Failed to load chats:', err);
      listEl.innerHTML = '<li class="messaging-list-empty"><i class="fa-solid fa-circle-exclamation"></i><p>Could not load chats. Try refreshing.</p></li>';
    }
  }

  renderMessagingList() {
    const listEl = document.getElementById('messagingList');
    if (!listEl) return;

    if (!this.messagingConversations || !this.messagingConversations.length) {
      listEl.innerHTML = `<li class="messaging-list-empty">
        <i class="fa-solid fa-comment-slash"></i>
        <p>No conversations yet. Start a new chat by searching for a farmer!</p>
      </li>`;
      return;
    }

    const esc = (s) => this.escapeHtml(s);
    
    // Normalize helper for active class comparison
    const normalize = (p) => {
      if (!p) return '';
      let d = String(p).replace(/\D/g, '');
      if (d.startsWith('0')) d = d.substring(1);
      if (d.startsWith('63')) d = d.substring(2);
      return d;
    };

    listEl.innerHTML = this.messagingConversations.map(c => {
      const m = c.latest_message;
      const isUnread = c.unread_count > 0;
      const unreadClass = isUnread ? ' is-unread' : '';
      
      const selectedPhone = normalize(this.messagingSelectedPhone);
      const currentConvPhone = normalize(c.phone);
      const activeClass = (this.messagingSelectedId && (m.id === this.messagingSelectedId || currentConvPhone === selectedPhone)) ? ' is-active' : '';
      
      const displayName = c.name;
      const initials = this.getInitials(displayName);
      const timeStr = this.formatChatListTime(m.created_at);
      
      const prefix = this.isAdminMessage(m) ? 'You: ' : '';
      const preview = prefix + (m.body || '').substring(0, 60);

      return `<li class="messaging-item${unreadClass}${activeClass}" data-phone="${esc(c.phone)}" data-msg-id="${m.id}">
        <div class="messaging-item__avatar">${esc(initials)}</div>
        <div class="messaging-item__content">
          <div class="messaging-item__top">
            <span class="messaging-item__sender">${esc(displayName)}</span>
            <span class="messaging-item__time">${esc(timeStr)}</span>
          </div>
          <div class="messaging-item__preview">${esc(preview)}</div>
        </div>
      </li>`;
    }).join('');

    // Re-attach listeners to list items
    listEl.querySelectorAll('.messaging-item').forEach(item => {
      item.addEventListener('click', () => {
        const phone = item.getAttribute('data-phone');
        const msgId = item.getAttribute('data-msg-id');
        this.messagingSelectedPhone = phone;
        this.openMessagingDetail(msgId);
      });
    });
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
      const initials = this.getInitials(fullName);
      
      return `<li class="messaging-item messaging-contact-item" data-phone="${esc(phone)}">
        <div class="messaging-item__avatar messaging-category-dot--farmer">${esc(initials)}</div>
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
      await fetch(
        `/api/messages/mark-thread-read?phone=${encodeURIComponent(String(farmerPhoneRaw))}`,
        { method: 'POST', headers: { Accept: 'application/json' } }
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
      const res = await fetch(
        `/api/messages/thread?phone=${encodeURIComponent(String(farmerPhoneRaw))}`,
        { headers: { Accept: 'application/json' } }
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
      const avatarInitials = isSentByMe ? 'AD' : this.getInitials(senderName);
      const timeStr = this.bubbleTimestamp(msg.created_at);

      return `
        <div class="messaging-message messaging-message--${direction}">
          <div class="messaging-message__avatar">${esc(avatarInitials)}</div>
          <div class="messaging-message__content">
            <div class="messaging-message__bubble">${esc(msg.body)}</div>
            <div class="messaging-message__timestamp" aria-label="Message time">${esc(timeStr)}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  async sendInlineReply() {
    console.log('sendInlineReply called, selectedId:', this.messagingSelectedId);
    
    if (!this.messagingSelectedId) {
      console.log('No selected ID, returning');
      return;
    }

    const inlineReplyInput = document.getElementById('msgInlineReplyInput');
    console.log('Reply input element:', inlineReplyInput);
    
    const message = (inlineReplyInput?.value || '').trim();
    console.log('Message content:', message);
    
    if (!message) {
      this.showNotification('Message is required.', 'error');
      return;
    }

    const sendBtn = document.getElementById('msgInlineReplySendBtn');
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.setAttribute('aria-busy', 'true');
    }

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

      const subject = (originalMessage && originalMessage.subject && originalMessage.subject.toLowerCase().startsWith('re:'))
        ? originalMessage.subject
        : `Re: ${(originalMessage && originalMessage.subject) || 'Message'}`;

      // Get recipient name from header if originalMessage is missing (for new conversations)
      const headerName = document.getElementById('messagingDetailSenderName')?.textContent || '';

      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          subject,
          body: message,
          category: 'farmers',
          recipient_phone: recipientPhone,
          recipient_name: (originalMessage && (normalize(originalMessage.sender_phone) === target ? originalMessage.sender_name : originalMessage.recipient_name)) || headerName,
          farmer_id: (originalMessage && originalMessage.farmer_id) ?? null,
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
        this.messagingSelectedId = currentMsg.id;
      }

      if (!currentMsg.conversation) {
        currentMsg.conversation = [
          {
            body: currentMsg.body,
            sender_name: currentMsg.sender_name,
            sender_phone: currentMsg.sender_phone,
            sender_role: 'farmer', // Assume the root is from farmer for new chats
            created_at: currentMsg.created_at
          }
        ];
      }
      
      // Don't push if it's the very first message we just put in the thread above
      if (currentMsg.conversation.length === 0 || currentMsg.conversation[currentMsg.conversation.length-1].body !== replyData.body) {
        currentMsg.conversation.push(replyData);
      }

      // Update the conversation view
      const bodyEl = document.getElementById('messagingDetailBody');
      if (bodyEl) {
        bodyEl.innerHTML = this.renderConversation(currentMsg);
        setTimeout(() => bodyEl.scrollTop = bodyEl.scrollHeight, 50);
      }

      this.showNotification('Message sent!', 'success');
      
      // Clear the input field locally
      const inlineReplyInput = document.getElementById('msgInlineReplyInput');
      if (inlineReplyInput) {
        inlineReplyInput.value = '';
        inlineReplyInput.style.height = 'auto';
      }

      // Refresh list and re-render full thread
      this.loadMessagingFolder().then(() => {
        if (this.messagingSelectedId) {
          this.openMessagingDetail(this.messagingSelectedId);
        }
      });
    } catch (err) {
      console.warn('Send reply failed:', err);
      this.showNotification(err.message || 'Could not send reply.', 'error');
    } finally {
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.removeAttribute('aria-busy');
      }
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
    this.closeMessagingCompose(); // Close compose if open
    this.messagingSelectedId = id;
    
    const main = document.getElementById('messagingMain');
    const detail = document.getElementById('messagingDetail');
    const placeholder = document.getElementById('messagingNoChatSelected');
    
    if (main) main.classList.add('has-detail');
    if (placeholder) placeholder.style.display = 'none';
    if (detail) {
      detail.style.display = 'flex';
      detail.classList.add('is-visible');
    }

    // Find the message to get the phone number
    let msg = id ? this.messagingMessages.find(m => String(m.id) === String(id)) : null;

    // Highlight in list
    document.querySelectorAll('.messaging-item').forEach(el => {
      const elId = el.getAttribute('data-msg-id');
      const elPhone = el.getAttribute('data-phone');
      const isActive = id ? String(elId) === String(id) : (newContact && elPhone === newContact.phone);
      el.classList.toggle('is-active', isActive);
    });

    try {
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

      // If not found in local data and we have an ID, try API
      if (!msg && id) {
        const res = await fetch(`/api/messages/${id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        msg = data.message;
        if (!msg) throw new Error('No message data');
      }

      if (!msg) throw new Error('Message not found');

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
        avatarEl.textContent = this.getInitials(displayName);
        avatarEl.className = 'messaging-detail__sender-avatar messaging-detail__sender-avatar--farmer';
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
        if (newContact && !id) {
          bodyEl.innerHTML = '<div class="messaging-list-empty"><p>No messages yet. Send a message to start the conversation!</p></div>';
        } else {
          let thread = await this.fetchConversationThread(this.messagingSelectedPhone);
          if (!thread.length) {
            thread = this.buildConversationThreadForPhone(this.messagingSelectedPhone);
          }
          thread.forEach((t) => {
            if (!this.isAdminMessage(t)) t.is_read = true;
          });
          msg.conversation = thread;
          bodyEl.innerHTML = this.renderConversation(msg);
          setTimeout(() => bodyEl.scrollTop = bodyEl.scrollHeight, 50);
        }
      }

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

      if (this.messagingSelectedPhone && !newContact) {
        await this.markConversationRead(this.messagingSelectedPhone);
        this.renderMessagingList();
      }
    } catch (err) {
      console.warn('Failed to load message detail:', err);
      const bodyEl = document.getElementById('messagingDetailBody');
      if (bodyEl) bodyEl.innerHTML = '<div class="messaging-list-empty"><i class="fa-solid fa-circle-exclamation"></i><p>Could not load this message.</p></div>';
    }
  }

  /**
   * Navigate to messaging module and open a specific farmer's conversation
   */
  async goToFarmerMessage(phone) {
    if (!phone) return;
    
    // Switch to messaging module
    this.switchModule('messaging');
    
    const targetPhone = String(phone).replace(/^\+63|^63|^0/, '');
    
    await this.loadMessagingFolder();
    
    // Search for a conversation with this farmer
    const conv = this.messagingConversations.find(c => {
      const convPhone = String(c.phone || '').replace(/^\+63|^63|^0/, '');
      return convPhone === targetPhone;
    });
    
    if (conv) {
      this.openMessagingDetail(conv.latest_message.id);
    } else {
      // If no conversation exists, open the compose panel
      this.openMessagingCompose(phone);
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
      hideModal();
      await this._performDelete(id);
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
      const initials = this.getInitials(fullName);
      
      return `
        <div class="messaging-contact-dropdown__item" data-phone="${esc(phone)}" data-name="${esc(fullName)}">
          <div class="messaging-contact-dropdown__avatar">${esc(initials)}</div>
          <div class="messaging-contact-dropdown__name">
            ${esc(fullName)}
          </div>
        </div>
      `;
    }).join('');
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
    
    // Find if we already have a conversation with this phone
    const normalize = (p) => String(p || '').replace(/\D/g, '').replace(/^(0|63)/, '');
    const target = normalize(phone);
    const existingMsg = this.messagingMessages.find(m => 
      normalize(m.sender_phone) === target || normalize(m.recipient_phone) === target
    );

    if (existingMsg) {
      this.openMessagingDetail(existingMsg.id);
    } else {
      // Open a "virtual" conversation for this new contact
      this.openMessagingDetail(null, { phone, name });
    }
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
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.setAttribute('aria-busy', 'true');
    }

    try {
      const res = await fetch('/api/messages', {
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
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.removeAttribute('aria-busy');
      }
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
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.setAttribute('aria-busy', 'true');
    }

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
        // Scroll to bottom to show the new message
        bodyEl.scrollTop = bodyEl.scrollHeight;
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

  mapGiContributionItem(item) {
    const status = String(item.upload_status || item.status || 'pending').toLowerCase();
    return {
      id: Number(item.gi_update_id || item.id || 0),
      farmer_id: Number(item.farmer_id || 0),
      farmer: String(item.farmer_name || item.farmer || 'Farmer'),
      farmer_email: String(item.farmer_email || ''),
      subject: String(item.title || item.subject || 'GI Update'),
      preview: String(item.preview || item.content || '').replace(/\s+/g, ' ').trim(),
      content: String(item.content || ''),
      date: this.formatContributionDate(item.created_at),
      status: status === 'archived' ? 'archived' : (status === 'approved' ? 'approved' : 'pending'),
      category: String(item.category || 'general'),
      starred: !!(item.is_starred || item.starred),
      unread: item.unread != null ? !!item.unread : !item.is_read_admin,
      seen: !!(item.is_read_admin || item.seen),
      attachments: Array.isArray(item.attachments) ? item.attachments : [],
    };
  }

  async loadContributionsFromApi() {
    if (this.contributionsLoading) return;
    this.contributionsLoading = true;
    this.contributionsLoadError = '';
    try {
      const res = await fetch('/api/gi-contributions-list?limit=500', { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(
          this.formatAppLoadError(data, `Could not load contributions (HTTP ${res.status}).`)
        );
      }
      if (!Array.isArray(data.items)) {
        throw new Error('Invalid response from server.');
      }
      this.contributions = data.items.map((item) => this.mapGiContributionItem(item));
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
    const res = await fetch(`/api/gi-contributions/${id}`, {
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
    const res = await fetch(`/api/gi-contributions/${id}`, {
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
    // Tab navigation
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
      container.innerHTML = `
        <div class="beanthentic-contribution-empty" role="status" aria-live="polite">
          <h3>Loading contributions…</h3>
        </div>
      `;
      return;
    }

    if (filtered.length === 0) {
      let extra = '<p>When farmers send GI updates from the mobile app, they will appear here.</p>';
      if (this.contributionsLoadError) {
        const safeMsg = this.escapeHtml(
          this.formatAppLoadError(this.contributionsLoadError, 'Could not load contributions.')
        );
        extra =
          `<p style="color:#b91c1c;line-height:1.5;">${safeMsg}</p>` +
          '<p style="color:#64748b;font-size:0.9rem;margin-top:0.5rem;">' +
          'Check <code>app_db_host</code>, <code>app_db_pass</code>, and <code>app_server_base</code> in ' +
          '<code>settings.json</code> or open <a href="/connection-settings">Connection Settings</a>.</p>';
      }
      container.innerHTML = `
        <div class="beanthentic-contribution-empty" role="status" aria-live="polite">
          <h3>No contributions found</h3>
          ${extra}
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map(contribution => `
      <div class="beanthentic-contribution-item ${contribution.unread ? 'unread' : ''}" data-id="${contribution.id}">
        <div class="beanthentic-contribution-left">
          <div class="beanthentic-contribution-checkbox">
            <input type="checkbox" ${this.selectedContributions.has(contribution.id) ? 'checked' : ''}>
          </div>
          <div class="beanthentic-contribution-star ${contribution.starred ? 'starred' : ''}">
            <i class="${contribution.starred ? 'fa-solid' : 'fa-regular'} fa-star"></i>
          </div>
          <div class="beanthentic-contribution-farmer">${contribution.farmer}</div>
        </div>
        <div class="beanthentic-contribution-subject">
          <span class="beanthentic-contribution-subject-text">${contribution.subject}</span>
          <span class="beanthentic-contribution-preview-inline">${contribution.preview}</span>
        </div>
        <div class="beanthentic-contribution-date">${contribution.date}</div>
      </div>
    `).join('');

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
    try {
      await this.patchGiContribution(id, { is_read_admin: true });
      contribution.unread = false;
      contribution.seen = true;
    } catch (_e) {
      contribution.unread = false;
      contribution.seen = true;
    }
    this.renderContributions();
    this.openContributionDetailModal(contribution);
  }

  openContributionDetailModal(contribution) {
    const modal = document.getElementById('beanthenticContributionDetailModal');
    if (!modal || !contribution) return;

    // Store previous focus
    this.__previousFocus = document.activeElement;

    // Gmail-style fields
    const avatarEl = document.getElementById('beanthenticContributionAvatar');
    const farmerEl = document.getElementById('beanthenticContributionDetailFarmer');
    const emailEl = document.getElementById('beanthenticContributionDetailEmail');
    const dateEl = document.getElementById('beanthenticContributionDetailDate');
    const subjectEl = document.getElementById('beanthenticContributionDetailSubject');
    const previewEl = document.getElementById('beanthenticContributionDetailPreview');
    const attachCountEl = document.getElementById('beanthenticAttachmentCount');
    const attachGridEl = document.getElementById('beanthenticAttachmentGrid');

    const attachments = Array.isArray(contribution.attachments) ? contribution.attachments : [];

    if (avatarEl) avatarEl.textContent = (contribution.farmer || 'F').charAt(0);
    if (farmerEl) farmerEl.textContent = contribution.farmer || '—';
    if (emailEl) emailEl.textContent = contribution.farmer_email || '—';
    if (dateEl) dateEl.textContent = contribution.date || '—';
    if (subjectEl) subjectEl.textContent = contribution.subject || 'Contribution Detail';

    if (previewEl) previewEl.textContent = contribution.content || contribution.preview || 'No details available.';

    if (attachCountEl) {
      attachCountEl.textContent = attachments.length
        ? `${attachments.length} Attachment${attachments.length === 1 ? '' : 's'}`
        : 'No attachments';
    }
    if (attachGridEl) {
      if (!attachments.length) {
        attachGridEl.innerHTML = '<p class="beanthentic-attachment-empty">No files attached.</p>';
      } else {
        attachGridEl.innerHTML = attachments.map((a) => {
          const name = String(a.name || 'file');
          const url = String(a.url || a.path || '#');
          const mime = String(a.mime || '').toLowerCase();
          const isImg = mime.indexOf('image/') === 0 || /\.(jpe?g|png|gif|webp)$/i.test(name);
          const preview = isImg
            ? `<img src="${url}" alt="${name}" style="max-width:100%;max-height:120px;object-fit:cover;border-radius:8px;">`
            : `<div class="beanthentic-attachment-doc-icon"><i class="fa-solid fa-file-lines"></i></div>`;
          return `
            <a class="beanthentic-attachment-thumb" href="${url}" target="_blank" rel="noopener">
              ${preview}
              <div class="beanthentic-attachment-info">${name}</div>
            </a>
          `;
        }).join('');
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

  showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `beanthentic-notification beanthentic-notification--${type}`;
    notification.textContent = message;
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 12px 20px;
      background: ${type === 'success' ? '#4CAF50' : type === 'error' ? '#f44336' : type === 'warning' ? '#ff9800' : '#2196F3'};
      color: white;
      border-radius: 4px;
      z-index: 9999;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      font-size: 14px;
      transition: opacity 0.3s ease;
    `;
    
    document.body.appendChild(notification);
    
    // Auto remove after 3 seconds
    setTimeout(() => {
      notification.style.opacity = '0';
      setTimeout(() => {
        if (notification.parentNode) {
          notification.parentNode.removeChild(notification);
        }
      }, 300);
    }, 3000);
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
  if (window.__BEANTHENTIC_GOOGLE_MAPS_READY__ && typeof window.dashboardApp.onGoogleMapsReady === 'function') {
    window.dashboardApp.onGoogleMapsReady();
  }
});

// Export for potential module usage
window.DashboardApp = DashboardApp;
