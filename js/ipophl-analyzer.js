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
                
                // Show preview modal with analysis
                this.showFilePreview(result);
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
            fileItem.className = 'file-item success';
            fileItem.innerHTML = `
                <div class="file-info">
                    <i class="fa-solid fa-file-alt text-success"></i>
                    <span class="file-name">${result.filename}</span>
                </div>
                <div class="file-status">
                    <span class="ai-score-badge ${this.getScoreClass(result.analysis.readiness_score)}">
                        ${result.analysis.readiness_score}% ${result.analysis.status}
                    </span>
                </div>
                <div class="file-actions">
                    <button class="btn btn-sm btn-primary" onclick="ipophlAnalyzer.previewFile('${result.file_uuid}')">
                        <i class="fa-solid fa-eye"></i> Preview
                    </button>
                    <button class="btn btn-sm btn-secondary" onclick="ipophlAnalyzer.showFilePreview(${JSON.stringify(result).replace(/"/g, '&quot;')})">
                        <i class="fa-solid fa-brain"></i> AI Analysis
                    </button>
                </div>
            `;
        }
    }

    getScoreClass(score) {
        if (score >= 75) return 'score-high';
        if (score >= 50) return 'score-medium';
        return 'score-low';
    }

    previewFile(fileUuid) {
        // Simple file preview using the new API endpoint
        fetch(`/api/ipo-preview/${fileUuid}`)
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    this.showFilePreview(data);
                } else {
                    this.showToast(`Preview failed: ${data.error}`, 'error');
                }
            })
            .catch(error => {
                console.error('Preview error:', error);
                this.showToast('Failed to load file preview', 'error');
            });
    }

    showFilePreview(fileData) {
        // For simple preview, show basic file info
        const modal = document.getElementById('simpleFilePreviewModal');
        modal.classList.add('active');
        
        // Set file info
        document.getElementById('simplePreviewFileName').textContent = fileData.file_info.filename;
        document.getElementById('simplePreviewFileType').textContent = `Type: ${fileData.file_info.file_type}`;
        document.getElementById('simplePreviewFileSize').textContent = `Size: ${this.formatFileSize(fileData.file_info.file_size)}`;
        document.getElementById('simplePreviewPhase').textContent = `Phase: ${fileData.file_info.ipophl_phase || 'Unknown'}`;
        
        // Load file preview
        this.loadSimpleFilePreview(fileData.preview_url);
        
        // Store data for AI analysis
        this.currentFileData = fileData;
    }
    
    loadSimpleFilePreview(previewUrl) {
        const frame = document.getElementById('simplePreviewFrame');
        const loading = document.getElementById('simplePreviewLoading');
        
        // Show loading
        loading.classList.remove('hidden');
        frame.style.display = 'none';
        
        // Load file
        frame.src = previewUrl;
        
        // Hide loading when loaded
        frame.onload = () => {
            loading.classList.add('hidden');
            frame.style.display = 'block';
        };
        
        frame.onerror = () => {
            loading.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Failed to load document';
        };
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
        
        // Show loading
        loading.classList.remove('hidden');
        frame.style.display = 'none';
        
        // Load file
        frame.src = previewUrl;
        
        // Hide loading when loaded
        frame.onload = () => {
            loading.classList.add('hidden');
            frame.style.display = 'block';
        };
        
        frame.onerror = () => {
            loading.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Failed to load document';
        };
    }

    async loadAIAnalysis(fileData) {
        if (fileData.analysis) {
            // Use existing analysis
            this.displayAnalysisResults(fileData.analysis);
        } else {
            // Fetch analysis from API
            try {
                const response = await fetch(`/api/ipo-analysis/${fileData.file_uuid}`);
                const result = await response.json();
                
                if (result.success) {
                    this.displayAnalysisResults(result.analysis);
                } else {
                    throw new Error(result.error);
                }
            } catch (error) {
                console.error('Failed to load analysis:', error);
                this.showAnalysisError(error.message);
            }
        }
    }

    displayAnalysisResults(analysis) {
        this.currentAnalysis = analysis;
        
        // Update progress indicator
        this.updateProgressIndicator(analysis.readiness_score);
        
        // Update status badge
        this.updateStatusBadge(analysis.status);
        
        // Update detected features
        this.updateDetectedFeatures(analysis.detected_features || []);
        
        // Update missing requirements
        this.updateMissingRequirements(analysis.missing_requirements || []);
        
        // Update metadata
        this.updateAnalysisMetadata(analysis);
        
        // Hide loading state
        document.getElementById('analysisResults').classList.remove('loading');
    }

    updateProgressIndicator(score) {
        const progressBar = document.getElementById('giProgressBar');
        const percentage = document.getElementById('giProgressPercentage');
        
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
        badge.textContent = status;
        badge.className = 'status-badge';
        
        if (status === 'Ready') {
            badge.classList.add('success');
        } else {
            badge.classList.add('warning');
        }
    }

    updateDetectedFeatures(features) {
        const list = document.getElementById('detectedFeaturesList');
        
        if (features.length === 0) {
            list.innerHTML = '<li class="placeholder">No features detected</li>';
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
        
        if (requirements.length === 0) {
            list.innerHTML = '<li class="placeholder">All requirements met!</li>';
            return;
        }
        
        list.innerHTML = requirements
            .map(req => `
                <li class="requirement-item">
                    <i class="fa-solid fa-exclamation-triangle text-warning"></i>
                    <span>${req}</span>
                </li>
            `)
            .join('');
    }

    updateAnalysisMetadata(analysis) {
        document.getElementById('analysisMethod').textContent = 
            analysis.analysis_method ? analysis.analysis_method.charAt(0).toUpperCase() + analysis.analysis_method.slice(1) : '-';
        
        document.getElementById('textLength').textContent = 
            analysis.text_length ? `${analysis.text_length.toLocaleString()} characters` : '-';
        
        document.getElementById('lastAnalyzed').textContent = 
            new Date().toLocaleString();
    }

    showAnalysisError(error) {
        const results = document.getElementById('analysisResults');
        results.innerHTML = `
            <div class="error-message">
                <i class="fa-solid fa-exclamation-triangle text-danger"></i>
                <p>Failed to load analysis: ${error}</p>
            </div>
        `;
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

// Global functions for simple preview modal
function closeSimpleFilePreview() {
    const modal = document.getElementById('simpleFilePreviewModal');
    modal.classList.remove('active');
    
    // Clear iframe
    document.getElementById('simplePreviewFrame').src = '';
}

function showAIAnalysis() {
    // Close simple preview and open full AI analysis
    closeSimpleFilePreview();
    if (ipophlAnalyzer.currentFileData) {
        ipophlAnalyzer.showFullAIAnalysis(ipophlAnalyzer.currentFileData);
    }
}

// Extend IPOPHLAnalyzer with full AI analysis
IPOPHLAnalyzer.prototype.showFullAIAnalysis = function(fileData) {
    this.currentFile = {
        filename: fileData.file_info.filename,
        preview_url: fileData.preview_url,
        analysis: fileData.analysis,
        file_uuid: fileData.file_info.filename.split('.')[0] // Extract UUID from filename
    };
    
    // Show the full AI analysis modal
    const modal = document.getElementById('filePreviewModal');
    modal.classList.add('active');
    
    // Set file name
    document.getElementById('previewFileName').textContent = this.currentFile.filename;
    
    // Load file preview
    this.loadFilePreview(this.currentFile.preview_url);
    
    // Load AI analysis
    this.loadAIAnalysis(this.currentFile);
};

// Global functions for onclick handlers
function closeFilePreview() {
    ipophlAnalyzer.closeFilePreview();
}

function refreshAnalysis() {
    ipophlAnalyzer.refreshAnalysis();
}

// Initialize the analyzer when DOM is ready
let ipophlAnalyzer;
document.addEventListener('DOMContentLoaded', () => {
    ipophlAnalyzer = new IPOPHLAnalyzer();
});
