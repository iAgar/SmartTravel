document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['anthropicApiKey'], (result) => {
    if (result.anthropicApiKey) {
      document.getElementById('apiKey').value = result.anthropicApiKey;
    }
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
