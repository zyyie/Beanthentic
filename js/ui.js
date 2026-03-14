// UI interactions and animations
class UIController {
  constructor() {
    this.init();
  }

  init() {
    this.setupAnimations();
    this.setupInteractions();
    this.setupHeroSlider();
    this.loadYear();
  }

  setupAnimations() {
    // Add entrance animations to elements
    const observerOptions = {
      threshold: 0.1,
      rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('animate-in');
        }
      });
    }, observerOptions);

    // Observe elements for animation
    document.querySelectorAll('.hero-card, .about-card').forEach(el => {
      observer.observe(el);
    });
  }

  setupInteractions() {
    // Button interactions
    document.querySelectorAll('.btn-primary').forEach(button => {
      button.addEventListener('mouseenter', () => {
        button.style.transform = 'translateY(-1px)';
      });
      
      button.addEventListener('mouseleave', () => {
        button.style.transform = 'translateY(0)';
      });
    });

    // Add ripple effect to buttons
    document.querySelectorAll('.btn-primary').forEach(button => {
      button.addEventListener('click', function(e) {
        const ripple = document.createElement('span');
        const rect = this.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height);
        const x = e.clientX - rect.left - size / 2;
        const y = e.clientY - rect.top - size / 2;
        
        ripple.style.width = ripple.style.height = size + 'px';
        ripple.style.left = x + 'px';
        ripple.style.top = y + 'px';
        ripple.classList.add('ripple');
        
        this.appendChild(ripple);
        
        setTimeout(() => {
          ripple.remove();
        }, 600);
      });
    });
  }

  setupHeroSlider() {
    const slider = document.querySelector('.hero-slider');
    if (!slider) return;

    const track = slider.querySelector('.hero-slider-track');
    const slides = Array.from(slider.querySelectorAll('.hero-slide'));
    const dots = Array.from(slider.querySelectorAll('.hero-slider-dot'));

    if (!track || slides.length === 0) return;

    let index = 0;
    let timerId = null;

    const setIndex = (nextIndex) => {
      index = (nextIndex + slides.length) % slides.length;
      track.style.transform = `translateX(-${index * 100}%)`;
      dots.forEach((dot, i) => {
        dot.setAttribute('aria-selected', i === index ? 'true' : 'false');
      });
    };

    const start = () => {
      stop();
      timerId = window.setInterval(() => setIndex(index + 1), 4500);
    };

    const stop = () => {
      if (timerId) window.clearInterval(timerId);
      timerId = null;
    };

    dots.forEach((dot) => {
      dot.addEventListener('click', () => {
        const slide = Number.parseInt(dot.dataset.slide || '0', 10);
        if (Number.isFinite(slide)) {
          setIndex(slide);
          start();
        }
      });
    });

    // Pause on hover/focus for accessibility.
    slider.addEventListener('mouseenter', stop);
    slider.addEventListener('mouseleave', start);
    slider.addEventListener('focusin', stop);
    slider.addEventListener('focusout', start);

    setIndex(0);
    start();
  }

  loadYear() {
    // Set current year in footer
    const yearElement = document.getElementById('year');
    if (yearElement) {
      yearElement.textContent = new Date().getFullYear();
    }
  }

  // Utility method to show notifications
  showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
      notification.classList.add('show');
    }, 100);
    
    setTimeout(() => {
      notification.classList.remove('show');
      setTimeout(() => {
        notification.remove();
      }, 300);
    }, 3000);
  }
}

// Initialize UI controller when DOM is ready and expose globally
document.addEventListener('DOMContentLoaded', () => {
  window.uiController = new UIController();
});
