/**
 * VideoMancer - Background Service Worker
 * Intercepts network requests to detect video streams (MP4, WebM, HLS, DASH)
 * and manages the detected video registry per tab.
 */

// ── Per-tab video store ──────────────────────────────────────────────────────
// Map<tabId, Map<videoId, VideoEntry>>
const tabVideos = new Map();

// Video entry structure:
// { id, url, type, quality, size, filename, pageUrl, pageTitle, timestamp, headers }

const VIDEO_EXTENSIONS = /\.(mp4|webm|mkv|avi|mov|flv|wmv|m4v|3gp|ogv|ts)(\?|$)/i;
const VIDEO_MIMETYPES = /^(video\/|application\/x-mpegurl|application\/vnd\.apple\.mpegurl|application\/dash\+xml|application\/octet-stream)/i;
const HLS_PATTERNS = /\.(m3u8|m3u)(\?|$)/i;
const DASH_PATTERNS = /\.(mpd)(\?|$)/i;
const AUDIO_EXTENSIONS = /\.(mp3|aac|ogg|wav|flac|m4a|opus|wma)(\?|$)/i;

// Minimum size in bytes to consider (filters out tiny tracking pixels etc.)
const MIN_VIDEO_SIZE = 100 * 1024; // 100KB

// ── Settings ─────────────────────────────────────────────────────────────────
let settings = {
  blacklistedDomains: [],
  minSize: MIN_VIDEO_SIZE,
  autoDetect: true,
  showNotifications: true,
  maxConcurrentDownloads: 3,
  preferredQuality: 'highest',
  filenameTemplate: '{title} - {quality}',
};

chrome.storage.sync.get('settings', (result) => {
  if (result.settings) {
    settings = { ...settings, ...result.settings };
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) {
    settings = { ...settings, ...changes.settings.newValue };
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function extractFilename(url) {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split('/');
    const last = parts[parts.length - 1];
    if (last && last.includes('.')) {
      return decodeURIComponent(last.split('?')[0]);
    }
  } catch (e) { /* ignore */ }
  return null;
}

function guessQuality(url, headers = {}) {
  const str = url + ' ' + JSON.stringify(headers);
  if (/2160|4k|uhd/i.test(str)) return '2160p';
  if (/1440|2k/i.test(str)) return '1440p';
  if (/1080|fhd|full.?hd/i.test(str)) return '1080p';
  if (/720|hd(?!s)/i.test(str)) return '720p';
  if (/480|sd/i.test(str)) return '480p';
  if (/360/i.test(str)) return '360p';
  if (/240/i.test(str)) return '240p';
  if (/144/i.test(str)) return '144p';
  return 'Unknown';
}

function classifyType(url, contentType = '') {
  if (HLS_PATTERNS.test(url) || /mpegurl/i.test(contentType)) return 'hls';
  if (DASH_PATTERNS.test(url) || /dash\+xml/i.test(contentType)) return 'dash';
  if (AUDIO_EXTENSIONS.test(url) || /^audio\//i.test(contentType)) return 'audio';
  return 'direct';
}

function isBlacklisted(url) {
  try {
    const hostname = new URL(url).hostname;
    return settings.blacklistedDomains.some(d => hostname.includes(d));
  } catch {
    return false;
  }
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(1)} ${units[i]}`;
}

function getVideosForTab(tabId) {
  if (!tabVideos.has(tabId)) {
    tabVideos.set(tabId, new Map());
  }
  return tabVideos.get(tabId);
}

// ── Badge Management ─────────────────────────────────────────────────────────

function updateBadge(tabId) {
  const videos = tabVideos.get(tabId);
  const count = videos ? videos.size : 0;

  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count), tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#e53935', tabId });
    chrome.action.setTitle({ title: `VideoMancer - ${count} video(s) detected`, tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
    chrome.action.setTitle({ title: 'VideoMancer - No videos detected', tabId });
  }
}

// ── Register a detected video ────────────────────────────────────────────────

function registerVideo(tabId, videoInfo) {
  if (!settings.autoDetect) return;
  if (isBlacklisted(videoInfo.url)) return;

  const videos = getVideosForTab(tabId);

  // Deduplicate by URL (ignore query string variations for m3u8/mpd)
  const normalizedUrl = videoInfo.type === 'hls' || videoInfo.type === 'dash'
    ? videoInfo.url.split('?')[0]
    : videoInfo.url;

  for (const [, existing] of videos) {
    const existingNorm = existing.type === 'hls' || existing.type === 'dash'
      ? existing.url.split('?')[0]
      : existing.url;
    if (existingNorm === normalizedUrl) return;
  }

  const entry = {
    id: generateId(),
    url: videoInfo.url,
    type: videoInfo.type || classifyType(videoInfo.url, videoInfo.contentType),
    quality: videoInfo.quality || guessQuality(videoInfo.url, videoInfo.headers),
    size: videoInfo.size || 0,
    sizeFormatted: formatSize(videoInfo.size || 0),
    filename: videoInfo.filename || extractFilename(videoInfo.url) || 'video',
    pageUrl: videoInfo.pageUrl || '',
    pageTitle: videoInfo.pageTitle || '',
    contentType: videoInfo.contentType || '',
    timestamp: Date.now(),
    headers: videoInfo.headers || {},
    duration: videoInfo.duration || null,
    resolution: videoInfo.resolution || null,
  };

  videos.set(entry.id, entry);
  updateBadge(tabId);

  // Notify popup if open
  chrome.runtime.sendMessage({
    action: 'videoDetected',
    tabId,
    video: entry,
  }).catch(() => { /* popup not open */ });

  if (settings.showNotifications && videos.size === 1) {
    chrome.notifications.create(`vm-${tabId}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'VideoMancer',
      message: `Video detected: ${entry.filename}`,
    });
  }
}

// ── Network Request Interception ─────────────────────────────────────────────

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return; // background requests
    if (details.type === 'main_frame') return;

    const url = details.url;
    const headers = {};
    let contentType = '';
    let contentLength = 0;

    if (details.responseHeaders) {
      for (const h of details.responseHeaders) {
        const name = h.name.toLowerCase();
        headers[name] = h.value;
        if (name === 'content-type') contentType = h.value || '';
        if (name === 'content-length') contentLength = parseInt(h.value, 10) || 0;
      }
    }

    // Check if this looks like a video resource
    const isVideoUrl = VIDEO_EXTENSIONS.test(url);
    const isVideoMime = VIDEO_MIMETYPES.test(contentType);
    const isHls = HLS_PATTERNS.test(url) || /mpegurl/i.test(contentType);
    const isDash = DASH_PATTERNS.test(url) || /dash\+xml/i.test(contentType);
    const isAudio = AUDIO_EXTENSIONS.test(url) || /^audio\//i.test(contentType);

    if (!isVideoUrl && !isVideoMime && !isHls && !isDash && !isAudio) return;

    // For direct videos, apply minimum size filter
    if (!isHls && !isDash && contentLength > 0 && contentLength < settings.minSize) return;

    // Filter out known ad/tracking domains
    const adPatterns = /doubleclick|googlesyndication|adservice|analytics|tracking|pixel|beacon/i;
    if (adPatterns.test(url)) return;

    registerVideo(details.tabId, {
      url,
      contentType,
      size: contentLength,
      headers,
      type: isHls ? 'hls' : isDash ? 'dash' : isAudio ? 'audio' : 'direct',
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Also monitor requests by URL pattern for HLS/DASH that may not have proper content-type
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const url = details.url;

    if (HLS_PATTERNS.test(url)) {
      registerVideo(details.tabId, { url, type: 'hls' });
    } else if (DASH_PATTERNS.test(url)) {
      registerVideo(details.tabId, { url, type: 'dash' });
    }
  },
  { urls: ['*://*/*.m3u8*', '*://*/*.m3u*', '*://*/*.mpd*'] }
);

// ── Tab lifecycle ────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  tabVideos.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    tabVideos.delete(tabId);
    updateBadge(tabId);
  }
});

// ── Message handling ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = messageHandlers[message.action];
  if (handler) {
    const result = handler(message, sender);
    if (result instanceof Promise) {
      result.then(sendResponse).catch(err => sendResponse({ error: err.message }));
      return true; // async
    }
    sendResponse(result);
  }
  return false;
});

const messageHandlers = {

  // Get all videos for a tab
  getVideos: (msg) => {
    const tabId = msg.tabId;
    const videos = tabVideos.get(tabId);
    if (!videos) return { videos: [] };
    return { videos: Array.from(videos.values()).sort((a, b) => b.timestamp - a.timestamp) };
  },

  // Register video from content script
  registerVideo: (msg, sender) => {
    const tabId = sender.tab?.id ?? msg.tabId;
    if (tabId == null) return;
    registerVideo(tabId, msg.video);
    return { ok: true };
  },

  // Download a video
  downloadVideo: async (msg) => {
    const { video, tabId } = msg;
    if (!video) return { error: 'No video specified' };

    try {
      if (video.type === 'hls') {
        return await downloadHLS(video, tabId);
      } else if (video.type === 'dash') {
        return await downloadDASH(video, tabId);
      } else {
        return await downloadDirect(video);
      }
    } catch (err) {
      return { error: err.message };
    }
  },

  // Get available qualities for HLS
  getHLSQualities: async (msg) => {
    try {
      const response = await fetch(msg.url);
      const text = await response.text();
      return { qualities: parseM3U8Master(text, msg.url) };
    } catch (err) {
      return { error: err.message };
    }
  },

  // Get available qualities for DASH
  getDASHQualities: async (msg) => {
    try {
      const response = await fetch(msg.url);
      const text = await response.text();
      return { qualities: parseMPD(text, msg.url) };
    } catch (err) {
      return { error: err.message };
    }
  },

  // Get settings
  getSettings: () => {
    return { settings };
  },

  // Clear videos for tab
  clearVideos: (msg) => {
    tabVideos.delete(msg.tabId);
    updateBadge(msg.tabId);
    return { ok: true };
  },

  // Remove a single video entry
  removeVideo: (msg) => {
    const videos = tabVideos.get(msg.tabId);
    if (videos) {
      videos.delete(msg.videoId);
      updateBadge(msg.tabId);
    }
    return { ok: true };
  },
};

// ── HLS Parsing ──────────────────────────────────────────────────────────────

function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

function parseM3U8Master(content, baseUrl) {
  const lines = content.split('\n').map(l => l.trim());
  const qualities = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = line.substring('#EXT-X-STREAM-INF:'.length);
      const bwMatch = attrs.match(/BANDWIDTH=(\d+)/);
      const resMatch = attrs.match(/RESOLUTION=(\d+x\d+)/);
      const nameMatch = attrs.match(/NAME="([^"]+)"/);

      // Next non-comment line is the URL
      let urlLine = '';
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] && !lines[j].startsWith('#')) {
          urlLine = lines[j];
          break;
        }
      }

      if (urlLine) {
        const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
        const resolution = resMatch ? resMatch[1] : null;
        const height = resolution ? parseInt(resolution.split('x')[1], 10) : 0;

        qualities.push({
          url: resolveUrl(baseUrl, urlLine),
          bandwidth,
          resolution,
          height,
          label: nameMatch ? nameMatch[1] : (height ? `${height}p` : `${Math.round(bandwidth / 1000)}kbps`),
        });
      }
    }
  }

  // Sort by bandwidth descending
  qualities.sort((a, b) => b.bandwidth - a.bandwidth);
  return qualities;
}

function parseM3U8Segments(content, baseUrl) {
  const lines = content.split('\n').map(l => l.trim());
  const segments = [];
  let currentDuration = 0;

  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      currentDuration = parseFloat(line.split(':')[1]);
    } else if (line && !line.startsWith('#')) {
      segments.push({
        url: resolveUrl(baseUrl, line),
        duration: currentDuration,
      });
      currentDuration = 0;
    }
  }

  return segments;
}

// ── DASH Parsing ─────────────────────────────────────────────────────────────

function parseMPD(content, baseUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(content, 'application/xml');
  const qualities = [];

  const adaptationSets = doc.querySelectorAll('AdaptationSet');
  for (const as of adaptationSets) {
    const mimeType = as.getAttribute('mimeType') || '';
    const isVideo = mimeType.startsWith('video') || as.getAttribute('contentType') === 'video';
    const isAudio = mimeType.startsWith('audio') || as.getAttribute('contentType') === 'audio';

    const representations = as.querySelectorAll('Representation');
    for (const rep of representations) {
      const bandwidth = parseInt(rep.getAttribute('bandwidth') || '0', 10);
      const width = parseInt(rep.getAttribute('width') || '0', 10);
      const height = parseInt(rep.getAttribute('height') || '0', 10);
      const codecs = rep.getAttribute('codecs') || as.getAttribute('codecs') || '';
      const id = rep.getAttribute('id') || '';

      // Get base URL for this representation
      const repBaseUrl = rep.querySelector('BaseURL');
      const asBaseUrl = as.querySelector('BaseURL');
      const periodBaseUrl = doc.querySelector('Period > BaseURL');

      let segmentUrl = '';
      if (repBaseUrl) segmentUrl = resolveUrl(baseUrl, repBaseUrl.textContent.trim());
      else if (asBaseUrl) segmentUrl = resolveUrl(baseUrl, asBaseUrl.textContent.trim());
      else if (periodBaseUrl) segmentUrl = resolveUrl(baseUrl, periodBaseUrl.textContent.trim());

      // Check for SegmentTemplate
      const segTemplate = rep.querySelector('SegmentTemplate') || as.querySelector('SegmentTemplate');

      qualities.push({
        id,
        url: segmentUrl || baseUrl,
        bandwidth,
        width,
        height,
        resolution: width && height ? `${width}x${height}` : null,
        codecs,
        mimeType: rep.getAttribute('mimeType') || mimeType,
        isVideo,
        isAudio,
        label: isVideo
          ? (height ? `${height}p (${codecs})` : `${Math.round(bandwidth / 1000)}kbps`)
          : `Audio ${Math.round(bandwidth / 1000)}kbps (${codecs})`,
        segmentTemplate: segTemplate ? {
          initialization: segTemplate.getAttribute('initialization'),
          media: segTemplate.getAttribute('media'),
          startNumber: parseInt(segTemplate.getAttribute('startNumber') || '1', 10),
          timescale: parseInt(segTemplate.getAttribute('timescale') || '1', 10),
          duration: parseInt(segTemplate.getAttribute('duration') || '0', 10),
        } : null,
      });
    }
  }

  qualities.sort((a, b) => b.bandwidth - a.bandwidth);
  return qualities;
}

// ── Download Functions ───────────────────────────────────────────────────────

async function downloadDirect(video) {
  const filename = sanitizeFilename(video.filename || 'video.mp4');

  const downloadId = await chrome.downloads.download({
    url: video.url,
    filename: filename,
    saveAs: true,
  });

  return { ok: true, downloadId };
}

async function downloadHLS(video, tabId) {
  // First fetch the m3u8 to check if it's a master or media playlist
  const response = await fetch(video.url);
  const content = await response.text();
  const qualities = parseM3U8Master(content, video.url);

  if (qualities.length > 0) {
    // It's a master playlist - use the best quality or user-selected
    const selected = video.selectedQuality
      ? qualities.find(q => q.url === video.selectedQuality)
      : qualities[0];

    if (!selected) return { error: 'Quality not found' };

    // Fetch the media playlist
    const mediaResp = await fetch(selected.url);
    const mediaContent = await mediaResp.text();
    return await downloadHLSSegments(mediaContent, selected.url, video);
  }

  // It's already a media playlist
  return await downloadHLSSegments(content, video.url, video);
}

async function downloadHLSSegments(content, baseUrl, video) {
  const segments = parseM3U8Segments(content, baseUrl);
  if (segments.length === 0) return { error: 'No segments found' };

  // Notify progress
  broadcastProgress(video.id, 0, segments.length);

  const chunks = [];
  const batchSize = settings.maxConcurrentDownloads || 3;

  for (let i = 0; i < segments.length; i += batchSize) {
    const batch = segments.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (seg) => {
        const resp = await fetch(seg.url);
        if (!resp.ok) throw new Error(`Failed to fetch segment: ${resp.status}`);
        return await resp.arrayBuffer();
      })
    );
    chunks.push(...results);
    broadcastProgress(video.id, Math.min(i + batchSize, segments.length), segments.length);
  }

  // Merge all segments into one blob
  const merged = new Blob(chunks, { type: 'video/mp2t' });
  const blobUrl = URL.createObjectURL(merged);

  const filename = sanitizeFilename(
    (video.filename || 'video').replace(/\.(m3u8?|ts)$/i, '') + '.ts'
  );

  const downloadId = await chrome.downloads.download({
    url: blobUrl,
    filename: filename,
    saveAs: true,
  });

  // Clean up blob URL after download starts
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);

  return { ok: true, downloadId, segmentCount: segments.length };
}

async function downloadDASH(video, tabId) {
  // For DASH, we download the selected representation directly
  // A full implementation would merge segments; here we provide the manifest URL
  // and let the user pick a representation

  const response = await fetch(video.url);
  const content = await response.text();
  const qualities = parseMPD(content, video.url);

  if (qualities.length === 0) return { error: 'No representations found in DASH manifest' };

  // If a specific representation URL is given, download it directly
  if (video.selectedQuality) {
    const selected = qualities.find(q => q.url === video.selectedQuality || q.id === video.selectedQuality);
    if (selected && selected.url && selected.url !== video.url) {
      return await downloadDirect({ ...video, url: selected.url, filename: video.filename });
    }

    // Handle SegmentTemplate-based DASH
    if (selected && selected.segmentTemplate) {
      return await downloadDASHSegments(selected, video);
    }
  }

  // Default: download best quality
  const best = qualities.find(q => q.isVideo && q.url && q.url !== video.url) || qualities[0];
  if (best && best.url && best.url !== video.url) {
    return await downloadDirect({ ...video, url: best.url });
  }

  if (best && best.segmentTemplate) {
    return await downloadDASHSegments(best, video);
  }

  return { error: 'Could not resolve DASH segments' };
}

async function downloadDASHSegments(representation, video) {
  const tmpl = representation.segmentTemplate;
  if (!tmpl || !tmpl.media) return { error: 'No segment template' };

  const segments = [];
  const segmentDuration = tmpl.duration / tmpl.timescale;
  // Estimate segment count (assume 2 hour max)
  const maxSegments = Math.ceil(7200 / segmentDuration);

  for (let num = tmpl.startNumber; num < tmpl.startNumber + maxSegments; num++) {
    const segUrl = resolveUrl(
      video.url,
      tmpl.media.replace('$Number$', num).replace('$RepresentationID$', representation.id)
    );
    segments.push(segUrl);
  }

  const chunks = [];
  const batchSize = settings.maxConcurrentDownloads || 3;

  // Download init segment if available
  if (tmpl.initialization) {
    const initUrl = resolveUrl(
      video.url,
      tmpl.initialization.replace('$RepresentationID$', representation.id)
    );
    try {
      const resp = await fetch(initUrl);
      if (resp.ok) chunks.push(await resp.arrayBuffer());
    } catch { /* optional */ }
  }

  let downloadedCount = 0;
  for (let i = 0; i < segments.length; i += batchSize) {
    const batch = segments.slice(i, i + batchSize);
    try {
      const results = await Promise.all(
        batch.map(async (url) => {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error('Segment 404');
          return await resp.arrayBuffer();
        })
      );
      chunks.push(...results);
      downloadedCount += results.length;
      broadcastProgress(video.id, downloadedCount, segments.length);
    } catch {
      // Likely we've hit the end of segments
      break;
    }
  }

  if (chunks.length === 0) return { error: 'No DASH segments downloaded' };

  const merged = new Blob(chunks, { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(merged);

  const filename = sanitizeFilename(
    (video.filename || 'video').replace(/\.(mpd|mp4)$/i, '') + '.mp4'
  );

  const downloadId = await chrome.downloads.download({
    url: blobUrl,
    filename: filename,
    saveAs: true,
  });

  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  return { ok: true, downloadId, segmentCount: chunks.length };
}

function broadcastProgress(videoId, current, total) {
  chrome.runtime.sendMessage({
    action: 'downloadProgress',
    videoId,
    current,
    total,
    percent: Math.round((current / total) * 100),
  }).catch(() => { /* popup may not be open */ });
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200);
}

// ── Context menu ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'videomancer-download',
    title: 'Download video with VideoMancer',
    contexts: ['video', 'link'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'videomancer-download') {
    const url = info.srcUrl || info.linkUrl;
    if (url) {
      registerVideo(tab.id, {
        url,
        pageUrl: info.pageUrl,
        pageTitle: tab.title,
        type: classifyType(url),
      });
      // Also trigger download directly
      downloadDirect({ url, filename: extractFilename(url) || 'video.mp4' });
    }
  }
});

// ── Keep service worker alive during downloads ──────────────────────────────

let keepAliveInterval = null;

function startKeepAlive() {
  if (!keepAliveInterval) {
    keepAliveInterval = setInterval(() => {
      // Ping to keep service worker alive
    }, 20000);
  }
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state) {
    if (delta.state.current === 'in_progress') {
      startKeepAlive();
    } else {
      stopKeepAlive();
    }
  }
});
