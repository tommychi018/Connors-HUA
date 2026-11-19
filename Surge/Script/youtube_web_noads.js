/*
 * YouTube Web NoAds - Surge http-response script (macOS / Chrome web player)
 * ---------------------------------------------------------------------------
 * Handles two kinds of responses from https://www.youtube.com :
 *   1. JSON  : /youtubei/v1/{player,next,browse,search,get_watch,reel/...}
 *   2. HTML  : page loads (/, /watch, /results, /feed/..., /shorts/..., ...)
 *              where the data is embedded as  ytInitialPlayerResponse = {...}
 *              and  ytInitialData = {...}
 *
 * What it does
 *   - Player data : deletes the ad-scheduling keys (adPlacements, playerAds,
 *                   adSlots, adBreakHeartbeatParams).
 *   - Feed data   : removes ad renderers (adSlotRenderer, promoted video /
 *                   sparkles renderers, masthead ads, ...) from any array,
 *                   including ones wrapped in richItemRenderer.content.
 *
 * Design rules
 *   - FAIL OPEN : any exception, unparseable body or unchanged data returns
 *                 $done({}) so the original response is delivered untouched.
 *   - No network access, no storage, no notifications.
 *
 * Arguments (JSON string, all optional):
 *   {"debug":false,"feedAds":true,"playerAds":true}
 *   debug=true prints what was removed to the Surge script log.
 *
 * Maintenance note: YouTube renames renderers from time to time. If ads come
 * back, turn debug on, find the new renderer name in the response, and add it
 * to AD_ITEM_KEYS below.
 */
(function () {
  var started = Date.now();

  // ----- configuration ------------------------------------------------------
  var cfg = { debug: false, feedAds: true, playerAds: true };
  try {
    if (typeof $argument === 'string' && $argument.length) {
      var parsed = JSON.parse($argument);
      for (var ck in parsed) if (Object.prototype.hasOwnProperty.call(parsed, ck)) cfg[ck] = parsed[ck];
    }
  } catch (e) { /* keep defaults */ }
  function log() {
    if (cfg.debug) console.log('[yt-web] ' + Array.prototype.slice.call(arguments).join(' '));
  }

  // Keys that, when they appear as an array item (or wrapped within 3 levels
  // of one), mark that item as an ad.
  var AD_ITEM_KEYS = {
    adSlotRenderer: 1,
    inFeedAdLayoutRenderer: 1,
    promotedSparklesWebRenderer: 1,
    promotedSparklesTextSearchRenderer: 1,
    promotedVideoRenderer: 1,
    compactPromotedVideoRenderer: 1,
    searchPyvRenderer: 1,
    displayAdRenderer: 1,
    mastheadAdRenderer: 1,
    videoMastheadAdV3Renderer: 1,
    statementBannerRenderer: 1,
    brandVideoSingletonRenderer: 1,
    brandVideoShelfRenderer: 1,
    actionCompanionAdRenderer: 1,
    adBreakServiceRenderer: 1,
    playerLegacyDesktopWatchAdsRenderer: 1
  };
  // Keys deleted wherever they appear in player data.
  var PLAYER_KEYS = {
    adPlacements: 1,
    playerAds: 1,
    adSlots: 1,
    adBreakHeartbeatParams: 1
  };

  var hasOwn = Object.prototype.hasOwnProperty;

  // ----- helpers ------------------------------------------------------------
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  // True if this array item is an ad (or a thin wrapper around one).
  function isAdItem(item, depth) {
    if (!isObj(item)) return false;
    for (var k in item) {
      if (!hasOwn.call(item, k)) continue;
      if (AD_ITEM_KEYS[k] === 1) return true;
      if (depth < 2 && isObj(item[k]) && isAdItem(item[k], depth + 1)) return true;
    }
    return false;
  }

  // Mutates node in place; counts removals in stats.removed.
  function prune(node, stats) {
    if (Array.isArray(node)) {
      var kept = [];
      for (var i = 0; i < node.length; i++) {
        var it = node[i];
        if (cfg.feedAds && isAdItem(it, 0)) { stats.removed++; continue; }
        prune(it, stats);
        kept.push(it);
      }
      if (kept.length !== node.length) {
        node.length = 0;
        for (var j = 0; j < kept.length; j++) node.push(kept[j]);
      }
      return;
    }
    if (isObj(node)) {
      for (var k in node) {
        if (!hasOwn.call(node, k)) continue;
        if (cfg.playerAds && PLAYER_KEYS[k] === 1) { delete node[k]; stats.removed++; continue; }
        if (cfg.feedAds && AD_ITEM_KEYS[k] === 1) { delete node[k]; stats.removed++; continue; }
        prune(node[k], stats);
      }
    }
  }

  // Index of the '}' that closes the object starting at s[start] === '{'.
  // String-aware (handles braces and escaped quotes inside strings).
  function findObjectEnd(s, start) {
    var depth = 0, inStr = false, esc = false;
    for (var i = start; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === 92) esc = true;        // backslash
        else if (c === 34) inStr = false;     // closing quote
        continue;
      }
      if (c === 34) inStr = true;             // opening quote
      else if (c === 123) depth++;            // {
      else if (c === 125) { depth--; if (depth === 0) return i; } // }
    }
    return -1;
  }

  // Serialise JSON so it is safe inside an inline <script> block.
  function safeStringify(obj) {
    return JSON.stringify(obj)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  }

  // ----- JSON endpoint (/youtubei/v1/...) -----------------------------------
  function handleJson(body) {
    var obj;
    try { obj = JSON.parse(body); } catch (e) { log('json parse failed'); return null; }
    var stats = { removed: 0 };
    prune(obj, stats);
    log('json removed', stats.removed);
    return stats.removed > 0 ? JSON.stringify(obj) : null;
  }

  // ----- HTML page (embedded ytInitialPlayerResponse / ytInitialData) -------
  function handleHtml(html) {
    if (html.indexOf('ytInitial') === -1) return null;
    var re = /(?:window\["ytInitial(?:Data|PlayerResponse)"\]|ytInitial(?:Data|PlayerResponse))\s*=\s*\{/g;
    var stats = { removed: 0 };
    var out = '', pos = 0, changed = false, m;
    while ((m = re.exec(html)) !== null) {
      var start = m.index + m[0].length - 1;       // position of '{'
      if (start < pos) continue;
      var end = findObjectEnd(html, start);
      if (end < 0) { re.lastIndex = start + 1; continue; }
      var obj;
      try { obj = JSON.parse(html.slice(start, end + 1)); }
      catch (e) { re.lastIndex = start + 1; continue; }
      var before = stats.removed;
      prune(obj, stats);
      if (stats.removed > before) {
        out += html.slice(pos, start) + safeStringify(obj);
        pos = end + 1;
        changed = true;
      }
      re.lastIndex = end + 1;
    }
    log('html removed', stats.removed);
    return changed ? out + html.slice(pos) : null;
  }

  // ----- main ---------------------------------------------------------------
  try {
    var url = ($request && $request.url) || '';
    var body = $response && $response.body;
    if (typeof body !== 'string' || body.length === 0) return $done({});
    var result = (url.indexOf('/youtubei/v1/') !== -1) ? handleJson(body) : handleHtml(body);
    if (result === null || result === body) {
      log('unchanged', url.slice(0, 90));
      return $done({});
    }
    log('patched', url.slice(0, 90), 'in', (Date.now() - started) + 'ms');
    return $done({ body: result });
  } catch (err) {
    console.log('[yt-web] error, passing response through untouched: ' + err);
    return $done({});
  }
})();
