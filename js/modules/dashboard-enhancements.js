/**
 * Dashboard enhancement module — patches DashboardApp after it loads.
 * Keeps dashboard.js intact while layering empty states, skeletons, and sparse-data UX.
 */
(function () {
  'use strict';

  function ui() {
    return window.BeanthenticUI || null;
  }

  function patchOnce() {
    const App = window.DashboardApp;
    if (!App || !App.prototype || App.prototype.__btEnhanced) return false;
    const proto = App.prototype;
    proto.__btEnhanced = true;

    const originalLoadAccount = proto.loadAccountData;
    if (typeof originalLoadAccount === 'function') {
      proto.loadAccountData = async function patchedLoadAccountData(...args) {
        const fields = [
          'accountHeroName',
          'accountFirstName',
          'accountLastName',
          'accountPhone',
          'accountDisplayName',
        ];
        fields.forEach((id) => {
          const el = document.getElementById(id);
          if (!el) return;
          el.classList.add('is-skeleton');
          if (ui()) el.innerHTML = ui().skeleton(id === 'accountHeroName' ? 'title' : 'text');
        });
        try {
          return await originalLoadAccount.apply(this, args);
        } finally {
          fields.forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.classList.remove('is-skeleton');
          });
        }
      };
    }

    const originalRenderAnalytics = proto.renderAnalyticsModule;
    if (typeof originalRenderAnalytics === 'function') {
      proto.renderAnalyticsModule = async function patchedRenderAnalytics(...args) {
        const result = await originalRenderAnalytics.apply(this, args);
        try {
          const docs = Array.isArray(this.__lastIpophlDocs)
            ? this.__lastIpophlDocs
            : [];
          const farmers = Array.isArray(this.data) ? this.data.length : 0;
          const root = document.getElementById('analytics-module');
          if (!root || !ui()) return result;
          let banner = root.querySelector('.bt-sparse-banner');
          const sparse = farmers < 5 || docs.length < 3;
          if (sparse) {
            const html = ui().sparseBanner(
              'Charts stay accurate with live data. Register more farmers and upload GI phase documents so Analytics and Maps fill in.',
              'Sparse live data'
            );
            if (!banner) {
              const host =
                root.querySelector('.analytics-summary-grid') ||
                root.querySelector('.analytics-kpi-grid') ||
                root.querySelector('.module-body') ||
                root;
              host.insertAdjacentHTML('beforebegin', html);
            }
          } else if (banner) {
            banner.remove();
          }
        } catch (_) {
          /* non-blocking */
        }
        return result;
      };
    }

    const originalFetchIpophl = proto.fetchIpophlDocumentItems;
    if (typeof originalFetchIpophl === 'function') {
      proto.fetchIpophlDocumentItems = async function patchedFetchIpophl(...args) {
        const docs = await originalFetchIpophl.apply(this, args);
        this.__lastIpophlDocs = Array.isArray(docs) ? docs : [];
        return docs;
      };
    }

    const originalRenderMaps = proto.refreshMapFromLiveFarmers;
    if (typeof originalRenderMaps === 'function') {
      proto.refreshMapFromLiveFarmers = async function patchedMaps(...args) {
        const result = await originalRenderMaps.apply(this, args);
        const mapModule = document.getElementById('maps-module');
        if (!mapModule || !ui()) return result;
        const count = Array.isArray(this.data) ? this.data.length : 0;
        let banner = mapModule.querySelector('.bt-sparse-banner');
        if (count < 3) {
          if (!banner) {
            const host =
              mapModule.querySelector('.map-container') ||
              mapModule.querySelector('.module-body') ||
              mapModule;
            host.insertAdjacentHTML(
              'beforebegin',
              ui().sparseBanner(
                'Pin density improves as more farmers complete registration with barangay locations.',
                'Few map pins yet'
              )
            );
          }
        } else if (banner) {
          banner.remove();
        }
        return result;
      };
    }

    return true;
  }

  function boot() {
    if (patchOnce()) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      if (patchOnce() || tries > 40) window.clearInterval(timer);
    }, 250);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
