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
            
            if (data.success && data.documents) {
                data.documents.forEach(doc => {
                    const container = document.getElementById(`${doc.task_id}-files`);
                    if (container) {
                        this.renderDocumentCard(container, doc);
                    }
                });
            }
        } catch (error) {
            console.error('Failed to load existing documents:', error);
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
            <div class="file-status">
                <span class="ai-score-badge ${this.getScoreClass(doc.ai_score)}">
                    ${doc.ai_score}% ${doc.ai_status}
                </span>
            </div>
            <div class="file-actions">
                <button class="file-action-btn action-ai ai-analysis" onclick="ipophlAnalyzer.loadAndShowFullAnalysis('${doc.file_uuid}')" title="AI Analysis">
                    <i class="fa-solid fa-brain"></i>
                </button>
                <button class="file-action-btn action-delete delete" onclick="ipophlAnalyzer.deleteFile('${doc.file_uuid}', this)" title="Delete File">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        `;
        container.appendChild(fileItem);
    }

    updateCardWithAI(card, doc) {
        card.classList.add('ai-enhanced');
        
        // Add or update status badge
        let statusContainer = card.querySelector('.file-status');
        if (!statusContainer) {
            statusContainer = document.createElement('div');
            statusContainer.className = 'file-status';
            card.insertBefore(statusContainer, card.querySelector('.file-actions'));
        }
        
        statusContainer.innerHTML = `
            <span class="ai-score-badge ${this.getScoreClass(doc.ai_score)}">
                ${doc.ai_score}% ${doc.ai_status}
            </span>
        `;

        // Update actions to include brain icon and ensure delete uses analyzer's logic
        const actionsContainer = card.querySelector('.file-actions');
        if (actionsContainer) {
            actionsContainer.innerHTML = `
                <button class="file-action-btn action-ai ai-analysis" onclick="ipophlAnalyzer.loadAndShowFullAnalysis('${doc.file_uuid}')" title="AI Analysis">
                    <i class="fa-solid fa-brain"></i>
                </button>
                <button class="file-action-btn action-delete delete" onclick="ipophlAnalyzer.deleteFile('${doc.file_uuid}', this)" title="Delete File">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            `;
        }
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
            const attachedFiles = zone.querySelector('.attached-files');

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
        try {
            // Show loading state
            this.showUploadProgress(attachedFilesContainer, file.name);

            // Extract phase and task from service name
            const [phase, task] = this.parseServiceName(service);

            // Create FormData for API request
            const formData = new FormData();
            formData.append('file', file);
            formData.append('phase', phase);
            formData.append('task_id', task);

            // Upload and analyze file
            const response = await fetch('/api/ipo-analyze', {
                method: 'POST',
                body: formData
            });

            const result = await response.json();

            if (result.success) {
                // Display file with AI analysis
                this.displayUploadedFile(attachedFilesContainer, result);
                
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
        const fileItem = document.createElement('div');
        fileItem.className = 'file-item uploading';
        fileItem.innerHTML = `
            <div class="file-info">
                <i class="fa-solid fa-spinner fa-spin"></i>
                <span class="file-name">${filename}</span>
            </div>
            <div class="file-status">Analyzing...</div>
        `;
        
        container.appendChild(fileItem);
    }

    showUploadError(container, filename, error) {
        const fileItem = container.querySelector('.file-item:last-child');
        if (fileItem) {
            fileItem.className = 'file-item error';
            fileItem.innerHTML = `
                <div class="file-info">
                    <i class="fa-solid fa-exclamation-triangle text-danger"></i>
                    <span class="file-name">${filename}</span>
                </div>
                <div class="file-status text-danger">${error}</div>
            `;
        }
    }

    displayUploadedFile(container, result) {
        const fileItem = container.querySelector('.file-item:last-child');
        if (fileItem) {
            fileItem.remove(); // Remove the placeholder uploading item
            this.renderDocumentCard(container, {
                filename: result.filename,
                file_size: result.analysis.text_length * 2,
                file_uuid: result.file_uuid,
                ai_score: result.analysis.readiness_score,
                ai_status: result.analysis.status
            });
        }
    }

    async deleteFile(fileUuid, btn) {
        if (!confirm('Are you sure you want to delete this document?')) return;
        
        try {
            const response = await fetch(`/api/ipo-delete/${fileUuid}`, { method: 'DELETE' });
            const result = await response.json();
            
            if (result.success) {
                const fileItem = btn.closest('.file-item');
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

    loadFilePreview(previewUrl) {
        const frame = document.getElementById('filePreviewFrame');
        const loading = document.getElementById('previewLoading');
        if (!frame || !loading) return;

        loading.classList.remove('hidden');
        frame.style.opacity = '0';
        
        // Short & robust loading: clear previous, set new, auto-hide spinner
        frame.onload = null;
        const hideSpinner = () => {
            loading.classList.add('hidden');
            frame.style.opacity = '1';
        };

        frame.onload = hideSpinner;
        frame.src = previewUrl;

        // Automatically hide spinner after 5 seconds if still visible
        setTimeout(() => {
            if (!loading.classList.contains('hidden')) hideSpinner();
        }, 5000);

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
        
        // Reset Missing Information list
        const missingList = document.getElementById('missingRequirementsList');
        if (missingList) missingList.innerHTML = '<li class="placeholder">Checking for missing requirements...</li>';
        
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
        
        // Update missing requirements (Missing Information)
        this.updateMissingRequirements(analysis.missing_requirements || []);
        
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

    updateMissingRequirements(requirements) {
        const list = document.getElementById('missingRequirementsList');
        if (!list) return;
        
        if (requirements.length === 0) {
            list.innerHTML = '<li class="placeholder">No missing information! The document is complete.</li>';
            return;
        }
        
        list.innerHTML = requirements
            .map(req => `
                <li class="requirement-item">
                    <div class="requirement-content">
                        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 4px;">
                            <i class="fa-solid fa-circle-info" style="color: #f59e0b;"></i>
                            <span class="requirement-title">Missing: ${req}</span>
                        </div>
                        <span class="requirement-desc">This section is required for the quality of this specific document type.</span>
                    </div>
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
            
            const missingList = document.getElementById('missingRequirementsList');
            if (missingList) missingList.innerHTML = `<li class="placeholder text-danger">Unable to check for missing requirements.</li>`;
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
