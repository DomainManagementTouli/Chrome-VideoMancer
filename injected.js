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
      try {
        const OrigMediaPlayer = window.dashjs.MediaPlayer;
        const origCreate = OrigMediaPlayer().create;
        if (origCreate) {
          // Intercept attachSource to capture DASH manifest URLs
          const origAttachSource = origCreate.prototype?.attachSource;
          if (origAttachSource) {
            origCreate.prototype.attachSource = function(src) {
              if (src && typeof src === 'string') {
                try {
                  const fullUrl = new URL(src, window.location.href).href;
                  notify(fullUrl, { mediaType: 'dash' });
                } catch { /* ignore */ }
              }
              return origAttachSource.call(this, src);
            };
          }
        }
      } catch { /* ignore dash.js interception errors */ }
      clearInterval(checkDashJs);
    }
  }, 500);
  setTimeout(() => clearInterval(checkDashJs), 30000);

  // ── MediaSource / SourceBuffer Interception ────────────────────────────
  // This is CRITICAL for paywall sites. Sites like The Great Courses, Udemy,
  // Netflix (non-DRM), etc. use MediaSource Extensions (MSE) to feed video
  // data into a <video> element via a blob: URL. The actual stream URLs are
  // fetched via fetch/XHR and then appended to a SourceBuffer.
  //
  // We intercept:
  // 1. URL.createObjectURL(mediaSource) - to track which blob URL maps to
  //    which MediaSource, so we can associate <video>.src blob URLs with
  //    detected streams.
  // 2. MediaSource.addSourceBuffer() - to know which MIME types are being used.
  // 3. We already intercept fetch/XHR above to capture the actual segment URLs.

  // Track MediaSource <-> blob URL associations
  const mediaSourceBlobs = new WeakMap();
  const blobToSourceInfo = new Map();

  // Intercept URL.createObjectURL to track MediaSource blob URLs
  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const blobUrl = origCreateObjectURL.call(this, obj);

    if (obj instanceof MediaSource) {
      mediaSourceBlobs.set(obj, blobUrl);
      blobToSourceInfo.set(blobUrl, {
        mimeTypes: [],
        created: Date.now(),
      });
    }

    return blobUrl;
  };

  // Intercept MediaSource.addSourceBuffer to track MIME types
  const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mimeType) {
    const blobUrl = mediaSourceBlobs.get(this);
    if (blobUrl && blobToSourceInfo.has(blobUrl)) {
      blobToSourceInfo.get(blobUrl).mimeTypes.push(mimeType);
    }

    const sourceBuffer = origAddSourceBuffer.call(this, mimeType);
    return sourceBuffer;
  };

  // ── Monitor <video> elements for blob: src and resolve them ────────────
  // When a <video> has a blob: src backed by MSE, we already captured the
  // actual stream URLs via fetch/XHR interception. But we also want to
  // track which <video> elements are using MSE so we can report them with
  // proper metadata (resolution, duration).

  const blobVideoObserver = setInterval(() => {
    document.querySelectorAll('video').forEach((video) => {
      if (video.src && video.src.startsWith('blob:') && !video._vmTracked) {
        video._vmTracked = true;

        const info = blobToSourceInfo.get(video.src);
        if (info) {
          // This video is using MSE - we have the real URLs from fetch/XHR intercepts
          // Add metadata if available
          const addMeta = () => {
            if (video.videoWidth && video.videoHeight) {
              window.postMessage({
                type: 'VIDEOMANCER_BLOB_VIDEO',
                blobUrl: video.src,
                resolution: `${video.videoWidth}x${video.videoHeight}`,
                duration: video.duration && isFinite(video.duration) ? video.duration : null,
                mimeTypes: info.mimeTypes,
              }, '*');
            }
          };

          if (video.readyState >= 1) {
            addMeta();
          } else {
            video.addEventListener('loadedmetadata', addMeta, { once: true });
          }
        }
      }
    });
  }, 1000);
  setTimeout(() => clearInterval(blobVideoObserver), 300000); // stop after 5 minutes

  // ── Intercept video.js (used by many course/LMS platforms) ──────────────

  const checkVideoJs = setInterval(() => {
    if (typeof window.videojs === 'function') {
      const origVideojs = window.videojs;
      window.videojs = function (...args) {
        const player = origVideojs.apply(this, args);

        try {
          // Listen for source changes
          player.on('loadstart', function () {
            const tech = player.tech({ IWillNotUseThisInPlugins: true });
            if (tech && tech.currentSource_) {
              const src = tech.currentSource_.src;
              if (src && typeof src === 'string' && !src.startsWith('blob:')) {
                notify(src, { mediaType: classifyMediaUrl(src) });
              }
            }
          });
        } catch { /* ignore */ }

        return player;
      };

      // Copy all static properties
      for (const key of Object.keys(origVideojs)) {
        window.videojs[key] = origVideojs[key];
      }
      Object.setPrototypeOf(window.videojs, origVideojs);

      clearInterval(checkVideoJs);
    }
  }, 500);
  setTimeout(() => clearInterval(checkVideoJs), 30000);

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
