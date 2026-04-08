(async function() {
  if (window.smartTravelInjected) return;
  window.smartTravelInjected = true;
  console.log("[SmartTravel] Extension script loaded");

  let tripState = {
    origin: null,
    destination: null,
    startDate: null,
    endDate: null
  };
  let currentRequestId = 0;
  let currentController = null;
  let shadowRoot = null;

  async function injectWidgetInstantly() {
    if (document.getElementById('smarttravel-container')) return;
    
    const container = document.createElement('div');
    container.id = 'smarttravel-container';
    container.style.position = 'fixed';
    container.style.right = '0';
    container.style.top = '60px'; 
    container.style.zIndex = '2147483647';
    container.style.pointerEvents = 'none';
    
    shadowRoot = container.attachShadow({ mode: 'open' });
    
    try {
      const [cssRes, htmlRes] = await Promise.all([
        fetch(chrome.runtime.getURL('ui/widget.css')).then(r => r.text()),
        fetch(chrome.runtime.getURL('ui/widget.html')).then(r => r.text())
      ]);
      
      shadowRoot.innerHTML = `<style>${cssRes}</style>${htmlRes}`;
      document.body.appendChild(container);
      console.log("[SmartTravel] Widget injected");

      const widget = shadowRoot.getElementById('smarttravel-widget');
      if (widget) widget.classList.remove('collapsed');

      setupEventListeners(shadowRoot);
      setWidgetStateLoading(); // Instant Skeleton loader baseline
    } catch (e) {
      console.error('[SmartTravel] Injection failed:', e);
    }
  }

  function setWidgetStateLoading() {
    if (!shadowRoot) return;
    const contextInfo = shadowRoot.getElementById('st-context-info');
    contextInfo.innerHTML = `Detecting trip details...`;
    
    const categories = ['packing', 'attractions', 'food', 'transport'];
    categories.forEach(cat => {
      shadowRoot.getElementById(`tab-${cat}`).innerHTML = `<div class="skeleton-container"><div class="skeleton skeleton-title"></div><div class="skeleton skeleton-text"></div></div>`;
    });
  }

  const debounce = (func, wait) => {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  };

  const debouncedFetchLLM = debounce(() => {
    fetchData(false, false);
  }, 1500);

  let extractionRetries = 0;
  let extractionInterval = null;

  const startExtractionLoop = () => {
    if (extractionInterval) clearTimeout(extractionInterval);
    extractionRetries = 0;

    const scheduleNext = (delay) => {
      extractionInterval = setTimeout(() => {
        extractAndSync();

        const hasDest = !!tripState.destination;
        const hasDate = !!(tripState.startDate || tripState.endDate);

        if (hasDest && hasDate) return; // Success — stop polling

        extractionRetries++;
        if (extractionRetries >= 30) return; // Limit reached — give up

        // Exponential backoff: 500ms → 1s → 2s → 4s (capped)
        scheduleNext(Math.min(delay * 2, 4000));
      }, delay);
    };

    extractAndSync(); // Immediate first run
    scheduleNext(500);
  };

  let pageObserver = null;

  const initObserver = () => {
    if (document.body) {
      injectWidgetInstantly().then(() => {
        startExtractionLoop();
        pageObserver = new MutationObserver(() => {
          extractAndSync();
        });
        pageObserver.observe(document, { subtree: true, childList: true, characterData: true });
      });
    } else {
      setTimeout(initObserver, 20);
    }
  };
  initObserver();

  window.addEventListener('beforeunload', () => {
    if (pageObserver) pageObserver.disconnect();
  });

  function extractFlightInfo() {
    const url = window.location.href;
    const docText = document.body ? document.body.innerText : '';
    const lowerDocText = docText.toLowerCase();
    
    let origin = null, dest = null, start = null, end = null;

    const isGoogleFlights = url.includes('google.com/travel/flights') || url.includes('google.com/flights');
    const isGoogleSearch = url.includes('google.com/search') && (lowerDocText.includes('flights from') || lowerDocText.includes('flights to'));
    const isAggregator = url.includes('makemytrip') || url.includes('skyscanner') || url.includes('kayak') || url.includes('expedia') || url.includes('goindigo') || url.includes('airindia');
    
    if (!isGoogleFlights && !isGoogleSearch && !isAggregator) return null;

    try {
      const urlObj = new URL(url);
      const params = urlObj.searchParams;
      origin = params.get('origin') || params.get('from') || null;
      dest = params.get('dest') || params.get('to') || params.get('destination') || null;

      if (!origin || !dest) {
        const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])'));
        for (const input of inputs) {
          const val = input.value;
          if (!val) continue;
          const label = (input.getAttribute('aria-label') || input.placeholder || '').toLowerCase();
          if (!origin && (label.includes('where from') || label.includes('origin'))) origin = val;
          else if (!dest && (label.includes('where to') || label.includes('destination'))) dest = val;
        }
      }

      if (!origin || !dest) {
        const fromMatch = lowerDocText.match(/(?:from|origin)\s*:?\s*([a-z\s]{3,20})(?:\n|to|-)/i);
        const destMatch = lowerDocText.match(/(?:to|destination)\s*:?\s*([a-z\s]{3,20})(?:\n|on|-)/i);
        if (!origin && fromMatch) origin = fromMatch[1].trim();
        if (!dest && destMatch) dest = destMatch[1].trim();
      }

      const dateRegex = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s?\d{1,2}/g;
      const allDates = docText.match(dateRegex);
      
      if (allDates && allDates.length > 0) {
        start = allDates[0];
        if (allDates.length > 1) {
          end = allDates[1];
        }
      }
      
      if (origin && origin.length > 20) origin = origin.split(/\n/)[0];
      if (dest && dest.length > 20) dest = dest.split(/\n/)[0];
    } catch (e) { }

    let extractedDates = { origin: origin, dest: dest, start: start, end: end };
    console.log("Date extraction attempt:", extractedDates);
    return extractedDates;
  }

  function extractAndSync() {
    const info = extractFlightInfo();
    
    if (!info) return;

    let updated = false;

    if (info.origin !== null && tripState.origin !== info.origin) { tripState.origin = info.origin; updated = true; }
    if (info.dest !== null && tripState.destination !== info.dest) { tripState.destination = info.dest; updated = true; }
    if (info.start !== null && tripState.startDate !== info.start) { tripState.startDate = info.start; updated = true; }
    if (info.end !== null && tripState.endDate !== info.end) { tripState.endDate = info.end; updated = true; }

    if (updated) {
       console.log("TripState:", tripState);
       updateWidgetUI();

       // Only trigger LLM if strict conditions met
       if (tripState.destination && (tripState.startDate || tripState.endDate)) {
          debouncedFetchLLM();
       }
    }
  }

  function setupEventListeners(shadow) {
    const toggle = shadow.getElementById('st-toggle');
    const widget = shadow.getElementById('smarttravel-widget');
    toggle.addEventListener('click', () => { widget.classList.toggle('collapsed'); });

    const tabs = shadow.querySelectorAll('.st-tab');
    const panels = shadow.querySelectorAll('.st-tab-panel');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        panels.forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        shadow.getElementById(`tab-${tab.dataset.tab}`).classList.add('active'); 
      });
    });

    shadow.getElementById('st-submit-manual').addEventListener('click', () => {
      const origin = shadow.getElementById('st-origin-input').value;
      const dest = shadow.getElementById('st-dest-input').value;
      const start = shadow.getElementById('st-start-input').value;
      const end = shadow.getElementById('st-end-input').value;

      if (dest && (start || end)) {
        tripState.origin = origin || null;
        tripState.destination = dest || null;
        tripState.startDate = start || null;
        tripState.endDate = end || null;
        
        console.log("TripState:", tripState);
        updateWidgetUI();
        fetchData(true); // Direct trigger
      }
    });

    shadow.addEventListener('click', (e) => {
      if(e.target.id === 'st-open-options') chrome.runtime.sendMessage({ action: 'openOptionsPage' });
      if(e.target.classList.contains('st-retry-btn')) fetchData(true, false);
    });
  }

  function updateWidgetUI() {
    if (!shadowRoot) return;
    const contextInfo = shadowRoot.getElementById('st-context-info');
    const fallbackForm = shadowRoot.getElementById('st-fallback-form');
    const mainView = shadowRoot.getElementById('st-main-view');
    
    // Immediate UI Sync logic decoupling LLM
    if (tripState.origin || tripState.destination) {
      const oText = tripState.origin || '...';
      const dText = tripState.destination || '...';
      
      if (tripState.startDate && tripState.endDate) {
        contextInfo.innerHTML = `✈️ <b>${oText}</b> to <b>${dText}</b><br>📅 ${tripState.startDate} - ${tripState.endDate}`;
      } else if (tripState.startDate || tripState.endDate) {
        const dPart = tripState.startDate || tripState.endDate;
        contextInfo.innerHTML = `✈️ <b>${oText}</b> to <b>${dText}</b><br>📅 ${dPart} (Detecting...)`;
      } else {
        contextInfo.innerHTML = `✈️ <b>${oText}</b> to <b>${dText}</b><br>📅 Detecting travel dates...`;
      }
    } else {
      contextInfo.innerHTML = `Detecting travel dates...`;
    }
    
    if (tripState.destination && (tripState.startDate || tripState.endDate)) {
      fallbackForm.classList.add('hidden');
      mainView.classList.remove('hidden');
    } else {
      shadowRoot.getElementById('st-origin-input').value = tripState.origin || '';
      shadowRoot.getElementById('st-dest-input').value = tripState.destination || '';
      shadowRoot.getElementById('st-start-input').value = tripState.startDate || '';
      shadowRoot.getElementById('st-end-input').value = tripState.endDate || '';
      fallbackForm.classList.remove('hidden');
      mainView.classList.add('hidden');
    }
  }

  function fetchData(force = false, skipCache = false) {
    const requestId = ++currentRequestId;
    if (currentController) currentController.abort();
    currentController = new AbortController();

    const categories = ['packing', 'attractions', 'food', 'transport'];
    
    const existingBanner = shadowRoot.getElementById('st-error-banner');
    if (existingBanner) existingBanner.remove();

    categories.forEach(cat => {
      shadowRoot.getElementById(`tab-${cat}`).innerHTML = `<div class="skeleton-container"><div class="skeleton skeleton-title"></div><div class="skeleton skeleton-text"></div></div>`;
    });

    const payload = {
       origin: tripState.origin || '',
       dest: tripState.destination || '',
       start: tripState.startDate || '',
       end: tripState.endDate || ''
    };

    console.log("LLM Request:", payload);

    chrome.runtime.sendMessage({ action: 'fetchTripData', data: payload, force: force || skipCache }, (response) => {
      if (requestId !== currentRequestId) return; // ignore stale response

      let dataToRender = response?.data;

      if (!response || response.error) {
        let titleMsg = "Network error";

        if (response?.error === 'LLM_KEY_MISSING') {
           titleMsg = "Anthropic API key required. Open Settings to add your key.";
        } else if ((response?.error || '') === 'RATE_LIMIT_COOLDOWN' || (response?.error || '').includes('429')) {
           titleMsg = "High demand. Please retry shortly.";
        } else if ((response?.error || '').includes('Parsing error')) {
           titleMsg = "Response parsing error. Retrying may help.";
        }
        
        console.log("Error:", response?.error || 'Network error');
        
        const banner = document.createElement('div');
        banner.id = 'st-error-banner';
        banner.style.cssText = 'background:rgba(255,100,100,0.1); padding:10px; margin:10px; border-radius:6px; border-left:3px solid var(--st-accent, #ff4c4c); font-size:12px; display:flex; flex-direction:column; gap:8px;';
        banner.innerHTML = `<strong style="color:var(--st-text);">${titleMsg}</strong>
        <button class="st-retry-btn" style="padding:6px; width:fit-content; font-size:11px; cursor:pointer; border-radius:4px; border:1px solid #ccc; background:var(--st-bg, #fff); color:var(--st-text);">Retry Request</button>`;
        
        const mainView = shadowRoot.getElementById('st-main-view');
        mainView.insertBefore(banner, mainView.firstChild);
        
        dataToRender = generateFallbackData(payload);
      }
      
      if(dataToRender) {
         renderPacking(shadowRoot, dataToRender.packing);
         renderClickableList(shadowRoot, 'attractions', dataToRender.attractions);
         renderClickableList(shadowRoot, 'food', dataToRender.food);
         renderTransport(shadowRoot, dataToRender.transport);
      }
    });
  }

  function generateFallbackData(info) {
    const month = (info.start || '').toLowerCase();

    let weather = 'mild';
    if (month.includes('nov') || month.includes('dec') || month.includes('jan') || month.includes('feb') || month.includes('mar')) weather = 'cold';
    else if (month.includes('jun') || month.includes('jul') || month.includes('aug') || month.includes('sep')) weather = 'hot';

    let packing = [];
    if (weather === 'cold') {
      packing = [
        { item: 'Heavy Jacket', reason: 'Temperatures drop significantly in winter months' },
        { item: 'Thermals', reason: 'Essential base layer for cold-weather travel' },
        { item: 'Gloves', reason: 'Protects hands in freezing outdoor conditions' }
      ];
    } else if (weather === 'hot') {
      packing = [
        { item: 'Sunscreen SPF 50+', reason: 'UV index is high during summer months' },
        { item: 'Light breathable clothes', reason: 'Heat and humidity require lightweight fabrics' },
        { item: 'Sunglasses', reason: 'Strong sun exposure during peak summer' }
      ];
    } else {
      packing = [
        { item: 'Light Jacket', reason: 'Mild seasons can have cool evenings' },
        { item: 'Walking Shoes', reason: 'Comfortable footwear for sightseeing' },
        { item: 'Umbrella', reason: 'Spring and autumn bring unpredictable showers' }
      ];
    }

    return {
      packing,
      attractions: [{ name: 'Suggestions unavailable', query: info.dest, reason: 'Could not load AI insights. Retry to get recommendations.' }],
      food: [{ name: 'Suggestions unavailable', query: `food in ${info.dest}`, reason: 'Could not load AI insights. Retry to get recommendations.' }],
      transport: [{ mode: 'Local Transit', details: 'Metro, cab, or airport shuttle', reason: 'Standard options available in most destinations' }]
    };
  }

  function renderPacking(shadow, items) {
    if (!shadow) return;
    if (!items || !items.length) { shadow.getElementById('tab-packing').innerHTML = '<p class="empty-state">No specific items.</p>'; return; }
    shadow.getElementById('tab-packing').innerHTML = `<ul class="st-cards">${items.map(i => `
      <li class="st-card">
        <div class="st-card-header">
          <span class="st-icon-emoji">🎒</span>
          <h4>${i.item || i.name || 'Item'}</h4>
          <input type="checkbox" class="st-check">
        </div>
        ${i.reason ? `<p class="st-reason">${i.reason}</p>` : ''}
      </li>`).join('')}</ul>`;
  }

  function renderClickableList(shadow, tab, items) {
    if (!shadow) return;
    if (!items || !items.length) { shadow.getElementById(`tab-${tab}`).innerHTML = '<p class="empty-state">Nothing found.</p>'; return; }
    const icon = tab === 'food' ? '🍽️' : '📍';
    shadow.getElementById(`tab-${tab}`).innerHTML = `<ul class="st-cards">${items.map(i => `
      <li>
        <a href="https://www.google.com/search?q=${encodeURIComponent(i.query || i.name)}" target="_blank" class="st-card clickable">
          <div class="st-card-header">
            <span class="st-icon-emoji">${icon}</span>
            <h4>${i.name}</h4>
            <span class="st-link-icon">↗</span>
          </div>
          ${i.reason ? `<p class="st-reason ellipsis">${i.reason}</p>` : ''}
        </a>
      </li>`).join('')}</ul>`;
  }

  function renderTransport(shadow, options) {
    if (!shadow) return;
    if (!options || !options.length) { shadow.getElementById('tab-transport').innerHTML = '<p class="empty-state">No options.</p>'; return; }
    shadow.getElementById('tab-transport').innerHTML = `<ul class="st-cards">${options.map(o => `
      <li class="st-card">
        <div class="st-card-header">
          <span class="st-icon-emoji">🚆</span>
          <h4>${o.mode}</h4>
        </div>
        ${o.details ? `<p class="st-desc">${o.details}</p>` : ''}
        ${o.reason ? `<p class="st-reason">${o.reason}</p>` : ''}
      </li>`).join('')}</ul>`;
  }
})();
