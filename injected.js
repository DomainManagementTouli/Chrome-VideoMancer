/**
 * VideoMancer - Injected Page Script
 * Runs in the page context (not extension context) to intercept:
 * - XMLHttpRequest / fetch for video URLs
 * - MediaSource / SourceBuffer for MSE streams
 * - Video element src assignments
 * - HLS.js / dash.js / video.js player libraries
 */

(function () {
  'use strict';

  if (window.__videoMancerPageInjected) return;
  window.__videoMancerPageInjected = true;

  const detectedUrls = new Set();

  function notify(url, extra = {}) {
    if (!url || detectedUrls.has(url) || url.startsWith('blob:') || url.startsWith('data:')) return;
    detectedUrls.add(url);
    window.postMessage({
      type: 'VIDEOMANCER_DETECTED',
      url: url,
      mediaType: extra.mediaType || null,
      quality: extra.quality || null,
      resolution: extra.resolution || null,
    }, '*');
  }

  function isVideoUrl(url) {
    return /\.(mp4|webm|mkv|m4v|ts|m3u8?|mpd|flv|mov|3gp|ogv)(\?|#|$)/i.test(url);
  }

  function isVideoMimeType(type) {
    return /^(video\/|application\/x-mpegurl|application\/vnd\.apple\.mpegurl|application\/dash\+xml)/i.test(type);
  }

  // ── Intercept fetch() ──────────────────────────────────────────────────

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0]
      : (args[0] instanceof Request ? args[0].url : null);

    if (url && isVideoUrl(url)) {
      try {
        const fullUrl = new URL(url, window.location.href).href;
        notify(fullUrl);
      } catch { /* ignore */ }
    }

    return originalFetch.apply(this, args).then(response => {
      // Check response content-type
      const ct = response.headers.get('content-type') || '';
      if (url && isVideoMimeType(ct)) {
        try {
          const fullUrl = new URL(url, window.location.href).href;
          notify(fullUrl, { mediaType: ct.includes('mpegurl') ? 'hls' : ct.includes('dash') ? 'dash' : 'direct' });
        } catch { /* ignore */ }
      }
      return response;
    });
  };

  // ── Intercept XMLHttpRequest ───────────────────────────────────────────

  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._vmUrl = url;
    if (url && typeof url === 'string' && isVideoUrl(url)) {
      try {
        const fullUrl = new URL(url, window.location.href).href;
        notify(fullUrl);
      } catch { /* ignore */ }
    }
    return originalXHROpen.call(this, method, url, ...rest);
  };

  const originalXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      const ct = this.getResponseHeader('content-type') || '';
      if (this._vmUrl && isVideoMimeType(ct)) {
        try {
          const fullUrl = new URL(this._vmUrl, window.location.href).href;
          notify(fullUrl);
        } catch { /* ignore */ }
      }
    });
    return originalXHRSend.apply(this, args);
  };

  // ── Intercept HTMLMediaElement.src ──────────────────────────────────────

  const videoProto = HTMLVideoElement.prototype;
  const audioProto = HTMLAudioElement.prototype;

  function interceptSrc(proto, tagName) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'src') ||
      Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');

    if (descriptor && descriptor.set) {
      const originalSet = descriptor.set;
      Object.defineProperty(proto, 'src', {
        ...descriptor,
        set(value) {
          if (value && typeof value === 'string' && !value.startsWith('blob:') && !value.startsWith('data:')) {
            try {
              const fullUrl = new URL(value, window.location.href).href;
              notify(fullUrl, { mediaType: isVideoUrl(fullUrl) ? classifyMediaUrl(fullUrl) : null });
            } catch { /* ignore */ }
          }
          return originalSet.call(this, value);
        },
      });
    }
  }

  function classifyMediaUrl(url) {
    if (/\.m3u8?(\?|#|$)/i.test(url)) return 'hls';
    if (/\.mpd(\?|#|$)/i.test(url)) return 'dash';
    return 'direct';
  }

  try { interceptSrc(videoProto, 'VIDEO'); } catch { /* may fail on some browsers */ }
  try { interceptSrc(audioProto, 'AUDIO'); } catch { /* may fail on some browsers */ }

  // ── Intercept HTMLSourceElement.src ─────────────────────────────────────

  const sourceDescriptor = Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, 'src');
  if (sourceDescriptor && sourceDescriptor.set) {
    const originalSourceSet = sourceDescriptor.set;
    Object.defineProperty(HTMLSourceElement.prototype, 'src', {
      ...sourceDescriptor,
      set(value) {
        if (value && typeof value === 'string' && !value.startsWith('blob:') && !value.startsWith('data:')) {
          try {
            const fullUrl = new URL(value, window.location.href).href;
            if (isVideoUrl(fullUrl)) {
              notify(fullUrl);
            }
          } catch { /* ignore */ }
        }
        return originalSourceSet.call(this, value);
      },
    });
  }

  // ── Monitor HLS.js instances ───────────────────────────────────────────

  // HLS.js stores manifest URLs that we can intercept
  const checkHlsJs = setInterval(() => {
    if (typeof window.Hls === 'function') {
      const OrigHls = window.Hls;
      const origLoadSource = OrigHls.prototype.loadSource;
      if (origLoadSource) {
        OrigHls.prototype.loadSource = function (src) {
          if (src && typeof src === 'string') {
            try {
              const fullUrl = new URL(src, window.location.href).href;
              notify(fullUrl, { mediaType: 'hls' });
            } catch { /* ignore */ }
          }
          return origLoadSource.call(this, src);
        };
      }
      clearInterval(checkHlsJs);
    }
  }, 500);
  setTimeout(() => clearInterval(checkHlsJs), 30000);

  // ── Monitor dash.js instances ──────────────────────────────────────────

  const checkDashJs = setInterval(() => {
    if (typeof window.dashjs !== 'undefined' && window.dashjs.MediaPlayer) {
      const origCreate = window.dashjs.MediaPlayer().create;
      if (origCreate) {
        const origInit = origCreate.prototype?.initialize;
        // Dash.js detection through attach source
      }
      clearInterval(checkDashJs);
    }
  }, 500);
  setTimeout(() => clearInterval(checkDashJs), 30000);

  // ── Scan inline scripts for video URLs ─────────────────────────────────

  function scanScripts() {
    document.querySelectorAll('script:not([src])').forEach((script) => {
      const text = script.textContent;
      if (!text || text.length > 500000) return; // skip very large scripts

      // Match URLs that look like video files
      const urlRegex = /["'](https?:\/\/[^"'\s]+\.(mp4|webm|m3u8?|mpd|m4v|ts)(\?[^"'\s]*)?)["']/gi;
      let match;
      while ((match = urlRegex.exec(text)) !== null) {
        notify(match[1]);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanScripts);
  } else {
    scanScripts();
  }

})();
