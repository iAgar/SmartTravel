document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['anthropicApiKey'], (result) => {
    if (result.anthropicApiKey) {
      document.getElementById('apiKey').value = result.anthropicApiKey;
    }
  });
});

document.getElementById('clear-cache').addEventListener('click', () => {
  const cacheStatus = document.getElementById('cache-status');
  // Only remove trip cache entries (trip_v*), preserving the API key
  chrome.storage.local.get(null, (allItems) => {
    const tripKeys = Object.keys(allItems).filter(k => k.startsWith('trip_v'));
    if (tripKeys.length === 0) {
      cacheStatus.textContent = 'No cached data found.';
      cacheStatus.style.color = '#6b7280';
    } else {
      chrome.storage.local.remove(tripKeys, () => {
        cacheStatus.textContent = `Cleared ${tripKeys.length} cached trip${tripKeys.length > 1 ? 's' : ''}.`;
        cacheStatus.style.color = '#10b981';
      });
    }
    setTimeout(() => { cacheStatus.textContent = ''; }, 3000);
  });
});

document.getElementById('save').addEventListener('click', () => {
  const apiKey = document.getElementById('apiKey').value.trim();
  const status = document.getElementById('status');

  if (!apiKey) {
    status.textContent = 'Please enter a valid key.';
    status.style.color = '#ef4444';
    return;
  }

  chrome.storage.local.set({ anthropicApiKey: apiKey }, () => {
    status.textContent = 'Settings saved.';
    status.style.color = '#10b981';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
});
