// IPOPHL Document Analyzer - File Previewer & AI Analysis Integration
function ipophlApi(path, init = {}) {
    const urlFn = typeof window.beanthenticApiUrl === 'function' ? window.beanthenticApiUrl : (p) => p;
    return fetch(urlFn(path), { credentials: 'same-origin', ...init });
}

class IPOPHLAnalyzer {
    constructor() {
        this.currentFile = null;
        this.currentAnalysis = null;
        this.isAnalyzing = false;
        this.modalIsMinimized = false;
        this.isMinimizingModal = false;
        this.isResizingModal = false;
        this.modalResizeState = null;
        this._previewResizeTimer = null;
        /** @type {Record<string, { file: File, key: string }[]>} */
        this.pendingByTask = {};
        this.init();
    }

    init() {
        this.attachEventListeners();
        this.setupFileUploadHandlers();
        this.loadExistingDocuments();
    }

    async loadExistingDocuments() {
        try {
            const response = await ipophlApi('/api/ipo-documents');
            const data = await response.json();
            
            if (data.items) {
                const latestByKey = new Map();
                data.items.forEach((doc) => {
                    const key = `${doc.task_id || ''}::${doc.filename || ''}`;
                    const prev = latestByKey.get(key);
                    const ts = String(doc.upload_timestamp || '');
                    const prevTs = String(prev?.upload_timestamp || '');
                    if (!prev || ts >= prevTs) {
                        latestByKey.set(key, doc);
                    }
                });
                latestByKey.forEach((doc) => {
                    const container = document.getElementById(`${doc.task_id}-files`);
                    if (container) {
                        this.renderDocumentCard(container, doc);
                        this.updateDashboardState(doc.task_id, doc, 'add');
                    }
                });
                this.refreshDashboardIndicator();
            }
        } catch (error) {
            console.error('Failed to load existing documents:', error);
        }
    }

    updateDashboardState(taskId, doc, action) {
        if (!window.dashboardApp) return;
        const official = window.dashboardApp.getOfficialIpophlTaskIds?.() || [];
        if (taskId && !official.includes(taskId)) return;
        
        if (!window.dashboardApp.ipophlFiles) {
            window.dashboardApp.ipophlFiles = {};
        }
        
        if (action === 'add') {
            if (!window.dashboardApp.ipophlFiles[taskId]) {
                window.dashboardApp.ipophlFiles[taskId] = [];
            }
            const fileId = doc.file_uuid || doc.id;
            const existing = window.dashboardApp.ipophlFiles[taskId].find(
                (f) => f.id === fileId
            );
            if (existing) {
                if (doc.ai_status != null) existing.ai_status = doc.ai_status;
                if (doc.ai_score != null) existing.ai_score = Number(doc.ai_score || 0);
            } else {
                window.dashboardApp.ipophlFiles[taskId].push({
                    id: fileId,
                    name: doc.filename,
                    ai_status: doc.ai_status || '',
                    ai_score: Number(doc.ai_score || 0),
                });
            }
        } else if (action === 'remove') {
            if (window.dashboardApp.ipophlFiles[taskId]) {
                window.dashboardApp.ipophlFiles[taskId] = window.dashboardApp.ipophlFiles[taskId]
                    .filter(f => f.id !== (doc.file_uuid || doc.id));
            }
        }
    }

    refreshDashboardIndicator() {
        if (window.dashboardApp && typeof window.dashboardApp.updateGiProcessIndicator === 'function') {
            window.dashboardApp.updateGiProcessIndicator();
        }
    }

    renderDocumentCard(container, doc) {
        // Same filename with a new UUID = replaced upload; drop stale card so analysis matches file.
        const existingNames = container.querySelectorAll('.file-item:not(.uploading):not(.error) .file-name');
        for (const nameEl of existingNames) {
            if (nameEl.textContent !== doc.filename) continue;
            const card = nameEl.closest('.file-item');
            const oldUuid = card?.dataset?.fileUuid;
            if (oldUuid && doc.file_uuid && oldUuid === doc.file_uuid) {
                this.updateCardWithAI(card, doc);
                return;
            }
            if (card) card.remove();
            break;
        }

        const fileExt = doc.filename.split('.').pop().toLowerCase();
        const iconClass = fileExt === 'pdf' ? 'fa-file-pdf text-danger' : 
                         (fileExt === 'doc' || fileExt === 'docx') ? 'fa-file-word text-primary' :
                         'fa-file-lines text-success';

        const zoneTaskId = (container && container.id) ? container.id.replace(/-files$/, '') : (doc.task_id || '');
        const fileItem = document.createElement('div');
        fileItem.className = this.fileItemClassForStatus(doc.ai_status);
        fileItem.dataset.fileUuid = doc.file_uuid;
        fileItem.dataset.taskId = zoneTaskId || doc.task_id || '';
        fileItem.dataset.aiStatus = String(doc.ai_status || '').trim();
        const meta = doc.ai_status
            ? `AI review · ${doc.ai_status}`
            : this.formatFileSize(doc.file_size || 0);
        fileItem.innerHTML = `
            <div class="file-info">
                <i class="fa-solid ${iconClass}"></i>
                <div class="file-details">
                    <span class="file-name">${doc.filename}</span>
                    <span class="file-meta">${meta}</span>
                </div>
            </div>
            <div class="file-status-actions">
                <div class="file-actions">
                    <button type="button" class="file-action-btn ai-analysis" data-ipophl-action="analyze" data-file-uuid="${doc.file_uuid}" title="AI Analysis">
                        <i class="fa-solid fa-brain"></i>
                    </button>
                    <button type="button" class="file-action-btn delete" data-ipophl-action="delete" data-file-uuid="${doc.file_uuid}" title="Delete File">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </div>
        `;
        container.appendChild(fileItem);
    }

    isAiReadyStatus(status) {
        return String(status || '').trim().toLowerCase() === 'ready';
    }

    fileItemClassForStatus(status) {
        if (this.isAiReadyStatus(status)) {
            return 'file-item success ai-enhanced';
        }
        if (String(status || '').trim()) {
            return 'file-item not-ready ai-not-ready ai-enhanced';
        }
        return 'file-item ai-enhanced';
    }

    applyAiStatusToCard(card, status) {
        if (!card) return;
        const ready = this.isAiReadyStatus(status);
        card.classList.remove('success', 'not-ready', 'ai-not-ready', 'error', 'uploading', 'pending');
        card.classList.add('ai-enhanced');
        if (ready) {
            card.classList.add('success');
        } else if (String(status || '').trim()) {
            card.classList.add('not-ready', 'ai-not-ready');
        }
        card.dataset.aiStatus = String(status || '').trim();
        const meta = card.querySelector('.file-meta');
        if (meta && String(status || '').trim()) {
            meta.textContent = `AI review · ${status}`;
        }
    }

    updateCardWithAI(card, doc) {
        this.applyAiStatusToCard(card, doc.ai_status);
        if (doc.file_uuid) {
            card.dataset.fileUuid = doc.file_uuid;
        }
        const container = card.parentElement;
        const zoneTaskId = container && container.id ? container.id.replace(/-files$/, '') : '';
        if (zoneTaskId) {
            card.dataset.taskId = zoneTaskId;
        }
        
        // Add or update status and actions wrapper
        let statusActionsWrapper = card.querySelector('.file-status-actions');
        if (!statusActionsWrapper) {
            // Remove old status and actions if they exist outside the wrapper
            const oldStatus = card.querySelector('.file-status');
            const oldActions = card.querySelector('.file-actions');
            if (oldStatus) oldStatus.remove();
            if (oldActions) oldActions.remove();

            statusActionsWrapper = document.createElement('div');
            statusActionsWrapper.className = 'file-status-actions';
            card.appendChild(statusActionsWrapper);
        }
        
        statusActionsWrapper.innerHTML = `
            <div class="file-actions">
                <button type="button" class="file-action-btn ai-analysis" data-ipophl-action="analyze" data-file-uuid="${doc.file_uuid}" title="AI Analysis">
                    <i class="fa-solid fa-brain"></i>
                </button>
                <button type="button" class="file-action-btn delete" data-ipophl-action="delete" data-file-uuid="${doc.file_uuid}" title="Delete File">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        `;
    }

    async loadAndShowFullAnalysis(fileUuid) {
        try {
            const response = await ipophlApi(`/api/ipo-analysis/${fileUuid}`);
            const result = await this.parseApiResponse(response);
            
            if (result.success) {
                const fname = result.filename || fileUuid;
                const fileData = {
                    file_info: { filename: fname },
                    preview_url: this.resolvePreviewUrl(fileUuid, fname),
                    analysis: result.analysis,
                    file_uuid: fileUuid
                };
                this.showFullAIAnalysis(fileData);
            }
        } catch (error) {
            this.showToast('Failed to load analysis', 'error');
        }
    }

    showFullAIAnalysis(fileData) {
        if (!fileData) return;

        // Normalize file data
        const filename = (fileData.file_info && fileData.file_info.filename) ? 
                        fileData.file_info.filename : 
                        (fileData.filename || 'Document');
        
        const fileUuid = fileData.file_uuid || 
                        (filename !== 'Document' ? filename.split('.')[0] : 'unknown');

        this.currentFile = {
            filename: filename,
            preview_url: fileData.preview_url,
            analysis: fileData.analysis,
            file_uuid: fileUuid
        };
        
        // Show the full AI analysis modal
        const modal = document.getElementById('filePreviewModal');
        if (modal) {
            modal.removeAttribute('hidden');
            modal.setAttribute('aria-hidden', 'false');
            modal.classList.add('active');
            modal.classList.remove('is-minimized');
            document.body.classList.add('modal-open');
            this.modalIsMinimized = false;
            this.syncModalWindowState();
            requestAnimationFrame(() => this.handlePreviewModalResize());
            
            // Set file name
            const nameEl = document.getElementById('previewFileName');
            if (nameEl) nameEl.textContent = this.currentFile.filename;
            
            // Load file preview
            this.loadFilePreview(this.currentFile.preview_url);
            
            // Load AI analysis
            this.loadAIAnalysis(this.currentFile);
        }
    }

    attachEventListeners() {
        document.addEventListener('click', (e) => {
            const actionBtn = e.target.closest('[data-ipophl-action]');
            if (!actionBtn) return;
            const uuid = actionBtn.dataset.fileUuid;
            const action = actionBtn.dataset.ipophlAction;
            if (!uuid) return;
            if (action === 'analyze') {
                this.loadAndShowFullAnalysis(uuid);
            } else if (action === 'delete') {
                this.deleteFile(uuid, actionBtn);
            }
        });

        const minimizeBtn = document.getElementById('filePreviewMinimizeBtn');
        if (minimizeBtn) {
            minimizeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.toggleMinimizeFilePreview();
            });
        }

        const minimizedBar = document.getElementById('filePreviewMinimizedBar');
        if (minimizedBar) {
            minimizedBar.addEventListener('click', () => {
                this.restoreFilePreview();
            });
        }

        const resizeEdges = document.querySelectorAll('#filePreviewModal .modal-resize-edge');
        resizeEdges.forEach((edge) => {
            edge.addEventListener('pointerdown', (e) => {
                this.startModalResize(e);
            });
        });

        document.addEventListener('pointermove', (e) => {
            this.handleModalResize(e);
        });

        document.addEventListener('pointerup', () => {
            this.stopModalResize();
        });

        window.addEventListener('resize', () => {
            if (this._previewResizeTimer) clearTimeout(this._previewResizeTimer);
            this._previewResizeTimer = setTimeout(() => this.handlePreviewModalResize(), 120);
        });

        // Modal close handlers
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal') || e.target.classList.contains('modal-close')) {
                this.closeFilePreview();
            }
        });

        // Escape key to close modal
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeFilePreview();
            }
        });
    }

    syncModalWindowState() {
        const modal = document.getElementById('filePreviewModal');
        const bar = document.getElementById('filePreviewMinimizedBar');
        if (!modal) return;
        modal.classList.toggle('is-minimized', this.modalIsMinimized);
        if (bar) {
            bar.classList.toggle('hidden', !this.modalIsMinimized);
        }
    }

    toggleMinimizeFilePreview() {
        const modal = document.getElementById('filePreviewModal');
        if (!modal || this.isMinimizingModal) return;

        if (!this.modalIsMinimized) {
            this.isMinimizingModal = true;
            modal.classList.add('is-minimizing');
            window.setTimeout(() => {
                this.modalIsMinimized = true;
                modal.classList.remove('is-minimizing');
                this.isMinimizingModal = false;
                this.syncModalWindowState();
            }, 340);
            return;
        }
        this.restoreFilePreview();
    }

    restoreFilePreview() {
        const modal = document.getElementById('filePreviewModal');
        this.modalIsMinimized = false;
        this.syncModalWindowState();
        if (!modal) return;
        modal.classList.add('is-restoring');
        window.setTimeout(() => {
            modal.classList.remove('is-restoring');
            this.handlePreviewModalResize();
        }, 380);
    }

    getPreviewModalBounds() {
        const maxWidth = Math.min(window.innerWidth - 24, 1600);
        const maxHeight = window.innerHeight - 24;
        const minWidth = Math.min(720, maxWidth);
        const minHeight = Math.min(480, maxHeight);
        return { minWidth, minHeight, maxWidth, maxHeight, margin: 12 };
    }

    clampPreviewModalGeometry(left, top, width, height) {
        const { minWidth, minHeight, maxWidth, maxHeight, margin } = this.getPreviewModalBounds();
        let nextWidth = Math.max(minWidth, Math.min(maxWidth, width));
        let nextHeight = Math.max(minHeight, Math.min(maxHeight, height));
        let nextLeft = left;
        let nextTop = top;

        if (nextLeft + nextWidth > window.innerWidth - margin) {
            nextLeft = window.innerWidth - margin - nextWidth;
        }
        if (nextTop + nextHeight > window.innerHeight - margin) {
            nextTop = window.innerHeight - margin - nextHeight;
        }
        nextLeft = Math.max(margin, nextLeft);
        nextTop = Math.max(margin, nextTop);

        return {
            left: nextLeft,
            top: nextTop,
            width: nextWidth,
            height: nextHeight,
        };
    }

    applyPreviewModalGeometry(left, top, width, height) {
        const modal = document.getElementById('filePreviewModal');
        if (!modal) return;
        const geometry = this.clampPreviewModalGeometry(left, top, width, height);
        modal.classList.add('is-geometry-ready');
        modal.style.setProperty('--file-preview-left', `${geometry.left}px`);
        modal.style.setProperty('--file-preview-top', `${geometry.top}px`);
        modal.style.setProperty('--file-preview-width', `${geometry.width}px`);
        modal.style.setProperty('--file-preview-height', `${geometry.height}px`);
    }

    handlePreviewModalResize() {
        const modal = document.getElementById('filePreviewModal');
        const modalContent = document.querySelector('#filePreviewModal .modal-content.large');
        if (!modal || !modal.classList.contains('active')) return;

        const { maxWidth, maxHeight } = this.getPreviewModalBounds();
        const rect = modalContent?.getBoundingClientRect();

        let width = parseFloat(getComputedStyle(modal).getPropertyValue('--file-preview-width'));
        let height = parseFloat(getComputedStyle(modal).getPropertyValue('--file-preview-height'));
        if (!Number.isFinite(width)) width = rect?.width || maxWidth;
        if (!Number.isFinite(height)) height = rect?.height || maxHeight;

        let left = parseFloat(getComputedStyle(modal).getPropertyValue('--file-preview-left'));
        let top = parseFloat(getComputedStyle(modal).getPropertyValue('--file-preview-top'));
        if (!Number.isFinite(left)) left = rect?.left ?? (window.innerWidth - width) / 2;
        if (!Number.isFinite(top)) top = rect?.top ?? (window.innerHeight - height) / 2;

        this.applyPreviewModalGeometry(left, top, width, height);
        this.fitWordPreviewToContainer();
    }

    fitWordPreviewToContainer() {
        const container = document.querySelector('#filePreviewModal .preview-container');
        const viewport = document.getElementById('wordPreviewViewport');
        if (!container || !viewport) return;
        const section = viewport.querySelector('section.docx-beanthentic, section.docx');
        if (!section) {
            viewport.style.removeProperty('--word-preview-fit-scale');
            return;
        }
        const available = Math.max(280, container.clientWidth - 24);
        const pageWidth = section.getBoundingClientRect().width || section.scrollWidth;
        if (pageWidth > available + 2) {
            viewport.style.setProperty('--word-preview-fit-scale', String(available / pageWidth));
        } else {
            viewport.style.setProperty('--word-preview-fit-scale', '1');
        }
    }

    startModalResize(event) {
        const modal = document.getElementById('filePreviewModal');
        const modalContent = document.querySelector('#filePreviewModal .modal-content.large');
        const direction = event.currentTarget?.dataset?.resize;
        if (!modal || !modalContent || !direction) return;
        event.preventDefault();
        event.stopPropagation();
        this.restoreFilePreview();
        this.handlePreviewModalResize();

        const rect = modalContent.getBoundingClientRect();
        this.isResizingModal = true;
        modal.classList.add('is-resizing');
        this.modalResizeState = {
            direction,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: rect.left,
            startTop: rect.top,
            startWidth: rect.width,
            startHeight: rect.height,
            pointerId: event.pointerId,
        };

        const cursorMap = {
            n: 'ns-resize',
            s: 'ns-resize',
            e: 'ew-resize',
            w: 'ew-resize',
            ne: 'nesw-resize',
            nw: 'nwse-resize',
            se: 'nwse-resize',
            sw: 'nesw-resize',
        };
        this.modalResizeCursor = cursorMap[direction] || 'default';

        try {
            event.currentTarget.setPointerCapture(event.pointerId);
        } catch (_err) {
            /* ignore */
        }
        document.body.style.userSelect = 'none';
        document.body.style.cursor = this.modalResizeCursor;
    }

    handleModalResize(event) {
        if (!this.isResizingModal || !this.modalResizeState) return;

        const { direction, startX, startY, startLeft, startTop, startWidth, startHeight } = this.modalResizeState;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        const { minWidth, minHeight } = this.getPreviewModalBounds();

        let left = startLeft;
        let top = startTop;
        let width = startWidth;
        let height = startHeight;

        if (direction.includes('e')) {
            width = startWidth + dx;
        }
        if (direction.includes('w')) {
            width = startWidth - dx;
            left = startLeft + dx;
        }
        if (direction.includes('s')) {
            height = startHeight + dy;
        }
        if (direction.includes('n')) {
            height = startHeight - dy;
            top = startTop + dy;
        }

        if (width < minWidth) {
            if (direction.includes('w')) {
                left = startLeft + startWidth - minWidth;
            }
            width = minWidth;
        }
        if (height < minHeight) {
            if (direction.includes('n')) {
                top = startTop + startHeight - minHeight;
            }
            height = minHeight;
        }

        this.applyPreviewModalGeometry(left, top, width, height);
    }

    stopModalResize() {
        if (!this.isResizingModal) return;
        this.isResizingModal = false;
        this.modalResizeState = null;
        this.modalResizeCursor = '';
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        const modal = document.getElementById('filePreviewModal');
        if (modal) modal.classList.remove('is-resizing');
        this.fitWordPreviewToContainer();
    }

    setupFileUploadHandlers() {
        // Enhanced file upload handlers for IPOPHL module
        const uploadZones = document.querySelectorAll('.file-upload-zone[data-service*="phase"]');
        
        uploadZones.forEach(zone => {
            const service = zone.dataset.service;
            const fileInput = zone.querySelector('.file-input');
            const attachedFiles = document.getElementById(`${service}-files`);

            // Click to trigger file input
            zone.addEventListener('click', (e) => {
                if (e.target !== fileInput) {
                    fileInput.click();
                }
            });

            // Enhanced file upload with AI analysis
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

                const files = e.dataTransfer.files;
                if (files.length > 0) {
                    void this.uploadAndAnalyzeFile(files[0], service, attachedFiles);
                }
            });

            fileInput.addEventListener('change', (e) => {
                const list = e.target.files;
                if (!list || !list.length) return;
                (async () => {
                    for (let i = 0; i < list.length; i++) {
                        await this.uploadAndAnalyzeFile(list[i], service, attachedFiles);
                    }
                })();
                e.target.value = '';
            });
        });
    }

    resolvePreviewUrl(fileUuid, filename) {
        const urlFn =
            typeof window.beanthenticApiUrl === 'function' ? window.beanthenticApiUrl : (p) => p;
        const name = String(filename || '');
        const ext = name.includes('.') ? '.' + name.split('.').pop().toLowerCase() : '';
        return urlFn(`/api/file-preview/${fileUuid}${ext}`);
    }

    async parseApiResponse(response) {
        if (typeof window.beanthenticParseJsonResponse === 'function') {
            return window.beanthenticParseJsonResponse(response);
        }
        return response.json();
    }

    removeFileCardByName(container, filename) {
        if (!container || !filename) return null;
        const nameEl = Array.from(container.querySelectorAll('.file-item .file-name'))
            .find((el) => el.textContent === filename);
        const card = nameEl?.closest('.file-item');
        const oldUuid = card?.dataset?.fileUuid || null;
        if (card) card.remove();
        return oldUuid;
    }

    fileAlreadyInContainer(container, filename) {
        if (!container || !filename) return false;
        return Array.from(
            container.querySelectorAll('.file-item:not(.uploading):not(.error) .file-name')
        ).some((el) => el.textContent === filename);
    }

    /** Upload to server, run ML analysis, show brain/delete icons, open AI panel. */
    async uploadAndAnalyzeFile(file, service, attachedFilesContainer) {
        if (!file || !service || !attachedFilesContainer) return;

        // Replacing a same-named file should analyze the new bytes, not reuse stale UUID/analysis.
        this.removeFileCardByName(attachedFilesContainer, file.name);

        const [phase] = this.parseServiceName(service);
        // Clear stale reviewer notes before the new upload finishes.
        this.resetAnalysisUI();
        this.showAnalysisLoadingPlaceholder(file.name);
        this.showUploadProgress(attachedFilesContainer, file.name);

        const formData = new FormData();
        formData.append('file', file);
        formData.append('phase', phase);
        formData.append('task_id', service);

        try {
            const response = await ipophlApi('/api/ipo-analyze', {
                method: 'POST',
                body: formData,
            });
            const result = await this.parseApiResponse(response);
            if (!response.ok || !result.success) {
                throw new Error(result.error || result.message || `Upload failed (HTTP ${response.status})`);
            }

            this.displayUploadedFile(attachedFilesContainer, result, file.name);

            const fileData = {
                file_info: { filename: result.filename || file.name },
                preview_url: this.resolvePreviewUrl(result.file_uuid, result.filename || file.name),
                analysis: result.analysis,
                file_uuid: result.file_uuid,
            };
            this.showFullAIAnalysis(fileData);
            // Force Refresh Analysis after every new upload so the panel never shows stale notes.
            if (result.file_uuid) {
                await this.refreshAnalysis();
            }

            const gi = result.gi_publish;
            if (gi && gi.ok) {
                this.showToast('Uploaded — live on farmers\' GI Updates.', 'success');
            } else if (gi && gi.error) {
                this.showToast(
                    `Uploaded, but GI Updates sync failed: ${gi.error}`,
                    'error'
                );
            } else {
                this.showToast('Document uploaded — analysis refreshed.', 'success');
            }
            if (window.dashboardApp?.syncCompleteRegistrationButtonState) {
                window.dashboardApp.syncCompleteRegistrationButtonState();
            }
            if (window.dashboardApp?.updateGiProcessIndicator) {
                window.dashboardApp.updateGiProcessIndicator();
            }
        } catch (error) {
            console.error('IPOPHL upload/analyze failed:', error);
            const msg = error.message || 'Upload or analysis failed';
            this.showUploadError(attachedFilesContainer, file.name, msg);
            this.showToast(msg, 'error');
        }
    }

    showAnalysisLoadingPlaceholder(filename) {
        const statusBadge = document.getElementById('analysisStatusBadge');
        const resultsEl = document.getElementById('analysisResults');
        const container = document.getElementById('requirementAnalysisContent');
        if (statusBadge) statusBadge.textContent = 'Refreshing…';
        if (resultsEl) resultsEl.classList.add('loading');
        if (container) {
            container.innerHTML =
                `<p class="placeholder">Refreshing analysis for <strong>${this.escapeHtml(filename || 'new upload')}</strong>… previous notes cleared.</p>`;
        }
        const nameEl = document.getElementById('previewFileName');
        if (nameEl && filename) nameEl.textContent = filename;
    }

    /** Called from dashboard.js when a phase file is added. */
    handleFileUpload(file, service, attachedFilesContainer) {
        return this.uploadAndAnalyzeFile(file, service, attachedFilesContainer);
    }

    /** Pick file locally — uploads to database only when admin clicks Complete Registration. */
    stageFileForComplete(file, service, attachedFilesContainer) {
        if (!file || !service) return;
        const key = `${file.name}:${file.size}:${file.lastModified || 0}`;
        if (!this.pendingByTask[service]) {
            this.pendingByTask[service] = [];
        }
        if (this.pendingByTask[service].some((p) => p.key === key)) {
            return;
        }
        this.pendingByTask[service].push({ file, key });
        this.renderPendingCard(attachedFilesContainer, file, service);
        if (window.dashboardApp && window.dashboardApp.ipophlFiles) {
            if (!window.dashboardApp.ipophlFiles[service]) {
                window.dashboardApp.ipophlFiles[service] = [];
            }
            if (!window.dashboardApp.ipophlFiles[service].some((f) => f.pendingKey === key)) {
                window.dashboardApp.ipophlFiles[service].push({
                    id: `pending-${key}`,
                    name: file.name,
                    pendingKey: key,
                });
            }
        }
        this.refreshDashboardIndicator();
        this.showToast(
            'File selected. Click Complete Registration (Phase 5) to upload and send to GI Updates.',
            'success'
        );
    }

    renderPendingCard(container, file, service) {
        if (!container) return;
        const fileItem = document.createElement('div');
        fileItem.className = 'file-item pending';
        fileItem.dataset.pendingKey = `${file.name}:${file.size}:${file.lastModified || 0}`;
        fileItem.dataset.taskId = service;
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        const iconClass =
            ext === 'pdf'
                ? 'fa-file-pdf text-danger'
                : ext === 'doc' || ext === 'docx'
                  ? 'fa-file-word text-primary'
                  : 'fa-file-lines text-success';
        fileItem.innerHTML = `
            <div class="file-info">
                <i class="fa-solid ${iconClass}"></i>
                <div class="file-details">
                    <span class="file-name">${file.name}</span>
                    <span class="file-meta">Ready — publishes on Complete Registration</span>
                </div>
            </div>
            <div class="file-status-actions">
                <div class="file-actions">
                    <button type="button" class="file-action-btn ai-analysis pending-analyze" title="Upload first for AI analysis" disabled>
                        <i class="fa-solid fa-brain"></i>
                    </button>
                    <button type="button" class="file-action-btn delete" title="Remove">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </div>
        `;
        const del = fileItem.querySelector('.file-action-btn.delete');
        if (del) {
            del.addEventListener('click', (e) => {
                e.stopPropagation();
                const k = fileItem.dataset.pendingKey;
                this.pendingByTask[service] = (this.pendingByTask[service] || []).filter(
                    (p) => p.key !== k
                );
                if (window.dashboardApp?.ipophlFiles?.[service]) {
                    window.dashboardApp.ipophlFiles[service] = window.dashboardApp.ipophlFiles[
                        service
                    ].filter((f) => f.pendingKey !== k);
                }
                fileItem.remove();
                this.refreshDashboardIndicator();
            });
        }
        container.appendChild(fileItem);
    }

    collectPendingUploads() {
        const out = [];
        const seen = new Set();
        const add = (file, taskId) => {
            const tid = String(taskId || '').trim();
            if (!file || !tid) return;
            const sig = `${tid}:${file.name}:${file.size}`;
            if (seen.has(sig)) return;
            seen.add(sig);
            out.push({ file, task_id: tid });
        };
        Object.keys(this.pendingByTask || {}).forEach((taskId) => {
            (this.pendingByTask[taskId] || []).forEach((p) => add(p.file, taskId));
        });
        document.querySelectorAll('#ipophl-module .file-upload-zone[data-service]').forEach((zone) => {
            const taskId = zone.dataset.service;
            const input = zone.querySelector('.file-input');
            if (!input?.files?.length) return;
            for (let i = 0; i < input.files.length; i++) {
                add(input.files[i], taskId);
            }
        });
        return out;
    }

    clearPendingAfterPublish() {
        this.pendingByTask = {};
        document.querySelectorAll('#ipophl-module .file-item.pending').forEach((el) => el.remove());
        document.querySelectorAll('#ipophl-module .file-input').forEach((input) => {
            input.value = '';
        });
        if (window.dashboardApp?.ipophlFiles) {
            Object.keys(window.dashboardApp.ipophlFiles).forEach((taskId) => {
                window.dashboardApp.ipophlFiles[taskId] = (
                    window.dashboardApp.ipophlFiles[taskId] || []
                ).filter((f) => !f.pendingKey);
            });
        }
        this.refreshDashboardIndicator();
    }

    parseServiceName(service) {
        // Extract phase and task from service names like "phase1-introduction"
        const parts = service.split('-');
        const phase = parts[0] || 'unknown';
        const task = parts.slice(1).join('-') || 'unknown';
        return [phase, task];
    }

    showUploadProgress(container, filename) {
        if (!container) return;
        const fileItem = document.createElement('div');
        fileItem.className = 'file-item uploading';
        fileItem.dataset.filename = filename;
        fileItem.innerHTML = `
            <div class="file-info">
                <i class="fa-solid fa-spinner fa-spin"></i>
                <div class="file-details">
                    <span class="file-name">${filename}</span>
                    <span class="file-meta">Uploading and analyzing...</span>
                </div>
            </div>
            <div class="file-status-actions">
                <div class="file-actions">
                    <i class="fa-solid fa-sync fa-spin" style="color: #64748b; margin-right: 10px;"></i>
                </div>
            </div>
        `;
        
        container.appendChild(fileItem);
    }

    showUploadError(container, filename, error) {
        if (!container) return;
        const fileItem = Array.from(container.querySelectorAll('.file-item.uploading'))
            .find(item => item.dataset.filename === filename);
            
        if (fileItem) {
            fileItem.className = 'file-item error';
            fileItem.innerHTML = `
                <div class="file-info">
                    <i class="fa-solid fa-circle-exclamation text-danger"></i>
                    <div class="file-details">
                        <span class="file-name">${filename}</span>
                        <span class="file-meta text-danger">${error}</span>
                    </div>
                </div>
                <div class="file-status-actions">
                    <div class="file-actions">
                        <button type="button" class="file-action-btn delete" title="Remove">
                            <i class="fa-solid fa-trash-can"></i>
                        </button>
                    </div>
                </div>
            `;
            const del = fileItem.querySelector('.file-action-btn.delete');
            if (del) {
                del.addEventListener('click', () => {
                    const taskId = container?.id?.replace('-files', '') || '';
                    fileItem.remove();
                    if (window.dashboardApp?.resetIpophlUploadZone) {
                        window.dashboardApp.resetIpophlUploadZone(taskId);
                    } else if (window.dashboardApp?.syncIpophlUploadZoneCompactState) {
                        window.dashboardApp.syncIpophlUploadZoneCompactState();
                    }
                    this.refreshDashboardIndicator();
                });
            }
        }
    }

    displayUploadedFile(container, result, originalFilename) {
        // Find the specific placeholder for this file
        const fileItem = Array.from(container.querySelectorAll('.file-item.uploading'))
            .find(item => item.dataset.filename === originalFilename);
            
        if (fileItem) {
            fileItem.remove(); // Remove the placeholder uploading item
        }
        
        const taskId = container.id.replace('-files', '');
        const analysis = result.analysis || {};
        const doc = {
            filename: result.filename,
            file_size: analysis.text_length ? analysis.text_length * 2 : 0,
            file_uuid: result.file_uuid,
            ai_score: analysis.readiness_score,
            ai_status: analysis.status,
            task_id: taskId
        };

        this.renderDocumentCard(container, doc);
        this.updateDashboardState(taskId, doc, 'add');
        this.refreshDashboardIndicator();
    }

    async deleteFile(fileUuid, btn) {
        const confirmed = await window.dashboardApp.showConfirmDialog(
            'Are you sure you want to delete this document? This action cannot be undone.',
            'Delete Document',
            'danger'
        );
        if (!confirmed) return;
        
        try {
            const response = await ipophlApi(`/api/ipo-delete/${fileUuid}`, { method: 'DELETE' });
            const result = await response.json();
            
            if (result.success) {
                const fileItem = btn.closest('.file-item');
                const container = fileItem?.parentElement;
                const taskId = container?.id?.replace('-files', '') || '';

                this.updateDashboardState(taskId, { file_uuid: fileUuid }, 'remove');

                if (fileItem) {
                    fileItem.remove();
                }

                if (window.dashboardApp?.resetIpophlUploadZone) {
                    window.dashboardApp.resetIpophlUploadZone(taskId);
                } else if (window.dashboardApp?.syncIpophlUploadZoneCompactState) {
                    window.dashboardApp.syncIpophlUploadZoneCompactState();
                }
                this.refreshDashboardIndicator();
                const giOk = result.gi_sync && result.gi_sync.ok !== false;
                this.showToast(
                    giOk
                        ? 'Document deleted and removed from farmer GI Updates.'
                        : 'Document deleted.',
                    'success'
                );
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            this.showToast('Failed to delete document', 'error');
        }
    }

    getScoreClass(score) {
        if (score >= 75) return 'score-high';
        if (score >= 50) return 'score-medium';
        return 'score-low';
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    async loadFilePreview(previewUrl) {
        const frame = document.getElementById('filePreviewFrame');
        const wordArea = document.getElementById('wordPreviewArea');
        const wordViewport = document.getElementById('wordPreviewViewport');
        const wordStyles = document.getElementById('wordPreviewStyles');
        const loading = document.getElementById('previewLoading');
        const container = document.querySelector('.preview-container');
        if (!frame || !loading || !container || !wordArea || !wordViewport || !wordStyles) return;

        loading.classList.remove('hidden');
        frame.style.display = 'none';
        wordArea.style.display = 'none';
        wordArea.classList.add('hidden');
        wordViewport.innerHTML = '';
        wordStyles.innerHTML = '';
        frame.src = 'about:blank';

        const filename = this.currentFile ? this.currentFile.filename.toLowerCase() : '';
        const isDocx = filename.endsWith('.docx');
        const isLegacyDoc = filename.endsWith('.doc');

        if (isDocx || isLegacyDoc) {
            try {
                if (isLegacyDoc) {
                    throw new Error('Legacy .doc files must be downloaded or re-saved as .docx for in-browser preview.');
                }
                if (typeof docx === 'undefined' || typeof docx.renderAsync !== 'function') {
                    throw new Error('Document preview library failed to load.');
                }

                const response = await fetch(previewUrl, { credentials: 'same-origin' });
                if (!response.ok) {
                    throw new Error(`Could not load document (${response.status}).`);
                }
                const arrayBuffer = await response.arrayBuffer();

                wordArea.style.display = 'block';
                wordArea.classList.remove('hidden');

                await docx.renderAsync(arrayBuffer, wordViewport, wordStyles, {
                    className: 'docx-beanthentic',
                    inWrapper: true,
                    ignoreWidth: false,
                    ignoreHeight: false,
                    ignoreFonts: false,
                    breakPages: true,
                    renderHeaders: true,
                    renderFooters: true,
                    renderFootnotes: true,
                    renderEndnotes: true,
                    useBase64URL: true,
                });
                wordStyles.insertAdjacentHTML(
                    'beforeend',
                    '<style>.docx-wrapper{background:transparent!important;padding:0!important;margin:0 auto!important;}.docx-wrapper>section.docx-beanthentic,.docx-wrapper>section.docx{margin-bottom:0!important;}</style>'
                );

                loading.classList.add('hidden');
                this.fitWordPreviewToContainer();
                this.applyTransform();
            } catch (error) {
                console.error('Word rendering failed:', error);
                loading.classList.add('hidden');
                wordArea.style.display = 'block';
                wordArea.classList.remove('hidden');
                wordViewport.innerHTML = `
                    <div class="preview-error">
                        <i class="fa-solid fa-file-circle-exclamation" aria-hidden="true"></i>
                        <h4>Preview Failed</h4>
                        <p>${this.escapeHtml(error.message || 'We could not render this Word document.')}</p>
                        <button type="button" class="btn btn-primary" onclick="window.ipophlAnalyzer.downloadCurrent()">
                            <i class="fa-solid fa-download"></i> Download Document
                        </button>
                    </div>
                `;
            }
        } else {
            // For PDFs and others, use the native iframe preview
            frame.style.display = 'block';
            let finalUrl = previewUrl;
            
            if (filename.endsWith('.pdf')) {
                finalUrl += '#toolbar=0&navpanes=0&scrollbar=0&view=FitH';
            }

            frame.onload = () => {
                loading.classList.add('hidden');
            };

            frame.src = finalUrl;

            // Auto-hide spinner after timeout
            setTimeout(() => {
                if (!loading.classList.contains('hidden')) {
                    loading.classList.add('hidden');
                }
            }, 8000);
        }

        this.currentZoom = 100;
        this.currentRotation = 0;
    }

    zoomIn() {
        this.currentZoom += 10;
        this.applyTransform();
    }

    zoomOut() {
        if (this.currentZoom > 20) {
            this.currentZoom -= 10;
            this.applyTransform();
        }
    }

    rotate() {
        this.currentRotation = (this.currentRotation + 90) % 360;
        this.applyTransform();
    }

    applyTransform() {
        const transform = `scale(${this.currentZoom / 100}) rotate(${this.currentRotation}deg)`;
        const frame = document.getElementById('filePreviewFrame');
        const wordViewport = document.getElementById('wordPreviewViewport');
        if (frame && frame.style.display !== 'none') {
            frame.style.transform = transform;
            frame.style.transformOrigin = 'top center';
        }
        if (wordViewport) {
            wordViewport.style.transform = transform;
            wordViewport.style.transformOrigin = 'top center';
        }
    }

    downloadCurrent() {
        if (this.currentFile && this.currentFile.preview_url) {
            const link = document.createElement('a');
            link.href = this.currentFile.preview_url;
            link.download = this.currentFile.filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
    }

    printCurrent() {
        const wordArea = document.getElementById('wordPreviewArea');
        const wordViewport = document.getElementById('wordPreviewViewport');
        if (wordArea && wordArea.style.display !== 'none' && wordViewport && wordViewport.innerHTML.trim()) {
            const printWin = window.open('', '_blank', 'noopener,noreferrer');
            if (!printWin) return;
            printWin.document.write(`<!DOCTYPE html><html><head><title>${this.escapeHtml(this.currentFile?.filename || 'Document')}</title>`);
            printWin.document.write('<style>body{margin:0;padding:0;background:#fff;} .docx-wrapper{padding:0!important;}</style>');
            printWin.document.write('</head><body>');
            printWin.document.write(wordViewport.innerHTML);
            printWin.document.write('</body></html>');
            printWin.document.close();
            printWin.focus();
            printWin.print();
            return;
        }
        const frame = document.getElementById('filePreviewFrame');
        if (frame) {
            frame.contentWindow.focus();
            frame.contentWindow.print();
        }
    }

    async loadAIAnalysis(fileData) {
        if (!fileData) return;
        
        const resultsEl = document.getElementById('analysisResults');
        const statusBadge = document.getElementById('analysisStatusBadge');
        
        if (statusBadge) statusBadge.textContent = 'Analyzing...';
        if (resultsEl) resultsEl.classList.add('loading');

        this.resetAnalysisUI();

        // Use analysis results if already provided
        if (fileData.analysis) {
            this.displayAnalysisResults(fileData.analysis);
        } else {
            try {
                const filename = (fileData.file_info && fileData.file_info.filename) ? 
                                fileData.file_info.filename : 
                                (fileData.filename || '');
                
                const identifier = fileData.file_uuid || (filename ? filename.split('.')[0] : null);
                
                if (!identifier) throw new Error('No valid file identifier found');

                const response = await ipophlApi(`/api/ipo-analysis/${encodeURIComponent(identifier)}`);
                const result = await response.json();
                
                if (result.success) {
                    this.displayAnalysisResults(result.analysis);
                } else {
                    throw new Error(result.error || 'Analysis results not yet available. Please try refreshing.');
                }
            } catch (error) {
                console.error('Failed to load analysis:', error);
                this.showAnalysisError(error.message);
            }
        }
    }

    resetAnalysisUI() {
        const container = document.getElementById('requirementAnalysisContent');
        const typing = document.getElementById('aiChatTyping');
        if (container) {
            container.querySelectorAll(
                '.ai-analysis-block, .ai-pillar-grid, .ai-doc-insights, .ai-review-shell'
            ).forEach((el) => el.remove());
        }
        if (typing) typing.hidden = false;
    }

    showChatTyping(show) {
        const typing = document.getElementById('aiChatTyping');
        if (typing) typing.hidden = !show;
    }

    formatPlainText(text) {
        let raw = String(text ?? '');
        raw = raw.replace(/<[^>]+>/g, ' ');
        raw = raw.replace(/\*\*(.+?)\*\*/g, '$1');
        raw = raw.replace(/\s{2,}/g, ' ').trim();
        return this.escapeHtml(raw);
    }

    /** Escape text, then bold the phrases that matter most for the reviewer. */
    formatReviewerEmphasis(text, extraFocus = []) {
        let safe = this.escapeHtml(String(text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim());
        if (!safe) return '';
        const focus = [
            ...extraFocus,
            'Not Ready',
            'Ready',
            'Kapeng Barako',
            'Coffea liberica',
            'Batangas',
            'Lipa',
            'Guimaras',
            'mangoes',
            'mango',
            'Tnalak',
            'product focus',
            'Trademark',
            'Copyright',
            'Industrial Design',
            'Patent',
            'Manual of Specifications',
            'MoP',
        ]
            .map((s) => String(s || '').trim())
            .filter(Boolean)
            .sort((a, b) => b.length - a.length);
        const seen = new Set();
        focus.forEach((phrase) => {
            const key = phrase.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            const re = new RegExp(
                `(^|[^A-Za-z0-9_])(${this.escapeRegExp(phrase)})(?![A-Za-z0-9_])`,
                'gi'
            );
            safe = safe.replace(re, (_, pre, m) => `${pre}<strong>${m}</strong>`);
        });
        return safe;
    }

    escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    formatAssistantMarkdown(text) {
        return this.formatPlainText(text);
    }

    pillarStatusLabel(status) {
        const map = {
            addressed: 'Addressed',
            partial: 'Partial',
            not_addressed: 'Gap',
        };
        return map[status] || 'Gap';
    }

    renderPillarTags(items, kind) {
        if (!items?.length) return '';
        const cls = kind === 'gap' ? 'ai-tag ai-tag--gap' : 'ai-tag';
        return `<div class="ai-tag-list">${items.map((item) =>
            `<span class="${cls}">${this.escapeHtml(item)}</span>`
        ).join('')}</div>`;
    }

    renderPillarCards(pillars) {
        if (!pillars.length) return '';
        const cards = pillars.map((pillar) => {
            const status = pillar.status || 'not_addressed';
            const met = Array.isArray(pillar.met) ? pillar.met.slice(0, 4) : [];
            const gaps = Array.isArray(pillar.gaps) ? pillar.gaps.slice(0, 4) : [];
            const scope = pillar.scope
                ? `<p class="ai-pillar-card__scope">${this.escapeHtml(pillar.scope)}</p>`
                : '';
            return `<article class="ai-pillar-card ai-pillar-card--${status}">
                <div class="ai-pillar-card__head">
                    <span class="ai-pillar-card__title">${this.escapeHtml(pillar.label || pillar.id || 'Pillar')}</span>
                    <span class="ai-pillar-chip ai-pillar-chip--${status}">${this.pillarStatusLabel(status)}</span>
                </div>
                ${scope}
                ${this.renderPillarTags(met, 'met')}
                ${this.renderPillarTags(gaps, 'gap')}
            </article>`;
        }).join('');
        return `<div class="ai-pillar-grid">${cards}</div>`;
    }

    getReviewMeta(analysis, assessment) {
        const insights = assessment?.document_insights || {};
        const breakdown = analysis.score_breakdown || {};
        const productFocus = analysis.product_focus
            || breakdown.product_focus
            || insights.product_focus
            || null;
        const ready = String(analysis.status || '').trim().toLowerCase() === 'ready';
        const wordCount = Number(
            insights.word_count
            || breakdown.word_count
            || analysis.word_count
            || Math.round((Number(analysis.text_length) || 0) / 5)
            || 0
        );
        const themesMet = Number(
            insights.checklist_met
            ?? breakdown.sections_found
            ?? 0
        );
        const themesTotal = Number(
            insights.checklist_total
            ?? breakdown.sections_total
            ?? (Array.isArray(breakdown.sections) ? breakdown.sections.length : 0)
            ?? 0
        );
        const docType = String(
            insights.document_type
            || (analysis.task_id || '').replace(/-/g, ' ')
            || 'GI document'
        ).trim();
        const method = String(analysis.analysis_method || breakdown.analysis_mode || 'GI document review')
            .replace(/official[_ ]mop[_ ]ensemble[_ ]hybrid|official[_ ]mop[_ ]qualitative|mop[_ ]reference[_ ]qualitative/gi, 'GI document review')
            .replace(/_/g, ' ');
        return {
            ready,
            statusLabel: ready ? 'Ready' : 'Not Ready',
            wordCount,
            themesMet,
            themesTotal,
            docType: docType.replace(/\b\w/g, (c) => c.toUpperCase()),
            method,
            rfScore: analysis.rf_score != null ? Number(analysis.rf_score) : null,
            rfAgreement: analysis.rf_agreement,
            strengths: (insights.detected_features || analysis.detected_features || []).slice(0, 8),
            missing: (insights.missing_requirements || analysis.missing_requirements || []).slice(0, 8),
            sections: Array.isArray(breakdown.sections) ? breakdown.sections : [],
            reference: insights.reference_source || breakdown.reference_source || '',
            productFocus,
            textExcerpt: String(
                analysis.text_excerpt
                || breakdown.text_excerpt
                || insights.text_excerpt
                || ''
            ).trim(),
            contentFingerprint: String(
                analysis.content_fingerprint
                || breakdown.content_fingerprint
                || insights.content_fingerprint
                || ''
            ).trim(),
        };
    }

    buildShortVerdict(analysis, assessment, meta) {
        const ready = meta.ready;
        const pf = meta.productFocus || {};
        const off = (pf.off_product_hits || []).slice(0, 3);
        const pillars = assessment?.pillars || [];
        const pillarFocus = [
            ...pillars.filter((p) => p.status === 'partial').map((p) => p.label),
            ...pillars.filter((p) => p.status === 'not_addressed').map((p) => p.label),
        ].slice(0, 3);
        const themeFocus = (meta.missing || [])
            .filter((m) => !/product focus/i.test(m))
            .slice(0, 3);
        const doc = this.escapeHtml(meta.docType);

        if (ready) {
            return (
                `Nice work — this <strong>${doc}</strong> already covers the critical ` +
                `<strong>Kapeng Barako</strong> GI requirements for this upload group.` +
                (pillarFocus.length || themeFocus.length
                    ? ` Optional polish: <strong>${this.escapeHtml((pillarFocus.length ? pillarFocus : themeFocus).join(', '))}</strong>.`
                    : ' Keep the companion uploads aligned so the full package stays consistent.')
            );
        }

        if (pf.ok === false || pf.wrong_product || /product focus/i.test((meta.missing || []).join(' '))) {
            const cue = pf.wrong_product && off.length
                ? ` It currently reads more like <strong>${this.escapeHtml(off.join(', '))}</strong>.`
                : '';
            const focusLine = pf.wrong_product && off.length
                ? `rewrite so the product, origin, and reputation clearly belong to <strong>Kapeng Barako</strong> from <strong>Batangas</strong>.${cue}`
                : `upload or rewrite a document that clearly names <strong>Kapeng Barako</strong>, <strong>Liberica</strong>, and <strong>Batangas / Lipa</strong> origin.`;
            return (
                `I can't mark this <strong>${doc}</strong> as <strong>Ready</strong> yet.` +
                ` The priority fix is <strong>Kapeng Barako product focus</strong> — ${focusLine}` +
                ` Trademark / Copyright details can wait until the product identity is right.`
            );
        }

        if (themeFocus.length) {
            return (
                `This <strong>${doc}</strong> is still <strong>Not Ready</strong>.` +
                ` Please build out <strong>${this.escapeHtml(themeFocus.join(', '))}</strong> first` +
                ` with concrete Kapeng Barako GI content, then send it back for another look.`
            );
        }

        if (pillarFocus.length) {
            return (
                `This <strong>${doc}</strong> is still <strong>Not Ready</strong>.` +
                ` From my reading, the weakest spots are <strong>${this.escapeHtml(pillarFocus.join(', '))}</strong>.` +
                ` Flesh those out with clear, examiner-friendly wording.`
            );
        }

        return (
            `This <strong>${doc}</strong> is still <strong>Not Ready</strong>.` +
            ` Critical <strong>Kapeng Barako</strong> GI requirements are missing or only thinly covered.`
        );
    }

    renderFeedbackHero(meta, summaryHtml) {
        const tone = meta.ready ? 'ready' : 'not-ready';
        const icon = meta.ready ? 'fa-circle-check' : 'fa-pen-to-square';
        const eyebrow = meta.ready ? 'Positive feedback' : 'Revision feedback';
        return `<section class="fb-hero fb-hero--${tone}" aria-label="Overall feedback">
            <div class="fb-hero__icon" aria-hidden="true"><i class="fa-solid ${icon}"></i></div>
            <div class="fb-hero__body">
                <p class="fb-hero__eyebrow">${eyebrow}</p>
                <h5 class="fb-hero__title">${this.escapeHtml(meta.statusLabel)}</h5>
                <p class="fb-hero__summary">${summaryHtml}</p>
                ${meta.reference
                    ? `<p class="fb-hero__ref"><i class="fa-solid fa-book-open"></i> Checked against ${this.escapeHtml(meta.reference)}</p>`
                    : ''}
            </div>
        </section>`;
    }

    renderFeedbackMeta(meta) {
        const themeText = meta.themesTotal
            ? `${meta.themesMet} of ${meta.themesTotal} themes covered`
            : 'Theme coverage pending';
        const reviewChip = `<span class="fb-meta__chip fb-meta__chip--authority"><i class="fa-solid fa-scale-balanced"></i> Review · ${this.escapeHtml(meta.statusLabel)}</span>`;
        let ensembleChip = '';
        let mlNote = '';
        if (meta.rfScore != null) {
            const agree =
                meta.rfAgreement == null
                    ? 'recorded'
                    : meta.rfAgreement
                      ? 'agrees'
                      : 'differs';
            ensembleChip = `<span class="fb-meta__chip fb-meta__chip--secondary" title="Advisory only — document review decides Ready / Not Ready"><i class="fa-solid fa-robot"></i> Ensemble ${this.escapeHtml(agree)}</span>`;
            const rfReady = meta.rfScore >= 75;
            mlNote = `<p class="fb-ml-note">Ensemble confidence ${meta.rfScore}% (${rfReady ? 'Ready' : 'Not Ready'} at 75% threshold) — ${meta.rfAgreement ? 'aligned with' : 'differs from'} document review.</p>`;
        }
        return `<section class="fb-meta" aria-label="Feedback context">
            ${reviewChip}
            <span class="fb-meta__chip"><i class="fa-solid fa-file"></i> ${this.escapeHtml(meta.docType)}</span>
            <span class="fb-meta__chip"><i class="fa-solid fa-layer-group"></i> ${this.escapeHtml(themeText)}</span>
            ${ensembleChip}
            ${meta.wordCount
                ? `<span class="fb-meta__chip"><i class="fa-solid fa-align-left"></i> ${meta.wordCount.toLocaleString()} words scanned</span>`
                : ''}
            ${meta.contentFingerprint
                ? `<span class="fb-meta__chip" title="Unique scan ID for this file content"><i class="fa-solid fa-fingerprint"></i> Scan ${this.escapeHtml(meta.contentFingerprint)}</span>`
                : ''}
        </section>
        ${mlNote}
        ${meta.textExcerpt
            ? `<details class="fb-scan-excerpt">
                <summary><i class="fa-solid fa-file-lines"></i> Text scanned from this upload</summary>
                <p>${this.escapeHtml(meta.textExcerpt)}${meta.textExcerpt.length >= 600 ? '…' : ''}</p>
               </details>`
            : ''}`;
    }

    renderHighlightStrip(meta) {
        return this.renderFeedbackMeta(meta);
    }

    renderThemeCoverage(sections) {
        if (!sections.length) return '';
        const rows = sections.map((s) => {
            const cov = String(s.coverage || (s.found ? 'well_covered' : 'missing'));
            const cls = cov === 'well_covered' || s.found
                ? 'fb-theme--ok'
                : (cov === 'partial' ? 'fb-theme--partial' : 'fb-theme--gap');
            const label = cov.replace(/_/g, ' ');
            const evidence = Array.isArray(s.evidence) ? s.evidence.filter(Boolean).slice(0, 4) : [];
            const tipParts = [];
            if (s.expectation) tipParts.push(this.escapeHtml(s.expectation));
            if (evidence.length) {
                tipParts.push(`<span class="fb-theme__evidence">Cues found: ${this.escapeHtml(evidence.join(', '))}</span>`);
            }
            const tip = tipParts.length
                ? `<p class="fb-theme__tip">${tipParts.join(' ')}</p>`
                : '';
            return `<li class="fb-theme ${cls}">
                <div class="fb-theme__top">
                    <span class="fb-theme__name">${this.escapeHtml(s.label || 'Theme')}</span>
                    <span class="fb-theme__state">${this.escapeHtml(label)}</span>
                </div>
                ${tip}
            </li>`;
        }).join('');
        return `<section class="fb-card">
            <div class="fb-card__head">
                <h5><i class="fa-solid fa-list-check"></i> Theme coverage</h5>
                <p>How this upload meets GI filing requirements for its document group</p>
            </div>
            <ul class="fb-theme-list">${rows}</ul>
        </section>`;
    }

    renderFindingsBlocks(meta) {
        const strengthBlock = meta.strengths.length
            ? `<div class="fb-side fb-side--ok">
                <h6><i class="fa-solid fa-thumbs-up"></i> What's working</h6>
                ${this.renderPillarTags(meta.strengths, 'met')}
               </div>`
            : '';
        const gapBlock = meta.missing.length
            ? `<div class="fb-side fb-side--gap">
                <h6><i class="fa-solid fa-flag"></i> Needs attention</h6>
                ${this.renderPillarTags(meta.missing, 'gap')}
               </div>`
            : '';
        if (!strengthBlock && !gapBlock) return '';
        return `<section class="fb-card">
            <div class="fb-card__head">
                <h5><i class="fa-solid fa-comments"></i> Quick feedback</h5>
                <p>Strengths to keep and gaps to fix</p>
            </div>
            <div class="fb-side-grid">${strengthBlock}${gapBlock}</div>
        </section>`;
    }

    dedupeRecommendations(recs, meta, summaryHtml = '') {
        const hero = String(summaryHtml).replace(/<[^>]+>/g, ' ').toLowerCase();
        const seen = new Set();
        return recs.filter((item) => {
            const text = String(item || '').trim();
            if (!text) return false;
            const key = text.toLowerCase().slice(0, 48);
            if (seen.has(key)) return false;
            seen.add(key);
            if (/product focus|upload or rewrite|liberica|batangas \/ lipa/i.test(text)
                && /product focus|kapeng barako|liberica|batangas/i.test(hero)) {
                return false;
            }
            if (meta?.missing?.length) {
                const overlap = meta.missing.some((m) => {
                    const label = String(m).toLowerCase();
                    return label.length > 8 && text.toLowerCase().includes(label.slice(0, 20));
                });
                if (overlap && /strengthen|add|fill|expand/i.test(text)) return false;
            }
            return true;
        }).slice(0, 4);
    }

    dedupeShapHtml(raw) {
        if (!raw) return '';
        let html = String(raw).trim();
        const stripPatterns = [
            /<p>\s*I reviewed this[\s\S]*?<\/p>/gi,
            /<p>\s*<strong>What I need from you next:[\s\S]*?<\/p>/gi,
            /<p>\s*<strong>What already works:[\s\S]*?<\/p>/gi,
            /<p>\s*<strong>Theme notes[\s\S]*?<\/ul>/gi,
            /<p>\s*<strong>Ensemble validation[\s\S]*?<\/p>/gi,
            /<p>\s*<strong>SHAP feature influence[\s\S]*?<\/p>/gi,
            /<p>\s*<strong>Main issue[\s\S]*?<\/p>/gi,
            /<p>\s*<strong>Product identity gap\.[\s\S]*?<\/p>/gi,
            /<p>\s*The (?:MoP )?themes are satisfied[\s\S]*?<\/p>/gi,
            /<p>\s*The ensemble may reflect[\s\S]*?<\/p>/gi,
        ];
        stripPatterns.forEach((re) => {
            html = html.replace(re, '');
        });
        return html.replace(/\s{2,}/g, ' ').trim();
    }

    buildRecommendations(analysis, assessment, gaps, meta = null, summaryHtml = '') {
        const pf = analysis.product_focus
            || analysis.score_breakdown?.product_focus
            || null;
        if (Array.isArray(assessment?.recommendations) && assessment.recommendations.length) {
            return assessment.recommendations;
        }
        if (Array.isArray(analysis.improvements) && analysis.improvements.length) {
            return analysis.improvements;
        }
        const recs = [];
        if (pf && pf.ok === false) {
            const off = (pf.off_product_hits || []).slice(0, 3);
            recs.push(
                pf.wrong_product && off.length
                    ? `Rewrite so this is clearly Kapeng Barako — not ${off.join(', ')}.`
                    : 'Upload or rewrite a Kapeng Barako GI document with clear Liberica / Batangas identity language.'
            );
        }
        (assessment?.pillars || []).forEach((pillar) => {
            if (pillar.gaps?.length) {
                recs.push(
                    `On ${pillar.label}, please add: ${pillar.gaps.slice(0, 4).join(', ')}.`
                );
            }
        });
        if (!recs.length && gaps.length) {
            recs.push(`Please fill in: ${gaps.slice(0, 4).join(', ')}.`);
        }
        if (!recs.length) {
            recs.push('Check companion uploads so any theme not covered here still appears in the package.');
        } else if (!meta?.ready) {
            recs.push('After you revise, hit Refresh Analysis so I can re-check Ready / Not Ready.');
        }
        return this.dedupeRecommendations(recs, meta, summaryHtml);
    }

    renderChatAnalysis(analysis) {
        const container = document.getElementById('requirementAnalysisContent');
        if (!container) return;

        const assessment = analysis.ip_pillar_assessment || null;
        const pillars = Array.isArray(assessment?.pillars) ? assessment.pillars : [];
        const gaps = this.collectRequirementGaps(analysis);
        const meta = this.getReviewMeta(analysis, assessment);
        const summaryHtml = this.buildShortVerdict(analysis, assessment, meta);
        const recommendations = this.buildRecommendations(analysis, assessment, gaps, meta, summaryHtml);

        this.showChatTyping(false);

        const themes = this.renderThemeCoverage(meta.sections);
        const pillarBlock = pillars.length
            ? `<section class="fb-card">
                <div class="fb-card__head">
                    <h5><i class="fa-solid fa-scale-balanced"></i> IP pillar feedback</h5>
                    <p>Trademark, Copyright, Industrial Design, and Patent signals in this file</p>
                </div>
                ${this.renderPillarCards(pillars)}
               </section>`
            : '';

        const recBlock = recommendations.length
            ? `<section class="fb-card fb-card--actions">
                <div class="fb-card__head">
                    <h5><i class="fa-solid fa-list-ol"></i> Action items</h5>
                    <p>Concrete next steps before re-checking</p>
                </div>
                <ol class="fb-actions">${recommendations.map((r, i) =>
                    `<li><span class="fb-actions__n">${i + 1}</span><span class="fb-actions__text">${this.formatReviewerEmphasis(r, meta.missing)}</span></li>`
                ).join('')}</ol>
               </section>`
            : '';

        const depth = this.renderInDepthReview(analysis, meta);

        container.innerHTML = `<div class="ai-review-shell fb-shell">
            ${this.renderFeedbackHero(meta, summaryHtml)}
            ${this.renderFeedbackMeta(meta)}
            ${themes}
            ${recBlock}
            ${pillarBlock}
            ${depth}
        </div>`;
    }

    renderInDepthReview(analysis, meta = null) {
        const raw = String(analysis.shap_analysis || '').trim();
        if (!raw) return '';
        let cleaned = this.dedupeShapHtml(raw)
            .replace(/\b\d{1,3}\s*%/g, '')
            .replace(/readiness score of\s*/gi, '')
            .replace(/keyword checklist score[^.<]*/gi, 'GI theme review')
            .replace(/This review evaluates the uploaded/gi, 'I reviewed this')
            .replace(/Overall classification:\s*/gi, 'My call: ')
            .replace(/Product focus check failed:\s*/gi, 'Product identity gap: ')
            .replace(/What is already working:/gi, 'Strengths to keep:')
            .replace(/Why it is not yet complete:/gi, 'What I need from you next:')
            .replace(/Theme-by-theme findings \(MoP basis\):/gi, 'Theme notes:')
            .replace(/Theme notes \(MoP basis\):/gi, 'Theme notes:')
            .replace(/The AI analysis only evaluates[^.<]*/gi, 'This review lane is only for Kapeng Barako')
            .replace(/\s{2,}/g, ' ')
            .trim();

        if (!cleaned || cleaned.replace(/<[^>]+>/g, '').trim().length < 24) return '';

        if (!/<[a-z][\s\S]*>/i.test(cleaned)) {
            cleaned = cleaned
                .split(/\n{2,}/)
                .map((p) => p.trim())
                .filter(Boolean)
                .map((p) => `<p>${this.formatReviewerEmphasis(p, meta?.missing || [])}</p>`)
                .join('');
        } else if (!/<strong[\s>]/i.test(cleaned)) {
            cleaned = cleaned.replace(/>([^<]+)</g, (_, text) => {
                const emphasized = this.formatReviewerEmphasis(text, meta?.missing || []);
                return `>${emphasized}<`;
            });
        }

        return `<details class="fb-card fb-card--depth">
            <summary class="fb-depth-summary">
                <span><i class="fa-solid fa-align-left"></i> Additional reviewer notes</span>
                <span class="fb-depth-hint" aria-hidden="true"></span>
            </summary>
            <div class="ai-analysis-depth fb-depth-body">${cleaned}</div>
        </details>`;
    }

    displayAnalysisResults(analysis) {
        this.currentAnalysis = analysis;

        const resultsEl = document.getElementById('analysisResults');
        if (resultsEl) {
            resultsEl.classList.remove('loading');
            const spinner = resultsEl.querySelector('.loading-spinner');
            if (spinner) spinner.remove();
        }

        this.updateStatusBadge(analysis.status || 'Analyzed');
        window.setTimeout(() => this.renderChatAnalysis(analysis), 450);
    }

    updateStatusBadge(status) {
        const badge = document.getElementById('analysisStatusBadge');
        if (!badge) return;

        const normalized = String(status || '').trim().toLowerCase();
        const displayStatus = normalized === 'ready' ? 'Ready' : 'Not Ready';

        badge.textContent = displayStatus;
        badge.className = 'status-badge';
        badge.classList.add(displayStatus === 'Ready' ? 'success' : 'warning');
    }

    collectRequirementGaps(analysis) {
        const gaps = [...(analysis.missing_requirements || [])];
        const breakdown = analysis.score_breakdown || {};
        (breakdown.terms || []).forEach((row) => {
            if (!row?.found && row?.term) gaps.push(row.term);
        });
        (breakdown.sections || []).forEach((row) => {
            if (!row?.found && row?.label) gaps.push(row.label);
        });
        return [...new Set(gaps.map((item) => String(item).trim()).filter(Boolean))];
    }

    formatRequirementPhrase(items) {
        const list = (items || []).map((item) => this.escapeHtml(String(item).trim())).filter(Boolean);
        if (!list.length) return '';
        if (list.length === 1) return list[0];
        if (list.length === 2) return `${list[0]} and ${list[1]}`;
        return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
    }

    cleanShapNarrative(html) {
        if (!html) return '';
        let out = String(html);
        out = out.replace(/readiness score of\s*<strong>\d+%<\/strong>/gi, 'readiness assessment');
        out = out.replace(/keyword checklist score is\s*<strong>\d+%<\/strong>/gi, 'keyword coverage');
        out = out.replace(/;\s*after section rubric blending the readiness score is\s*<strong>\d+%<\/strong>/gi, '');
        out = out.replace(/yielding a readiness score of\s*<strong>\d+%<\/strong>/gi, '');
        out = out.replace(/initial readiness score of\s*<strong>\d+%<\/strong>/gi, 'initial assessment');
        out = out.replace(/\b\d+%\b/g, '');
        out = out.replace(/\s{2,}/g, ' ');
        return out.trim();
    }

    buildPillarParagraph(pillar) {
        const label = pillar.label || pillar.id || 'Pillar';
        const statusMap = {
            addressed: 'Addressed',
            partial: 'Partially addressed',
            not_addressed: 'Not addressed',
        };
        const status = statusMap[pillar.status] || 'Not addressed';
        const met = Array.isArray(pillar.met) ? pillar.met : [];
        const gaps = Array.isArray(pillar.gaps) ? pillar.gaps : [];
        const scope = pillar.scope || '';

        let text = `${label} — ${status}. ${scope}`;

        if (met.length) {
            text += ` Requirements satisfied in the extracted text: ${this.formatRequirementPhrase(met)}.`;
        } else if (pillar.signal_detected) {
            text += ` The document contains related ${label.toLowerCase()} language, but mapped checklist items for this pillar are still incomplete.`;
        } else {
            text += ` No requirements for this pillar were clearly identified in the document text.`;
        }

        if (gaps.length) {
            text += ` Items to improve: ${this.formatRequirementPhrase(gaps)}.`;
        } else if (pillar.status === 'addressed') {
            text += ` This pillar is adequately covered for the current upload category.`;
        }

        return text;
    }

    buildRequirementNarrative(analysis, met, gaps) {
        const ready = String(analysis.status || '').trim().toLowerCase() === 'ready';
        const assessment = analysis.ip_pillar_assessment || null;
        const pillars = Array.isArray(assessment?.pillars) ? assessment.pillars : [];
        const parts = [];

        parts.push(
            `<p>This analysis applies the IPOPHL <strong>four-pillar standard</strong>: <strong>Trademark</strong>, <strong>Copyright</strong>, <strong>Industrial Design</strong>, and <strong>Patent</strong>. Requirements are identified by which IP right they belong to — not by loose keywords alone. Overall document classification: <strong>${ready ? 'Ready' : 'Not Ready'}</strong>.</p>`
        );

        if (pillars.length) {
            pillars.forEach((pillar) => parts.push(this.buildPillarParagraph(pillar)));
            parts.push(
                `<p><strong>Pillar summary.</strong> ${assessment.ready_pillars || 0} of 4 pillars fully addressed, ${assessment.partial_pillars || 0} partially addressed, and ${assessment.gap_pillars || 0} require revision. A GI filing package should collectively satisfy all four pillars across its supporting documents.</p>`
            );
        } else if (met.length || gaps.length) {
            parts.push(
                `<p><strong>Legacy checklist view.</strong> Re-run Refresh Analysis to generate four-pillar classification. Detected items: ${met.length ? this.formatRequirementPhrase(met) : 'none'}. Gaps: ${gaps.length ? this.formatRequirementPhrase(gaps) : 'none'}.</p>`
            );
        }

        if (!ready) {
            parts.push(
                '<p><strong>Next steps.</strong> Revise the document so each pillar — Trademark, Copyright, Industrial Design, and Patent — has explicit supporting content where applicable. Use consistent Kapeng Barako / Lipa Barako terminology, attach evidence (labels, photos, process descriptions), then run Refresh Analysis before Complete Registration.</p>'
            );
        } else {
            parts.push(
                '<p><strong>Next steps.</strong> Confirm that companion uploads cover any pillar not fully addressed in this file alone, then proceed with the next IPOPHL phase.</p>'
            );
        }

        return parts.join('');
    }

    escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    updateRequirementAnalysis(analysis) {
        this.renderChatAnalysis(analysis);
    }

    showAnalysisError(message) {
        const resultsEl = document.getElementById('analysisResults');
        const statusBadge = document.getElementById('analysisStatusBadge');

        if (statusBadge) statusBadge.textContent = 'Error';

        if (resultsEl) {
            resultsEl.classList.remove('loading');
            this.showToast(`Analysis Error: ${message}`, 'error');

            const container = document.getElementById('requirementAnalysisContent');
            if (container) {
                container.innerHTML = `<p class="placeholder text-danger">Failed to retrieve analysis: ${this.escapeHtml(message)}</p>`;
            }
        }
    }

    async refreshAnalysis() {
        if (!this.currentFile || this.isAnalyzing) return;
        
        this.isAnalyzing = true;
        const refreshBtn = document.getElementById('ipophlRefreshBtn');
        const originalContent = refreshBtn.innerHTML;
        
        // Show loading state
        refreshBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Refreshing...';
        refreshBtn.disabled = true;
        
        try {
            const response = await ipophlApi(`/api/ipo-analysis/${this.currentFile.file_uuid}`, {
                method: 'POST'
            });
            
            const result = await response.json();
            
            if (result.success) {
                // Update current file data
                this.currentFile.analysis = result.analysis;
                
                // Refresh display
                this.displayAnalysisResults(result.analysis);

                // Keep the file list card accent in sync with Ready / Not Ready
                const uuid = this.currentFile?.file_uuid;
                if (uuid) {
                    const card = document.querySelector(
                        `#ipophl-module .file-item[data-file-uuid="${uuid}"]`
                    );
                    this.applyAiStatusToCard(card, result.analysis?.status);
                    if (window.dashboardApp?.ipophlFiles) {
                        Object.keys(window.dashboardApp.ipophlFiles).forEach((taskId) => {
                            (window.dashboardApp.ipophlFiles[taskId] || []).forEach((f) => {
                                if (String(f.id || f.file_uuid || '') === String(uuid)) {
                                    f.ai_status = result.analysis?.status;
                                    if (result.analysis?.score != null) {
                                        f.ai_score = Number(result.analysis.score || 0);
                                    }
                                }
                            });
                        });
                    }
                    this.refreshDashboardIndicator();
                }
                if (window.dashboardApp?.syncCompleteRegistrationButtonState) {
                    window.dashboardApp.syncCompleteRegistrationButtonState();
                }
                if (window.dashboardApp?.updateGiProcessIndicator) {
                    window.dashboardApp.updateGiProcessIndicator();
                }
                
                // Show success message
                this.showToast('Analysis refreshed successfully', 'success');
            } else {
                throw new Error(result.error);
            }
            
        } catch (error) {
            console.error('Refresh failed:', error);
            this.showToast(`Failed to refresh analysis: ${error.message}`, 'error');
        } finally {
            // Restore button state
            refreshBtn.innerHTML = originalContent;
            refreshBtn.disabled = false;
            this.isAnalyzing = false;
        }
    }

    closeFilePreview() {
        const modal = document.getElementById('filePreviewModal');
        if (modal) {
            modal.classList.remove('active');
            modal.classList.remove('is-minimized');
            modal.classList.remove('is-geometry-ready');
            modal.setAttribute('hidden', '');
            modal.setAttribute('aria-hidden', 'true');
        }
        this.modalIsMinimized = false;
        this.stopModalResize();
        this.syncModalWindowState();
        document.body.classList.remove('modal-open');

        const frame = document.getElementById('filePreviewFrame');
        if (frame) frame.src = '';
        const wordViewport = document.getElementById('wordPreviewViewport');
        if (wordViewport) wordViewport.innerHTML = '';
        const wordStyles = document.getElementById('wordPreviewStyles');
        if (wordStyles) wordStyles.innerHTML = '';
        const wordArea = document.getElementById('wordPreviewArea');
        if (wordArea) {
            wordArea.style.display = 'none';
            wordArea.classList.add('hidden');
        }
        
        // Reset current file
        this.currentFile = null;
        this.currentAnalysis = null;
    }

    showToast(message, type = 'info') {
        // Create toast notification
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `
            <i class="fa-solid fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-triangle' : 'info-circle'}"></i>
            <span>${message}</span>
        `;
        
        // Add to page
        document.body.appendChild(toast);
        
        // Show animation
        setTimeout(() => toast.classList.add('show'), 100);
        
        // Remove after delay
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
}

// Global functions for modal handlers
function closeFilePreview() {
    if (window.ipophlAnalyzer) {
        window.ipophlAnalyzer.closeFilePreview();
    }
}

function refreshAnalysis() {
    if (window.ipophlAnalyzer) {
        window.ipophlAnalyzer.refreshAnalysis();
    }
}

// Initialize the analyzer when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.ipophlAnalyzer = new IPOPHLAnalyzer();
});
