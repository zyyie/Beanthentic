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
                    // task_id should be the full service name (e.g. phase1-product)
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
        const meta =
            doc.ai_score != null
                ? `AI ${doc.ai_score}% · ${doc.ai_status || 'Analyzed'}`
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
            this.showToast('Document uploaded and analyzed.', 'success');
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
                    <span class="file-meta">Ready — publishes when you click Complete Registration</span>
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
        // Extract phase and task from service names like "phase1-product"
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
                this.showToast('Document deleted', 'success');
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

        // Always reset progress bar to 0 before loading new analysis
        this.updateProgressIndicator(0);

        // Reset cards to placeholder state instead of clearing innerHTML
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
        // Reset Information Found list
        const foundList = document.getElementById('detectedFeaturesList');
        if (foundList) foundList.innerHTML = '<li class="placeholder">Analyzing document for key information...</li>';
        
        // Reset Improvement paragraph
        const improvedPara = document.getElementById('improvementAnalysisParagraph');
        if (improvedPara) improvedPara.innerHTML = '<p class="placeholder">Generating in-depth analysis and improvement recommendations...</p>';
    }

    /** Keep SHAP narrative % in sync with Document Quality Score (fixes legacy mismatches). */
    syncShapScoreInHtml(html, score) {
        if (!html || score == null || score === '') return html || '';
        const n = Math.max(0, Math.min(100, parseInt(score, 10) || 0));
        const statusLabel =
            n >= 85 ? 'highly compliant' : n >= 70 ? 'conditionally sufficient' : 'insufficient';
        let out = String(html);
        out = out.replace(
            /(readiness score of\s*<strong>)\d+(%<\/strong>)/gi,
            `$1${n}$2`
        );
        out = out.replace(
            /(initial readiness score of\s*<strong>)\d+(%<\/strong>)/gi,
            `$1${n}$2`
        );
        out = out.replace(
            /status of\s*<strong>[^<]*<\/strong>/i,
            `status of <strong>${statusLabel}</strong>`
        );
        return out;
    }

    displayAnalysisResults(analysis) {
        this.currentAnalysis = analysis;
        const score = analysis.readiness_score ?? 0;
        
        // Hide loading state immediately
        const resultsEl = document.getElementById('analysisResults');
        if (resultsEl) {
            resultsEl.classList.remove('loading');
            // Remove the loading spinner text
            const spinner = resultsEl.querySelector('.loading-spinner');
            if (spinner) spinner.remove();
        }

        // Update progress indicator (Document Quality Score)
        this.updateProgressIndicator(score);
        
        // Update status badge
        this.updateStatusBadge(analysis.status || 'Analyzed');
        
        // Update detected features (Information Found)
        this.updateDetectedFeatures(analysis.detected_features || []);
        
        // Update improvement analysis (What Needs to be Improved)
        const improvementContainer = document.getElementById('improvementAnalysisParagraph');
        if (improvementContainer) {
            if (analysis.shap_analysis) {
                improvementContainer.innerHTML = this.syncShapScoreInHtml(
                    analysis.shap_analysis,
                    score
                );
            } else {
                improvementContainer.innerHTML = `<p class="placeholder">Detailed improvement analysis is currently unavailable for this document.</p>`;
            }
        }
    }

    updateProgressIndicator(score) {
        const progressBar = document.getElementById('giProgressBar');
        const percentage = document.getElementById('giProgressPercentage');
        if (!progressBar || !percentage) return;
        
        // Animate progress bar
        progressBar.style.width = '0%';
        setTimeout(() => {
            progressBar.style.width = `${score}%`;
        }, 100);
        
        percentage.textContent = `${score}%`;
        
        // Update color based on score
        progressBar.className = 'progress-bar';
        if (score >= 75) {
            progressBar.classList.add('success');
        } else if (score >= 50) {
            progressBar.classList.add('warning');
        } else {
            progressBar.classList.add('danger');
        }
    }

    updateStatusBadge(status) {
        const badge = document.getElementById('analysisStatusBadge');
        if (!badge) return;
        
        // Ensure status is readable
        const displayStatus = status.toLowerCase() === 'not ready' ? 'Not Ready' : 
                             status.toLowerCase() === 'ready' ? 'Ready' : status;
        
        badge.textContent = displayStatus;
        badge.className = 'status-badge';
        
        if (displayStatus === 'Ready' || displayStatus.toLowerCase().includes('compliant')) {
            badge.classList.add('success');
        } else {
            badge.classList.add('warning');
        }
    }

    updateDetectedFeatures(features) {
        const list = document.getElementById('detectedFeaturesList');
        if (!list) return;
        
        if (features.length === 0) {
            list.innerHTML = '<li class="placeholder">No mandatory sections or information found in this document.</li>';
            return;
        }
        
        list.innerHTML = features
            .map(feature => `
                <li class="feature-item">
                    <i class="fa-solid fa-check-circle text-success"></i>
                    <span>${feature}</span>
                </li>
            `)
            .join('');
    }

    showAnalysisError(message) {
        const resultsEl = document.getElementById('analysisResults');
        const statusBadge = document.getElementById('analysisStatusBadge');
        
        if (statusBadge) statusBadge.textContent = 'Error';
        
        if (resultsEl) {
            resultsEl.classList.remove('loading');
            // We don't overwrite the entire innerHTML anymore, just show a toast or a small error indicator
            this.showToast(`Analysis Error: ${message}`, 'error');
            
            // Set placeholders to indicate failure
            const foundList = document.getElementById('detectedFeaturesList');
            if (foundList) foundList.innerHTML = `<li class="placeholder text-danger">Failed to retrieve information: ${message}</li>`;
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
