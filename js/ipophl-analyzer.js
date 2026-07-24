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
                data.items.forEach(doc => {
                    // task_id should be the full service name (e.g. phase1-introduction)
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
            // Avoid duplicates
            if (!window.dashboardApp.ipophlFiles[taskId].some(f => f.id === (doc.file_uuid || doc.id))) {
                window.dashboardApp.ipophlFiles[taskId].push({
                    id: doc.file_uuid || doc.id,
                    name: doc.filename
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
        // Prevent duplication: check if file with this name already exists
        const existingFiles = container.querySelectorAll('.file-name');
        for (let nameEl of existingFiles) {
            if (nameEl.textContent === doc.filename) {
                // If exists, just update the existing card with AI info
                const card = nameEl.closest('.file-item');
                this.updateCardWithAI(card, doc);
                return;
            }
        }

        const fileExt = doc.filename.split('.').pop().toLowerCase();
        const iconClass = fileExt === 'pdf' ? 'fa-file-pdf text-danger' : 
                         (fileExt === 'doc' || fileExt === 'docx') ? 'fa-file-word text-primary' :
                         'fa-file-lines text-success';

        const zoneTaskId = (container && container.id) ? container.id.replace(/-files$/, '') : (doc.task_id || '');
        const fileItem = document.createElement('div');
        fileItem.className = 'file-item success ai-enhanced';
        fileItem.dataset.fileUuid = doc.file_uuid;
        fileItem.dataset.taskId = zoneTaskId || doc.task_id || '';
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
                    <button type="button" class="file-action-btn ai-analysis" onclick="ipophlAnalyzer.loadAndShowFullAnalysis('${doc.file_uuid}')" title="AI Analysis">
                        <i class="fa-solid fa-brain"></i>
                    </button>
                    <button type="button" class="file-action-btn delete" onclick="ipophlAnalyzer.deleteFile('${doc.file_uuid}', this)" title="Delete File">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </div>
        `;
        container.appendChild(fileItem);
    }

    updateCardWithAI(card, doc) {
        card.classList.add('ai-enhanced');
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
                <button type="button" class="file-action-btn ai-analysis" onclick="ipophlAnalyzer.loadAndShowFullAnalysis('${doc.file_uuid}')" title="AI Analysis">
                    <i class="fa-solid fa-brain"></i>
                </button>
                <button type="button" class="file-action-btn delete" onclick="ipophlAnalyzer.deleteFile('${doc.file_uuid}', this)" title="Delete File">
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
            document.body.classList.add('modal-open');
            
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

    fileAlreadyInContainer(container, filename) {
        if (!container || !filename) return false;
        return Array.from(
            container.querySelectorAll('.file-item:not(.uploading):not(.error) .file-name')
        ).some((el) => el.textContent === filename);
    }

    /** Upload to server, run ML analysis, show brain/delete icons, open AI panel. */
    async uploadAndAnalyzeFile(file, service, attachedFilesContainer) {
        if (!file || !service || !attachedFilesContainer) return;

        if (this.fileAlreadyInContainer(attachedFilesContainer, file.name)) {
            this.showToast(`"${file.name}" is already in this list.`, 'error');
            return;
        }

        const [phase] = this.parseServiceName(service);
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

            const gi = result.gi_publish;
            if (gi && gi.ok) {
                this.showToast('Uploaded — live on farmers\' GI Updates.', 'success');
            } else if (gi && gi.error) {
                this.showToast(
                    `Uploaded, but GI Updates sync failed: ${gi.error}`,
                    'error'
                );
            } else {
                this.showToast('Document uploaded and analyzed.', 'success');
            }
        } catch (error) {
            console.error('IPOPHL upload/analyze failed:', error);
            const msg = error.message || 'Upload or analysis failed';
            this.showUploadError(attachedFilesContainer, file.name, msg);
            this.showToast(msg, 'error');
        }
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
            if (del) del.addEventListener('click', () => fileItem.remove());
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
                const container = fileItem.parentElement;
                const taskId = container.id.replace('-files', '');
                
                this.updateDashboardState(taskId, { file_uuid: fileUuid }, 'remove');
                this.refreshDashboardIndicator();

                fileItem.style.opacity = '0';
                setTimeout(() => fileItem.remove(), 300);
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
        const loading = document.getElementById('previewLoading');
        const container = document.querySelector('.preview-container');
        if (!frame || !loading || !container || !wordArea) return;

        // Reset states
        loading.classList.remove('hidden');
        frame.style.display = 'none';
        wordArea.style.display = 'none';
        wordArea.innerHTML = '';
        frame.src = 'about:blank';

        const filename = this.currentFile ? this.currentFile.filename.toLowerCase() : '';
        const isWordDoc = filename.endsWith('.doc') || filename.endsWith('.docx');

        if (isWordDoc) {
            try {
                // Use mammoth.js for local Word document rendering
                const response = await fetch(previewUrl, { credentials: 'same-origin' });
                const arrayBuffer = await response.arrayBuffer();
                
                const result = await mammoth.convertToHtml({ arrayBuffer: arrayBuffer });
                
                loading.classList.add('hidden');
                wordArea.style.display = 'block';
                wordArea.innerHTML = `
                    <div class="rendered-word-content">
                        ${result.value}
                    </div>
                `;
                
                if (result.messages.length > 0) {
                    console.warn('Mammoth messages:', result.messages);
                }
            } catch (error) {
                console.error('Word rendering failed:', error);
                loading.classList.add('hidden');
                wordArea.style.display = 'block';
                wordArea.innerHTML = `
                    <div class="preview-error" style="text-align: center; padding: 40px;">
                        <i class="fa-solid fa-file-circle-exclamation" style="font-size: 3rem; color: #ef4444; margin-bottom: 15px;"></i>
                        <h4>Preview Failed</h4>
                        <p style="color: #64748b;">We couldn't render this Word document. Please download it to view.</p>
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
        const frame = document.getElementById('filePreviewFrame');
        if (frame) {
            frame.style.transform = `scale(${this.currentZoom / 100}) rotate(${this.currentRotation}deg)`;
            frame.style.transformOrigin = 'top center';
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
            container.querySelectorAll('.ai-analysis-block, .ai-pillar-grid, .ai-doc-insights').forEach((el) => el.remove());
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
            const narrative = pillar.narrative || this.buildPillarParagraph(pillar);
            const evidence = Array.isArray(pillar.evidence) ? pillar.evidence : [];
            const evidenceHtml = evidence.length
                ? `<blockquote class="ai-evidence">${evidence.map((e) =>
                    this.escapeHtml(e)
                ).join('</blockquote><blockquote class="ai-evidence">')}</blockquote>`
                : '';
            return `<article class="ai-pillar-card">
                <div class="ai-pillar-card__head">
                    <span class="ai-pillar-card__title">${this.escapeHtml(pillar.label || pillar.id || 'Pillar')}</span>
                    <span class="ai-pillar-chip ai-pillar-chip--${status}">${this.pillarStatusLabel(status)}</span>
                </div>
                <p class="ai-pillar-card__body">${this.formatPlainText(narrative)}</p>
                ${evidenceHtml}
                ${this.renderPillarTags(pillar.met, 'met')}
                ${this.renderPillarTags(pillar.gaps, 'gap')}
            </article>`;
        }).join('');
        return `<div class="ai-pillar-grid">${cards}</div>`;
    }

    renderDocumentInsights(analysis, assessment) {
        const insights = assessment?.document_insights;
        if (!insights) return '';

        const breakdown = analysis.score_breakdown || {};
        const sections = breakdown.sections || [];
        const sectionRows = sections.length
            ? sections.map((s) => {
                const cov = String(s.coverage || (s.found ? 'well_covered' : 'missing')).replace(/_/g, ' ');
                const cls = s.coverage === 'well_covered' || s.found
                    ? 'ai-insight-ok'
                    : (s.coverage === 'partial' ? 'ai-insight-partial' : 'ai-insight-gap');
                return `<li class="${cls}">${this.escapeHtml(s.label || 'Theme')} — ${this.escapeHtml(cov)}</li>`;
            }).join('')
            : '';

        const detected = (insights.detected_features || []).slice(0, 8);
        const missing = (insights.missing_requirements || []).slice(0, 8);
        const ref = insights.reference_source
            ? `<p class="ai-doc-insights__ref">${this.escapeHtml(insights.reference_source)}</p>`
            : '';

        return `<div class="ai-doc-insights">
            <h5 class="ai-doc-insights__title">Document profile</h5>
            ${ref}
            <dl class="ai-doc-insights__meta">
                <div><dt>Type</dt><dd>${this.escapeHtml(insights.document_type || 'GI document')}</dd></div>
                <div><dt>Content</dt><dd>${Number(insights.word_count || 0).toLocaleString()} words extracted</dd></div>
                <div><dt>MoP themes</dt><dd>${insights.checklist_met || 0} of ${insights.checklist_total || 0} well covered</dd></div>
            </dl>
            ${detected.length ? `<p class="ai-doc-insights__label">Strengths in this file</p>${this.renderPillarTags(detected, 'met')}` : ''}
            ${missing.length ? `<p class="ai-doc-insights__label">Themes still thin or missing</p>${this.renderPillarTags(missing, 'gap')}` : ''}
            ${sectionRows ? `<p class="ai-doc-insights__label">MoP theme coverage</p><ul class="ai-section-list">${sectionRows}</ul>` : ''}
        </div>`;
    }

    buildExecutiveSummary(analysis, assessment) {
        if (assessment?.executive_summary) {
            return assessment.executive_summary;
        }
        const ready = String(analysis.status || '').trim().toLowerCase() === 'ready';
        const pillars = assessment?.pillars || [];
        const partial = pillars.filter((p) => p.status === 'partial').map((p) => p.label);
        const gaps = pillars.filter((p) => p.status === 'not_addressed').map((p) => p.label);
        let focus = '';
        if (partial.length || gaps.length) {
            focus = ` Priority revision areas: ${[...partial, ...gaps].slice(0, 3).join(', ')}.`;
        }
        return (
            `This review evaluates the submitted document against the Batangas Kapeng Barako ` +
            `Manual of Specifications basis (Part I Justification, Part II Technical & production, ` +
            `Part III–IV Control, Traceability & Labelling). ` +
            `Overall classification: ${ready ? 'Ready' : 'Not Ready'}.${focus} ` +
            `Findings are drawn from text extracted from this upload — not a keyword percentage score.`
        );
    }

    buildRecommendations(analysis, assessment, gaps) {
        if (Array.isArray(assessment?.recommendations) && assessment.recommendations.length) {
            return assessment.recommendations;
        }
        const recs = [];
        (assessment?.pillars || []).forEach((pillar) => {
            if (pillar.gaps?.length) {
                recs.push(`Improve ${pillar.label}: ${pillar.gaps.slice(0, 5).join(', ')}.`);
            }
        });
        if (!recs.length && gaps.length) {
            recs.push(`Address missing requirements: ${gaps.slice(0, 4).join(', ')}.`);
        }
        if (!recs.length) {
            recs.push('Confirm companion uploads cover any pillar not fully addressed in this file alone.');
        } else {
            recs.push('Run **Refresh Analysis** after revisions to verify readiness.');
        }
        return recs.slice(0, 5);
    }

    renderChatAnalysis(analysis) {
        const container = document.getElementById('requirementAnalysisContent');
        if (!container) return;

        const assessment = analysis.ip_pillar_assessment || null;
        const pillars = Array.isArray(assessment?.pillars) ? assessment.pillars : [];
        const gaps = this.collectRequirementGaps(analysis);
        const summary = this.buildExecutiveSummary(analysis, assessment);
        const recommendations = this.buildRecommendations(analysis, assessment, gaps);
        const docInsights = this.renderDocumentInsights(analysis, assessment);
        const deepHtml = this.renderInDepthReview(analysis);

        this.showChatTyping(false);

        const intro = `<section class="ai-analysis-block">
            <h5 class="ai-analysis-block__title">Overview</h5>
            <p class="ai-analysis-block__text">${this.formatPlainText(summary)}</p>
        </section>`;

        const pillarBlock = pillars.length ? this.renderPillarCards(pillars) : '';

        const recBlock = `<section class="ai-analysis-block">
            <h5 class="ai-analysis-block__title">What the admin can improve</h5>
            <ul class="ai-rec-list">${recommendations.map((r) =>
                `<li>${this.formatPlainText(r)}</li>`
            ).join('')}</ul>
        </section>`;

        container.innerHTML = `${intro}${deepHtml}${docInsights}${pillarBlock}${recBlock}`;
    }

    renderInDepthReview(analysis) {
        const raw = String(analysis.shap_analysis || '').trim();
        if (!raw) return '';
        // Strip leftover percentage mentions from older stored analyses
        const cleaned = raw
            .replace(/\b\d{1,3}\s*%/g, '')
            .replace(/readiness score of\s*/gi, '')
            .replace(/keyword checklist score[^.<]*/gi, 'MoP theme review');
        return `<section class="ai-analysis-block ai-analysis-block--depth">
            <h5 class="ai-analysis-block__title">In-depth MoP review</h5>
            <div class="ai-analysis-depth">${cleaned}</div>
        </section>`;
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
        const refreshBtn = document.getElementById('refreshBtn');
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
            modal.setAttribute('hidden', '');
            modal.setAttribute('aria-hidden', 'true');
        }
        document.body.classList.remove('modal-open');

        const frame = document.getElementById('filePreviewFrame');
        if (frame) frame.src = '';
        
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
