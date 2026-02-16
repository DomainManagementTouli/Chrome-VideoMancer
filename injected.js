/**
 * VideoMancer - Injected Page Script
 * Runs in the page context (not extension context) to intercept:
 * - XMLHttpRequest / fetch for video URLs AND response bodies containing manifest URLs
 * - MediaSource / SourceBuffer for MSE streams
 * - Video element src assignments
 * - Bitmovin Player (used by The Great Courses / Wondrium, etc.)
 * - HLS.js / dash.js / video.js / Shaka Player / JW Player libraries
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
    return /\.(mp4|webm|mkv|m4v|ts|m3u8?|mpd|flv|mov|3gp|ogv|m4s|fmp4|cmfv|cmfa)(\?|#|$)/i.test(url);
  }

  function isManifestUrl(url) {
    return /\.(m3u8?|mpd)(\?|#|$)/i.test(url);
  }

  function isVideoMimeType(type) {
    return /^(video\/|application\/x-mpegurl|application\/vnd\.apple\.mpegurl|application\/dash\+xml)/i.test(type);
  }

  function classifyMediaUrl(url) {
    if (/\.m3u8?(\?|#|$)/i.test(url)) return 'hls';
    if (/\.mpd(\?|#|$)/i.test(url)) return 'dash';
    return 'direct';
  }

  /**
   * Scan a string (JSON response body, inline script, etc.) for embedded
   * manifest/video URLs. This is critical for sites like The Great Courses
   * where Bitmovin Player receives its manifest URL from an API response.
   */
  function scanTextForVideoUrls(text) {
    if (!text || text.length > 2000000) return; // skip very large responses

    // Direct URL patterns for manifests and video files
    const urlRegex = /["'](https?:\/\/[^"'\s<>]+?\.(m3u8?|mpd|mp4|webm|m4v|ts)(\?[^"'\s<>]*)?)["']/gi;
    let match;
    while ((match = urlRegex.exec(text)) !== null) {
      const url = match[1];
      notify(url, { mediaType: classifyMediaUrl(url) });
    }

    // Also look for unquoted URLs in common JSON patterns:
    // "dash": "https://...", "hls": "https://...", "manifest": "https://..."
    const jsonUrlRegex = /["']((?:dash|hls|manifest|stream|video|source|playback|content)(?:_url|Url|URL|_uri|Uri|URI)?)\s*["']\s*:\s*["'](https?:\/\/[^"'\s<>]+)["']/gi;
    while ((match = jsonUrlRegex.exec(text)) !== null) {
      const url = match[2];
      const key = match[1].toLowerCase();
      const type = key.includes('dash') || key.includes('mpd') ? 'dash'
        : key.includes('hls') || key.includes('m3u') ? 'hls'
        : null;
      notify(url, { mediaType: type });
    }
  }

  // ── Intercept fetch() ──────────────────────────────────────────────────
  // Intercepts BOTH the request URL and the response body. The response
  // body scan is critical for sites where an API returns a JSON object
  // containing the actual manifest URL.

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0]
      : (args[0] instanceof Request ? args[0].url : null);

    if (url && isVideoUrl(url)) {
      try {
        const fullUrl = new URL(url, window.location.href).href;
        notify(fullUrl, { mediaType: classifyMediaUrl(fullUrl) });
      } catch { /* ignore */ }
    }

    return originalFetch.apply(this, args).then(response => {
      const ct = response.headers.get('content-type') || '';

      // Check if the response itself is a video/manifest
      if (url && isVideoMimeType(ct)) {
        try {
          const fullUrl = new URL(url, window.location.href).href;
          notify(fullUrl, { mediaType: ct.includes('mpegurl') ? 'hls' : ct.includes('dash') ? 'dash' : 'direct' });
        } catch { /* ignore */ }
      }

      // For JSON/text API responses, clone and scan the body for manifest URLs.
      // This catches: API calls that return { "hls": "https://cdn.../manifest.m3u8" }
      if (ct.includes('json') || ct.includes('text')) {
        const cloned = response.clone();
        cloned.text().then(body => {
          scanTextForVideoUrls(body);
        }).catch(() => {});
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
        notify(fullUrl, { mediaType: classifyMediaUrl(fullUrl) });
      } catch { /* ignore */ }
    }
    return originalXHROpen.call(this, method, url, ...rest);
  };

  const originalXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      const ct = this.getResponseHeader('content-type') || '';

      // Direct video/manifest content-type
      if (this._vmUrl && isVideoMimeType(ct)) {
        try {
          const fullUrl = new URL(this._vmUrl, window.location.href).href;
          notify(fullUrl, { mediaType: classifyMediaUrl(fullUrl) });
        } catch { /* ignore */ }
      }

      // Scan JSON/text responses for embedded manifest URLs
      if ((ct.includes('json') || ct.includes('text')) && this.responseText) {
        scanTextForVideoUrls(this.responseText);
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

  // ── Bitmovin Player Interception ───────────────────────────────────────
  // Bitmovin Player (used by The Great Courses / Wondrium, many others)
  // loads video via: player.load({ dash: '...', hls: '...' })
  // The player object is created via: new bitmovin.player.Player(container, config)
  // Or in newer versions: bitmovin.playerx.Player()
  //
  // We intercept both the constructor AND the .load() / .setup() methods
  // to extract the manifest URLs from the source config.

  function extractBitmovinSource(sourceConfig) {
    if (!sourceConfig || typeof sourceConfig !== 'object') return;

    // Standard v8 source config properties
    const urlProps = ['dash', 'hls', 'progressive', 'smooth'];
    for (const prop of urlProps) {
      const val = sourceConfig[prop];
      if (typeof val === 'string' && val.length > 0) {
        try {
          const url = new URL(val, window.location.href).href;
          const type = prop === 'hls' ? 'hls' : prop === 'dash' ? 'dash' : 'direct';
          notify(url, { mediaType: type });
        } catch { /* ignore */ }
      }
      // Progressive can be an array of objects with .url
      if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === 'string') notify(item);
          else if (item && item.url) notify(item.url);
        }
      }
    }

    // Player Web X (v10+) uses resources array
    if (Array.isArray(sourceConfig.resources)) {
      for (const res of sourceConfig.resources) {
        if (res && res.url) {
          notify(res.url, { mediaType: classifyMediaUrl(res.url) });
        }
      }
    }

    // Sometimes the source is nested under .source
    if (sourceConfig.source) {
      extractBitmovinSource(sourceConfig.source);
    }
  }

  function interceptBitmovinPlayer(playerInstance) {
    if (!playerInstance || playerInstance._vmIntercepted) return playerInstance;
    playerInstance._vmIntercepted = true;

    // Intercept .load()
    const origLoad = playerInstance.load;
    if (typeof origLoad === 'function') {
      playerInstance.load = function (sourceConfig, ...rest) {
        extractBitmovinSource(sourceConfig);
        return origLoad.call(this, sourceConfig, ...rest);
      };
    }

    // Intercept .setup() (older API)
    const origSetup = playerInstance.setup;
    if (typeof origSetup === 'function') {
      playerInstance.setup = function (config, ...rest) {
        if (config && config.source) {
          extractBitmovinSource(config.source);
        }
        extractBitmovinSource(config);
        return origSetup.call(this, config, ...rest);
      };
    }

    // Listen for events that reveal the source
    try {
      if (typeof playerInstance.on === 'function') {
        playerInstance.on('sourceloaded', () => {
          try {
            const source = playerInstance.getSource?.() || playerInstance.getConfig?.()?.source;
            if (source) extractBitmovinSource(source);
          } catch { /* ignore */ }
        });
      }
    } catch { /* ignore */ }

    // Check if source is already loaded
    try {
      const currentSource = playerInstance.getSource?.() || playerInstance.getConfig?.()?.source;
      if (currentSource) extractBitmovinSource(currentSource);
    } catch { /* ignore */ }

    return playerInstance;
  }

  // Poll for bitmovin.player namespace
  const checkBitmovin = setInterval(() => {
    if (typeof window.bitmovin !== 'undefined' && window.bitmovin.player) {
      // Intercept the Player constructor
      const origPlayerNs = window.bitmovin.player;
      if (origPlayerNs.Player && !origPlayerNs._vmPatched) {
        origPlayerNs._vmPatched = true;
        const OrigPlayer = origPlayerNs.Player;

        origPlayerNs.Player = function (container, config, ...rest) {
          // Extract source from initial config if present
          if (config && config.source) {
            extractBitmovinSource(config.source);
          }

          const instance = new OrigPlayer(container, config, ...rest);
          interceptBitmovinPlayer(instance);
          return instance;
        };

        // Preserve prototype and static properties
        origPlayerNs.Player.prototype = OrigPlayer.prototype;
        Object.keys(OrigPlayer).forEach(key => {
          try { origPlayerNs.Player[key] = OrigPlayer[key]; } catch { /* ignore */ }
        });
      }
      clearInterval(checkBitmovin);
    }
  }, 200);
  setTimeout(() => clearInterval(checkBitmovin), 60000);

  // Also try to find already-existing Bitmovin player instances in the DOM
  const findExistingBitmovin = setInterval(() => {
    // Bitmovin adds a specific class/id pattern to its player container
    document.querySelectorAll('[id*="bitmovin"], [class*="bitmovin"], [data-bitmovin]').forEach((el) => {
      // The player instance is sometimes stored on the element
      if (el._player || el.player) {
        interceptBitmovinPlayer(el._player || el.player);
      }
    });

    // Also check the global player registry that Bitmovin maintains
    try {
      if (window.bitmovin && window.bitmovin.player && window.bitmovin.player.Player) {
        // Some sites store player instance globally
        for (const key of Object.keys(window)) {
          try {
            const val = window[key];
            if (val && typeof val === 'object' && typeof val.getSource === 'function' && typeof val.load === 'function') {
              const source = val.getSource();
              if (source) extractBitmovinSource(source);
              interceptBitmovinPlayer(val);
            }
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }, 2000);
  setTimeout(() => clearInterval(findExistingBitmovin), 60000);

  // ── Monitor HLS.js instances ───────────────────────────────────────────

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

  // ── Shaka Player Interception ──────────────────────────────────────────
  // Shaka Player (Google's open source player) is used by many streaming sites

  const checkShaka = setInterval(() => {
    if (typeof window.shaka !== 'undefined' && window.shaka.Player) {
      const OrigShaka = window.shaka.Player;
      const origLoad = OrigShaka.prototype.load;
      if (origLoad) {
        OrigShaka.prototype.load = function (manifestUri, ...rest) {
          if (manifestUri && typeof manifestUri === 'string') {
            try {
              const fullUrl = new URL(manifestUri, window.location.href).href;
              notify(fullUrl, { mediaType: classifyMediaUrl(fullUrl) });
            } catch { /* ignore */ }
          }
          return origLoad.call(this, manifestUri, ...rest);
        };
      }
      clearInterval(checkShaka);
    }
  }, 500);
  setTimeout(() => clearInterval(checkShaka), 30000);

  // ── JW Player Interception ─────────────────────────────────────────────

  const checkJWPlayer = setInterval(() => {
    if (typeof window.jwplayer === 'function') {
      const origJW = window.jwplayer;
      window.jwplayer = function (...args) {
        const instance = origJW.apply(this, args);
        if (instance && typeof instance.setup === 'function' && !instance._vmPatched) {
          instance._vmPatched = true;
          const origSetup = instance.setup;
          instance.setup = function (config) {
            if (config) {
              // JW Player uses playlist[].sources[].file or playlist[].file
              const items = config.playlist || (config.file ? [config] : []);
              for (const item of items) {
                if (item.file) notify(item.file, { mediaType: classifyMediaUrl(item.file) });
                if (item.sources) {
                  for (const s of item.sources) {
                    if (s.file) notify(s.file, { mediaType: classifyMediaUrl(s.file) });
                  }
                }
              }
            }
            return origSetup.call(this, config);
          };
        }
        return instance;
      };
      Object.keys(origJW).forEach(k => { try { window.jwplayer[k] = origJW[k]; } catch {} });
      clearInterval(checkJWPlayer);
    }
  }, 500);
  setTimeout(() => clearInterval(checkJWPlayer), 30000);

  // ── MediaSource / SourceBuffer Interception ────────────────────────────

  const mediaSourceBlobs = new WeakMap();
  const blobToSourceInfo = new Map();

  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const blobUrl = origCreateObjectURL.call(this, obj);
    if (obj instanceof MediaSource) {
      mediaSourceBlobs.set(obj, blobUrl);
      blobToSourceInfo.set(blobUrl, { mimeTypes: [], created: Date.now() });
    }
    return blobUrl;
  };

  const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mimeType) {
    const blobUrl = mediaSourceBlobs.get(this);
    if (blobUrl && blobToSourceInfo.has(blobUrl)) {
      blobToSourceInfo.get(blobUrl).mimeTypes.push(mimeType);
    }
    return origAddSourceBuffer.call(this, mimeType);
  };

  // Monitor <video> elements for blob: src
  const blobVideoObserver = setInterval(() => {
    document.querySelectorAll('video').forEach((video) => {
      if (video.src && video.src.startsWith('blob:') && !video._vmTracked) {
        video._vmTracked = true;
        const info = blobToSourceInfo.get(video.src);
        if (info) {
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
          if (video.readyState >= 1) addMeta();
          else video.addEventListener('loadedmetadata', addMeta, { once: true });
        }
      }
    });
  }, 1000);
  setTimeout(() => clearInterval(blobVideoObserver), 300000);

  // ── Intercept video.js ─────────────────────────────────────────────────

  const checkVideoJs = setInterval(() => {
    if (typeof window.videojs === 'function') {
      const origVideojs = window.videojs;
      window.videojs = function (...args) {
        const player = origVideojs.apply(this, args);
        try {
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
      if (!text || text.length > 500000) return;
      scanTextForVideoUrls(text);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanScripts);
  } else {
    scanScripts();
  }

  // Re-scan after a delay for dynamically added scripts
  setTimeout(scanScripts, 3000);
  setTimeout(scanScripts, 8000);

})();
