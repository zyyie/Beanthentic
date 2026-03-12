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
