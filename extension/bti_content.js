/**
 * BTI 스포츠북 배당 수집 (pbc00 iframe 포함)
 *
 * 흔한 실패 원인:
 * 1) all_frames: false → iframe 안 BTI DOM 접근 불가
 * 2) 부모 페이지만 스캔 → 배당은 iframe 내부
 * 3) 종목 전환을 텍스트 클릭만 시도 → BTI는 postMessage sportId 필요
 */
(function () {
  "use strict";

  const SOURCE = "arb-bti-content";
  const BTI_HOST_HINTS = ["bti", "sportsbook", "asian-view", "/sports"];
  const SPORT_IDS = {
    football: "1",
    baseball: "3",
    basketball: "2",
    esports: "64",
    tennis: "6",
  };

  /** @type {Array<{url:string, data:any, ts:number}>} */
  const capturedApi = [];

  function isBtiContext() {
    const href = location.href.toLowerCase();
    if (BTI_HOST_HINTS.some((h) => href.includes(h))) return true;
    // pbc00 래퍼 페이지의 iframe 안이면 true
    if (window !== window.top && document.querySelector("[class*='odds'], [class*='Odds'], [class*='event']")) {
      return true;
    }
    return false;
  }

  function decimalOdds(raw) {
    const v = parseFloat(raw);
    if (!v || Number.isNaN(v)) return null;
    if (v < 1) return +(v + 1).toFixed(3);
    if (v >= 100) return +(v / 100 + 1).toFixed(3);
    if (v <= -100) return +(100 / Math.abs(v) + 1).toFixed(3);
    return +v.toFixed(3);
  }

  function normalizeTeam(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  /** BTI 공식: iframe에 sportId postMessage */
  function navigateBtiSport(sportKey) {
    const sportId = SPORT_IDS[sportKey] || sportKey;
    const payload = JSON.stringify({
      eventType: "sportId",
      eventData: { value: String(sportId) },
    });

    if (window === window.top) {
      document.querySelectorAll("iframe").forEach((iframe) => {
        try {
          iframe.contentWindow?.postMessage(payload, "*");
        } catch (_) {}
      });
    } else {
      window.parent.postMessage(payload, "*");
    }
    return sportId;
  }

  /** 네트워크 JSON 캡처 (fetch/XHR hook) */
  function installNetworkHook() {
    if (window.__arbBtiHooked) return;
    window.__arbBtiHooked = true;

    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      try {
        const clone = res.clone();
        const ct = (clone.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("json")) {
          const data = await clone.json();
          pushApi(args[0]?.url || args[0], data);
        }
      } catch (_) {}
      return res;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__arbUrl = url;
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", function () {
        try {
          const ct = (this.getResponseHeader("content-type") || "").toLowerCase();
          if (ct.includes("json") && this.responseText) {
            pushApi(this.__arbUrl, JSON.parse(this.responseText));
          }
        } catch (_) {}
      });
      return origSend.apply(this, args);
    };
  }

  function pushApi(url, data) {
    const u = String(url || "");
    if (!/api|event|sport|market|odds|bet|line|fixture|selection|match/i.test(u)) return;
    capturedApi.push({ url: u, data, ts: Date.now() });
    if (capturedApi.length > 80) capturedApi.shift();
  }

  function parseBtiEvent(ev) {
    if (!ev || typeof ev !== "object") return null;

    let home = ev.homeTeam || ev.HomeTeam || ev.home_team;
    let away = ev.awayTeam || ev.AwayTeam || ev.away_team;

    if (!home || !away) {
      const name = ev.eventName || ev.name || "";
      const m = name.match(/^(.+?)\s+(?:vs|VS|v\.|@)\s+(.+)$/);
      if (m) {
        home = m[1];
        away = m[2];
      }
    }

    const parts = ev.participants || ev.competitors || ev.teams || [];
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (!p || typeof p !== "object") continue;
        const n = p.name || p.teamName;
        const role = String(p.venueRole || p.alignment || p.side || "").toLowerCase();
        if (role === "home" || role === "h") home = n;
        if (role === "away" || role === "a") away = n;
      }
      if (!home && parts.length >= 2) {
        home = parts[0].name || parts[0];
        away = parts[1].name || parts[1];
      }
    }

    home = normalizeTeam(home);
    away = normalizeTeam(away);
    if (!home || !away) return null;

    const markets = ev.markets || ev.market || [];
    const list = Array.isArray(markets) ? markets : [markets];
    let homeOdds = null;
    let awayOdds = null;
    let drawOdds = null;

    for (const mk of list) {
      if (!mk || typeof mk !== "object") continue;
      const sels = mk.selections || mk.outcomes || mk.runners || mk.prices || [];
      const arr = Array.isArray(sels) ? sels : Object.values(sels);
      for (const s of arr) {
        if (!s || typeof s !== "object") continue;
        const price = decimalOdds(s.price ?? s.odds ?? s.decimal ?? s.decimalOdds ?? s.value);
        if (!price) continue;
        const label = String(s.name || s.designation || s.side || "").toLowerCase();
        if (/home|^h$|1/.test(label)) homeOdds = price;
        else if (/away|^a$|2/.test(label)) awayOdds = price;
        else if (/draw|^x$/.test(label)) drawOdds = price;
      }
      if (homeOdds && awayOdds) break;
    }

    if (!homeOdds || !awayOdds) return null;

    return {
      matchId: String(ev.id || ev.eventId || `${home}_${away}`),
      homeTeam: home,
      awayTeam: away,
      league: ev.leagueName || ev.league || "",
      odds: { home: homeOdds, away: awayOdds, draw: drawOdds },
      source: "bti-api",
    };
  }

  function walkBtiEvents(data, out, depth = 0) {
    if (depth > 8 || !data) return;
    if (Array.isArray(data)) {
      if (data.length && typeof data[0] === "object") {
        const sample = data[0];
        const keys = Object.keys(sample).map((k) => k.toLowerCase());
        if (
          keys.some((k) => ["participants", "markets", "hometeam", "eventname"].includes(k))
        ) {
          for (const item of data) {
            const p = parseBtiEvent(item);
            if (p) out.push(p);
          }
          return;
        }
      }
      for (const item of data) walkBtiEvents(item, out, depth + 1);
      return;
    }
    if (typeof data === "object") {
      const p = parseBtiEvent(data);
      if (p) out.push(p);
      for (const v of Object.values(data)) walkBtiEvents(v, out, depth + 1);
    }
  }

  function scrapeFromApi() {
    const out = [];
    const seen = new Set();
    for (const c of capturedApi.slice().reverse()) {
      walkBtiEvents(c.data, out);
    }
    return out.filter((m) => {
      const k = `${m.homeTeam}|${m.awayTeam}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /** DOM 폴백: BTI 이벤트 행 */
  function scrapeFromDom() {
    const out = [];
    const rowSelectors = [
      "[class*='event-row']",
      "[class*='EventRow']",
      "[class*='match-row']",
      "tr[class*='event']",
      ".game-list .item",
    ];

    for (const sel of rowSelectors) {
      const rows = document.querySelectorAll(sel);
      if (!rows.length) continue;

      rows.forEach((row, i) => {
        const text = row.innerText || "";
        const vm = text.match(/(.{2,40}?)\s+(?:vs|VS|v\.)\s+(.{2,40})/);
        if (!vm) return;
        const odds = [...text.matchAll(/\b([1-9]\d?\.\d{2})\b/g)]
          .map((x) => parseFloat(x[1]))
          .filter((x) => x >= 1.01 && x <= 50);
        if (odds.length < 2) return;
        out.push({
          matchId: `dom_${i}`,
          homeTeam: normalizeTeam(vm[1]),
          awayTeam: normalizeTeam(vm[2]),
          league: "",
          odds: { home: odds[0], away: odds[1], draw: odds[2] || null },
          source: "bti-dom",
        });
      });
      if (out.length) break;
    }
    return out;
  }

  async function collectOdds(sport = "football") {
    installNetworkHook();
    navigateBtiSport(sport);
    await new Promise((r) => setTimeout(r, 2500));

    let matches = scrapeFromApi();
    if (!matches.length) matches = scrapeFromDom();

    return {
      ok: matches.length > 0,
      sport,
      frameUrl: location.href,
      isTop: window === window.top,
      matchCount: matches.length,
      matches,
      apiCaptureCount: capturedApi.length,
      debug: {
        title: document.title,
        frameCount: window === window.top ? document.querySelectorAll("iframe").length : 0,
      },
    };
  }

  function searchTeam(query, sport = "football") {
    const q = normalizeTeam(query).toLowerCase();
    return collectOdds(sport).then((result) => {
      const hits = result.matches.filter((m) => {
        const blob = `${m.homeTeam} ${m.awayTeam}`.toLowerCase();
        return blob.includes(q) || m.homeTeam.toLowerCase().includes(q) || m.awayTeam.toLowerCase().includes(q);
      });
      return { ...result, query, hits, hitCount: hits.length };
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== "bti") return;

    (async () => {
      try {
        if (msg.action === "ping") {
          sendResponse({
            ok: true,
            source: SOURCE,
            href: location.href,
            isBti: isBtiContext(),
            isTop: window === window.top,
          });
          return;
        }
        if (msg.action === "collectOdds") {
          sendResponse(await collectOdds(msg.sport || "football"));
          return;
        }
        if (msg.action === "search") {
          sendResponse(await searchTeam(msg.query || "", msg.sport || "football"));
          return;
        }
        if (msg.action === "navigateSport") {
          sendResponse({ ok: true, sportId: navigateBtiSport(msg.sport || "football") });
          return;
        }
        sendResponse({ ok: false, error: "unknown_action" });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();

    return true; // async
  });

  // 부모/자식 프레임 간 브로드캐스트
  window.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    if (!ev.data.includes("sportId")) return;
  });

  console.log(`[${SOURCE}] loaded`, location.href, "top=", window === window.top);
})();
