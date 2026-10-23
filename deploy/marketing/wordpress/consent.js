/* AKE_MARKETING_CONSENT_BRIDGE: run before a delayed collector. No tracking or storage. */
(() => {
  if (window.AKEMarketing?.version || window.AKEMarketing?.consentBridge) return;
  window.AKEMarketing = {
    consentBridge: true,
    pendingConsent: null,
    setConsent(choice) {
      this.pendingConsent = Object.fromEntries(
        ['analytics', 'adStorage', 'adUserData', 'adPersonalization'].map(key =>
          [key, ['granted', 'denied', 'unknown'].includes(choice?.[key]) ? choice[key] : 'unknown'])
      );
    },
  };
  document.addEventListener('click', event => {
    if (window.AKEMarketing?.version) return;
    const button = event.target.closest?.('[data-ake-consent]');
    if (button) window.AKEMarketing.setConsent({
      analytics: button.dataset.akeConsent === 'analytics' ? 'granted' : 'denied',
      adStorage: 'denied', adUserData: 'denied', adPersonalization: 'denied',
    });
  });
})();
