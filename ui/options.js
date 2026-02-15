/**
 * VideoMancer - Options Page Script
 * Manages settings persistence via chrome.storage.sync
 */

(function () {
  'use strict';

  const COMMON_AD_DOMAINS = [
    'doubleclick.net',
    'googlesyndication.com',
    'adservice.google.com',
    'googleadservices.com',
    'moatads.com',
    'amazon-adsystem.com',
    'facebook.com/tr',
    'ads.yahoo.com',
    'adsrvr.org',
    'criteo.com',
    'rubiconproject.com',
    'pubmatic.com',
    'openx.net',
    'casalemedia.com',
    'adnxs.com',
    'taboola.com',
    'outbrain.com',
    'chartbeat.com',
    'scorecardresearch.com',
    'quantserve.com',
  ];

  const DEFAULTS = {
    autoDetect: true,
    showNotifications: true,
    preferredQuality: 'highest',
    maxConcurrentDownloads: 3,
    minSize: 100,
    filenameTemplate: '{title} - {quality}',
    blacklistedDomains: [],
  };

  // ── DOM Elements ───────────────────────────────────────────────────────

  const autoDetect = document.getElementById('auto-detect');
  const showNotifications = document.getElementById('show-notifications');
  const preferredQuality = document.getElementById('preferred-quality');
  const maxConcurrent = document.getElementById('max-concurrent');
  const minSize = document.getElementById('min-size');
  const filenameTemplate = document.getElementById('filename-template');
  const blacklist = document.getElementById('blacklist');
  const btnSave = document.getElementById('btn-save');
  const btnReset = document.getElementById('btn-reset');
  const btnAddAdDomains = document.getElementById('btn-add-ad-domains');
  const btnClearBlacklist = document.getElementById('btn-clear-blacklist');
  const saveStatus = document.getElementById('save-status');

  // ── Load Settings ──────────────────────────────────────────────────────

  function loadSettings() {
    chrome.storage.sync.get('settings', (result) => {
      const s = { ...DEFAULTS, ...(result.settings || {}) };

      autoDetect.checked = s.autoDetect;
      showNotifications.checked = s.showNotifications;
      preferredQuality.value = s.preferredQuality;
      maxConcurrent.value = String(s.maxConcurrentDownloads);
      minSize.value = s.minSize / 1024; // stored in bytes, display in KB
      filenameTemplate.value = s.filenameTemplate;
      blacklist.value = (s.blacklistedDomains || []).join('\n');
    });
  }

  // ── Save Settings ──────────────────────────────────────────────────────

  function saveSettings() {
    const settings = {
      autoDetect: autoDetect.checked,
      showNotifications: showNotifications.checked,
      preferredQuality: preferredQuality.value,
      maxConcurrentDownloads: parseInt(maxConcurrent.value, 10),
      minSize: (parseInt(minSize.value, 10) || 100) * 1024, // KB to bytes
      filenameTemplate: filenameTemplate.value || DEFAULTS.filenameTemplate,
      blacklistedDomains: blacklist.value
        .split('\n')
        .map(d => d.trim())
        .filter(d => d.length > 0),
    };

    chrome.storage.sync.set({ settings }, () => {
      saveStatus.textContent = 'Settings saved!';
      saveStatus.style.color = '#4caf50';
      setTimeout(() => { saveStatus.textContent = ''; }, 3000);
    });
  }

  // ── Reset ──────────────────────────────────────────────────────────────

  function resetSettings() {
    chrome.storage.sync.set({ settings: DEFAULTS }, () => {
      loadSettings();
      saveStatus.textContent = 'Settings reset to defaults.';
      saveStatus.style.color = '#ff9800';
      setTimeout(() => { saveStatus.textContent = ''; }, 3000);
    });
  }

  // ── Event Listeners ────────────────────────────────────────────────────

  btnSave.addEventListener('click', saveSettings);
  btnReset.addEventListener('click', resetSettings);

  btnAddAdDomains.addEventListener('click', () => {
    const current = blacklist.value.split('\n').map(d => d.trim()).filter(d => d);
    const merged = [...new Set([...current, ...COMMON_AD_DOMAINS])];
    blacklist.value = merged.join('\n');
  });

  btnClearBlacklist.addEventListener('click', () => {
    blacklist.value = '';
  });

  // ── Init ────────────────────────────────────────────────────────────────

  loadSettings();

})();
