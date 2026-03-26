// Dashboard functionality for coffee database
class DashboardApp {
  constructor() {
    this.data = [];
    this.filteredData = [];
    this.currentPage = 1;
    this.pageSize = 10;
    this.totalRecords = 0;
    this.farmerTableView = 'basic';
    this.activeSettingsTab = 'security';
    this.init();
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

        // When clicking Settings, show overview first (no fragment auto-display).
        this.activeSettingsTab = null;
        this.switchModule('settings');
      });

      const submenuButtons = sidebarSettingsSubmenu.querySelectorAll('.settings-submenu-item[data-tab]');
      submenuButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
          const tab = btn.getAttribute('data-tab') || 'security';

          submenuButtons.forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');

          this.activeSettingsTab = tab;

          // Ensure the Settings module is visible and render the selected fragment inside it.
          this.switchModule('settings');
        });
      });
    }

    // Settings overview cards (click to open fragment)
    const settingsOverview = document.getElementById('settingsOverview');
    if (settingsOverview) {
      settingsOverview.addEventListener('click', (e) => {
        const card = e.target.closest('[data-open-tab]');
        if (!card) return;
        const tab = card.getAttribute('data-open-tab') || 'security';

        const sidebarSubmenu = document.getElementById('sidebarSettingsSubmenu');
        if (sidebarSubmenu) {
          const btn = sidebarSubmenu.querySelector(`.settings-submenu-item[data-tab="${tab}"]`);
          if (btn) btn.click();
        } else {
          this.activeSettingsTab = tab;
          this.switchModule('settings');
        }
      });
    }

    // Header notifications + profile menu
    const notificationBtn = document.getElementById('notificationBtn');
    if (notificationBtn) {
      notificationBtn.addEventListener('click', () => {
        this.showNotification('You have 3 new notifications.', 'success');
      });
    }

    const profileMenuWrap = document.getElementById('profileMenuWrap');
    const profileMenuBtn = document.getElementById('profileMenuBtn');
    const profileAccountInfoBtn = document.getElementById('profileAccountInfoBtn');
    if (profileMenuWrap && profileMenuBtn) {
      profileMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nextOpen = !profileMenuWrap.classList.contains('open');
        profileMenuWrap.classList.toggle('open', nextOpen);
        profileMenuBtn.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
      });

      if (profileAccountInfoBtn) {
        profileAccountInfoBtn.addEventListener('click', () => {
          profileMenuWrap.classList.remove('open');
          profileMenuBtn.setAttribute('aria-expanded', 'false');
          this.activeSettingsTab = 'profile';
          this.switchModule('settings');
        });
      }

      document.addEventListener('click', (e) => {
        if (!profileMenuWrap.contains(e.target)) {
          profileMenuWrap.classList.remove('open');
          profileMenuBtn.setAttribute('aria-expanded', 'false');
        }
      });
    }

    // Refresh button
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        console.log('Refresh button clicked');
        this.loadExcelData();
      });
    }

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

    // Farmer table view toggle
    const viewToggleBtns = document.querySelectorAll('[data-table-view]');
    viewToggleBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.setFarmerTableView(btn.dataset.tableView || 'basic');
      });
    });

    // Farmer CRUD actions
    const addFarmerBtn = document.getElementById('addFarmerBtn');
    if (addFarmerBtn) {
      addFarmerBtn.addEventListener('click', () => this.addFarmer());
    }

    const saveFarmersBtn = document.getElementById('saveFarmersBtn');
    if (saveFarmersBtn) {
      saveFarmersBtn.addEventListener('click', () => this.saveFarmers());
    }

    // Inline edit + row delete (event delegation)
    document.addEventListener('click', (e) => {
      const delBtn = e.target.closest('[data-action="delete-farmer"]');
      if (!delBtn) return;
      const idx = Number.parseInt(delBtn.getAttribute('data-row-index') || '', 10);
      if (!Number.isFinite(idx) || idx < 0) return;
      this.deleteFarmer(idx);
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
      'farmers': 'Farmer Records',
      'analytics': 'Analytics',
      'reports': 'Reports',
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
      this.showSettingsOverview();
      if (this.activeSettingsTab) {
        this.showSettingsFragment(this.activeSettingsTab);
      }
    }

    // Close mobile menu
    if (window.innerWidth <= 768) {
      this.closeMobileSidePanel();
    }
  }

  showSettingsOverview() {
    const overview = document.getElementById('settingsOverview');
    const fragmentSection = document.getElementById('settingsFragmentSection');
    if (overview) overview.classList.remove('hidden');
    if (fragmentSection) fragmentSection.classList.add('hidden');

    const pageTitleEl = document.getElementById('adminSettingsPageTitle');
    if (pageTitleEl) pageTitleEl.textContent = 'Settings';
  }

  showSettingsFragment(tab) {
    const overview = document.getElementById('settingsOverview');
    const fragmentSection = document.getElementById('settingsFragmentSection');
    if (overview) overview.classList.add('hidden');
    if (fragmentSection) fragmentSection.classList.remove('hidden');
    this.loadAdminSettingsFragment(tab);
  }

  async loadAdminSettingsFragment(tab) {
    const container = document.getElementById('adminSettingsFragmentContainer');
    const titleEl = document.getElementById('adminSettingsFragmentTitle');
    const pageTitleEl = document.getElementById('adminSettingsPageTitle');
    if (!container) return;

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
      this.initAdminSettingsInteractions(container, resolvedTab);
    } catch (err) {
      console.error('Failed to load settings fragment:', err);
      const msg = err && err.message ? err.message : String(err);
      container.innerHTML = `<div class="alert alert-error">Failed to load settings content: ${msg}</div>`;
    }
  }

  initAdminSettingsInteractions(containerEl) {
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
        // Columns: [Date & Time, Action, Details, IP Address]
        if (tds.length >= 2) return (tds[1].textContent || '').trim().toLowerCase();
        return '';
      };

      const applyFilters = () => {
        const term = (search && (search.value || '')).toString().toLowerCase().trim();
        const selectedAction = (actionFilter && actionFilter.value) ? actionFilter.value : 'all';

        rows.forEach((row) => {
          const fullText = row.textContent.toLowerCase();
          const rowAction = getRowActionText(row);

          const actionOk = selectedAction === 'all' || rowAction === selectedAction;
          const termOk = !term || fullText.includes(term);

          row.style.display = actionOk && termOk ? '' : 'none';
        });
      };

      if (search) {
        search.addEventListener('input', () => {
          applyFilters();
        });
      }
      if (actionFilter) actionFilter.addEventListener('change', applyFilters);
      applyFilters();
    }

    // Notifications save button
    const saveNotificationsBtn = containerEl.querySelector('#saveNotificationsBtn');
    if (saveNotificationsBtn) {
      saveNotificationsBtn.addEventListener('click', () => {
        this.showNotification('Notification settings saved (UI-only).', 'success');
      });
    }

    // Profile form submit + logout
    const profileForm = containerEl.querySelector('#profileForm');
    if (profileForm) {
      profileForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.showNotification('Profile updated (UI-only).', 'success');
      });
    }

    const logoutBtn = containerEl.querySelector('#logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        if (confirm('Are you sure you want to log out?')) {
          window.location.href = '/logout';
        }
      });
    }

    // Account security: password reset (UI-only)
    const passwordForm = containerEl.querySelector('#passwordForm');
    if (passwordForm) {
      passwordForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.showNotification('Password reset submitted (UI-only).', 'success');
      });
    }

    // Account security: simple 2FA UI toggle + sample codes (UI-only)
    const enable2faBtn = containerEl.querySelector('#enable2faBtn');
    const disable2faBtn = containerEl.querySelector('#disable2faBtn');
    const viewBackupCodesBtn = containerEl.querySelector('#viewBackupCodesBtn');
    const cancel2faSetupBtn = containerEl.querySelector('#cancel2faSetupBtn');
    // IDs start with a digit, so we must use attribute selectors (CSS selector '#2faStatus' is invalid).
    const twoFaStatus = containerEl.querySelector('[id="2faStatus"]');
    const twoFaSetup = containerEl.querySelector('[id="2faSetup"]');
    const manualKey = containerEl.querySelector('#manualKey');
    const backupCodesList = containerEl.querySelector('#backupCodesList');
    const enable2faToggle = containerEl.querySelector('#enable2faToggle');
    const notEnabledState = containerEl.querySelector('[id="2faNotEnabledState"]');
    const enabledState = containerEl.querySelector('[id="2faEnabledState"]');

    const genCodes = () => [
      'ABCD-1234-EFGH-5678',
      'IJKL-9012-MNOP-3456',
      'QRST-7890-UVWX-1234',
      'YZAB-4567-CDEF-8901',
    ];

    const set2faEnabledState = (enabled) => {
      if (twoFaStatus) twoFaStatus.style.display = 'block';
      if (notEnabledState) notEnabledState.style.display = enabled ? 'none' : 'block';
      if (enabledState) enabledState.style.display = enabled ? 'block' : 'none';
    };

    const open2faSetup = (showMsg = true) => {
      if (twoFaStatus) twoFaStatus.style.display = 'none';
      if (twoFaSetup) twoFaSetup.style.display = 'block';
      if (manualKey) manualKey.textContent = 'Manual key: (sample) BEANTHENTIC-DEMO-SECRET';
      if (backupCodesList) {
        backupCodesList.innerHTML = genCodes().map((c) => `<code>${c}</code>`).join('');
      }
      if (showMsg) this.showNotification('2FA setup initiated (UI-only).', 'success');
    };

    if (enable2faToggle) {
      // Initialize state on load.
      set2faEnabledState(!!enable2faToggle.checked);

      enable2faToggle.addEventListener('change', () => {
        const enabled = !!enable2faToggle.checked;
        set2faEnabledState(enabled);
        if (enabled) open2faSetup(true);
      });
    } else if (notEnabledState && enabledState) {
      // Fallback initialization: assume "not enabled" visible.
      set2faEnabledState(false);
    }

    if (enable2faBtn) {
      enable2faBtn.addEventListener('click', () => {
        if (enable2faToggle) enable2faToggle.checked = true;
        set2faEnabledState(true);
        open2faSetup(true);
      });
    }
    if (viewBackupCodesBtn) {
      viewBackupCodesBtn.addEventListener('click', () => open2faSetup(false));
    }
    if (disable2faBtn) {
      disable2faBtn.addEventListener('click', () => {
        if (twoFaSetup) twoFaSetup.style.display = 'none';
        if (twoFaStatus) twoFaStatus.style.display = 'block';
        if (enable2faToggle) enable2faToggle.checked = false;
        set2faEnabledState(false);
        this.showNotification('2FA disabled (UI-only).', 'success');
      });
    }
    if (cancel2faSetupBtn) {
      cancel2faSetupBtn.addEventListener('click', () => {
        if (twoFaSetup) twoFaSetup.style.display = 'none';
        if (twoFaStatus) twoFaStatus.style.display = 'block';
      });
    }
  }

  handleExport(type) {
    console.log(`Exporting as ${type}...`);
    this.showNotification(`Exporting data as ${type.toUpperCase()}...`, 'success');
    
    // Simulate export process
    setTimeout(() => {
      this.showNotification(`Data exported successfully as ${type.toUpperCase()}!`, 'success');
    }, 2000);
  }

  async loadExcelData() {
    try {
      console.log('Loading farmer data from data file...');
      
      // Prefer admin-edited data (localStorage), then fall back to seeded data
      const saved = this.loadSavedFarmers();
      const source = (Array.isArray(saved) && saved.length)
        ? saved
        : (window.farmerData && window.farmerData.length > 0 ? window.farmerData : null);

      if (source) {
        this.data = source;
        this.filteredData = [...this.data];
        this.totalRecords = this.data.length;
        
        console.log('Successfully loaded farmer data:', this.data.length, 'records');
        console.log('First farmer:', this.data[0]);
        console.log('Sample of farmers:', this.data.slice(0, 3));
        
        this.updateStats();
        this.createCharts();
        this.updateTable();
        this.updateStats();
        
      } else {
        throw new Error('Farmer data not available');
      }
      
    } catch (error) {
      console.error('Error loading farmer data:', error);
      this.showNotification('Failed to load farmer data. Loading sample data...', 'error');
      this.loadSampleData();
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
  }

  updateTable() {
    this.renderTableBody();
    this.renderPagination();
    this.updateRecordInfo();
    this.updateOwnershipLegend();
  }

  renderTableBody() {
    const tableBody =
      this.farmerTableView === 'trees'
        ? document.getElementById('tableBodyTrees')
        : this.farmerTableView === 'production'
          ? document.getElementById('tableBodyProduction')
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
            ? 10
            : 12;
      tableBody.innerHTML = `<tr><td colspan="${colSpan}" class="no-data">No data available.</td></tr>`;
      return;
    }

    const bodyHTML = pageData.map((row, index) => {
      const actualIndex = startIndex + index + 1;
      const rowIndexInData = this.data.indexOf(row);
      console.log('Rendering farmer', actualIndex, ':', row['NAME OF FARMER'] || 'Unknown');

      const fullName = this.getValue(row, ['NAME OF FARMER', 'Name of Farmer', 'name']);
      const nameParts = this.splitFarmerName(fullName);

      const cells =
        this.farmerTableView === 'trees'
          ? [
              this.createInputCell(actualIndex, 'number'),
              this.createInputCell(nameParts.first, 'text'),
              this.createInputCell(nameParts.last, 'text'),

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
                this.createInputCell(actualIndex, 'number'),
                this.createInputCell(nameParts.first, 'text'),
                this.createInputCell(nameParts.last, 'text'),
                this.createInputCell(this.getValue(row, ['TOTAL TREES', 'TOTAL_TREES']), 'number', 'highlight-green'),
                this.createInputCell(this.getValue(row, ['LIBERICA PRODUCTION', 'Liberica_Production']), 'number', 'highlight-blue'),
                this.createInputCell(this.getValue(row, ['EXCELSA PRODUCTION', 'Excelsa_Production']), 'number', 'highlight-blue'),
                this.createInputCell(this.getValue(row, ['ROBUSTA PRODUCTION', 'Robusta_Production']), 'number', 'highlight-blue'),
                this.createInputCell(this.getTotalProduction(row), 'number', 'highlight-blue'),
                this.createEditableCell(this.getValue(row, ['REMARKS', 'remarks']), rowIndexInData, 'REMARKS', 'text'),
                this.createRowActionsCell(rowIndexInData)
              ]
          : [
              this.createInputCell(actualIndex, 'number'),
              this.createInputCell(nameParts.first, 'text'),
              this.createInputCell(nameParts.last, 'text'),
              this.createInputCell(this.getValue(row, ['ADDRESS (BARANGAY)', 'Address (Barangay)', 'address']), 'text'),
              this.createInputCell(this.getValue(row, ['FA OFFICER / MEMBER', 'FA Officer / member', 'officer']), 'text'),
              this.createInputCell(this.getValue(row, ['BIRTHDAY', 'birthday']), 'text'),
              this.createInputCell(this.getValue(row, ['RSBSA Registered (Yes/No)', 'REGISTERED (YES/NO)', 'Registered (Yes/No)', 'registered']), 'text'),
              this.createInputCell(
                this.formatOwnership(this.getValue(row, ['STATUS OF OWNERSHIP', 'ownership'])),
                'text'
              ),
              this.createInputCell(this.getValue(row, ['Total Area Planted (HA.)', 'TOTAL AREA PLANTED (HA.)', 'area']), 'number'),
              this.createInputCell(this.getValue(row, ['NCFRS', 'ncfrs']), 'text'),
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
    const moduleContent = document.querySelector('.module-content');
    const tableWrapper = document.querySelector('.table-wrapper');
    const prevWindowScrollY = window.scrollY;
    const prevWindowScrollX = window.scrollX;
    const prevModuleScrollTop = moduleContent ? moduleContent.scrollTop : 0;
    const prevTableScrollTop = tableWrapper ? tableWrapper.scrollTop : 0;
    const prevTableScrollLeft = tableWrapper ? tableWrapper.scrollLeft : 0;

    this.farmerTableView = view === 'trees' ? 'trees' : view === 'production' ? 'production' : 'basic';

    const btns = document.querySelectorAll('[data-table-view]');
    btns.forEach(btn => {
      btn.classList.toggle('active', (btn.dataset.tableView || 'basic') === this.farmerTableView);
    });

    const basicTable = document.getElementById('farmerTableBasic');
    const treesTable = document.getElementById('farmerTableTrees');
    const productionTable = document.getElementById('farmerTableProduction');

    if (basicTable && treesTable && productionTable) {
      const showBasic = this.farmerTableView === 'basic';
      const showTrees = this.farmerTableView === 'trees';
      const showProduction = this.farmerTableView === 'production';

      basicTable.classList.toggle('is-hidden', !showBasic);
      treesTable.classList.toggle('is-hidden', !showTrees);
      productionTable.classList.toggle('is-hidden', !showProduction);

      treesTable.setAttribute('aria-hidden', showTrees ? 'false' : 'true');
      productionTable.setAttribute('aria-hidden', showProduction ? 'false' : 'true');
    }

    this.renderTableBody();
    this.updateOwnershipLegend();

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
      this.showNotification('Farmer records saved.', 'success');
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

  formatOwnership(rawValue) {
    const v = (rawValue ?? '').toString().trim();
    if (!v) return '';

    const upper = v.toUpperCase();
    const letter = upper[0] || '';

    const map = {
      A: 'Landowner',
      B: 'COA Holder',
      C: 'Leaseholder',
      D: 'Seasonal Farm Worker',
      E: 'Others'
    };

    if (map[letter]) {
      // Show only the Excel-style code (A/B/C/D/E) in the table.
      return letter;
    }

    // Fallback: display the raw value if it isn't the expected A-E codes.
    return v;
  }

  updateOwnershipLegend() {
    const el = document.getElementById('ownershipLegend');
    if (!el) return;

    const shouldShow = this.farmerTableView === 'basic';
    el.classList.toggle('hidden', !shouldShow);
    el.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');

    if (shouldShow) {
      el.textContent = 'Legend: A - Landowner, B - COA Holder, C - Leaseholder, D - Seasonal Farm Worker, E - Others';
    }
  }

  filterData(searchTerm) {
    if (!searchTerm) {
      this.filteredData = [...this.data];
    } else {
      this.filteredData = this.data.filter(row => {
        return Object.values(row).some(value => 
          value && value.toString().toLowerCase().includes(searchTerm)
        );
      });
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
    this.showNotification('Data exported successfully!', 'success');
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

  showNotification(message, type = 'success') {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
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
