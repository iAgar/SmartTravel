// ─── Proxy configuration ──────────────────────────────────────────────────────
// After deploying the Cloudflare Worker, replace this URL with your worker URL.
// Format: https://smarttravel-proxy.YOUR_SUBDOMAIN.workers.dev/api/travel-insights
const PROXY_ENDPOINT = 'https://smarttravel-proxy.YOUR_SUBDOMAIN.workers.dev/api/travel-insights';

let cooldownUntil = 0;
const activeRequests = new Map();

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'fetchTripData') {
    handleFetchData(request.data, request.force).then(sendResponse);
    return true; // Keep channel open for async response
  }
  if (request.action === 'openOptionsPage') {
    chrome.runtime.openOptionsPage();
  }
});

async function handleFetchData(info, force = false) {
  const cacheKey = `trip_v10_${info.dest}_${info.start}_${info.end}`;

  // 1. Request deduplication — concurrent calls share same Promise
  if (activeRequests.has(cacheKey)) {
    console.log(`[Dedup] Sharing active request for: ${cacheKey}`);
    return activeRequests.get(cacheKey);
  }

  const fetchPromise = new Promise((resolve) => {
    chrome.storage.local.get([cacheKey], async (result) => {
      // 2. 24-hour local cache check
      if (result[cacheKey] && !force) {
        const entry = result[cacheKey];
        if (Date.now() - entry.timestamp < 24 * 60 * 60 * 1000) {
          console.log(`[Cache Hit] <10ms from storage: ${cacheKey}`);
          resolve({ source: 'cache', data: entry.data });
          return;
        }
        console.log(`[Cache Miss] Stale entry discarded (>24h TTL)`);
      }

      // 3. Rate limit gate (local cooldown after upstream 429)
      if (Date.now() < cooldownUntil) {
        const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
        console.warn(`[Rate Limited] Cooling for ${remaining}s`);
        resolve({ error: 'RATE_LIMIT_COOLDOWN', remaining });
        return;
      }

      // 4. Call proxy
      try {
        console.log(`[API Call] Fetching insights for: ${info.dest}`);
        const data = await callWithRetry(info, 1);
        chrome.storage.local.set({ [cacheKey]: { data, timestamp: Date.now() } });
        resolve({ source: 'api', data });
      } catch (e) {
        console.error('[SmartTravel] Fatal error:', e.message, e);
        if (e.message.includes('429')) {
          cooldownUntil = Date.now() + 35000; // 35s local cooldown
          resolve({ error: 'RATE_LIMIT_COOLDOWN', remaining: 35 });
        } else {
          resolve({ error: e.message });
        }
      }
    });
  });

  activeRequests.set(cacheKey, fetchPromise);
  try {
    const result = await fetchPromise;
    activeRequests.delete(cacheKey);
    return result;
  } catch (e) {
    activeRequests.delete(cacheKey);
    return { error: 'INTERNAL_ERROR' };
  }
}

// One silent retry on transient errors; never retry rate limits
async function callWithRetry(info, retries = 1) {
  try {
    return await getTravelInsights(info);
  } catch (error) {
    if (error.message.includes('429')) throw error;
    if (retries > 0) {
      console.warn('[Retry] Transient error, retrying in 500ms...');
      await new Promise(r => setTimeout(r, 500));
      return await callWithRetry(info, retries - 1);
    }
    throw error;
  }
}

// ─── Abstract API layer ───────────────────────────────────────────────────────
// All insight requests go through here.
// To switch providers or go direct: replace callProxy() body only.
async function getTravelInsights(info) {
  return await callProxy(info);
}

async function callProxy(info) {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 10000);

  console.log('[Proxy] API request sent', { dest: info.dest });

  let response;
  try {
    response = await fetch(PROXY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(info)
    });
  } catch (networkError) {
    clearTimeout(timeoutId);
    console.error('[Proxy] Network error:', networkError.message, networkError);
    throw new Error(`Network error: ${networkError.message}`);
  }

  clearTimeout(timeoutId);
  console.log('[Proxy] Response received — Status:', response.status);

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[Proxy] Error — Status: ${response.status} — Body: ${errText}`);
    if (response.status === 429) throw new Error('429: Too Many Requests');
    if (response.status === 403) throw new Error('403: Access denied');
    throw new Error(`Proxy ${response.status}: ${errText}`);
  }

  const data = await response.json();
  console.log('[Proxy] Response JSON parsed');

  // Normalize missing sections to empty arrays
  if (!Array.isArray(data.packing))     data.packing     = [];
  if (!Array.isArray(data.attractions)) data.attractions = [];
  if (!Array.isArray(data.food))        data.food        = [];
  if (!Array.isArray(data.transport))   data.transport   = [];

  return data;
}
