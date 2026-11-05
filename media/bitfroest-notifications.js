(function () {
  'use strict';
  function create({ closeLabel = 'Close' } = {}) {
    const notyf = new window.Notyf({ position: { x: 'right', y: 'top' }, duration: 5000, dismissible: true, ripple: false, types: ['info', 'warning', 'success', 'error'].map(type => ({ type, icon: false, className: `bitfroest-notification-${type}` })) });
    return {
      show(message, type = 'info') {
        const text = document.createElement('span');
        text.textContent = String(message);
        const notification = notyf.open({ type: ['info', 'warning', 'success', 'error'].includes(type) ? type : 'info', message: text.innerHTML });
        const buttons = document.querySelectorAll('.notyf__dismiss-btn:not([aria-label])');
        buttons.forEach(button => button.setAttribute('aria-label', closeLabel));
        return notification;
      },
      dismiss(notification) { notyf.dismiss(notification); },
      dismissAll() { notyf.dismissAll(); }
    };
  }
  window.BitfroestNotifications = { create };
}());
