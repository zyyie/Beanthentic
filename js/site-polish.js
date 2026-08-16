/**
 * Beanthentic — shared UI polish (motion, loading, empty, mobile tables).
 * Preserves existing green + coffee design; no layout rewrites.
 */
(function () {
  'use strict';

  const LOADING_ROW =
    (colspan, label) =>
      `<tr class="bt-loading-row"><td colspan="${colspan}" class="bt-loading-cell">` +
      `<span class="bt-loading-spinner" aria-hidden="true"></span>` +
      `<span>${label}…</span></td></tr>`;

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  window.BeanthenticUI = {
    loadingRow(colspan = 7, label = 'Loading') {
      return LOADING_ROW(colspan, label);
    },

    loadingPanel(label = 'Loading') {
      return (
        `<div class="bt-loading-panel" role="status" aria-live="polite">` +
        `<span class="bt-loading-spinner" aria-hidden="true"></span>` +
        `<span>${escapeHtml(label)}…</span></div>`
      );
    },

    emptyState({ icon = 'fa-inbox', title = 'Nothing here yet', hint = '' } = {}) {
      return (
        `<div class="bt-empty" role="status">` +
        `<div class="bt-empty__icon"><i class="fa-solid ${escapeHtml(icon)}" aria-hidden="true"></i></div>` +
        `<p class="bt-empty__title">${escapeHtml(title)}</p>` +
        (hint ? `<p class="bt-empty__hint">${escapeHtml(hint)}</p>` : '') +
        `</div>`
      );
    },

    emptyTableRow(colspan = 7, options = {}) {
      return (
        `<tr><td colspan="${colspan}">` +
        this.emptyState(options) +
        `</td></tr>`
      );
    },

    skeleton(kind = 'text') {
      const cls =
        kind === 'title'
          ? 'bt-skeleton bt-skeleton--title'
          : kind === 'block'
            ? 'bt-skeleton bt-skeleton--block'
            : kind === 'avatar'
              ? 'bt-skeleton bt-skeleton--avatar'
              : 'bt-skeleton bt-skeleton--text';
      return `<span class="${cls}" aria-hidden="true">&nbsp;</span>`;
    },

    sparseBanner(message, title = 'Growing dataset') {
      return (
        `<div class="bt-sparse-banner" role="status">` +
        `<i class="fa-solid fa-seedling" aria-hidden="true"></i>` +
        `<div><strong>${escapeHtml(title)}</strong> — ${escapeHtml(message)}</div>` +
        `</div>`
      );
    },

    labelMobileTable(table) {
      if (!table || table.dataset.btMobileReady === '1') return;
      const headerRows = table.querySelectorAll('thead tr');
      const headerRow = headerRows[headerRows.length - 1];
      if (!headerRow) return;
      const labels = Array.from(headerRow.querySelectorAll('th')).map((th) =>
        (th.textContent || '').replace(/\s+/g, ' ').trim()
      );
      if (!labels.length) return;
      table.classList.add('bt-mobile-cards');
      table.dataset.btMobileReady = '1';
      table.querySelectorAll('tbody tr').forEach((tr) => {
        Array.from(tr.children).forEach((td, i) => {
          if (td.tagName !== 'TD') return;
          if (!td.getAttribute('data-label') && labels[i]) {
            td.setAttribute('data-label', labels[i]);
          }
        });
      });
    },

    refreshMobileTables(root = document) {
      const selectors = [
        '#transactions-module table',
        '#client-report-module .data-table',
        '#coffee-pricing-module table',
        '#analytics-module table',
        '.transactions-table',
        'table.bt-cardable',
      ];
      selectors.forEach((sel) => {
        root.querySelectorAll(sel).forEach((table) => this.labelMobileTable(table));
      });
    },
  };

  function setupRippleDelegation() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-primary');
      if (!btn || btn.disabled || btn.classList.contains('is-loading')) return;
      const rect = btn.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const ripple = document.createElement('span');
      ripple.className = 'ripple';
      ripple.style.width = ripple.style.height = `${size}px`;
      ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
      ripple.style.top = `${e.clientY - rect.top - size / 2}px`;
      btn.appendChild(ripple);
      ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
    });
  }

  function setupOverviewStagger() {
    const grid = document.querySelector('.overview-stats-grid, #overview-module .stats-grid');
    if (!grid || grid.dataset.staggerReady) return;
    grid.dataset.staggerReady = '1';
    grid.classList.add('bt-stagger-ready');
  }

  function setupScrollTop() {
    const scroller = document.querySelector('.module-content');
    if (!scroller || document.getElementById('btScrollTop')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btScrollTop';
    btn.className = 'bt-scroll-top';
    btn.setAttribute('aria-label', 'Scroll to top');
    btn.innerHTML = '<i class="fa-solid fa-arrow-up" aria-hidden="true"></i>';
    document.body.appendChild(btn);

    const toggle = () => {
      const show = scroller.scrollTop > 320;
      btn.classList.toggle('is-visible', show);
    };

    scroller.addEventListener('scroll', toggle, { passive: true });
    btn.addEventListener('click', () => {
      scroller.scrollTo({ top: 0, behavior: 'smooth' });
    });
    toggle();
  }

  function setupSkipLink() {
    if (document.querySelector('.bt-skip-link')) return;
    const link = document.createElement('a');
    link.href = '#main-content';
    link.className = 'bt-skip-link';
    link.textContent = 'Skip to main content';
    document.body.prepend(link);

    const main = document.querySelector('.module-content, .dashboard-main, main');
    if (main && !main.id) main.id = 'main-content';
  }

  function setupMobileTableObserver() {
    if (!document.body.classList.contains('dashboard-page')) return;
    const run = () => window.BeanthenticUI.refreshMobileTables();
    run();
    const root = document.querySelector('.module-content') || document.body;
    const observer = new MutationObserver(() => {
      window.clearTimeout(setupMobileTableObserver._t);
      setupMobileTableObserver._t = window.setTimeout(run, 120);
    });
    observer.observe(root, { childList: true, subtree: true });
    window.addEventListener('hashchange', () => window.setTimeout(run, 250));
  }

  function init() {
    setupRippleDelegation();
    setupSkipLink();

    if (document.body.classList.contains('dashboard-page')) {
      setupScrollTop();
      setupMobileTableObserver();
      window.setTimeout(setupOverviewStagger, 120);

      window.addEventListener('hashchange', () => {
        window.setTimeout(setupOverviewStagger, 200);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
