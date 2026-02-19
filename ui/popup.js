/**
 * VideoMancer - Popup Script
 * Manages the popup UI: displays detected videos, handles downloads,
 * and shows quality selection for HLS/DASH streams.
 */

(function () {
  'use strict';

  let currentTabId = null;
  let videos = [];
  let downloadingIds = new Set();

  // ── DOM Elements ───────────────────────────────────────────────────────

  const videoList = document.getElementById('video-list');
  const emptyState = document.getElementById('empty-state');
  const statusText = document.getElementById('status-text');
  const videoCount = document.getElementById('video-count');
  const btnDownloadAll = document.getElementById('btn-download-all');
  const btnClear = document.getElementById('btn-clear');
  const btnRefresh = document.getElementById('btn-refresh');
  const btnSettings = document.getElementById('btn-settings');

  // ── Init ────────────────────────────────────────────────────────────────

  async function init() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    currentTabId = tab.id;

    loadVideos();
    setupListeners();
  }

  function loadVideos() {
    chrome.runtime.sendMessage(
      { action: 'getVideos', tabId: currentTabId },
      (response) => {
        if (response && response.videos) {
          videos = response.videos;
          render();
        }
      }
    );
  }

  function setupListeners() {
    btnRefresh.addEventListener('click', () => {
      // Re-inject content script to force rescan
      chrome.tabs.sendMessage(currentTabId, { action: 'rescan' }, () => {
        // Ignore errors if content script can't receive
      });
      setTimeout(loadVideos, 1000);
    });

    btnSettings.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });

    btnDownloadAll.addEventListener('click', downloadAll);
    btnClear.addEventListener('click', clearAll);

    // Listen for real-time video detection updates
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'videoDetected' && msg.tabId === currentTabId) {
        videos.push(msg.video);
        render();
      }
      if (msg.action === 'downloadProgress') {
        updateProgress(msg.videoId, msg.percent, msg.current, msg.total);
      }
    });
  }

  // ── Render ─────────────────────────────────────────────────────────────

  function render() {
    const count = videos.length;
    videoCount.textContent = `${count} video${count !== 1 ? 's' : ''}`;
    statusText.textContent = count > 0 ? 'Videos found on this page' : 'No videos detected';
    btnDownloadAll.disabled = count === 0;

    if (count === 0) {
      emptyState.style.display = 'flex';
      // Remove all video cards
      videoList.querySelectorAll('.video-card').forEach(c => c.remove());
      return;
    }

    emptyState.style.display = 'none';

    // Clear existing cards
    videoList.querySelectorAll('.video-card').forEach(c => c.remove());

    // Render video cards
    for (const video of videos) {
      const card = createVideoCard(video);
      videoList.appendChild(card);
    }
  }

  function createVideoCard(video) {
    const card = document.createElement('div');
    card.className = 'video-card';
    card.dataset.videoId = video.id;
    if (downloadingIds.has(video.id)) card.classList.add('downloading');

    const displayName = truncate(video.filename || 'Unknown video', 60);
    const typeClass = video.type || 'direct';

    card.innerHTML = `
      <div class="video-card-header">
        <div class="video-filename" title="${escapeHtml(video.filename || video.url)}">${escapeHtml(displayName)}</div>
        <span class="video-type-badge ${typeClass}">${typeClass}</span>
      </div>
      <div class="video-meta">
        ${video.quality && video.quality !== 'Unknown' ? `<span>&#9632; ${escapeHtml(video.quality)}</span>` : ''}
        ${video.resolution ? `<span>&#9633; ${escapeHtml(video.resolution)}</span>` : ''}
        ${video.sizeFormatted && video.sizeFormatted !== 'Unknown size' ? `<span>&#9660; ${escapeHtml(video.sizeFormatted)}</span>` : ''}
        ${video.contentType ? `<span>${escapeHtml(simplifyMime(video.contentType))}</span>` : ''}
      </div>
      <div class="video-actions">
        <button class="btn-download" data-video-id="${video.id}">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 1v7M3 6l3 3 3-3M2 10h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Download
        </button>
        <button class="btn-remove" data-video-id="${video.id}" title="Remove">&times;</button>
      </div>
      <div class="progress-container" id="progress-${video.id}">
        <div class="progress-bar">
          <div class="progress-bar-fill" id="progress-fill-${video.id}"></div>
        </div>
        <div class="progress-text" id="progress-text-${video.id}">0%</div>
      </div>
    `;

    // Download button
    card.querySelector('.btn-download').addEventListener('click', (e) => {
      e.stopPropagation();
      downloadVideo(video);
    });

    // Remove button
    card.querySelector('.btn-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeVideo(video.id);
    });

    return card;
  }

  // ── Download ───────────────────────────────────────────────────────────

  async function downloadVideo(video) {
    if (downloadingIds.has(video.id)) return;

    // For HLS/DASH, first check for quality options
    if (video.type === 'hls') {
      await handleHLSDownload(video);
      return;
    }

    if (video.type === 'dash') {
      await handleDASHDownload(video);
      return;
    }

    // Direct download
    startDownload(video);
  }

  async function handleHLSDownload(video) {
    // Fetch available qualities (pass tabId for authenticated fetch)
    chrome.runtime.sendMessage(
      { action: 'getHLSQualities', url: video.url, tabId: currentTabId },
      (response) => {
        if (response && response.qualities && response.qualities.length > 0) {
          showQualityPicker(video, response.qualities, (selectedUrl) => {
            startDownload({ ...video, selectedQuality: selectedUrl });
          });
        } else {
          // Single quality, download directly
          startDownload(video);
        }
      }
    );
  }

  async function handleDASHDownload(video) {
    chrome.runtime.sendMessage(
      { action: 'getDASHQualities', url: video.url, tabId: currentTabId },
      (response) => {
        if (response && response.qualities && response.qualities.length > 0) {
          showQualityPicker(video, response.qualities, (selectedId) => {
            startDownload({ ...video, selectedQuality: selectedId });
          });
        } else {
          startDownload(video);
        }
      }
    );
  }

  function showQualityPicker(video, qualities, onSelect) {
    const card = document.querySelector(`[data-video-id="${video.id}"]`);
    if (!card) return;

    // Remove existing quality picker
    const existing = card.querySelector('.quality-list');
    if (existing) existing.remove();

    const list = document.createElement('div');
    list.className = 'quality-list show';

    for (const q of qualities) {
      const item = document.createElement('div');
      item.className = 'quality-item';
      item.innerHTML = `
        <span class="q-label">${escapeHtml(q.label || q.resolution || 'Unknown')}</span>
        <span class="q-info">${q.bandwidth ? Math.round(q.bandwidth / 1000) + ' kbps' : ''}</span>
      `;
      item.addEventListener('click', () => {
        list.remove();
        onSelect(q.url || q.id);
      });
      list.appendChild(item);
    }

    const actionsDiv = card.querySelector('.video-actions');
    actionsDiv.style.position = 'relative';
    actionsDiv.appendChild(list);

    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', function closeList(e) {
        if (!list.contains(e.target)) {
          list.remove();
          document.removeEventListener('click', closeList);
        }
      });
    }, 100);
  }

  function startDownload(video) {
    downloadingIds.add(video.id);

    const card = document.querySelector(`[data-video-id="${video.id}"]`);
    if (card) {
      card.classList.add('downloading');
      const progressContainer = card.querySelector('.progress-container');
      if (progressContainer) progressContainer.classList.add('active');
    }

    chrome.runtime.sendMessage(
      { action: 'downloadVideo', video, tabId: currentTabId },
      (response) => {
        downloadingIds.delete(video.id);
        if (card) card.classList.remove('downloading');

        if (response && response.error) {
          showError(video.id, response.error);
        } else if (response && response.demuxed) {
          // Demuxed HLS: video and audio saved as separate files
          showInfo(video.id, response.message || 'Saved as separate video + audio files');
        } else if (response && response.warning) {
          showInfo(video.id, response.warning);
        } else {
          // Download started
          if (card) {
            const progressContainer = card.querySelector('.progress-container');
            if (progressContainer) {
              progressContainer.classList.remove('active');
            }
          }
        }
      }
    );
  }

  function downloadAll() {
    for (const video of videos) {
      downloadVideo(video);
    }
  }

  // ── Progress ───────────────────────────────────────────────────────────

  function updateProgress(videoId, percent, current, total) {
    const fill = document.getElementById(`progress-fill-${videoId}`);
    const text = document.getElementById(`progress-text-${videoId}`);
    const container = document.getElementById(`progress-${videoId}`);

    if (fill) fill.style.width = `${percent}%`;
    if (text) text.textContent = `${percent}% (${current}/${total} segments)`;
    if (container) container.classList.add('active');
  }

  function showError(videoId, message) {
    const text = document.getElementById(`progress-text-${videoId}`);
    const container = document.getElementById(`progress-${videoId}`);
    if (text) {
      text.textContent = `Error: ${message}`;
      text.style.color = '#e94560';
    }
    if (container) container.classList.add('active');
  }

  function showInfo(videoId, message) {
    const fill = document.getElementById(`progress-fill-${videoId}`);
    const text = document.getElementById(`progress-text-${videoId}`);
    const container = document.getElementById(`progress-${videoId}`);
    if (fill) fill.style.width = '100%';
    if (text) {
      text.textContent = message;
      text.style.color = '#64b5f6';
    }
    if (container) container.classList.add('active');
  }

  // ── Clear / Remove ─────────────────────────────────────────────────────

  function removeVideo(videoId) {
    chrome.runtime.sendMessage({
      action: 'removeVideo',
      tabId: currentTabId,
      videoId,
    });
    videos = videos.filter(v => v.id !== videoId);
    render();
  }

  function clearAll() {
    chrome.runtime.sendMessage({ action: 'clearVideos', tabId: currentTabId });
    videos = [];
    render();
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function truncate(str, max) {
    return str.length > max ? str.substring(0, max) + '...' : str;
  }

  function simplifyMime(mime) {
    return mime.split(';')[0].replace('video/', '').replace('audio/', '').replace('application/', '');
  }

  // ── Start ──────────────────────────────────────────────────────────────

  init();

})();
