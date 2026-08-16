/**
 * Shared confirm-dialog helpers — unifies open/close behavior across dialog systems
 * without changing each dialog's HTML structure.
 */
(function () {
  'use strict';

  function openOverlay(el) {
    if (!el) return;
    el.hidden = false;
    el.removeAttribute('hidden');
    el.style.display = el.classList.contains('confirm-dialog') || el.id === 'beanthenticConfirmDialog'
      ? 'flex'
      : '';
    document.body.classList.add('confirm-dialog-active');
  }

  function closeOverlay(el) {
    if (!el) return;
    el.hidden = true;
    el.setAttribute('hidden', '');
    if (el.id === 'beanthenticConfirmDialog') el.style.display = 'none';
    if (!document.querySelector('.confirm-dialog:not([hidden]), #beanthenticConfirmDialog:not([hidden]), .messaging-modal-overlay:not([hidden])')) {
      document.body.classList.remove('confirm-dialog-active');
    }
  }

  window.BeanthenticDialogs = {
    open(el) {
      openOverlay(typeof el === 'string' ? document.getElementById(el) : el);
    },
    close(el) {
      closeOverlay(typeof el === 'string' ? document.getElementById(el) : el);
    },
  };
})();
