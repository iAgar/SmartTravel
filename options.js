document.getElementById('clear-cache').addEventListener('click', () => {
  const cacheStatus = document.getElementById('cache-status');
  // Only remove trip cache entries (trip_v*) — no API key to preserve
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
