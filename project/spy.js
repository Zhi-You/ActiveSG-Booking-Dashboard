/**
 * Runs in the page's MAIN world so we can see the same tRPC calls ActiveSG makes.
 * Ignores the dashboard's own fetches (x-asg-dash) so we only learn official routes.
 */
(function () {
  if (window.__ASG_TRPC_SPY__) return;
  window.__ASG_TRPC_SPY__ = true;

  function headerMap(headers) {
    if (!headers) return {};
    if (typeof headers.get === 'function') {
      const dash = headers.get('x-asg-dash') || headers.get('X-ASG-Dash');
      return { 'x-asg-dash': dash };
    }
    const out = {};
    for (const key of Object.keys(headers)) out[key.toLowerCase()] = headers[key];
    return out;
  }

  function isDashFetch(input, init) {
    const fromInit = headerMap(init && init.headers)['x-asg-dash'];
    if (fromInit) return true;
    if (typeof Request !== 'undefined' && input instanceof Request) {
      if (headerMap(input.headers)['x-asg-dash']) return true;
    }
    return false;
  }

  function jsonInputsFromValue(value) {
    if (!value || typeof value !== 'object') return [];
    if (value.json && typeof value.json === 'object') return [value.json];
    const keys = Object.keys(value);
    if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
      return keys
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => value[k]?.json)
        .filter((json) => json && typeof json === 'object');
    }
    return [];
  }

  function decodeInputs(url, init) {
    const inputs = [];
    try {
      const parsed = new URL(String(url), location.origin);
      const raw = parsed.searchParams.get('input');
      if (raw) inputs.push(...jsonInputsFromValue(JSON.parse(raw)));
    } catch {
      /* ignore */
    }
    try {
      const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
      if (body) inputs.push(...jsonInputsFromValue(body));
    } catch {
      /* ignore */
    }
    return inputs;
  }

  function emit(url, init) {
    try {
      window.dispatchEvent(
        new CustomEvent('asg-trpc', {
          detail: { url: String(url), inputs: decodeInputs(url, init) },
        })
      );
    } catch {
      /* ignore */
    }
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    if (isDashFetch(input, init)) return origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (url && String(url).includes('/api/trpc/')) emit(url, init);
    } catch {
      /* ignore */
    }
    return origFetch.apply(this, arguments);
  };
})();
