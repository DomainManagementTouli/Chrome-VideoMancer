/**
 * VideoMancer - Background Service Worker
 * Intercepts network requests to detect video streams (MP4, WebM, HLS, DASH)
 * and manages the detected video registry per tab.
 *
 * Paywall/auth support: captures request headers (cookies, auth tokens, referer)
 * from the original page context and forwards them when downloading HLS/DASH
 * segments, enabling downloads from subscription/paywall sites.
 */

// ── Per-tab video store ──────────────────────────────────────────────────────
// Map<tabId, Map<videoId, VideoEntry>>
const tabVideos = new Map();

// ── Per-tab captured request headers (for authenticated downloads) ───────────
// Map<tabId, { cookies, referer, origin, authorization, customHeaders }>
const tabRequestHeaders = new Map();

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

// ── Capture outgoing request headers for auth-gated streams ──────────────────
// When the browser sends a request for a video resource, it includes cookies,
// auth tokens, and referer. We capture these so we can re-use them when
// downloading HLS/DASH segments from the service worker.
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const url = details.url;

    const isStream = HLS_PATTERNS.test(url) || DASH_PATTERNS.test(url)
      || VIDEO_EXTENSIONS.test(url) || /\.(ts|fmp4|m4s|m4f|m4v|mp4|cmfv|cmfa)(\?|$)/i.test(url);
    if (!isStream) return;

    const captured = {};
    if (details.requestHeaders) {
      for (const h of details.requestHeaders) {
        const name = h.name.toLowerCase();
        if (name === 'cookie') captured.cookie = h.value;
        if (name === 'authorization') captured.authorization = h.value;
        if (name === 'referer') captured.referer = h.value;
        if (name === 'origin') captured.origin = h.value;
        // Capture custom tokens often used by CDNs
        if (name.startsWith('x-') || name === 'range') {
          if (!captured.custom) captured.custom = {};
          captured.custom[h.name] = h.value;
        }
      }
    }

    // Also capture the page URL as referer fallback
    if (!captured.referer) {
      try {
        const urlObj = new URL(url);
        captured.referer = urlObj.origin + '/';
      } catch { /* ignore */ }
    }

    // Merge with existing (don't overwrite if we already have richer data)
    const existing = tabRequestHeaders.get(details.tabId) || {};
    tabRequestHeaders.set(details.tabId, { ...existing, ...captured });
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders']
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
  tabRequestHeaders.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    tabVideos.delete(tabId);
    tabRequestHeaders.delete(tabId);
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

  // Get available qualities for HLS (with auth)
  getHLSQualities: async (msg) => {
    try {
      const tabId = msg.tabId;
      if (tabId) await ensureAuthHeaders(tabId, msg.url);
      const response = tabId
        ? await authenticatedFetch(msg.url, tabId)
        : await fetch(msg.url);
      const text = await response.text();
      return { qualities: parseM3U8Master(text, msg.url) };
    } catch (err) {
      return { error: err.message };
    }
  },

  // Get available qualities for DASH (with auth)
  getDASHQualities: async (msg) => {
    try {
      const tabId = msg.tabId;
      if (tabId) await ensureAuthHeaders(tabId, msg.url);
      const response = tabId
        ? await authenticatedFetch(msg.url, tabId)
        : await fetch(msg.url);
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

/**
 * Build fetch options with captured auth headers from the original page session.
 * This is the KEY mechanism for paywall/subscription site support:
 * - Forwards cookies so CDN thinks request comes from authenticated session
 * - Forwards Authorization headers (Bearer tokens, Basic auth, etc.)
 * - Forwards Referer so CDN doesn't reject the request as hotlinking
 * - Forwards Origin for CORS-protected streams
 * - Forwards custom X-* headers that CDNs use for token validation
 */
function buildAuthHeaders(tabId, targetUrl) {
  const captured = tabRequestHeaders.get(tabId) || {};
  const headers = {};

  // Forward cookie for same-origin and same-domain segment requests
  if (captured.cookie) {
    headers['Cookie'] = captured.cookie;
  }

  // Forward authorization (Bearer/Basic tokens used by APIs like Wondrium, Udemy, etc.)
  if (captured.authorization) {
    headers['Authorization'] = captured.authorization;
  }

  // Forward referer (CDNs like Akamai/CloudFront check this to prevent hotlinking)
  if (captured.referer) {
    headers['Referer'] = captured.referer;
  }

  // Forward origin for CORS
  if (captured.origin) {
    headers['Origin'] = captured.origin;
  }

  // Forward custom CDN token headers (e.g., x-playback-session-id, x-custom-token)
  if (captured.custom) {
    for (const [name, value] of Object.entries(captured.custom)) {
      if (name.toLowerCase() !== 'range') { // don't forward range headers
        headers[name] = value;
      }
    }
  }

  return headers;
}

/**
 * Fetch with authentication — wraps fetch() with captured headers.
 * Falls back to unauthenticated fetch if authenticated request fails.
 */
async function authenticatedFetch(url, tabId, extraOpts = {}) {
  const authHeaders = buildAuthHeaders(tabId, url);
  const hasAuth = Object.keys(authHeaders).length > 0;

  const fetchOpts = {
    ...extraOpts,
    headers: { ...authHeaders, ...(extraOpts.headers || {}) },
    credentials: 'include', // include cookies for same-origin requests
  };

  try {
    const resp = await fetch(url, fetchOpts);
    if (resp.ok) return resp;

    // If auth fetch got 403/401, try without auth headers (the URL itself may have tokens)
    if (hasAuth && (resp.status === 403 || resp.status === 401)) {
      return await fetch(url, { credentials: 'include' });
    }
    return resp;
  } catch (err) {
    // If authenticated fetch threw a network error (CORS), retry without custom headers
    if (hasAuth) {
      return await fetch(url, { credentials: 'include' });
    }
    throw err;
  }
}

/**
 * Get cookies from chrome.cookies API for a specific URL.
 * Used as a fallback when we didn't capture headers from webRequest.
 */
async function getCookiesForUrl(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (cookies.length === 0) return null;
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  } catch {
    return null;
  }
}

/**
 * Ensure we have auth headers for a tab. If webRequest didn't capture them,
 * fall back to the chrome.cookies API.
 */
async function ensureAuthHeaders(tabId, url) {
  const existing = tabRequestHeaders.get(tabId);
  if (existing && existing.cookie) return; // already have cookies

  const cookieStr = await getCookiesForUrl(url);
  if (cookieStr) {
    const current = tabRequestHeaders.get(tabId) || {};
    tabRequestHeaders.set(tabId, { ...current, cookie: cookieStr });
  }

  // Also set referer from the video URL's origin
  if (!existing?.referer) {
    try {
      const current = tabRequestHeaders.get(tabId) || {};
      const tab = await chrome.tabs.get(tabId);
      if (tab?.url) {
        tabRequestHeaders.set(tabId, { ...current, referer: tab.url });
      }
    } catch { /* tab may not exist */ }
  }
}

async function downloadDirect(video, tabId) {
  const filename = sanitizeFilename(video.filename || 'video.mp4');

  // For direct downloads, chrome.downloads will send cookies automatically
  // if the user is authenticated in the browser session
  const downloadId = await chrome.downloads.download({
    url: video.url,
    filename: filename,
    saveAs: true,
  });

  return { ok: true, downloadId };
}

async function downloadHLS(video, tabId) {
  // Ensure we have auth headers before starting
  await ensureAuthHeaders(tabId, video.url);

  // First fetch the m3u8 with authentication
  const response = await authenticatedFetch(video.url, tabId);
  if (!response.ok) return { error: `Failed to fetch manifest: HTTP ${response.status}` };
  const content = await response.text();
  const qualities = parseM3U8Master(content, video.url);

  if (qualities.length > 0) {
    // It's a master playlist - use the best quality or user-selected
    const selected = video.selectedQuality
      ? qualities.find(q => q.url === video.selectedQuality)
      : qualities[0];

    if (!selected) return { error: 'Quality not found' };

    // Fetch the media playlist with authentication
    const mediaResp = await authenticatedFetch(selected.url, tabId);
    if (!mediaResp.ok) return { error: `Failed to fetch media playlist: HTTP ${mediaResp.status}` };
    const mediaContent = await mediaResp.text();
    return await downloadHLSSegments(mediaContent, selected.url, video, tabId);
  }

  // It's already a media playlist
  return await downloadHLSSegments(content, video.url, video, tabId);
}

async function downloadHLSSegments(content, baseUrl, video, tabId) {
  const segments = parseM3U8Segments(content, baseUrl);
  if (segments.length === 0) return { error: 'No segments found' };

  // Parse encryption key if present (many paywall sites use AES-128 encrypted HLS)
  const keyInfo = parseM3U8Key(content, baseUrl);

  let decryptionKey = null;
  if (keyInfo && keyInfo.uri) {
    try {
      const keyResp = await authenticatedFetch(keyInfo.uri, tabId);
      if (keyResp.ok) {
        decryptionKey = await keyResp.arrayBuffer();
      }
    } catch { /* decryption not available */ }
  }

  // Notify progress
  broadcastProgress(video.id, 0, segments.length);

  const chunks = [];
  const batchSize = settings.maxConcurrentDownloads || 3;
  let failureCount = 0;

  for (let i = 0; i < segments.length; i += batchSize) {
    const batch = segments.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (seg) => {
        // Each segment request uses authenticated fetch with cookies/tokens
        const resp = await authenticatedFetch(seg.url, tabId);
        if (!resp.ok) {
          failureCount++;
          if (failureCount > 5) throw new Error(`Too many segment failures (${resp.status})`);
          return null; // skip this segment
        }
        let data = await resp.arrayBuffer();

        // If HLS uses AES-128 encryption, decrypt segment
        if (decryptionKey && keyInfo) {
          data = await decryptSegment(data, decryptionKey, keyInfo.iv, i + batch.indexOf(seg));
        }

        return data;
      })
    );
    chunks.push(...results.filter(Boolean));
    broadcastProgress(video.id, Math.min(i + batchSize, segments.length), segments.length);
  }

  if (chunks.length === 0) return { error: 'No segments downloaded — authentication may have expired' };

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
  // Ensure we have auth headers before starting
  await ensureAuthHeaders(tabId, video.url);

  const response = await authenticatedFetch(video.url, tabId);
  if (!response.ok) return { error: `Failed to fetch MPD: HTTP ${response.status}` };
  const content = await response.text();
  const qualities = parseMPD(content, video.url);

  if (qualities.length === 0) return { error: 'No representations found in DASH manifest' };

  // If a specific representation URL is given, download it directly
  if (video.selectedQuality) {
    const selected = qualities.find(q => q.url === video.selectedQuality || q.id === video.selectedQuality);
    if (selected && selected.url && selected.url !== video.url) {
      return await downloadDirect({ ...video, url: selected.url, filename: video.filename }, tabId);
    }

    // Handle SegmentTemplate-based DASH
    if (selected && selected.segmentTemplate) {
      return await downloadDASHSegments(selected, video, tabId);
    }
  }

  // Default: download best quality
  const best = qualities.find(q => q.isVideo && q.url && q.url !== video.url) || qualities[0];
  if (best && best.url && best.url !== video.url) {
    return await downloadDirect({ ...video, url: best.url }, tabId);
  }

  if (best && best.segmentTemplate) {
    return await downloadDASHSegments(best, video, tabId);
  }

  return { error: 'Could not resolve DASH segments' };
}

async function downloadDASHSegments(representation, video, tabId) {
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

  // Download init segment if available (with auth)
  if (tmpl.initialization) {
    const initUrl = resolveUrl(
      video.url,
      tmpl.initialization.replace('$RepresentationID$', representation.id)
    );
    try {
      const resp = await authenticatedFetch(initUrl, tabId);
      if (resp.ok) chunks.push(await resp.arrayBuffer());
    } catch { /* optional */ }
  }

  let downloadedCount = 0;
  for (let i = 0; i < segments.length; i += batchSize) {
    const batch = segments.slice(i, i + batchSize);
    try {
      const results = await Promise.all(
        batch.map(async (url) => {
          const resp = await authenticatedFetch(url, tabId);
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

// ── HLS AES-128 Decryption ───────────────────────────────────────────────────
// Many paywall sites (Wondrium, Udemy, Pluralsight, etc.) encrypt HLS segments
// with AES-128-CBC. We parse the #EXT-X-KEY tag and decrypt each segment.

function parseM3U8Key(content, baseUrl) {
  const keyMatch = content.match(/#EXT-X-KEY:METHOD=AES-128,URI="([^"]+)"(?:,IV=0x([0-9a-fA-F]+))?/);
  if (!keyMatch) return null;
  return {
    method: 'AES-128',
    uri: resolveUrl(baseUrl, keyMatch[1]),
    iv: keyMatch[2] || null, // null = use segment sequence number
  };
}

async function decryptSegment(encryptedData, keyBuffer, ivHex, segmentIndex) {
  try {
    const key = await crypto.subtle.importKey(
      'raw', keyBuffer, { name: 'AES-CBC' }, false, ['decrypt']
    );

    // IV: use explicit IV if provided, otherwise use segment index (per HLS spec)
    let iv;
    if (ivHex) {
      iv = new Uint8Array(ivHex.match(/.{2}/g).map(b => parseInt(b, 16)));
    } else {
      iv = new Uint8Array(16);
      const view = new DataView(iv.buffer);
      view.setUint32(12, segmentIndex); // big-endian segment number as IV
    }

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv }, key, encryptedData
    );

    return decrypted;
  } catch {
    // If decryption fails, return original data (may be unencrypted or different cipher)
    return encryptedData;
  }
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
