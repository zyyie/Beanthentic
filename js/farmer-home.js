(function () {
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatUnlockMessage(audit) {
    if (!audit || typeof audit !== 'object') return '';
    const by = audit.unlocked_by || audit.unlocked_by_phone || '';
    const at = audit.unlocked_at || '';
    if (!by && !at) return '';
    if (by && at) return `Unlocked by ${by} on ${at}.`;
    if (by) return `Unlocked by ${by}.`;
    return `Unlocked at ${at}.`;
  }

  async function loadPortalStatus() {
    const unreadEl = document.getElementById('farmerUnreadSummary');
    const unlockEl = document.getElementById('farmerUnlockSummary');
    const priceEl = document.getElementById('farmerPriceSummary');
    const priceList = document.getElementById('farmerPriceList');

    try {
      const res = await fetch('/api/farmer/portal-status', { headers: { Accept: 'application/json' } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      const unread = Number(data.unread_count || 0);
      if (unreadEl) {
        unreadEl.textContent =
          unread > 0
            ? `${unread} unread message${unread === 1 ? '' : 's'} — open inbox`
            : 'No unread messages — open inbox';
      }

      const selfSale = !!data.self_sale_enabled;
      const records = !!data.records_unlocked;
      const auditMsg = formatUnlockMessage(data.unlock_audit) || data.unlock_message || '';
      if (unlockEl) {
        unlockEl.textContent =
          `Self-sale: ${selfSale ? 'enabled' : 'disabled'}. Records: ${records ? 'unlocked' : 'locked'}.` +
          (auditMsg ? ` ${auditMsg}` : '');
      }

      const items = Array.isArray(data.pricelist) ? data.pricelist : [];
      if (priceEl) {
        priceEl.textContent = items.length
          ? `${items.length} active price row${items.length === 1 ? '' : 's'}`
          : 'No active pricelist rows yet.';
      }
      if (priceList) {
        priceList.innerHTML = items
          .slice(0, 6)
          .map((item) => {
            const label = escapeHtml(item.classification || item.label || item.variety || 'Item');
            const price = item.price_per_kg != null ? item.price_per_kg : item.price;
            const priceStr = price != null ? `₱${escapeHtml(String(price))}/kg` : '—';
            return `<li><span>${label}</span><strong>${priceStr}</strong></li>`;
          })
          .join('');
      }
    } catch (err) {
      if (unreadEl) unreadEl.textContent = 'Could not load unread count.';
      if (unlockEl) unlockEl.textContent = 'Could not load unlock status.';
      if (priceEl) priceEl.textContent = 'Could not load pricelist.';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadPortalStatus();
    const poll = window.setInterval(() => {
      if (!document.hidden) loadPortalStatus();
    }, 20000);
    window.addEventListener('beforeunload', () => clearInterval(poll));
  });
})();
