const DEFAULT_ANTHROPIC_KEY = ''; // Set via options page (chrome.storage)

// Provider configuration — extend providers object to add future fallbacks
const API_CONFIG = {
  provider: 'anthropic',
  providers: {
    anthropic: {
      endpoint: 'https://api.anthropic.com/v1/messages',
      model: 'claude-3-haiku-20240307',
      version: '2023-06-01'
    }
    // future: { openai: {...}, backend: { endpoint: '/api/travel-insights' } }
  }
};

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
    chrome.storage.local.get([cacheKey, 'anthropicApiKey'], async (result) => {
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

      // 3. Rate limit gate
      if (Date.now() < cooldownUntil) {
        const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
        console.warn(`[Rate Limited] Cooling for ${remaining}s`);
        resolve({ error: 'RATE_LIMIT_COOLDOWN', remaining });
        return;
      }

      // 4. API key resolution: user key → default key
      const apiKey = result.anthropicApiKey || DEFAULT_ANTHROPIC_KEY;
      if (!apiKey || apiKey === 'ENTER_DEFAULT_ANTHROPIC_KEY_HERE') {
        resolve({ error: 'LLM_KEY_MISSING' });
        return;
      }

      // 5. Scarce network call through abstract layer
      try {
        console.log(`[API Call] Fetching insights for: ${info.dest}`);
        const data = await callWithRetry(info, apiKey, 1);
        chrome.storage.local.set({ [cacheKey]: { data, timestamp: Date.now() } });
        resolve({ source: 'api', data });
      } catch (e) {
        console.error('[SmartTravel] Fatal error:', e.message, e);
        if (e.message.includes('429')) {
          cooldownUntil = Date.now() + 35000; // 35s hard cooldown
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
async function callWithRetry(info, apiKey, retries = 1) {
  try {
    return await getTravelInsights(info, apiKey);
  } catch (error) {
    if (error.message.includes('429')) throw error;
    if (retries > 0) {
      console.warn('[Retry] Transient error, retrying in 500ms...');
      await new Promise(r => setTimeout(r, 500));
      return await callWithRetry(info, apiKey, retries - 1);
    }
    throw error;
  }
}

// ─── Abstract API Layer ────────────────────────────────────────────────────────
// All travel insight requests funnel through here.
// Future swap: replace body with fetch('/api/travel-insights', { method: 'POST', body: JSON.stringify(info) })
async function getTravelInsights(info, apiKey) {
  return await callProvider(API_CONFIG.provider, info, apiKey);
}

async function callProvider(provider, info, apiKey) {
  const config = API_CONFIG.providers[provider];
  if (!config) throw new Error(`Unknown provider: ${provider}`);

  switch (provider) {
    case 'anthropic':
      return await callAnthropicAPI(info, apiKey, config);
    default:
      throw new Error(`No implementation for provider: ${provider}`);
  }
}
// ──────────────────────────────────────────────────────────────────────────────

async function callAnthropicAPI(info, apiKey, config) {
  const prompt = buildPrompt(info);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  console.log('[Anthropic] API request sent', { model: config.model, dest: info.dest });

  let response;
  try {
    response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': config.version,
        'content-type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      })
    });
  } catch (networkError) {
    clearTimeout(timeoutId);
    console.error('[Anthropic] Network error:', networkError.message, networkError);
    throw new Error(`Network error: ${networkError.message}`);
  }

  clearTimeout(timeoutId);
  console.log('[Anthropic] Response received — Status:', response.status);

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[Anthropic] API error — Status: ${response.status} — Body: ${errText}`);
    if (response.status === 429) throw new Error('429: Too Many Requests');
    throw new Error(`API ${response.status}: ${errText}`);
  }

  const result = await response.json();
  console.log('[Anthropic] Response JSON parsed');
  const textContent = result.content[0].text;
  console.log('[Anthropic] Raw text content:', textContent);

  return parseAndValidate(textContent);
}

function buildPrompt(info) {
  return `You are a fast, expert travel assistant. Trip: ${info.origin || 'Unknown origin'} → ${info.dest} (${info.start}–${info.end}).

Output ONLY valid JSON. No markdown. No explanation. No extra text.

{
  "packing": [{"item": "Item name", "reason": "Specific weather/culture/activity reason tied to destination and dates"}],
  "attractions": [{"name": "Attraction name", "query": "Google search query", "reason": "Why this specific place is unmissable in ${info.dest}"}],
  "food": [{"name": "Restaurant or dish", "query": "Google search query", "reason": "Why this is the authentic or best choice here"}],
  "transport": [{"mode": "Transport mode", "details": "Route or timing info", "reason": "Why this is the smartest option for this trip"}]
}

Rules:
- Max 5 items per section
- Every "reason" must be specific — mention weather, geography, culture, or local context
- Never use generic reasons like "it's popular" or "very convenient"
- Attractions and food reasons must reference what makes them unique to ${info.dest}`;
}

function parseAndValidate(text) {
  let json;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in response');
    json = JSON.parse(match[0]);
  } catch (e) {
    console.error('[Parse Error]', e.message);
    throw new Error('Parsing error');
  }

  if (!json || typeof json !== 'object') throw new Error('Parsing error');

  // Lenient validation — normalize missing sections to empty arrays
  if (!Array.isArray(json.packing)) json.packing = [];
  if (!Array.isArray(json.attractions)) json.attractions = [];
  if (!Array.isArray(json.food)) json.food = [];
  if (!Array.isArray(json.transport)) json.transport = [];

  return json;
}
