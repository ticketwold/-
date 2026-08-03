// BTI content script v2.21
// 실제 DOM 구조 (진단 결과 기준):
// ─ 슬립 카드: [class*="betslip_fe_BetSecondary_bet"] (wrapper/counter/badge 제외)
// ─ 배당판 버튼: button[class*="master_fe_Selections_selection"]
//     배당 span: [class*="master_fe_Selections_odds"]
//     기준점 span: [class*="master_fe_Selections_points"] 또는 [class*="selectionNameLine"]
// ─ 금액 입력: input#counter
// ─ 베팅 버튼: button.sportsbook-Button (텍스트: "베팅하기")

(function () {
  "use strict";

  const VERSION = "2.21";

  // ─────────────────────────────────────────────
  // 슬립 읽기 (v2.20)
  // ─────────────────────────────────────────────

  function readBtiSlip() {
    const betCards = document.querySelectorAll('[class*="betslip_fe_BetSecondary_bet"]');
    const realCards = Array.from(betCards).filter((el) =>
      !el.className.includes("wrapper") &&
      !el.className.includes("counter") &&
      !el.className.includes("bageGroup") &&
      !el.className.includes("badge") &&
      !el.className.includes("PlaceBet") &&
      !el.className.includes("Tab"),
    );
    if (!realCards.length) return null;
    const card = realCards[0];

    const titleEls = card.querySelectorAll('[class*="betInformation__title"]');
    const selectionText = titleEls[0] ? titleEls[0].textContent.trim() : "";
    const marketTitleText = titleEls[1] ? titleEls[1].textContent.trim() : "";

    const eventEl = card.querySelector('[class*="eventName"], [class*="betInformation__eventName"]');
    const eventText = eventEl ? eventEl.textContent.trim() : "";

    const mktEl = card.querySelector('[class*="betInformation__marketName"]');
    const mktText = mktEl ? mktEl.textContent.trim() : marketTitleText;

    const allText = `${selectionText} ${mktText} ${marketTitleText}`;

    let odds = null;
    let matchedLine = null;
    let matchedSide = null;

    const allBtns = document.querySelectorAll('button[class*="master_fe_Selections_selection"]');

    if (selectionText) {
      const slipLineMatch = selectionText.match(/([+-]\d+\.?\d*)\s*$/);
      const slipLine = slipLineMatch ? parseFloat(slipLineMatch[1]) : null;
      const teamName = slipLine !== null
        ? selectionText.replace(slipLineMatch[0], "").trim()
        : selectionText;

      if (slipLine !== null) {
        for (const btn of allBtns) {
          const parsed = parseSelectionButton(btn);
          if (!parsed || !parsed.odds) continue;
          const pointsText = parsed.pointsText || "";
          const pointsLineMatch = pointsText.match(/([+-]\d+\.?\d*)\s*$/);
          if (!pointsLineMatch) continue;
          const pointsLine = parseFloat(pointsLineMatch[1]);
          if (Math.abs(pointsLine - slipLine) < 0.01) {
            const pointsClean = pointsText.replace(/\s+/g, "").toLowerCase();
            const teamClean = teamName.replace(/\s+/g, "").toLowerCase();
            if (pointsClean.includes(teamClean) || teamClean.length < 2) {
              odds = parsed.odds;
              matchedLine = pointsLine;
              break;
            }
          }
        }
      }

      if (!odds) {
        const slipMktType = detectMarketType(allText);
        const candidates = [];
        for (const btn of allBtns) {
          const parsed = parseSelectionButton(btn);
          if (!parsed || !parsed.odds) continue;
          const btnTextClean = parsed.rawText.replace(/\s+/g, "");
          const selClean = selectionText.replace(/\s+/g, "");
          if (btnTextClean.includes(selClean) || selClean.includes(btnTextClean.replace(/[\d.]+$/, ""))) {
            const pointsText = parsed.pointsText || "";
            const hasHandicap = /[+-]\d/.test(pointsText);
            const isOuBtn = /오버|언더|over|under/i.test(parsed.rawText);
            candidates.push({ btn, btnOdds: parsed.odds, pointsText, hasHandicap, isOuBtn });
          }
        }

        let chosen = null;
        if (slipMktType === "ml") {
          chosen = candidates.find((c) => !c.hasHandicap && !c.isOuBtn)
            || candidates.find((c) => !c.isOuBtn)
            || candidates[0];
        } else if (slipMktType === "ah") {
          chosen = candidates.find((c) => c.hasHandicap) || candidates[0];
        } else {
          chosen = candidates[0];
        }

        if (chosen) {
          odds = chosen.btnOdds;
          const pm = (chosen.pointsText || "").match(/([+-]?\d+\.?\d*)/);
          if (pm) matchedLine = parseFloat(pm[1]);
          if (chosen.btn.textContent.includes("언더") || chosen.btn.textContent.toLowerCase().includes("under")) matchedSide = "u";
          else if (chosen.btn.textContent.includes("오버") || chosen.btn.textContent.toLowerCase().includes("over")) matchedSide = "o";
        }
      }

      if (!odds) {
        const ouMatch = selectionText.match(/(오버|언더|over|under)\s*([\d]+\.?[\d]*)/i);
        if (ouMatch) {
          const targetSide = (ouMatch[1].toLowerCase().includes("언더") || ouMatch[1].toLowerCase() === "under") ? "u" : "o";
          const targetLine = parseFloat(ouMatch[2]);
          for (const btn of allBtns) {
            const parsed = parseSelectionButton(btn);
            if (!parsed || !parsed.odds) continue;
            const btnSide = /언더|under/i.test(parsed.rawText) ? "u" : (/오버|over/i.test(parsed.rawText) ? "o" : null);
            if (btnSide !== targetSide) continue;
            let btnLine = parsed.line;
            if (btnLine !== null && Math.abs(btnLine - targetLine) < 0.01) {
              odds = parsed.odds;
              matchedLine = btnLine;
              matchedSide = targetSide;
              break;
            }
          }
        }
      }

      if (!odds) {
        const ahMatch = selectionText.match(/([+-]\d+\.?\d*)/);
        if (ahMatch) {
          const targetLine = parseFloat(ahMatch[1]);
          for (const btn of allBtns) {
            const parsed = parseSelectionButton(btn);
            if (!parsed || !parsed.odds || parsed.line === null) continue;
            if (Math.abs(parsed.line - targetLine) < 0.01) {
              odds = parsed.odds;
              matchedLine = parsed.line;
              break;
            }
          }
        }
      }
    }

    if (!odds) odds = 0;

    const period = detectPeriod(allText);
    const type = mktText ? detectMarketType(mktText) : detectMarketType(allText);
    const side = detectSide(selectionText || allText, type, matchedSide);
    const line = detectLine(selectionText || allText, matchedLine);
    const marketKey = type === "ml"
      ? `${period}_ml_${side}`
      : type === "ah"
        ? `${period}_ah_${side}_${line}`
        : `${period}_ou_${side}_${line}`;

    const urlMatch = location.href.match(/\/(\d{10,20})(?:\/|$|\?|#)/);
    const eventId = urlMatch ? urlMatch[1] : null;

    return {
      odds,
      eventId,
      marketKind: type,
      period,
      side,
      line,
      marketKey,
      mktText,
      selectionText,
      eventText,
    };
  }

  function validateBtiLine(targetLine, tolerance) {
    const slip = readBtiSlip();
    if (!slip) return { valid: false, reason: "슬립 없음" };
    if (slip.line === null) return { valid: false, reason: "기준점 파싱 실패" };
    const diff = Math.abs(slip.line - targetLine);
    if (diff > tolerance) {
      return {
        valid: false,
        reason: `기준점 불일치: 목표=${targetLine}, 실제=${slip.line}("${slip.selectionText}"), 차이=${diff.toFixed(2)}`,
        actualLine: slip.line,
        selectionText: slip.selectionText,
      };
    }
    return { valid: true, actualLine: slip.line, selectionText: slip.selectionText };
  }

  async function placeBtiBet(amount, targetLine, lineTolerance) {
    try {
      if (targetLine !== undefined && lineTolerance !== undefined) {
        const validation = validateBtiLine(targetLine, lineTolerance);
        if (!validation.valid) {
          return {
            success: false,
            reason: `⚠️ ${validation.reason} → 베팅 취소`,
            lineChanged: true,
          };
        }
      }

      const betCards = document.querySelectorAll('[class*="betslip_fe_BetSecondary_bet"]');
      const realCards = Array.from(betCards).filter((el) =>
        !el.className.includes("wrapper") &&
        !el.className.includes("counter") &&
        !el.className.includes("bageGroup") &&
        !el.className.includes("badge") &&
        !el.className.includes("PlaceBet") &&
        !el.className.includes("Tab"),
      );
      if (!realCards.length) return { success: false, reason: "슬립 카드 없음" };

      const input = document.getElementById("counter")
        || document.querySelector('input[class*="CounterSecondary_input"], input[class*="counter__input"]');
      if (!input) return { success: false, reason: "금액 입력 필드 없음" };

      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      nativeSetter.call(input, String(amount));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));

      await new Promise((r) => setTimeout(r, 800));

      const allBtns = document.querySelectorAll("button:not([disabled])");
      let betBtn = null;

      for (const btn of allBtns) {
        if (btn.className.includes("sportsbook-Button") && btn.textContent.trim().includes("베팅하기")) {
          betBtn = btn;
          break;
        }
      }
      if (!betBtn) {
        for (const btn of allBtns) {
          if (btn.className.includes("PlaceBetBlock") && !btn.className.includes("clearAll")) {
            betBtn = btn;
            break;
          }
        }
      }
      if (!betBtn) {
        for (const btn of allBtns) {
          const txt = btn.textContent.trim();
          if ((txt.includes("베팅하기") || txt.includes("베팅 확인"))
            && !txt.includes("슬립") && !txt.includes("내 베팅") && !txt.includes("로그인")) {
            betBtn = btn;
            break;
          }
        }
      }

      if (!betBtn) return { success: false, reason: "베팅 버튼 없음 (금액 미입력 또는 최소금액 미달?)" };

      betBtn.click();
      await new Promise((r) => setTimeout(r, 1500));
      return { success: true };
    } catch (e) {
      return { success: false, reason: e.message };
    }
  }

  // ─────────────────────────────────────────────
  // 배당판 검색 (v2.21 신규 — 슬립 없이 동작)
  // ─────────────────────────────────────────────

  function detectPeriod(text) {
    const t = text.toLowerCase();
    if (t.includes("전반전") || t.includes("1st half") || t.includes("halftime")) return "1h";
    if (t.includes("후반전") || t.includes("2nd half")) return "2h";
    if (/[23]세트|[23]rd set|[23]nd set/i.test(t)) return "set";
    return "ft";
  }

  function detectMarketType(text) {
    const t = text.toLowerCase();
    if (t.includes("머니 라인") || t.includes("money line") || t.includes("moneyline") || t.includes("승패")) return "ml";
    if (t.includes("핸디캡") || t.includes("handicap") || t.includes("아시안")) return "ah";
    if (t.includes("오버") || t.includes("언더") || t.includes("over") || t.includes("under") || t.includes("총계")) return "ou";
    return "ml";
  }

  function detectSide(text, type, matchedSide) {
    const t = text.toLowerCase();
    if (type === "ou") {
      if (matchedSide) return matchedSide;
      return (t.includes("언더") || t.includes("under")) ? "u" : "o";
    }
    if (type === "ah") return (t.includes("어웨이") || t.includes("away")) ? "a" : "h";
    if (t.includes("무승부") || t.includes("draw")) return "draw";
    if (t.includes("어웨이") || t.includes("away")) return "away";
    return "home";
  }

  function detectLine(text, matchedLine) {
    if (matchedLine !== null) return matchedLine;
    const m = text.match(/(?:오버|언더|over|under)[\s]*([\d]+\.?[\d]*)/i);
    if (m) return parseFloat(m[1]);
    const m2 = text.match(/([+-]\d+\.?\d*)/);
    if (m2) return parseFloat(m2[1]);
    const m3 = text.match(/([\d]+\.[\d]+)/);
    if (m3) return parseFloat(m3[1]);
    return null;
  }

  function parseSelectionButton(btn) {
    if (!btn) return null;
    const rawText = (btn.textContent || "").trim();
    const oddsEl = btn.querySelector('[class*="master_fe_Selections_odds"]');
    if (!oddsEl) return null;
    const odds = parseFloat(oddsEl.textContent.trim());
    if (!odds || odds <= 1.01 || odds >= 100) return null;

    const pointsEl = btn.querySelector('[class*="master_fe_Selections_points"], [class*="selectionNameLine"]');
    const pointsText = pointsEl ? pointsEl.textContent.trim() : "";

    let line = null;
    const lineMatch = (pointsText || rawText).match(/([+-]\d+\.?\d*)/);
    if (lineMatch) line = parseFloat(lineMatch[1]);
    else {
      const ouLine = rawText.replace(/오버|언더|over|under/gi, "").match(/(\d+\.?\d*)/);
      if (ouLine) line = parseFloat(ouLine[1]);
    }

    let label = pointsText || rawText.replace(String(odds), "").trim();
    label = label.replace(/[+-]?\d+\.?\d*$/, "").trim();

    return { odds, line, pointsText, label, rawText, element: btn };
  }

  function findEventNameNearButton(btn) {
    let el = btn.parentElement;
    for (let depth = 0; depth < 15 && el; depth++) {
      const selectors = [
        '[class*="eventName"]',
        '[class*="EventName"]',
        '[class*="competitor"]',
        '[class*="participants"]',
        '[class*="matchName"]',
      ];
      for (const sel of selectors) {
        const found = el.querySelector(sel);
        if (found) {
          const t = found.textContent.trim();
          if (t.includes("vs") || t.includes("VS") || t.includes(" @ ")) return t;
        }
      }
      const text = (el.textContent || "").trim();
      const vm = text.match(/([^\n]{2,50})\s+(?:vs|VS|v\.|@)\s+([^\n]{2,50})/);
      if (vm && text.length < 200) return `${vm[1].trim()} vs ${vm[2].trim()}`;
      el = el.parentElement;
    }
    return "";
  }

  function parseEventTeams(eventText) {
    if (!eventText) return { home: "", away: "" };
    for (const sep of [" vs ", " VS ", " v ", " @ "]) {
      if (eventText.includes(sep)) {
        const [home, away] = eventText.split(sep, 2);
        return { home: home.trim(), away: away.trim() };
      }
    }
    return { home: eventText, away: "" };
  }

  /** 배당판의 모든 selection 버튼 스캔 (슬립 불필요) */
  function scrapeBoardSelections() {
    const btns = document.querySelectorAll('button[class*="master_fe_Selections_selection"]');
    const byEvent = new Map();

    btns.forEach((btn, idx) => {
      const parsed = parseSelectionButton(btn);
      if (!parsed) return;

      const eventText = findEventNameNearButton(btn);
      const eventKey = eventText || `unknown_${idx}`;
      const { home, away } = parseEventTeams(eventText);

      const marketContainer = btn.closest('[class*="market"], [class*="Market"], [class*="selections"]');
      const marketText = marketContainer
        ? (marketContainer.querySelector('[class*="marketName"], [class*="MarketName"]')?.textContent || "").trim()
        : "";

      const marketKind = detectMarketType(marketText || parsed.rawText);
      const side = detectSide(parsed.label || parsed.rawText, marketKind, null);

      const entry = {
        eventText,
        homeTeam: home,
        awayTeam: away,
        selectionText: parsed.label || parsed.rawText,
        marketText,
        marketKind,
        side,
        line: parsed.line,
        odds: parsed.odds,
        pointsText: parsed.pointsText,
        eventId: (location.href.match(/\/(\d{10,20})/) || [])[1] || null,
      };

      if (!byEvent.has(eventKey)) byEvent.set(eventKey, []);
      byEvent.get(eventKey).push(entry);
    });

    const events = [];
    for (const [eventText, selections] of byEvent) {
      const { home, away } = parseEventTeams(eventText);
      events.push({
        eventText,
        homeTeam: home,
        awayTeam: away,
        selections,
        moneyline: selections.filter((s) => s.marketKind === "ml"),
        handicap: selections.filter((s) => s.marketKind === "ah"),
        totals: selections.filter((s) => s.marketKind === "ou"),
      });
    }

    return {
      ok: events.length > 0 || btns.length > 0,
      frameUrl: location.href,
      isTop: window === window.top,
      buttonCount: btns.length,
      eventCount: events.length,
      events,
    };
  }

  function normalizeQuery(q) {
    return (q || "").replace(/\s+/g, "").toLowerCase();
  }

  /** 팀명으로 배당판 검색 */
  function searchBtiOdds(query) {
    const board = scrapeBoardSelections();
    const q = normalizeQuery(query);

    if (!q) {
      return { ...board, query, hits: board.events, hitCount: board.eventCount };
    }

    const hits = board.events.filter((ev) => {
      const blob = normalizeQuery(`${ev.homeTeam} ${ev.awayTeam} ${ev.eventText}`);
      return blob.includes(q)
        || normalizeQuery(ev.homeTeam).includes(q)
        || normalizeQuery(ev.awayTeam).includes(q);
    });

    const selectionHits = [];
    for (const btn of document.querySelectorAll('button[class*="master_fe_Selections_selection"]')) {
      const parsed = parseSelectionButton(btn);
      if (!parsed) continue;
      const blob = normalizeQuery(`${parsed.label} ${parsed.rawText} ${findEventNameNearButton(btn)}`);
      if (blob.includes(q)) {
        const eventText = findEventNameNearButton(btn);
        const { home, away } = parseEventTeams(eventText);
        selectionHits.push({
          eventText,
          homeTeam: home,
          awayTeam: away,
          selectionText: parsed.label,
          odds: parsed.odds,
          line: parsed.line,
          marketKind: detectMarketType(parsed.rawText),
        });
      }
    }

    return {
      ...board,
      query,
      hits,
      hitCount: hits.length,
      selectionHits,
      selectionHitCount: selectionHits.length,
      slip: readBtiSlip(),
    };
  }

  // ─────────────────────────────────────────────
  // 메시지 핸들러 (기존 popup 호환 + 신규 search)
  // ─────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // 레거시: msg.type
    if (msg.type === "READ_SLIP") {
      sendResponse({ slip: readBtiSlip() });
      return false;
    }
    if (msg.type === "PLACE_BET") {
      placeBtiBet(msg.amount, msg.targetLine, msg.lineTolerance)
        .then((result) => sendResponse(result));
      return true;
    }
    if (msg.type === "VALIDATE_LINE") {
      sendResponse(validateBtiLine(msg.targetLine, msg.tolerance));
      return false;
    }
    if (msg.type === "SEARCH_ODDS" || msg.type === "BTI_SEARCH") {
      sendResponse(searchBtiOdds(msg.query || msg.team || msg.q || ""));
      return false;
    }
    if (msg.type === "SCRAPE_BOARD") {
      sendResponse(scrapeBoardSelections());
      return false;
    }
    if (msg.type === "PING") {
      sendResponse({
        ok: true,
        version: VERSION,
        href: location.href,
        isTop: window === window.top,
        buttonCount: document.querySelectorAll('button[class*="master_fe_Selections_selection"]').length,
        hasSlip: !!readBtiSlip(),
      });
      return false;
    }

    // 신규 background broadcast: msg.target === 'bti'
    if (msg.target === "bti") {
      (async () => {
        if (msg.action === "collectOdds") {
          sendResponse(scrapeBoardSelections());
        } else if (msg.action === "search") {
          sendResponse(searchBtiOdds(msg.query || ""));
        } else if (msg.action === "ping") {
          sendResponse({
            ok: true,
            version: VERSION,
            href: location.href,
            isTop: window === window.top,
            buttonCount: document.querySelectorAll('button[class*="master_fe_Selections_selection"]').length,
          });
        } else {
          sendResponse({ ok: false, error: "unknown_action" });
        }
      })();
      return true;
    }

    return false;
  });

  // ── MutationObserver: 슬립 변화 감지 ──
  (function startBtiObserver() {
    let lastOddsKey = "";
    let debounceTimer = null;

    function checkAndNotify() {
      const slip = readBtiSlip();
      if (!slip) return;
      const key = `${slip.odds}_${slip.marketKey}_${slip.selectionText}`;
      if (key === lastOddsKey) return;
      lastOddsKey = key;
      try {
        chrome.runtime.sendMessage({ type: "ODDS_CHANGED", source: "bti", slip });
      } catch (_) {}
    }

    function scheduleCheck() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(checkAndNotify, 30);
    }

    if (document.body) {
      const observer = new MutationObserver(scheduleCheck);
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class"],
      });
      checkAndNotify();
    }
  })();

  console.log(`[BTI봇] content script 로드됨 (v${VERSION})`, location.href, "top=", window === window.top);
})();
