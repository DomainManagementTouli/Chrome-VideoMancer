/**
 * VideoMancer - Content Script
 * Detects video elements in the DOM, intercepts blob URLs,
 * monitors dynamic media loading, and captures MediaSource/MSE streams.
 */

(function () {
  'use strict';

  if (window.__videoMancerInjected) return;
  window.__videoMancerInjected = true;

  // ── Configuration ────────────────────────────────────────────────────────

  const SCAN_INTERVAL = 2000; // ms between DOM scans
  const detectedUrls = new Set();

  // ── Utility ──────────────────────────────────────────────────────────────

  function sendToBackground(video) {
    chrome.runtime.sendMessage({
      action: 'registerVideo',
      video: {
        ...video,
        pageUrl: window.location.href,
        pageTitle: document.title,
      },
    }).catch(() => { /* extension context may be invalid */ });
  }

  function isVideoUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return /\.(mp4|webm|mkv|avi|mov|flv|m4v|3gp|ogv|ts|m3u8?|mpd)(\?|#|$)/i.test(url);
  }

  function isAudioUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return /\.(mp3|aac|ogg|wav|flac|m4a|opus)(\?|#|$)/i.test(url);
  }

  function classifyUrl(url) {
    if (/\.m3u8?(\?|#|$)/i.test(url)) return 'hls';
    if (/\.mpd(\?|#|$)/i.test(url)) return 'dash';
    if (isAudioUrl(url)) return 'audio';
    return 'direct';
  }

  function registerUrl(url, extra = {}) {
    if (!url || detectedUrls.has(url)) return;
    if (url.startsWith('blob:') && !extra.resolvedUrl) return; // skip raw blobs
    detectedUrls.add(url);
    sendToBackground({
      url,
      type: extra.type || classifyUrl(url),
      quality: extra.quality || null,
      filename: extra.filename || null,
      duration: extra.duration || null,
      resolution: extra.resolution || null,
    });
  }

  // ── DOM Scanner ──────────────────────────────────────────────────────────

  function scanForVideos() {
    // <video> elements
    document.querySelectorAll('video').forEach((video) => {
      // Direct src attribute
      if (video.src && !video.src.startsWith('blob:')) {
        registerUrl(video.src, {
          resolution: video.videoWidth && video.videoHeight
            ? `${video.videoWidth}x${video.videoHeight}`
            : null,
          duration: video.duration && isFinite(video.duration) ? video.duration : null,
        });
      }

      // currentSrc (may differ from src)
      if (video.currentSrc && !video.currentSrc.startsWith('blob:') && video.currentSrc !== video.src) {
        registerUrl(video.currentSrc);
      }

      // <source> children
      video.querySelectorAll('source').forEach((source) => {
        if (source.src && !source.src.startsWith('blob:')) {
          registerUrl(source.src);
        }
      });
    });

    // <audio> elements
    document.querySelectorAll('audio').forEach((audio) => {
      if (audio.src && !audio.src.startsWith('blob:')) {
        registerUrl(audio.src, { type: 'audio' });
      }
      audio.querySelectorAll('source').forEach((source) => {
        if (source.src && !source.src.startsWith('blob:')) {
          registerUrl(source.src, { type: 'audio' });
        }
      });
    });

    // <iframe> - we can't access cross-origin, but note video embeds
    document.querySelectorAll('iframe').forEach((iframe) => {
      const src = iframe.src || iframe.dataset.src;
      if (src && /\.(mp4|webm|m3u8|mpd)/i.test(src)) {
        registerUrl(src);
      }
    });

    // Links pointing to video files
    document.querySelectorAll('a[href]').forEach((a) => {
      if (isVideoUrl(a.href) || isAudioUrl(a.href)) {
        registerUrl(a.href);
      }
    });

    // Open Graph / meta video tags
    document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[name="twitter:player:stream"]').forEach((meta) => {
      const content = meta.getAttribute('content');
      if (content) registerUrl(content);
    });

    // JSON-LD structured data
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      try {
        const data = JSON.parse(script.textContent);
        extractVideoUrlsFromJSON(data);
      } catch { /* ignore parse errors */ }
    });

    // data-* attributes that may contain video URLs
    document.querySelectorAll('[data-video-url], [data-src], [data-video-src], [data-hls], [data-dash], [data-stream-url]').forEach((el) => {
      const attrs = ['data-video-url', 'data-src', 'data-video-src', 'data-hls', 'data-dash', 'data-stream-url'];
      for (const attr of attrs) {
        const val = el.getAttribute(attr);
        if (val && (isVideoUrl(val) || /^https?:\/\//i.test(val))) {
          registerUrl(val);
        }
      }
    });
  }

  function extractVideoUrlsFromJSON(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach(extractVideoUrlsFromJSON);
      return;
    }
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string' && isVideoUrl(value)) {
        registerUrl(value);
      } else if (typeof value === 'string' && key.match(/contentUrl|embedUrl|videoUrl|streamUrl|hlsUrl|dashUrl|mp4Url/i)) {
        registerUrl(value);
      } else if (typeof value === 'object') {
        extractVideoUrlsFromJSON(value);
      }
    }
  }

  // ── MutationObserver for dynamically added elements ──────────────────────

  const observer = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO' || node.tagName === 'SOURCE') {
          shouldScan = true;
          break;
        }
        if (node.querySelector && (node.querySelector('video') || node.querySelector('audio'))) {
          shouldScan = true;
          break;
        }
      }
      if (shouldScan) break;
    }
    if (shouldScan) {
      scanForVideos();
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // ── Inject page-level script for deeper interception ─────────────────────

  function injectPageScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  // Listen for messages from injected page script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    if (event.data && event.data.type === 'VIDEOMANCER_DETECTED') {
      const { url, mediaType, quality, resolution } = event.data;
      if (url && !url.startsWith('blob:')) {
        registerUrl(url, { type: mediaType, quality, resolution });
      }
    }

    // Handle blob video metadata (from MSE/MediaSource interception)
    if (event.data && event.data.type === 'VIDEOMANCER_BLOB_VIDEO') {
      const { blobUrl, resolution, duration, mimeTypes } = event.data;
      // Notify background that a blob-backed video was found with these properties
      // The actual downloadable URLs were already captured via fetch/XHR interception
      chrome.runtime.sendMessage({
        action: 'registerVideo',
        video: {
          url: blobUrl,
          type: 'mse-blob',
          quality: resolution ? (parseInt(resolution.split('x')[1]) + 'p') : null,
          resolution,
          duration,
          filename: document.title || 'video',
          pageUrl: window.location.href,
          pageTitle: document.title,
          mimeTypes,
          isBlobVideo: true,
        },
      }).catch(() => {});
    }
  });

  // ── Initialization ───────────────────────────────────────────────────────

  // Initial scan
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      scanForVideos();
      injectPageScript();
    });
  } else {
    scanForVideos();
    injectPageScript();
  }

  // Periodic re-scan for SPAs and lazy-loaded content
  setInterval(scanForVideos, SCAN_INTERVAL);

  // Also scan after page fully loads (catches late-loading players)
  window.addEventListener('load', () => {
    setTimeout(scanForVideos, 1000);
    setTimeout(scanForVideos, 3000);
  });

})();
