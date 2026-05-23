// IPOPHL Document Analyzer - File Previewer & AI Analysis Integration
class IPOPHLAnalyzer {
    constructor() {
        this.currentFile = null;
        this.currentAnalysis = null;
        this.isAnalyzing = false;
        this.init();
    }

    init() {
        this.attachEventListeners();
        this.setupFileUploadHandlers();
        this.loadExistingDocuments();
    }

    async loadExistingDocuments() {
        try {
            const response = await fetch('/api/ipo-documents');
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

        const fileItem = document.createElement('div');
        fileItem.className = 'file-item success ai-enhanced';
        fileItem.innerHTML = `
            <div class="file-info">
                <i class="fa-solid ${iconClass}"></i>
                <div class="file-details">
                    <span class="file-name">${doc.filename}</span>
                    <span class="file-meta">${this.formatFileSize(doc.file_size)}</span>
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
            const response = await fetch(`/api/ipo-analysis/${fileUuid}`);
            const result = await response.json();
            
            if (result.success) {
                const fileData = {
                    file_info: { filename: result.filename },
                    preview_url: `/api/file-preview/${fileUuid}`,
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
            modal.classList.add('active');
            
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

            zone.addEventListener('drop', async (e) => {
                e.preventDefault();
                zone.classList.remove('drag-over');
                
                const files = e.dataTransfer.files;
                if (files.length > 0) {
                    await this.handleFileUpload(files[0], service, attachedFiles);
                }
            });

            fileInput.addEventListener('change', async (e) => {
                if (e.target.files.length > 0) {
                    await this.handleFileUpload(e.target.files[0], service, attachedFiles);
                }
            });
        });
    }

    async handleFileUpload(file, service, attachedFilesContainer) {
        // Check if this file is already being uploaded to prevent duplicate indicators
        const existingUploading = Array.from(attachedFilesContainer.querySelectorAll('.file-item.uploading'))
            .find(item => item.querySelector('.file-name').textContent === file.name);
        
        if (existingUploading) {
            console.log(`File ${file.name} is already being analyzed.`);
            return;
        }

        try {
            // Show loading state
            this.showUploadProgress(attachedFilesContainer, file.name);

            // Extract phase and task from service name
            const [phase, task] = this.parseServiceName(service);

            // Create FormData for API request
            const formData = new FormData();
            formData.append('file', file);
            formData.append('phase', phase);
            formData.append('task_id', service); // Use full service name as task_id for consistency

            // Upload and analyze file
            const response = await fetch('/api/ipo-analyze', {
                method: 'POST',
                body: formData
            });

            const result = await response.json();

            if (result.success) {
                // Display file with AI analysis
                this.displayUploadedFile(attachedFilesContainer, result, file.name);
                
                // Show preview modal with full AI analysis
                this.showFullAIAnalysis(result);
            } else {
                throw new Error(result.error || 'Upload failed');
            }

        } catch (error) {
            console.error('File upload error:', error);
            this.showUploadError(attachedFilesContainer, file.name, error.message);
        }
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
                        <i class="fa-solid fa-circle-xmark" style="color: #dc2626; margin-right: 10px;"></i>
                    </div>
                </div>
            `;
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
        const doc = {
            filename: result.filename,
            file_size: result.analysis.text_length * 2,
            file_uuid: result.file_uuid,
            ai_score: result.analysis.readiness_score,
            ai_status: result.analysis.status,
            task_id: taskId
        };

        this.renderDocumentCard(container, doc);
        this.updateDashboardState(taskId, doc, 'add');
        this.refreshDashboardIndicator();
    }

    async deleteFile(fileUuid, btn) {
        const confirmed = await window.dashboardApp.showConfirmDialog(
            'Are you sure you want to delete this document?',
            'Confirm Delete'
        );
        if (!confirmed) return;
        
        try {
            const response = await fetch(`/api/ipo-delete/${fileUuid}`, { method: 'DELETE' });
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
                const response = await fetch(previewUrl);
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

                const response = await fetch(`/api/ipo-analysis/${encodeURIComponent(identifier)}`);
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

    displayAnalysisResults(analysis) {
        this.currentAnalysis = analysis;
        
        // Hide loading state immediately
        const resultsEl = document.getElementById('analysisResults');
        if (resultsEl) {
            resultsEl.classList.remove('loading');
            // Remove the loading spinner text
            const spinner = resultsEl.querySelector('.loading-spinner');
            if (spinner) spinner.remove();
        }

        // Update progress indicator (Document Quality Score)
        this.updateProgressIndicator(analysis.readiness_score || 0);
        
        // Update status badge
        this.updateStatusBadge(analysis.status || 'Analyzed');
        
        // Update detected features (Information Found)
        this.updateDetectedFeatures(analysis.detected_features || []);
        
        // Update improvement analysis (What Needs to be Improved)
        const improvementContainer = document.getElementById('improvementAnalysisParagraph');
        if (improvementContainer) {
            if (analysis.shap_analysis) {
                improvementContainer.innerHTML = `<p>${analysis.shap_analysis}</p>`;
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
            const response = await fetch(`/api/ipo-analysis/${this.currentFile.file_uuid}`, {
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
        modal.classList.remove('active');
        
        // Clear iframe
        document.getElementById('filePreviewFrame').src = '';
        
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
