// Main application entry point
class App {
  constructor() {
    this.init();
  }

  init() {
    console.log('Beanthentic Coffee application initialized');
    
    // Initialize any global app functionality
    this.setupGlobalEventListeners();
    this.checkPageLoad();
  }

  setupGlobalEventListeners() {
    // Handle page visibility changes
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        console.log('Page is hidden');
      } else {
        console.log('Page is visible');
      }
    });

    // Handle window resize
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        console.log('Window resized');
        // Trigger any resize-specific logic here
      }, 250);
    });

    // Handle scroll events with throttling
    let scrollTimer;
    window.addEventListener('scroll', () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        // Add any scroll-based functionality here
      }, 100);
    });

    // Setup notification button
    this.setupNotificationButton();
  }

  setupNotificationButton() {
    const notificationBtn = document.getElementById('notificationBtn');
    if (notificationBtn) {
      notificationBtn.addEventListener('click', () => {
        this.handleNotificationClick();
      });
    }
  }

  handleNotificationClick() {
    const badge = document.querySelector('.notification-badge');
    if (badge) {
      badge.style.display = 'none';
    }
    if (window.dashboardApp && typeof window.dashboardApp.switchModule === 'function') {
      window.dashboardApp.switchModule('notifications');
      return;
    }
    this.showNotificationMessage('Notifications');
  }

  showNotificationMessage(message) {
    // Create a simple toast notification
    const toast = document.createElement('div');
    toast.className = 'notification-toast';
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: linear-gradient(135deg, #8b4a2b, #5a2e1c);
      color: white;
      padding: 1rem 1.5rem;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(139, 74, 43, 0.3);
      z-index: 10000;
      font-weight: 600;
      opacity: 0;
      transform: translateY(-20px);
      transition: all 0.3s ease;
    `;
    
    document.body.appendChild(toast);
    
    // Animate in
    setTimeout(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    }, 10);
    
    // Remove after 3 seconds
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-20px)';
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300);
    }, 3000);
  }

  checkPageLoad() {
    // Remove loading state if it exists
    const loadingElement = document.querySelector('.loading');
    if (loadingElement) {
      loadingElement.classList.remove('loading');
    }

    // Add loaded class to body for CSS animations
    document.body.classList.add('loaded');
  }

  // Utility method to debounce function calls
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  // Utility method to throttle function calls
  throttle(func, limit) {
    let inThrottle;
    return function() {
      const args = arguments;
      const context = this;
      if (!inThrottle) {
        func.apply(context, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  }
}

// Initialize the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  if (window.__beanthenticAppInstance) return;
  window.__beanthenticAppInstance = new App();
});

// Export for potential module usage
window.BeanthenticApp = App;
