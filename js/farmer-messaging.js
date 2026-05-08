class FarmerMessagingApp {
  constructor() {
    this.folder = 'inbox';
    this.searchTerm = '';
    this.messages = [];
    this.selectedId = null;
    this.init();
  }

  init() {
    const folderList = document.getElementById('messagingFolders');
    if (folderList) {
      folderList.addEventListener('click', (e) => {
        const item = e.target.closest('.messaging-folder-item');
        if (!item) return;
        const folder = item.getAttribute('data-folder');
        if (!folder) return;
        this.folder = folder;
        this.selectedId = null;
        folderList.querySelectorAll('.messaging-folder-item').forEach((el) => el.classList.remove('is-active'));
        item.classList.add('is-active');
        this.closeDetail();
        this.loadFolder();
      });
    }

    const searchInput = document.getElementById('messagingSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchTerm = (e.target.value || '').trim();
        this.loadFolder();
      });
    }

    const refreshBtn = document.getElementById('messagingRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => this.loadFolder());

    const markAllBtn = document.getElementById('messagingMarkAllReadBtn');
    if (markAllBtn) markAllBtn.addEventListener('click', () => this.markAllRead());

    const listEl = document.getElementById('messagingList');
    if (listEl) {
      listEl.addEventListener('click', (e) => {
        const starBtn = e.target.closest('.messaging-item__star');
        if (starBtn) {
          e.stopPropagation();
          const id = Number(starBtn.getAttribute('data-msg-id'));
          if (id) this.toggleStar(id);
          return;
        }
        const item = e.target.closest('.messaging-item');
        if (item) {
          const id = Number(item.getAttribute('data-msg-id'));
          if (id) this.openDetail(id);
        }
      });
    }

    const backBtn = document.getElementById('messagingDetailBackBtn');
    if (backBtn) backBtn.addEventListener('click', () => this.closeDetail());

    const starBtn = document.getElementById('messagingDetailStarBtn');
    if (starBtn) starBtn.addEventListener('click', () => this.selectedId && this.toggleStar(this.selectedId));

    const archiveBtn = document.getElementById('messagingDetailArchiveBtn');
    if (archiveBtn) archiveBtn.addEventListener('click', () => this.selectedId && this.toggleArchive(this.selectedId));

    const deleteBtn = document.getElementById('messagingDetailDeleteBtn');
    if (deleteBtn) deleteBtn.addEventListener('click', () => this.selectedId && this.deleteMessage(this.selectedId));

    const composeBtn = document.getElementById('messagingComposeBtn');
    if (composeBtn) composeBtn.addEventListener('click', () => this.openCompose());
    const composeClose = document.getElementById('messagingComposeClose');
    if (composeClose) composeClose.addEventListener('click', () => this.closeCompose());
    const composeCancel = document.getElementById('messagingComposeCancel');
    if (composeCancel) composeCancel.addEventListener('click', () => this.closeCompose());
    const composeOverlay = document.getElementById('messagingComposeOverlay');
    if (composeOverlay) {
      composeOverlay.addEventListener('click', (e) => {
        if (e.target === composeOverlay) this.closeCompose();
      });
    }
    const composeForm = document.getElementById('messagingComposeForm');
    if (composeForm) {
      composeForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.sendMessage();
      });
    }

    const inlineReplySendBtn = document.getElementById('msgInlineReplySendBtn');
    if (inlineReplySendBtn) inlineReplySendBtn.addEventListener('click', () => this.sendInlineReply());
    const inlineReplyInput = document.getElementById('msgInlineReplyInput');
    if (inlineReplyInput) {
      inlineReplyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendInlineReply();
        }
      });
      inlineReplyInput.addEventListener('input', () => this.autoResizeTextarea(inlineReplyInput));
    }

    this.loadFolder();
  }

  escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  showToast(message) {
    // Minimal feedback without relying on dashboard notification system
    alert(message);
  }

  getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }

  formatMessageTime(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return isoStr;
      const now = new Date();
      const diffMs = now - d;
      const diffH = diffMs / 3600000;
      if (diffH < 1) {
        const mins = Math.floor(diffMs / 60000);
        return mins <= 1 ? 'Just now' : `${mins}m ago`;
      }
      if (diffH < 24 && d.getDate() === now.getDate()) {
        return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
      }
      if (diffH < 168) return d.toLocaleDateString(undefined, { weekday: 'short' });
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return isoStr;
    }
  }

  renderList() {
    const listEl = document.getElementById('messagingList');
    if (!listEl) return;

    if (!this.messages.length) {
      listEl.innerHTML = `<li class="messaging-list-empty">
        <i class="fa-solid fa-envelope-open"></i>
        <p>No messages.</p>
      </li>`;
      return;
    }

    const esc = (s) => this.escapeHtml(s);
    listEl.innerHTML = this.messages
      .map((m) => {
        const unreadClass = m.is_read ? '' : ' is-unread';
        const activeClass = m.id === this.selectedId ? ' is-active' : '';
        const initials = this.getInitials(m.sender_name);
        const timeStr = this.formatMessageTime(m.created_at);
        const starClass = m.is_starred ? ' is-starred' : '';
        const starIcon = m.is_starred ? 'fa-solid fa-star' : 'fa-regular fa-star';
        const preview = (m.body || '').substring(0, 100);

        return `<li class="messaging-item${unreadClass}${activeClass}" data-msg-id="${m.id}">
          <div class="messaging-item__avatar messaging-item__avatar--farmer-message">${esc(initials)}</div>
          <div class="messaging-item__content">
            <div class="messaging-item__top">
              <span class="messaging-item__sender">${esc(m.sender_name || m.sender_phone)}</span>
              <span class="messaging-item__time">${esc(timeStr)}</span>
            </div>
            <div class="messaging-item__subject">${esc(m.subject)}</div>
            <div class="messaging-item__preview">${esc(preview)}</div>
            <div class="messaging-item__meta">
              <button type="button" class="messaging-item__star${starClass}" data-msg-id="${m.id}" title="Star">
                <i class="${starIcon}"></i>
              </button>
            </div>
          </div>
        </li>`;
      })
      .join('');
  }

  renderConversation(message) {
    const esc = (s) => this.escapeHtml(s);
    // We don't have real threads yet; show single message as bubble.
    const isSent = message.sender_phone === (window.__BEANTHENTIC_USER__ && window.__BEANTHENTIC_USER__.phone);
    const direction = isSent ? 'sent' : 'received';
    const avatarInitials = this.getInitials(message.sender_name || message.sender_phone);
    const timeStr = this.formatMessageTime(message.created_at);

    return `
      <div class="messaging-message messaging-message--${direction}">
        <div class="messaging-message__avatar">${esc(avatarInitials)}</div>
        <div class="messaging-message__content">
          ${!isSent ? `<div class="messaging-message__sender">${esc(message.sender_name || message.sender_phone)}</div>` : ''}
          <div class="messaging-message__bubble">${esc(message.body || '')}</div>
          <div class="messaging-message__timestamp">${esc(timeStr)}</div>
        </div>
      </div>
    `;
  }

  async loadFolder() {
    const listEl = document.getElementById('messagingList');
    if (listEl) {
      listEl.innerHTML = '<li class="messaging-loading"><i class="fa-solid fa-spinner"></i><span>Loading messages…</span></li>';
    }
    try {
      let url = `/api/messages?folder=${encodeURIComponent(this.folder)}`;
      if (this.searchTerm) url += `&search=${encodeURIComponent(this.searchTerm)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.messages = Array.isArray(data.items) ? data.items : [];

      const badge = document.getElementById('messagingInboxBadge');
      if (badge) {
        const unread = data.unread_count || this.messages.filter((m) => !m.is_read).length;
        badge.textContent = unread > 0 ? (unread > 99 ? '99+' : String(unread)) : '';
      }
      this.renderList();
    } catch (e) {
      if (listEl) listEl.innerHTML = '<li class="messaging-list-empty"><i class="fa-solid fa-circle-exclamation"></i><p>Could not load messages.</p></li>';
    }
  }

  async openDetail(id) {
    this.selectedId = id;
    const main = document.getElementById('messagingMain');
    const detail = document.getElementById('messagingDetail');
    if (main) main.classList.add('has-detail');
    if (detail) detail.classList.add('is-visible');

    document.querySelectorAll('.messaging-item').forEach((el) => {
      el.classList.toggle('is-active', Number(el.getAttribute('data-msg-id')) === id);
    });

    try {
      const res = await fetch(`/api/messages/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const m = data.message;
      if (!m) throw new Error('No message data');

      const subjectEl = document.getElementById('messagingDetailSubject');
      const avatarEl = document.getElementById('messagingDetailAvatar');
      const nameEl = document.getElementById('messagingDetailSenderName');
      const phoneEl = document.getElementById('messagingDetailSenderPhone');
      const tsEl = document.getElementById('messagingDetailTimestamp');
      const bodyEl = document.getElementById('messagingDetailBody');

      if (subjectEl) subjectEl.textContent = m.subject;
      if (avatarEl) avatarEl.textContent = this.getInitials(m.sender_name);
      if (nameEl) nameEl.textContent = m.sender_name || m.sender_phone;
      if (phoneEl) phoneEl.textContent = m.sender_phone ? `+63${m.sender_phone}` : '';
      if (tsEl) {
        try {
          const d = new Date(m.created_at);
          tsEl.textContent = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        } catch {
          tsEl.textContent = m.created_at || '';
        }
      }

      if (bodyEl) {
        const replySection = document.getElementById('messagingConversationReply');
        if (replySection) replySection.remove();
        bodyEl.innerHTML = this.renderConversation(m);
        if (replySection) bodyEl.appendChild(replySection);
        bodyEl.scrollTop = bodyEl.scrollHeight;
      }

      // Always show reply UI; enable if sender phone exists and isn't the farmer
      const farmerPhone = (window.__BEANTHENTIC_USER__ && window.__BEANTHENTIC_USER__.phone) || '';
      const replyable = !!m.sender_phone && String(m.sender_phone) !== String(farmerPhone);
      const inlineReplySection = document.getElementById('messagingConversationReply');
      if (inlineReplySection) inlineReplySection.classList.add('messaging-conversation__reply--visible');
      const inlineReplyInput = document.getElementById('msgInlineReplyInput');
      const inlineReplySendBtn = document.getElementById('msgInlineReplySendBtn');
      if (inlineReplyInput) {
        inlineReplyInput.disabled = !replyable;
        inlineReplyInput.placeholder = replyable ? 'Type your reply…' : 'Cannot reply to this message.';
      }
      if (inlineReplySendBtn) inlineReplySendBtn.disabled = !replyable;

      // cache current message for replying
      this._openMessage = m;
      this.renderList();
    } catch {
      const bodyEl = document.getElementById('messagingDetailBody');
      if (bodyEl) bodyEl.innerHTML = '<div class="messaging-list-empty"><i class="fa-solid fa-circle-exclamation"></i><p>Could not load this message.</p></div>';
    }
  }

  closeDetail() {
    this.selectedId = null;
    this._openMessage = null;
    const main = document.getElementById('messagingMain');
    const detail = document.getElementById('messagingDetail');
    if (main) main.classList.remove('has-detail');
    if (detail) detail.classList.remove('is-visible');
    document.querySelectorAll('.messaging-item').forEach((el) => el.classList.remove('is-active'));
  }

  openCompose() {
    const overlay = document.getElementById('messagingComposeOverlay');
    if (overlay) overlay.classList.add('is-visible');
    const subjectInput = document.getElementById('msgComposeSubject');
    if (subjectInput) setTimeout(() => subjectInput.focus(), 100);
  }

  closeCompose() {
    const overlay = document.getElementById('messagingComposeOverlay');
    if (overlay) overlay.classList.remove('is-visible');
    const form = document.getElementById('messagingComposeForm');
    if (form) form.reset();
  }

  async sendMessage() {
    const subject = (document.getElementById('msgComposeSubject')?.value || '').trim();
    const body = (document.getElementById('msgComposeBody')?.value || '').trim();
    const category = document.getElementById('msgComposeCategory')?.value || 'farmers';
    const recipientPhone = (document.getElementById('msgComposeRecipient')?.value || '').trim();

    if (!subject || !body) {
      this.showToast('Subject and message body are required.');
      return;
    }

    const sendBtn = document.getElementById('messagingComposeSend');
    if (sendBtn) sendBtn.disabled = true;

    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ subject, body, category, recipient_phone: recipientPhone }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      this.closeCompose();
      this.showToast('Message sent!');
      this.loadFolder();
    } catch (e) {
      this.showToast(e.message || 'Could not send message.');
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  async sendInlineReply() {
    const msg = this._openMessage;
    if (!msg || !msg.sender_phone) {
      this.showToast('Open an admin message to reply.');
      return;
    }

    const input = document.getElementById('msgInlineReplyInput');
    const body = (input?.value || '').trim();
    if (!body) {
      this.showToast('Message is required.');
      return;
    }

    const sendBtn = document.getElementById('msgInlineReplySendBtn');
    if (sendBtn) sendBtn.disabled = true;

    try {
      const subject = msg.subject && msg.subject.toLowerCase().startsWith('re:') ? msg.subject : `Re: ${msg.subject || 'Message'}`;
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          subject,
          body,
          category: 'farmers',
          recipient_phone: msg.sender_phone,
          farmer_id: msg.farmer_id ?? null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      if (input) {
        input.value = '';
        input.style.height = 'auto';
      }
      this.showToast('Reply sent!');
      this.loadFolder();
    } catch (e) {
      this.showToast(e.message || 'Could not send reply.');
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  autoResizeTextarea(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  }

  async toggleStar(id) {
    try {
      const res = await fetch(`/api/messages/${id}/star`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const m = this.messages.find((x) => x.id === id);
      if (m) m.is_starred = data.is_starred;
      this.renderList();
    } catch {}
  }

  async toggleArchive(id) {
    try {
      const res = await fetch(`/api/messages/${id}/archive`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.closeDetail();
      this.loadFolder();
    } catch {
      this.showToast('Could not archive message.');
    }
  }

  async deleteMessage(id) {
    if (!confirm('Delete this message permanently?')) return;
    try {
      const res = await fetch(`/api/messages/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.closeDetail();
      this.loadFolder();
    } catch {
      this.showToast('Could not delete message.');
    }
  }

  async markAllRead() {
    try {
      const res = await fetch('/api/messages/mark-all-read', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.loadFolder();
    } catch {}
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.farmerMessagingApp = new FarmerMessagingApp();
});

