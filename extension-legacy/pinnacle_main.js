// MAIN world — 피나클 페이지 fetch/XHR 응답 가로채기 (한글 팀명 캐시)
(function () {
  if (window.__pinMainInstalled) return;
  window.__pinMainInstalled = true;
  window.__pinMatchupCache = window.__pinMatchupCache || {};
  window.__PIN_API_KEY = window.__PIN_API_KEY || '';

  function hasHangul(s) {
    return /[가-힣]/.test(String(s || ''));
  }

  function getParticipants(mu, byId) {
    const direct = mu.participants;
    if (Array.isArray(direct) && direct.length >= 2 && direct.some((p) => p?.name)) return direct;
    if (mu.parent?.participants?.length >= 2) return mu.parent.participants;
    let pid = mu.parentId;
    for (let d = 0; d < 6 && pid; d++) {
      const p = byId[pid];
      if (!p) break;
      if (p.participants?.length >= 2 && p.participants.some((x) => x?.name)) return p.participants;
      pid = p.parentId;
    }
    return [];
  }

  function parseMatchupsArray(data) {
    if (!Array.isArray(data)) return null;
    const byId = {};
    for (const m of data) byId[m.id] = m;
    const matchups = {};
    let koCount = 0;
    for (const mu of data) {
      if (mu.isLive || (mu.type && mu.type !== 'matchup') || mu.hasMarkets === false) continue;
      const parts = getParticipants(mu, byId);
      if (parts.length < 2) continue;
      const home = parts.find((p) => p.alignment === 'home')?.name || parts[0]?.name || '';
      const away = parts.find((p) => p.alignment === 'away')?.name || parts[1]?.name || '';
      if (!home || !away) continue;
      if (/^\d+$/.test(home) && /^\d+$/.test(away)) continue;
      if (hasHangul(home + away)) koCount++;
      matchups[mu.id] = { home, away, league: mu.league?.name || '', startTime: mu.startTime || null };
    }
    const total = Object.keys(matchups).length;
    if (!total) return null;
    return { matchups, koCount, total };
  }

  function sportIdFromUrl(url) {
    const m = url.match(/\/sports\/(\d+)\/matchups/);
    return m ? Number(m[1]) : null;
  }

  function storeParsed(url, data) {
    const sportId = sportIdFromUrl(url);
    if (!sportId) return;
    const parsed = parseMatchupsArray(data);
    if (!parsed) return;
    const prev = window.__pinMatchupCache[sportId];
    if (prev && prev.koCount > parsed.koCount && parsed.koCount === 0) return;
    if (prev && prev.total > parsed.total && parsed.koCount <= (prev.koCount || 0)) return;
    window.__pinMatchupCache[sportId] = {
      ...parsed,
      updatedAt: Date.now(),
      source: 'intercept',
      url: location.href
    };
    try {
      document.dispatchEvent(new CustomEvent('pin-cache-update', {
        detail: { sportId, matchups: parsed.matchups, koCount: parsed.koCount, total: parsed.total }
      }));
    } catch (_) {}
  }

  function captureApiKey(headers) {
    if (!headers) return;
    let key = null;
    if (headers instanceof Headers) key = headers.get('X-Api-Key') || headers.get('x-api-key');
    else if (typeof headers === 'object') key = headers['X-Api-Key'] || headers['x-api-key'];
    if (key && key.length > 15) window.__PIN_API_KEY = key;
  }

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url || '');
    if (url.includes('arcadia.pinnacle.com')) captureApiKey(init?.headers);
    const response = await origFetch.call(this, input, init);
    if (url.includes('/matchups') && response.ok) {
      try {
        const clone = response.clone();
        const data = await clone.json();
        storeParsed(url, data);
      } catch (_) {}
    }
    return response;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__pinUrl = url;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (name && name.toLowerCase() === 'x-api-key' && value && value.length > 15) {
      window.__PIN_API_KEY = value;
    }
    return origSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try {
        const url = this.__pinUrl || '';
        if (!url.includes('/matchups') || this.status < 200 || this.status >= 300) return;
        const data = JSON.parse(this.responseText);
        storeParsed(url, data);
      } catch (_) {}
    });
    return origSend.apply(this, arguments);
  };

  document.addEventListener('pin-cache-request', (ev) => {
    const sportId = ev?.detail?.sportId;
    if (!sportId) return;
    const cache = window.__pinMatchupCache?.[sportId];
    if (!cache?.matchups) return;
    try {
      document.dispatchEvent(new CustomEvent('pin-cache-read', {
        detail: { sportId, matchups: cache.matchups, koCount: cache.koCount, total: cache.total }
      }));
    } catch (_) {}
  });
})();
