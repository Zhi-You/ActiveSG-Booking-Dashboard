/**
 * Runs in the page's MAIN world so we can see the same tRPC calls ActiveSG makes.
 */
(function () {
  if (window.__ASG_TRPC_SPY__) return;
  window.__ASG_TRPC_SPY__ = true;

  function emit(url) {
    try {
      window.dispatchEvent(new CustomEvent('asg-trpc', { detail: { url: String(url) } }));
    } catch {
      /* ignore */
    }
  }

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    try {
      const target = args[0];
      const url = typeof target === 'string' ? target : target && target.url;
      if (url && String(url).includes('/api/trpc/')) emit(url);
    } catch {
      /* ignore */
    }
    return origFetch.apply(this, args);
  };
})();
