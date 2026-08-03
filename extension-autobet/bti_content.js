// BTI content script v2.22
// 실제 DOM 구조 (진단 결과 기준):
// ─ 슬립 카드: [class*="betslip_fe_BetSecondary_bet"] (wrapper/counter/badge 제외)
//     선택명: [class*="betInformation__title"][0] → "삼성 라이온스" (팀명 또는 "언더 16")
//     마켓명: [class*="betInformation__title"][1] → "[7:5] 라이브 승패 라이브 베팅"
//     이벤트: [class*="betInformation__eventName"] → "NC 다이노스 vs 삼성 라이온스"
//     배당: 슬립 카드 안에 배당 숫자 없음 → 배당판 버튼에서 읽어야 함
// ─ 배당판 버튼: button.master_fe_Selections_selection
//     텍스트: "삼성 라이온스-1.51.90" (팀명+기준점+배당 붙어있음)
//     배당 span: [class*="master_fe_Selections_odds"] → "1.90"
//     기준점 span: [class*="master_fe_Selections_points"] 또는 [class*="selectionNameLine"]
//     팀명 span: span:not([class]) 또는 빈 클래스 span
// ─ 금액 입력: input#counter (class: betslip_fe_CounterSecondary_input)
// ─ 베팅 버튼: button.sportsbook-Button (텍스트: "베팅하기")

// BTI content script v2.24

function parseOddsText(txt) {
  const t = String(txt || '').trim();
  const n = parseFloat(t);
  if (!n || n <= 1.01 || n >= 100) return null;
  if (!/^\d+(\.\d{1,4})?$/.test(t)) return null;
  return n;
}

function isStruckThrough(el) {
  if (!el || el.nodeType !== 1) return false;
  let node = el;
  for (let depth = 0; depth < 4 && node; depth++) {
    try {
      const cs = window.getComputedStyle(node);
      if ((cs.textDecorationLine || '').includes('line-through')) return true;
      if ((cs.textDecoration || '').includes('line-through')) return true;
    } catch (_) {}
    const cn = String(node.className || '');
    if (/\b(old|previous|strike|strikethrough|deprecated|crossed)\b/i.test(cn)) return true;
    node = node.parentElement;
  }
  return false;
}

function looksLikeLineTotal(n, txt, ctx = '') {
  const t = String(txt || '').trim();
  const c = String(ctx || '');
  if (c && /오버|언더|over|under/i.test(c)) {
    const lineM = c.match(/(?:오버|언더|over|under)[\s(]*([\d]+\.?[\d]*)/i);
    if (lineM && Math.abs(parseFloat(lineM[1]) - n) < 0.01) return true;
  }
  if (/^\d+$/.test(t) && n >= 8 && n <= 50) return true;
  if (n >= 10 && n <= 50 && /\.5$/.test(t) && !/^\d+\.\d{2}$/.test(t)) return true;
  return false;
}

function collectLeafOdds(el, out, opts = {}) {
  if (!el || el.nodeType !== 1 || isStruckThrough(el)) return;

  for (const node of el.childNodes) {
    if (node.nodeType !== 3) continue;
    const text = (node.textContent || '').trim();
    const n = parseOddsText(text);
    if (n && !(opts.rejectLines && looksLikeLineTotal(n, text, opts.lineContext))) out.push(n);
  }

  const kids = el.children;
  if (!kids.length) {
    const text = (el.textContent || '').trim();
    const n = parseOddsText(text);
    if (n && !(opts.rejectLines && looksLikeLineTotal(n, text, opts.lineContext))) out.push(n);
    return;
  }
  for (const ch of kids) collectLeafOdds(ch, out, opts);
}

function readOddsFromSlipCard(card) {
  if (!card) return null;
  const lineContext = card.querySelector('[class*="betInformation__title"]')?.textContent || '';
  const leafOpts = { rejectLines: true, lineContext };

  const notifOdds = [];
  for (const notif of card.querySelectorAll('[class*="UpdateNotification"]')) {
    collectLeafOdds(notif, notifOdds, leafOpts);
  }
  if (notifOdds.length) return notifOdds[notifOdds.length - 1];

  for (const sel of ['[class*="odds"]', '[class*="Odds"]', '[class*="price"]', '[class*="Price"]']) {
    const classOdds = [];
    for (const el of card.querySelectorAll(sel)) {
      collectLeafOdds(el, classOdds, leafOpts);
    }
    if (classOdds.length) return classOdds[classOdds.length - 1];
  }

  const atM = (card.textContent || '').match(/@\s*(\d+(?:\.\d{1,4})?)/);
  if (atM) {
    const n = parseOddsText(atM[1]);
    if (n) return n;
  }

  const found = [];
  for (const sp of card.querySelectorAll('span, b, strong')) {
    if (isStruckThrough(sp)) continue;
    const text = (sp.textContent || '').trim();
    if (!/^\d+(\.\d{1,4})?$/.test(text)) continue;
    const n = parseOddsText(text);
    if (!n || looksLikeLineTotal(n, text, lineContext)) continue;
    found.push(n);
  }
  if (found.length) return found[found.length - 1];

  return null;
}

function readOddsFromSelectedBoardButton(selectionText, slipMktType) {
  const selected = [];
  for (const btn of queryBoardButtons()) {
    if (!isElementVisible(btn)) continue;
    if (!isBoardButtonSelected(btn)) continue;
    const parsed = parseSelectionButton(btn);
    if (!parsed?.odds || parsed.odds <= 1.01) continue;
    const raw = (parsed.rawText || '').toLowerCase();
    const isOu = /오버|언더|over|under/i.test(raw);
    const hasHc = /[+-]\d/.test(parsed.pointsText || raw);
    if (slipMktType === 'ml' && (isOu || hasHc)) continue;
    if (slipMktType === 'ah' && isOu) continue;
    if (slipMktType === 'ou' && !isOu) continue;
    selected.push(parsed);
  }
  if (!selected.length) return null;

  const sel = String(selectionText || '').trim();
  if (/^W1$/i.test(sel)) return selected[0]?.odds || null;
  if (/^W2$/i.test(sel)) return (selected.length > 1 ? selected[selected.length - 1] : selected[0])?.odds || null;

  if (sel.length > 1) {
    for (const p of selected) {
      const label = p.label || p.rawText || '';
      if (teamNamesMatch(label, sel) || teamNamesMatch(p.pointsText, sel)) return p.odds;
    }
  }
  return selected[0].odds;
}

function readOddsFromBoardForSelection(selectionText, allText, slipMktType) {
  const fromSelected = readOddsFromSelectedBoardButton(selectionText, slipMktType);
  if (fromSelected > 1.01) return fromSelected;

  const allBtns = queryBoardButtons();
  if (!selectionText) return null;

  const wMatch = String(selectionText).trim().match(/^W([12])$/i);
  if (wMatch && slipMktType === 'ml') {
    const pickFirst = wMatch[1] === '1';
    const wMarket = readWMlOddsFromVisibleBoard(pickFirst ? 1 : 2);
    if (wMarket) return wMarket;
    const mlLines = Array.from(document.querySelectorAll('[class*="MoneyLineSelection_line"]'));
    if (mlLines.length >= 2) {
      const line = pickFirst ? mlLines[0] : mlLines[mlLines.length - 1];
      const oddsEl = line.querySelector('[class*="Selections_odds"], [class*="master_fe_Selections_odds"]');
      const n = oddsEl ? parseOddsText(oddsEl.textContent) : null;
      if (n) return n;
      const btn = line.querySelector('button') || line;
      const parsed = parseSelectionButton(btn);
      if (parsed?.odds) return parsed.odds;
    }
    const mlBtns = Array.from(allBtns).filter((b) =>
      b.querySelector('[class*="Selections_odds"], [class*="master_fe_Selections_odds"]')
    );
    if (mlBtns.length >= 2) {
      const btn = pickFirst ? mlBtns[0] : mlBtns[1];
      const parsed = parseSelectionButton(btn);
      if (parsed?.odds) return parsed.odds;
    }
  }

  const slipLineMatch = selectionText.match(/([+-]\d+\.?\d*)\s*$/);
  const slipLine = slipLineMatch ? parseFloat(slipLineMatch[1]) : null;
  const teamName = slipLine !== null
    ? selectionText.replace(slipLineMatch[0], '').trim()
    : selectionText.replace(/^W[12]\s*/i, '').trim();
  const teamClean = teamName.replace(/\s+/g, '').toLowerCase();

  // ML: MoneyLineSelection 순서 (첫=home, 마지막=away)
  if (slipMktType === 'ml' && teamClean.length > 1) {
    const mlLines = Array.from(document.querySelectorAll('[class*="MoneyLineSelection_line"]'));
    if (mlLines.length >= 2) {
      for (let i = 0; i < mlLines.length; i++) {
        const lineText = (mlLines[i].textContent || '').replace(/\s+/g, '').toLowerCase();
        if (!lineText.includes(teamClean) && !teamClean.includes(lineText.slice(0, 6))) continue;
        const oddsEl = mlLines[i].querySelector('[class*="Selections_odds"], [class*="master_fe_Selections_odds"]');
        const n = oddsEl ? parseOddsText(oddsEl.textContent) : null;
        if (n) return n;
        const btn = mlLines[i].querySelector('button') || mlLines[i];
        const parsed = parseSelectionButton(btn);
        if (parsed?.odds) return parsed.odds;
      }
    }
  }

  for (const btn of allBtns) {
    const parsed = parseSelectionButton(btn);
    if (!parsed) continue;
    const raw = parsed.rawText || '';
    const isOu = /오버|언더|over|under/i.test(raw);
    const hasHc = /[+-]\d/.test(parsed.pointsText || raw);
    if (slipMktType === 'ml' && (isOu || hasHc)) continue;
    if (slipMktType === 'ah' && isOu) continue;
    if (slipMktType === 'ou' && !isOu) continue;

    const btnClean = (parsed.label || parsed.rawText || '').replace(/\s+/g, '').toLowerCase();
    if (teamClean.length > 1 && !btnClean.includes(teamClean) && !teamClean.includes(btnClean.slice(0, 6))) {
      continue;
    }
    if (slipLine !== null && parsed.line != null && Math.abs(parsed.line - slipLine) > 0.02) continue;

    if (slipMktType === 'ou') {
      const ouMatch = selectionText.match(/(오버|언더|over|under)\s*([\d.]+)/i);
      if (ouMatch) {
        const wantSide = (ouMatch[1].toLowerCase().includes('언더') || ouMatch[1].toLowerCase() === 'under') ? 'u' : 'o';
        const wantLine = parseFloat(ouMatch[2]);
        const btnSide = /언더|under/i.test(raw) ? 'u' : 'o';
        if (btnSide !== wantSide) continue;
        if (parsed.line != null && Math.abs(parsed.line - wantLine) > 0.02) continue;
      }
    }

    if (teamClean.length > 1 && btnClean.includes(teamClean)) return parsed.odds;
  }
  return null;
}

function isSlipCardSuspended(card) {
  const cardText = (card.innerText || card.textContent || '').replace(/\s+/g, ' ');
  if (/정지된|정지됨|마감|closed|suspended|locked|unavailable/i.test(cardText)) return true;
  for (const sp of card.querySelectorAll('span, div, label')) {
    const t = (sp.textContent || '').trim();
    if (/^정지된$|^정지$|^마감$|^Suspended$|^Closed$/i.test(t)) return true;
  }
  return false;
}

function readBtiSlip(hint) {
  const realCards = getRealSlipCards();
  if (!realCards.length) return null;

  const preferActive = hint?.preferActiveSlip || hint?.forArbPick === false;

  if (preferActive) {
    for (let i = realCards.length - 1; i >= 0; i--) {
      const slip = parseSlipFromCard(realCards[i]);
      if (slip?.odds > 1.01) return enrichBtiSlip(slip);
    }
    return null;
  }

  let best = null;
  for (let i = realCards.length - 1; i >= 0; i--) {
    const slip = parseSlipFromCard(realCards[i]);
    if (!slip?.odds || slip.odds <= 1.01) continue;
    if (hint?.excludeTeam || hint?.polyTeam) {
      const oppose = hint.excludeTeam || hint.polyTeam;
      const sel = slip.selectionText || slip.teamLabel || '';
      if (teamNamesMatch(sel, oppose)) continue;
      if (teamNamesMatch(slip.homeTeam, oppose) && (slip.side === 'home' || slip.side === 'h')) continue;
      if (teamNamesMatch(slip.awayTeam, oppose) && (slip.side === 'away' || slip.side === 'a')) continue;
    }
    if (hint?.side === 'away' && slip.side === 'home' && /^W1$/i.test(slip.selectionText || '')) continue;
    if (hint?.side === 'home' && slip.side === 'away' && /^W2$/i.test(slip.selectionText || '')) continue;
    if (!best) best = enrichBtiSlip(slip);
  }
  return best;
}

let btiOddsLatch = { odds: 0, source: '', at: 0, key: '' };

function finalizeBtiOdds(slip) {
  if (!(slip?.odds > 1.01)) return slip;
  const src = slip.source || '';
  const trusted = slip.fromSlip === true
    || src === 'slip-display' || src === 'slip-card' || src === 'slip-latched'
    || src === 'board-live' || src === 'board' || src === 'board-emergency'
    || src === 'bti-api' || String(src).includes('bti-api');
  if (!trusted) return null;

  const o = Math.round(slip.odds * 1000) / 1000;
  const key = `${slip.selectionText || slip.teamLabel || ''}_${slip.marketKey || ''}_${slip.eventText || ''}`;
  const fromSlipCard = src === 'slip-display' || src === 'slip-card' || src === 'slip-latched'
    || src === 'bti-api' || String(src).includes('bti-api') || slip.fromSlip === true;
  if (fromSlipCard) {
    btiOddsLatch = { odds: o, source: 'slip', at: Date.now(), key };
  }
  return {
    ...slip,
    odds: o,
    fromSlip: fromSlipCard
  };
}

function parseSlipFromCard(card) {
  if (!card) return null;
  if (isSlipCardSuspended(card)) return null;
  if (isInsideBetHistory(card) || !isCardVisible(card)) return null;

  const titleEls = card.querySelectorAll('[class*="betInformation__title"]');
  const selectionText = titleEls[0] ? titleEls[0].textContent.trim() : '';
  const marketTitleText = titleEls[1] ? titleEls[1].textContent.trim() : '';
  const eventEl = card.querySelector('[class*="eventName"], [class*="betInformation__eventName"]');
  const eventText = eventEl ? eventEl.textContent.trim() : '';
  const mktEl = card.querySelector('[class*="betInformation__marketName"]');
  const mktText = mktEl ? mktEl.textContent.trim() : marketTitleText;
  const allText = `${selectionText} ${mktText} ${marketTitleText}`;
  const slipMktType = detectMarketType(allText);
  const slipCardOdds = readOddsFromSlipCard(card);

  if (/^W[12]$/i.test(selectionText.trim())) {
    let odds = slipCardOdds;
    if (!odds) {
      odds = readOddsFromSelectedBoardButton(selectionText, slipMktType);
      if (!odds) odds = readOddsFromBoardForSelection(selectionText, allText, slipMktType);
      if (!odds) {
        const teams = parseEventTeams(eventText);
        const side = /^W2$/i.test(selectionText.trim()) ? 'away' : 'home';
        const teamLabel = side === 'away' ? teams.away : teams.home;
        if (teamLabel) odds = readOddsFromBoardForSelection(teamLabel, allText, slipMktType);
      }
    }
    if (!odds) return null;
    const period = 'ft';
    const side = /^W2$/i.test(selectionText.trim()) ? 'away' : 'home';
    const resolvedEventText = eventText || findEventNameNearButton(document.querySelector('button[class*="master_fe_Selections_selection"]'));
    const teams = parseEventTeams(resolvedEventText);
    return {
      odds: Math.round(odds * 1000) / 1000,
      eventId: (location.href.match(/\/(\d{10,20})(?:\/|$|\?|#)/) || [])[1] || null,
      marketKind: 'ml',
      period,
      side,
      line: null,
      marketKey: `${period}_ml_${side}`,
      mktText,
      selectionText,
      eventText: resolvedEventText,
      homeTeam: teams.home,
      awayTeam: teams.away,
      fromSlip: !!slipCardOdds,
      source: slipCardOdds ? 'slip-card' : 'board-live'
    };
  }

  let odds = slipCardOdds || 0;
  let matchedLine = null;
  let matchedSide = null;
  const allBtns = document.querySelectorAll('button[class*="master_fe_Selections_selection"]');

  if (!odds && selectionText) {
    const slipLineMatch = selectionText.match(/([+-]\d+\.?\d*)\s*$/);
    const slipLine = slipLineMatch ? parseFloat(slipLineMatch[1]) : null;
    const teamName = slipLine !== null
      ? selectionText.replace(slipLineMatch[0], '').trim()
      : selectionText;

    if (slipLine !== null) {
      for (const btn of allBtns) {
        const oddsEl = btn.querySelector('[class*="master_fe_Selections_odds"]');
        if (!oddsEl) continue;
        const btnOdds = parseFloat(oddsEl.textContent.trim());
        if (!btnOdds || btnOdds <= 1.01 || btnOdds >= 100) continue;
        const pointsEl = btn.querySelector('[class*="master_fe_Selections_points"], [class*="selectionNameLine"]');
        if (!pointsEl) continue;
        const pointsText = pointsEl.textContent.trim();
        const pointsLineMatch = pointsText.match(/([+-]\d+\.?\d*)\s*$/);
        if (!pointsLineMatch) continue;
        const pointsLine = parseFloat(pointsLineMatch[1]);
        if (Math.abs(pointsLine - slipLine) < 0.01) {
          const pointsClean = pointsText.replace(/\s+/g, '').toLowerCase();
          const teamClean = teamName.replace(/\s+/g, '').toLowerCase();
          if (pointsClean.includes(teamClean) || teamClean.length < 2) {
            odds = btnOdds;
            matchedLine = pointsLine;
            break;
          }
        }
      }
    }

    if (!odds) {
      const candidates = [];
      for (const btn of allBtns) {
        const btnText = btn.textContent || '';
        const oddsEl = btn.querySelector('[class*="master_fe_Selections_odds"]');
        if (!oddsEl) continue;
        const btnOdds = parseFloat(oddsEl.textContent.trim());
        if (!btnOdds || btnOdds <= 1.01 || btnOdds >= 100) continue;
        const btnTextClean = btnText.replace(/\s+/g, '');
        const selClean = selectionText.replace(/\s+/g, '');
        if (btnTextClean.includes(selClean) || selClean.includes(btnTextClean.replace(/[\d.]+$/, ''))) {
          const pointsEl = btn.querySelector('[class*="master_fe_Selections_points"], [class*="selectionNameLine"]');
          const pointsText = pointsEl ? pointsEl.textContent.trim() : '';
          const hasHandicap = /[+-]\d/.test(pointsText);
          const isOuBtn = /오버|언더|over|under/i.test(btnText);
          candidates.push({ btn, btnOdds, hasHandicap, isOuBtn });
        }
      }
      let chosen = null;
      if (slipMktType === 'ml') {
        chosen = candidates.find((c) => !c.hasHandicap && !c.isOuBtn)
          || candidates.find((c) => !c.isOuBtn)
          || candidates[0];
      } else if (slipMktType === 'ah') {
        chosen = candidates.find((c) => c.hasHandicap) || candidates[0];
      } else {
        chosen = candidates[0];
      }
      if (chosen) {
        odds = chosen.btnOdds;
        const pointsEl = chosen.btn.querySelector('[class*="master_fe_Selections_points"], [class*="selectionNameLine"]');
        if (pointsEl) {
          const pm = pointsEl.textContent.trim().match(/([+-]?\d+\.?\d*)/);
          if (pm) matchedLine = parseFloat(pm[1]);
        }
        if (matchedLine === null) {
          const lineM = chosen.btn.textContent.match(/([+-]?\d+\.?\d*)(?=\s*\d+\.\d{2,4})/);
          if (lineM) matchedLine = parseFloat(lineM[1]);
        }
        if (/언더|under/i.test(chosen.btn.textContent)) matchedSide = 'u';
        else if (/오버|over/i.test(chosen.btn.textContent)) matchedSide = 'o';
      }
    }

    if (!odds) {
      const ouMatch = selectionText.match(/(오버|언더|over|under)[\s(]*([\d]+\.?[\d]*)/i);
      if (ouMatch) {
        const targetSide = /언더|under/i.test(ouMatch[1]) ? 'u' : 'o';
        const targetLine = parseFloat(ouMatch[2]);
        for (const btn of allBtns) {
          const btnText = btn.textContent || '';
          const oddsEl = btn.querySelector('[class*="master_fe_Selections_odds"]');
          if (!oddsEl) continue;
          const btnOdds = parseFloat(oddsEl.textContent.trim());
          if (!btnOdds || btnOdds <= 1.01 || btnOdds >= 100) continue;
          const btnSide = /언더|under/i.test(btnText) ? 'u' : 'o';
          if (btnSide !== targetSide) continue;
          const pointsEl = btn.querySelector('[class*="master_fe_Selections_points"], [class*="selectionNameLine"]');
          let btnLine = null;
          if (pointsEl) {
            const pm = pointsEl.textContent.trim().match(/(\d+\.?\d*)/);
            if (pm) btnLine = parseFloat(pm[1]);
          }
          if (btnLine === null) {
            const lm = btnText.replace(/언더|오버|under|over/gi, '').match(/(\d+\.?\d*)/);
            if (lm) btnLine = parseFloat(lm[1]);
          }
          if (btnLine !== null && Math.abs(btnLine - targetLine) < 0.01) {
            odds = btnOdds;
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
          const btnText = btn.textContent || '';
          const oddsEl = btn.querySelector('[class*="master_fe_Selections_odds"]');
          if (!oddsEl) continue;
          const btnOdds = parseFloat(oddsEl.textContent.trim());
          if (!btnOdds || btnOdds <= 1.01 || btnOdds >= 100) continue;
          const pointsEl = btn.querySelector('[class*="master_fe_Selections_points"], [class*="selectionNameLine"]');
          let btnLine = null;
          if (pointsEl) {
            const pm = pointsEl.textContent.trim().match(/([+-]?\d+\.?\d*)/);
            if (pm) btnLine = parseFloat(pm[1]);
          }
          if (btnLine === null) {
            const lm = btnText.match(/([+-]\d+\.?\d*)/);
            if (lm) btnLine = parseFloat(lm[1]);
          }
          if (btnLine !== null && Math.abs(btnLine - targetLine) < 0.01) {
            odds = btnOdds;
            matchedLine = btnLine;
            break;
          }
        }
      }
    }
  }

  if (!odds) odds = readOddsFromBoardForSelection(selectionText, allText, slipMktType);
  if (!odds && isSlipCardSuspended(card)) return null;
  if (!odds || odds <= 1.01) return null;
  odds = Math.round(odds * 1000) / 1000;

  const period = detectPeriod(allText);
  const type = mktText ? detectMarketType(mktText) : detectMarketType(allText);
  const side = (type === 'ou' && matchedSide) ? matchedSide : detectSideFromSlipText(selectionText || allText, type);
  const line = matchedLine !== null ? matchedLine : detectLineFromSlipText(selectionText || allText);
  const marketKey = type === 'ml'
    ? `${period}_ml_${side}`
    : type === 'ah'
      ? `${period}_ah_${side}_${line}`
      : `${period}_ou_${side}_${line}`;
  const urlMatch = location.href.match(/\/(\d{10,20})(?:\/|$|\?|#)/);
  const teams = parseEventTeams(eventText);
  const fromSlipCard = !!slipCardOdds;

  return {
    odds,
    eventId: urlMatch ? urlMatch[1] : null,
    marketKind: type,
    period,
    side,
    line,
    marketKey,
    mktText,
    selectionText,
    eventText,
    homeTeam: teams.home,
    awayTeam: teams.away,
    fromSlip: fromSlipCard,
    source: fromSlipCard ? 'slip-card' : 'board-live'
  };
}

function detectPeriod(text) {
  const t = text.toLowerCase();
  if (t.includes('전반전') || t.includes('1st half') || t.includes('halftime')) return '1h';
  if (t.includes('후반전') || t.includes('2nd half')) return '2h';
  if (/[23]세트|[23]rd set|[23]nd set/i.test(t)) return 'set';
  return 'ft';
}

function detectSideFromSlipText(text, type) {
  const t = text.toLowerCase();
  if (/^W2$/i.test(text.trim())) return 'away';
  if (/^W1$/i.test(text.trim())) return 'home';
  if (type === 'ou') return (t.includes('언더') || t.includes('under')) ? 'u' : 'o';
  if (type === 'ah') return (t.includes('어웨이') || t.includes('away')) ? 'a' : 'h';
  if (t.includes('무승부') || t.includes('draw')) return 'draw';
  if (t.includes('어웨이') || t.includes('away')) return 'away';
  return 'home';
}

function detectLineFromSlipText(text) {
  const m = text.match(/(?:오버|언더|over|under)[\s(]*([\d]+\.?[\d]*)/i);
  if (m) return parseFloat(m[1]);
  const m2 = text.match(/([+-]\d+\.?\d*)/);
  if (m2) return parseFloat(m2[1]);
  const m3 = text.match(/([\d]+\.[\d]+)/);
  if (m3) return parseFloat(m3[1]);
  return null;
}

// ── BTI 기준점 검증 ──
function validateBtiLine(targetLine, tolerance) {
  const slip = readBtiSlip();
  if (!slip) return { valid: false, reason: '슬립 없음' };
  if (slip.line === null) return { valid: false, reason: '기준점 파싱 실패' };
  const diff = Math.abs(slip.line - targetLine);
  if (diff > tolerance) {
    return {
      valid: false,
      reason: `기준점 불일치: 목표=${targetLine}, 실제=${slip.line}("${slip.selectionText}"), 차이=${diff.toFixed(2)}`,
      actualLine: slip.line,
      selectionText: slip.selectionText
    };
  }
  return { valid: true, actualLine: slip.line, selectionText: slip.selectionText };
}

function slipOddsFromText(txt) {
  const t = String(txt || '').trim();
  const n = parseFloat(t);
  if (!n || n <= 1.01 || n >= 100) return 0;
  if (!/^\d+(\.\d{1,4})?$/.test(t)) return 0;
  return n;
}

function readWMlOddsFromVisibleBoard(wNum) {
  const pickSecond = wNum === 2;
  const marketRoots = document.querySelectorAll(
    '[class*="market"], [class*="Market"], [class*="selections"], [class*="Selections"]'
  );
  for (const mkt of marketRoots) {
    const label = (mkt.querySelector('[class*="marketName"], [class*="MarketName"]')?.textContent || mkt.textContent || '').slice(0, 120);
    if (!/승리|winner|winning|money|승패|win\s*team|맵.*우승|map.*winner|우승자/i.test(label)) continue;
    const btns = Array.from(mkt.querySelectorAll('button[class*="master_fe_Selections_selection"]'))
      .map((b) => parseSelectionButton(b))
      .filter((p) => p?.odds && p.element && isElementVisible(p.element));
    if (btns.length >= 2) {
      const pick = pickSecond ? btns[btns.length - 1] : btns[0];
      return pick.odds;
    }
  }

  const visible = Array.from(document.querySelectorAll('button[class*="master_fe_Selections_selection"]'))
    .map((b) => parseSelectionButton(b))
    .filter((p) => {
      if (!p?.odds || !p.element || !isElementVisible(p.element)) return false;
      const raw = (p.rawText || '').toLowerCase();
      if (raw.includes('오버') || raw.includes('언더') || raw.includes('over') || raw.includes('under')) return false;
      if (/[+-]\d/.test(p.pointsText || '')) return false;
      return true;
    });
  if (visible.length >= 2) {
    const pick = pickSecond ? visible[visible.length - 1] : visible[0];
    return pick.odds;
  }
  return null;
}

function readSlipLooseFromPanel(_hint) {
  // 베팅내역/패널 @배당 텍스트는 절대 읽지 않음 (배당판만 사용)
  return null;
}

function isInsideBetHistory(el) {
  let node = el;
  for (let i = 0; i < 18 && node; i++) {
    const cn = String(node.className || '');
    const id = String(node.id || '');
    const testId = String(node.getAttribute?.('data-testid') || '');
    const role = String(node.getAttribute?.('role') || '');
    const aria = String(node.getAttribute?.('aria-label') || '');
    const blob = `${cn} ${id} ${testId} ${role} ${aria}`.toLowerCase();
    if (/mybets|my-bets|my_bets|bet-history|bethistory|betsliphistory|openbets|settledbets|bet_history|historybets|pastbets|open-bets|mybet|mybetslist/i.test(blob)) return true;
    if (/내베팅|베팅내역|배팅내역|마이베팅/i.test(blob)) return true;
    if (node.matches?.('[class*="myBets"], [class*="MyBets"], [class*="openBets"], [class*="OpenBets"], [class*="betHistory"], [class*="BetHistory"]')) return true;
    node = node.parentElement;
  }
  return false;
}

function isCardVisible(el) {
  if (!el || !el.isConnected) return false;
  if (isElementVisible(el)) return true;
  return isDomVisible(el);
}

function scoreSlipCard(card) {
  if (!card || !isCardVisible(card) || isInsideBetHistory(card)) return -1;
  if (card.closest('[class*="myBets"], [class*="MyBets"], [class*="betHistory"], [class*="BetHistory"]')) return -1;
  let score = 0;
  const input = findBtiBetInput();
  if (input) {
    const slipRoot = input.closest('[class*="betslip"], [class*="Betslip"], [class*="betslip_fe"]');
    if (slipRoot?.contains(card)) score += 120;
  }
  if (card.closest('[class*="betslip_fe"], [class*="Betslip"]')) score += 60;
  if (card.querySelector('input[id="counter"], input[class*="Counter"]')) score -= 80;
  return score;
}

function isDomVisible(el) {
  if (!el || !el.isConnected) return false;
  if (!isElementVisible(el)) return false;
  let node = el;
  for (let i = 0; i < 14 && node; i++) {
    if (node.getAttribute?.('aria-hidden') === 'true') return false;
    if (node.hasAttribute?.('hidden')) return false;
    try {
      const st = window.getComputedStyle(node);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    } catch (_) {}
    node = node.parentElement;
  }
  return true;
}

function normalizeTabLabel(el) {
  return String(el?.textContent || '').replace(/\s+/g, '').replace(/\d+/g, '').toLowerCase();
}

function isTabElementActive(tab) {
  if (!tab) return false;
  if (tab.classList?.contains('active') || tab.classList?.contains('selected') ||
      tab.classList?.contains('isActive') || tab.getAttribute?.('aria-selected') === 'true' ||
      tab.getAttribute?.('data-active') === 'true') return true;
  const cn = String(tab.className || '');
  return /active|selected|current/i.test(cn) && !/inactive/i.test(cn);
}

function findBtiSideTabs() {
  const tabs = [];
  const seen = new Set();
  const scope = document.querySelector('[class*="betslip_fe"], [class*="Betslip"], [class*="rightPanel"], [class*="RightPanel"]') || document;
  const candidates = scope.querySelectorAll(
    '[class*="tabs__tab"], [class*="Tabs"] [class*="Tab"], [class*="betslip"] [class*="tab"]'
  );
  for (const el of candidates) {
    if (seen.has(el)) continue;
    const raw = String(el.textContent || '').replace(/\s+/g, ' ').trim();
    const label = normalizeTabLabel(el);
    if (!label && !raw) continue;
    const isSlip = /베팅\s*슬립/i.test(raw) || label === '베팅슬립' || label === 'betslip';
    const isHistory = /내\s*베팅/i.test(raw) || label === '내베팅' || label === 'mybets' ||
      /베팅\s*내역|배팅\s*내역/i.test(raw);
    if (!isSlip && !isHistory) continue;
    seen.add(el);
    tabs.push({ el, isSlip, isHistory, active: isTabElementActive(el) });
  }
  return tabs;
}

function isMyBetsTabActive() {
  const tabs = findBtiSideTabs();
  if (!tabs.length) return false;
  const historyActive = tabs.some((t) => t.isHistory && t.active);
  const slipActive = tabs.some((t) => t.isSlip && t.active);
  return historyActive && !slipActive;
}

function getActiveBetslipPanelRoot() {
  if (isMyBetsTabActive()) return null;

  const tabs = findBtiSideTabs();
  const slipTab = tabs.find((t) => t.isSlip && t.active);
  if (slipTab) {
    const container = slipTab.el.closest(
      '[class*="tabs"], [class*="Tabs"], [class*="betslip"], [class*="Betslip"], [class*="rightPanel"], [class*="RightPanel"]'
    );
    if (container) {
      const panels = container.querySelectorAll(
        '[class*="tabContent"], [class*="tab-content"], [class*="tabs__content"], [class*="TabContent"], [class*="panel"]'
      );
      for (const panel of panels) {
        if (!isDomVisible(panel) || isInsideBetHistory(panel)) continue;
        if (panel.querySelector('[class*="betInformation__title"], [data-editor-id="betslipSelectionOdd"]')) {
          return panel;
        }
      }
      if (isDomVisible(container) && !isInsideBetHistory(container)) return container;
    }
  }

  const visibleTitle = Array.from(document.querySelectorAll('[class*="betInformation__title"]'))
    .find((el) => isDomVisible(el) && !isInsideBetHistory(el));
  if (visibleTitle) {
    return visibleTitle.closest(
      '[class*="betslipTabContent"], [class*="betslip"], [class*="Betslip"], [class*="betslip_fe"], [class*="rightPanel"]'
    ) || document.body;
  }

  const slipRoot = document.querySelector('[class*="betslip_fe"], [class*="Betslip"]');
  if (slipRoot && isDomVisible(slipRoot) && !isInsideBetHistory(slipRoot)) return slipRoot;

  return null;
}

function readSlipOddsFromCardElement(card) {
  if (!card || isInsideBetHistory(card)) return null;
  const txt = (card.textContent || '').trim();
  if (txt.length < 6 || txt.length > 900) return null;
  if (card.querySelector('input[id="counter"], input[class*="Counter"]')) return null;

  const titleEls = card.querySelectorAll('[class*="betInformation__title"]');
  const selectionText = titleEls[0]?.textContent?.trim() || '';
  const allText = `${selectionText} ${txt}`;
  const mktType = detectMarketType(allText);
  if (!selectionText && !/W[12]/i.test(txt) && mktType === 'ml') return null;

  const slip = parseSlipFromCard(card);
  if (!(slip?.odds > 1.01)) return null;
  return enrichBtiSlip(slip);
}

function slipUiLikelyOpen() {
  return isActiveBetslipOpen() || hasVisibleBetslipCards();
}

function readActiveSlipDisplayOdds() {
  if (!slipUiLikelyOpen()) return null;
  const cards = getRealSlipCards();
  if (!cards.length) return null;
  for (let i = cards.length - 1; i >= 0; i--) {
    const slip = readSlipOddsFromCardElement(cards[i]);
    if (slip?.odds > 1.01) return slip;
  }
  return null;
}

function getRealSlipCards() {
  if (isMyBetsTabActive()) return [];

  const selectors = [
    '[class*="betslip_fe_BetSecondary_bet"]',
    '[class*="BetSecondary_bet"]',
    '[class*="betslip"][class*="bet"]'
  ];
  const seen = new Set();
  const scored = [];

  const consider = (el) => {
    if (!el || seen.has(el)) return;
    const score = scoreSlipCard(el);
    if (score < 0) return;
    seen.add(el);
    scored.push({ el, score });
  };

  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      const cn = String(el.className || '');
      if (cn.includes('wrapper') || cn.includes('counter') || cn.includes('bageGroup') ||
          cn.includes('badge') || cn.includes('PlaceBet') || cn.includes('Tab')) continue;
      const hasTitle = el.querySelector('[class*="betInformation__title"]');
      const txt = el.textContent || '';
      const hasOdds = /@\s*\d+\.\d+/.test(txt)
        || el.querySelector('[class*="UpdateNotification"]')
        || el.querySelector('[class*="odds"], [class*="Odds"]')
        || /\b\d+\.\d{2,3}\b/.test(txt);
      if (!hasTitle && !hasOdds) continue;
      consider(el);
    }
  }

  if (!scored.length) {
    for (const el of document.querySelectorAll('[class*="betInformation__title"]')) {
      const card = el.closest('[class*="bet"]') || el.closest('[class*="Bet"]') || el.parentElement?.parentElement;
      if (!card) continue;
      const txt = card.textContent || '';
      if (txt.length < 8 || txt.length > 800) continue;
      if (!/W[12]|@\s*\d+\.\d{2}|베팅|bet/i.test(txt)) continue;
      consider(card);
    }
  }

  if (!scored.length) {
    const slipRoot = document.querySelector('[class*="betslip_fe"], [class*="Betslip"]');
    if (slipRoot) {
      for (const el of slipRoot.querySelectorAll('div, section, article, li')) {
        const txt = (el.textContent || '').trim();
        if (txt.length < 10 || txt.length > 400) continue;
        if (!/W[12]/i.test(txt) && !/@\s*\d+\.\d{2}/.test(txt)) continue;
        if (el.querySelector('input[id="counter"], input[class*="Counter"]')) continue;
        consider(el);
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const cards = scored.map((x) => x.el);
  if (cards.length > 1) {
    return cards.filter((c) => !cards.some((other) => other !== c && c.contains(other)));
  }
  return cards;
}

function findBtiClearAllButton() {
  for (const btn of document.querySelectorAll('button, [role="button"]')) {
    const cn = String(btn.className || '');
    if (cn.includes('clearAll') || cn.includes('ClearAll')) return btn;
    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    if (/전체\s*삭제|모두\s*삭제|clear\s*all|delete\s*all|슬립\s*비우|베팅\s*정리/i.test(t)) return btn;
  }
  return null;
}

function clickBtiSlipRemoveButtons() {
  let clicked = 0;
  const slipRoot = document.querySelector('[class*="betslip_fe"], [class*="Betslip"]');
  if (!slipRoot) return 0;
  for (const btn of slipRoot.querySelectorAll('button, [role="button"]')) {
    const cn = String(btn.className || '');
    const t = (btn.textContent || '').trim();
    const aria = btn.getAttribute('aria-label') || '';
    if (cn.includes('clearAll') || cn.includes('PlaceBetBlock')) continue;
    if (cn.includes('remove') || cn.includes('Remove') || cn.includes('delete') || cn.includes('Delete')
      || /^[x×✕✖]$/i.test(t) || /remove|delete|삭제|제거|close/i.test(`${aria} ${t}`)) {
      try { btn.click(); clicked++; } catch (_) {}
    }
  }
  return clicked;
}

async function clearAllBtiSlips() {
  if (!isActiveBetslipOpen() && !hasVisibleBetslipCards()) {
    return { ok: true, cleared: 0, alreadyEmpty: true };
  }
  const before = getRealSlipCards().length;
  if (!before) return { ok: true, cleared: 0, alreadyEmpty: true };

  for (let round = 0; round < 8; round++) {
    const clearBtn = findBtiClearAllButton();
    if (clearBtn) {
      try { clearBtn.click(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 220));
    }
    clickBtiSlipRemoveButtons();
    await new Promise((r) => setTimeout(r, 280));
    const left = getRealSlipCards().length;
    if (!left) return { ok: true, cleared: before, rounds: round + 1 };
  }
  const left = getRealSlipCards().length;
  return { ok: left === 0, cleared: Math.max(0, before - left), slipLeft: left };
}

function readSlipOddsFromDom() {
  const slip = readBtiOdds();
  return slip?.odds > 1.01 ? slip.odds : 0;
}

function validateBtiOdds(targetOdds, tolerance = 0.06) {
  if (!targetOdds || targetOdds <= 1) return { valid: true };
  const curOdds = readSlipOddsFromDom();
  if (!curOdds) return { valid: true };
  if (Math.abs(curOdds - targetOdds) > tolerance) {
    return {
      valid: false,
      reason: `배당 변경: 목표=${targetOdds}, 현재=${curOdds}`,
      oddsChanged: true,
      actualOdds: curOdds
    };
  }
  return { valid: true, actualOdds: curOdds };
}

function findBtiBetInput() {
  const direct = document.getElementById('counter')
    || document.querySelector('input[class*="CounterSecondary_input"], input[class*="counter__input"], input[placeholder="베팅금"], input[placeholder*="베팅"], input[class*="counter"], input[class*="Counter"]');
  if (direct) return direct;

  function walk(root) {
    if (!root?.querySelectorAll) return null;
    for (const inp of root.querySelectorAll('input, textarea')) {
      const ph = inp.placeholder || '';
      const cls = String(inp.className || '');
      const id = inp.id || '';
      if (id === 'counter' || /counter|Counter|베팅/i.test(cls + ph + id)) return inp;
    }
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const found = walk(el.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(document);
}

function readBtiStake() {
  const input = findBtiBetInput();
  if (!input) return 0;
  const raw = String(input.value || '').replace(/,/g, '').trim();
  const v = parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function hasVisibleBetslipCards() {
  if (isMyBetsTabActive()) return false;
  if (getRealSlipCards().length > 0) return true;
  for (const el of document.querySelectorAll(
    '[class*="betslip_fe"] [class*="betInformation__title"], [class*="BetSecondary_bet"] [class*="betInformation__title"], [class*="betInformation__eventName"]'
  )) {
    if (isInsideBetHistory(el)) continue;
    if (isCardVisible(el)) return true;
  }
  return false;
}

function isActiveBetslipOpen() {
  const input = findBtiBetInput();
  if (input) {
    const r = input.getBoundingClientRect();
    if (r && r.width >= 4 && r.height >= 4) {
      try {
        const st = window.getComputedStyle(input);
        if (st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) !== 0) return true;
      } catch (_) {
        return true;
      }
    }
  }
  if (hasVisibleBetslipCards()) return true;
  const betBtn = findBtiBetButton();
  if (betBtn && /베팅|bet/i.test(betBtn.textContent || '')) return true;
  return false;
}

function probeBtiBetFrame() {
  const odds = readBtiOdds();
  const cards = getRealSlipCards();
  const input = findBtiBetInput();
  const betBtn = findBtiBetButton();
  const hasSlip = cards.length > 0 || (odds?.odds > 1);
  const r = input?.getBoundingClientRect?.();
  const hasInput = !!input && r && r.width > 0 && r.height > 0;
  const slipOpen = slipUiLikelyOpen();
  return {
    hasSlip,
    hasInput,
    hasBtn: !!betBtn,
    slipOpen,
    ready: slipOpen && hasInput,
    slipOdds: odds?.odds > 1 ? odds.odds : 0,
    slipCount: cards.length,
    buttonCount: queryBoardButtons().length,
    href: location.href,
    source: odds?.source || ''
  };
}

function isBtiPrimaryBetButtonText(txt) {
  const t = String(txt || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (t.includes('슬립') || t.includes('내 베팅') || t.includes('로그인') || t.includes('정리')) return false;
  if (t === '최대' || t.includes('전체') || t.includes('리그') || /^\+\s*[\d,]+\s*₩/.test(t)) return false;
  if (t.includes('배당 수락') || t.includes('배당수락')) return true;
  if (/수락.*베팅|베팅.*수락/i.test(t)) return true;
  if (t.includes('베팅하기') || t === 'Place Bet' || t === 'Bet Now' || t === 'Bet') return true;
  if (t === '베팅 확인' || t.includes('베팅 확인')) return true;
  return false;
}

function findBtiBetButton() {
  const allBtns = Array.from(document.querySelectorAll('button')).filter((b) => !b.disabled);
  for (const btn of allBtns) {
    const txt = btn.textContent.trim();
    if (txt.includes('배당 수락') || txt.includes('배당수락')) return btn;
  }
  for (const btn of allBtns) {
    if ((btn.className || '').includes('sportsbook-Button') && isBtiPrimaryBetButtonText(btn.textContent)) {
      return btn;
    }
  }
  for (const btn of allBtns) {
    if ((btn.className || '').includes('PlaceBetBlock') && !(btn.className || '').includes('clearAll')) {
      return btn;
    }
  }
  for (const btn of allBtns) {
    if (isBtiPrimaryBetButtonText(btn.textContent)) return btn;
  }
  return null;
}

function findBtiConfirmButton() {
  const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
  for (const b of allBtns) {
    if (b.disabled) continue;
    const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
    if (/^(승인|확인|OK|Confirm|Accept|Approve)$/i.test(t)) return b;
    if (/베팅\s*승인|베팅\s*확인|place\s*bet|submit\s*bet|confirm\s*bet/i.test(t)) return b;
  }
  const modals = document.querySelectorAll('[class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"], [class*="overlay"], [class*="Overlay"], [class*="popup"], [class*="Popup"]');
  for (const modal of modals) {
    for (const b of modal.querySelectorAll('button, [role="button"]')) {
      if (b.disabled) continue;
      const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
      if (/승인|확인|Confirm|Accept|Approve|Place Bet/i.test(t)) return b;
    }
  }
  return null;
}

function confirmBtiBet(fast = false) {
  return new Promise((resolve) => {
    const MAX_WAIT = fast ? 2500 : 8000;
    const INTERVAL = fast ? 35 : 150;
    let elapsed = 0;
    function slipRemaining() {
      return getRealSlipCards().length;
    }
    function findConfirm() {
      try {
        const acceptBtn = findAcceptOddsButton();
        if (acceptBtn) {
          acceptBtn.click();
          elapsed += INTERVAL;
          setTimeout(findConfirm, 120);
          return;
        }
        const confirmBtn = findBtiConfirmButton();
        if (confirmBtn) {
          confirmBtn.click();
          setTimeout(() => {
            const left = slipRemaining();
            const okMsg = document.body.innerText.match(/베팅.*(완료|성공|접수)|Bet.*(accepted|placed)/i);
            resolve({
              confirmed: left === 0 || !!okMsg,
              btnText: confirmBtn.textContent.trim().substring(0, 20),
              elapsed,
              slipLeft: left
            });
          }, 400);
          return;
        }
        if (slipRemaining() === 0) {
          resolve({ confirmed: true, btnText: '슬립비움', elapsed });
          return;
        }
        elapsed += INTERVAL;
        if (elapsed >= MAX_WAIT) {
          const left = slipRemaining();
          const okMsg = document.body.innerText.match(/베팅.*(완료|성공|접수)|Bet.*(accepted|placed)/i);
          if (left === 0 || okMsg) {
            resolve({ confirmed: true, btnText: '슬립비움/메시지', elapsed, slipLeft: left });
          } else {
            resolve({ confirmed: false, reason: `승인버튼없음+슬립${left}건`, elapsed, slipLeft: left });
          }
          return;
        }
        setTimeout(findConfirm, INTERVAL);
      } catch (e) {
        resolve({ confirmed: false, reason: e.message });
      }
    }
    findConfirm();
  });
}

async function waitSlipStable(targetOdds, maxWaitMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const hasUpdateNotif = !!document.querySelector('[class*="UpdateNotification"]');
    const cards = getRealSlipCards();
    if (!cards.length) {
      await new Promise((r) => setTimeout(r, 80));
      continue;
    }
    const slip = readBtiSlip();
    const curOdds = slip?.odds > 1 ? slip.odds : 0;
    if (!hasUpdateNotif) {
      if (!targetOdds || !curOdds || Math.abs(curOdds - targetOdds) <= 0.08) {
        return { ready: true, curOdds, elapsed: Date.now() - start };
      }
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  const cards = getRealSlipCards();
  const slip = readBtiSlip();
  if (cards.length && !document.querySelector('[class*="UpdateNotification"]')) {
    return { ready: true, curOdds: slip?.odds || 0, elapsed: maxWaitMs, forced: true };
  }
  return {
    ready: false,
    reason: `슬립 안정화 타임아웃 (슬립=${cards.length > 0}, 배당=${slip?.odds || 0})`
  };
}

// ── BTI 베팅 실행 ──
function findAcceptOddsButton() {
  for (const btn of document.querySelectorAll('button')) {
    if (btn.disabled) continue;
    const t = (btn.textContent || '').trim();
    if (/배당\s*수락|배당수락|accept.*odds|odds.*accept/i.test(t)) return btn;
  }
  return null;
}

async function placeBtiBet(amount, targetLine, lineTolerance, targetOdds, hint = {}) {
  try {
    const force = !!hint.forceBet;

    if (!force && document.querySelector('[class*="UpdateNotification"]')) {
      const acceptBtn = findAcceptOddsButton();
      if (acceptBtn) {
        acceptBtn.click();
        await new Promise((r) => setTimeout(r, 120));
      } else {
        return { success: false, reason: '배당 업데이트 중 — 배당 수락 필요' };
      }
    } else if (force && document.querySelector('[class*="UpdateNotification"]')) {
      const acceptBtn = findAcceptOddsButton();
      if (acceptBtn) {
        acceptBtn.click();
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    const oppose = hint.excludeTeam || hint.polyTeam;
    let realCards = getRealSlipCards();
    const existing = readBtiSlip(hint);
    const wrongSlip = oppose && existing && (
      teamNamesMatch(existing.selectionText, oppose) || teamNamesMatch(existing.teamLabel, oppose)
    );
    const multiSlip = realCards.length > 1;
    const hasInput = !!findBtiBetInput();
    const mustPrepare = multiSlip || wrongSlip || !realCards.length || !hasInput;

    if (mustPrepare || (!hint.skipEnsure && !force) || (force && (!hasInput || !realCards.length))) {
      if (multiSlip || wrongSlip) {
        const cleared = await clearAllBtiSlips();
        if (cleared.slipLeft > 0 && multiSlip) {
          return { success: false, reason: `슬립 ${cleared.slipLeft}건 — 전체삭제 후 재시도`, slipLeft: cleared.slipLeft };
        }
        realCards = getRealSlipCards();
      }
      if (!realCards.length || wrongSlip || multiSlip) {
        const ensured = await ensureSlipFromBoard({ ...hint, clearSlips: true });
        if (!ensured.ok) return { success: false, reason: ensured.reason || '슬립 준비 실패' };
        realCards = getRealSlipCards();
        if (!realCards.length) return { success: false, reason: '슬립 카드 없음' };
        if (realCards.length > 1) {
          return { success: false, reason: `슬립 ${realCards.length}건 — 수동 전체삭제 필요`, slipLeft: realCards.length };
        }
      }
    } else if (!realCards.length && !force) {
      return { success: false, reason: '슬립 카드 없음 — 베팅슬립 열기' };
    }

    if (hint.fastStrike) {
      /* 슬립·금액 사전동기화됨 — 대기 생략 */
    } else if (!force) {
      const stable = await waitSlipStable(targetOdds, hint.skipEnsure ? 800 : 2500);
      if (!stable.ready && targetOdds && !hint.skipEnsure) {
        return { success: false, reason: stable.reason || '슬립 배당 미확정' };
      }
    } else {
      await waitSlipStable(targetOdds, 150);
    }

    // ── 기준점 검증 (위치 변경 버그 방어) ──
    if (targetLine !== undefined && lineTolerance !== undefined) {
      const validation = validateBtiLine(targetLine, lineTolerance);
      if (!validation.valid) {
        return {
          success: false,
          reason: `⚠️ ${validation.reason} → 베팅 취소`,
          lineChanged: true
        };
      }
    }

    if (!hint.forceBet && targetOdds !== undefined && targetOdds !== null) {
      const oddsTol = hint.skipEnsure ? 0.15 : 0.06;
      const oddsValidation = validateBtiOdds(targetOdds, oddsTol);
      if (!oddsValidation.valid) {
        return {
          success: false,
          reason: oddsValidation.reason,
          oddsChanged: true
        };
      }
    }

    const input = findBtiBetInput();
    if (!input) return { success: false, reason: '금액 입력 필드 없음 — 베팅슬립 열기' };

    const want = Math.max(1000, Math.round(Number(amount) || 0));
    const curStake = readBtiStake();
    if (!curStake || Math.abs(curStake - want) > 50) {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(input, String(want));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    }

    let betBtn = null;
    const btnTries = hint.fastStrike ? 2 : (force ? 8 : 30);
    const btnDelay = hint.fastStrike ? 5 : (force ? 25 : 50);
    for (let i = 0; i < btnTries; i++) {
      await new Promise((r) => setTimeout(r, btnDelay));
      betBtn = findBtiBetButton();
      if (betBtn && !betBtn.disabled) break;
    }
    if (!betBtn) return { success: false, reason: '베팅 버튼 없음 (금액 미입력 또는 최소금액 미달?)' };

    const rect = betBtn.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    betBtn.dispatchEvent(new MouseEvent('mousedown', opts));
    betBtn.dispatchEvent(new MouseEvent('mouseup', opts));
    betBtn.dispatchEvent(new MouseEvent('click', opts));
    betBtn.click();
    const confirm = await confirmBtiBet(!!hint.fastStrike);
    if (!confirm.confirmed) {
      return {
        success: false,
        reason: confirm.reason || `승인 실패 (슬립잔존=${confirm.slipLeft ?? '?'})`,
        slipLeft: confirm.slipLeft
      };
    }
    return { success: true, btnText: confirm.btnText || '확정' };
  } catch (e) {
    return { success: false, reason: e.message };
  }
}

// ── 배당판 스캔 (API 실패 시 DOM 폴백) ──

function getTeamLabelFromBoardContext(btn, side, home, away) {
  const mlLine = btn?.closest?.('[class*="MoneyLineSelection_line"]');
  if (mlLine) {
    const teamEl = mlLine.querySelector(
      '[class*="competitorName"], [class*="teamName"], [class*="participant"], [class*="selectionName"]'
    );
    if (teamEl?.textContent?.trim()) return teamEl.textContent.trim();
    const lineText = (mlLine.textContent || '')
      .replace(/\d+\.\d{2,4}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (lineText.length >= 2 && lineText.length < 60) return lineText;
  }

  const pointsEl = btn?.querySelector?.('[class*="master_fe_Selections_points"], [class*="selectionNameLine"]');
  const pointsText = pointsEl?.textContent?.trim() || '';
  if (pointsText && !/^\d+\.\d+$/.test(pointsText) && !/^[+-]?\d+\.?\d*$/.test(pointsText)) {
    return pointsText.replace(/\s*[+-]\d+\.?\d*\s*$/, '').trim();
  }

  if (side === 'away' || side === 'a') return away || '';
  if (side === 'home' || side === 'h') return home || '';
  return '';
}

function queryBoardButtons() {
  const selectors = [
    'button[class*="master_fe_Selections_selection"]',
    'button[class*="Selections_selection"]',
    'button[class*="selection"][class*="Selection"]',
    'button[class*="Selection"]'
  ];
  const seen = new Set();
  const out = [];
  for (const sel of selectors) {
    for (const btn of document.querySelectorAll(sel)) {
      if (seen.has(btn)) continue;
      seen.add(btn);
      out.push(btn);
    }
  }
  if (!out.length) {
    for (const btn of document.querySelectorAll('button')) {
      if (seen.has(btn) || !isElementVisible(btn)) continue;
      const txt = (btn.textContent || '').trim();
      if (/오버|언더|over|under/i.test(txt)) continue;
      const hasOddsEl = btn.querySelector('[class*="odds"], [class*="Odds"]');
      const hasOddsText = /\d+\.\d{2,3}/.test(txt);
      if (!hasOddsEl && !hasOddsText) continue;
      seen.add(btn);
      out.push(btn);
    }
  }
  return out;
}

function parseSelectionButton(btn) {
  if (!btn) return null;
  const rawText = (btn.textContent || '').trim();
  const oddsEl = btn.querySelector(
    '[class*="master_fe_Selections_odds"], [class*="Selections_odds"], [class*="selections_odds"], [class*="odds"], [class*="Odds"]'
  );
  let odds = oddsEl ? parseFloat(String(oddsEl.textContent || '').trim()) : NaN;
  if (!odds || odds <= 1.01 || odds >= 100) {
    const tail = rawText.match(/(\d+\.\d{2,3})\s*$/);
    if (tail) odds = parseFloat(tail[1]);
    else {
      const any = rawText.match(/(\d+\.\d{2,3})/);
      if (any) odds = parseFloat(any[1]);
    }
  }
  if (!odds || odds <= 1.01 || odds >= 100) return null;

  const pointsEl = btn.querySelector('[class*="master_fe_Selections_points"], [class*="selectionNameLine"]');
  const pointsText = pointsEl ? pointsEl.textContent.trim() : '';

  let line = null;
  const lineMatch = (pointsText || rawText).match(/([+-]\d+\.?\d*)/);
  if (lineMatch) line = parseFloat(lineMatch[1]);
  else {
    const ouLine = rawText.replace(/오버|언더|over|under/gi, '').match(/(\d+\.?\d*)/);
    if (ouLine) line = parseFloat(ouLine[1]);
  }

  let label = pointsText || rawText.replace(String(odds), '').trim();
  label = label.replace(/[+-]?\d+\.?\d*$/, '').trim();
  if (!label || /^\d+\.\d+$/.test(label)) {
    const ctxLabel = getTeamLabelFromBoardContext(btn);
    if (ctxLabel) label = ctxLabel;
  }

  return { odds, line, pointsText, label, rawText, element: btn };
}

function findEventNameNearButton(btn) {
  let el = btn.parentElement;
  for (let depth = 0; depth < 18 && el; depth++) {
    const selectors = [
      '[class*="eventName"]', '[class*="EventName"]',
      '[class*="betInformation__eventName"]',
      '[class*="competitor"]', '[class*="participants"]', '[class*="matchName"]',
      '[class*="eventTitle"]', '[class*="EventTitle"]'
    ];
    for (const sel of selectors) {
      const found = el.querySelector(sel);
      if (found) {
        const t = found.textContent.trim();
        if (/vs|VS|v\.|@|대/.test(t)) return t.replace(/\s+대\s+/, ' vs ');
      }
    }
    const text = (el.textContent || '').trim();
    const vm = text.match(/([^\n]{2,50})\s+(?:vs|VS|v\.|@|대)\s+([^\n]{2,50})/);
    if (vm && text.length < 240) return `${vm[1].trim()} vs ${vm[2].trim()}`;
    el = el.parentElement;
  }
  return '';
}

function parseEventTeams(eventText) {
  if (!eventText) return { home: '', away: '' };
  for (const sep of [' vs ', ' VS ', ' v ', ' @ ', ' 대 ']) {
    if (eventText.includes(sep)) {
      const [home, away] = eventText.split(sep, 2);
      return { home: home.trim(), away: away.trim() };
    }
  }
  return { home: eventText, away: '' };
}

function resolveBtiTeamLabel(slip) {
  if (!slip) return '';
  const sel = String(slip.selectionText || '').trim();
  const { home, away } = parseEventTeams(slip.eventText || '');

  if (slip.side === 'away' || slip.side === 'a' || slip.side === 'Away') {
    if (away) return away;
  }
  if (slip.side === 'home' || slip.side === 'h' || slip.side === 'Home') {
    if (home) return home;
  }

  if (/^W1$/i.test(sel)) return home || 'W1';
  if (/^W2$/i.test(sel)) return away || 'W2';

  if (sel && !/^W[12]$/i.test(sel)) {
    const cleaned = sel.replace(/\s*[+-]\d+\.?\d*\s*$/, '').trim();
    if (cleaned.length >= 2) return cleaned;
  }

  if (slip.side === 'away' || slip.side === 'a' || slip.side === 'Away') return away || home || sel;
  if (slip.side === 'home' || slip.side === 'h' || slip.side === 'Home') return home || away || sel;

  if (home && away) {
    if (teamNamesMatch(sel, away)) return away;
    if (teamNamesMatch(sel, home)) return home;
  }
  return sel || home || away || '';
}

function enrichBtiSlip(slip) {
  if (!slip) return slip;
  const { home, away } = parseEventTeams(slip.eventText || '');
  slip.homeTeam = slip.homeTeam || home;
  slip.awayTeam = slip.awayTeam || away;
  slip.teamLabel = resolveBtiTeamLabel(slip);
  return slip;
}

function detectMarketType(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('머니 라인') || t.includes('money line') || t.includes('moneyline') || t.includes('승패')) return 'ml';
  if (t.includes('승리팀') || t.includes('승리') || t.includes('winner') || t.includes('winning team')) return 'ml';
  if ((t.includes('맵') || t.includes('map')) && (t.includes('우승') || t.includes('winner'))) return 'ml';
  if (t.includes('핸디') || t.includes('핸디캡') || t.includes('handicap') || t.includes('hdp') || t.includes('아시안') || t.includes('spread') || t.includes('run line')) return 'ah';
  if (t.includes('오버') || t.includes('언더') || t.includes('over') || t.includes('under') || t.includes('총계') || t.includes('total') || t.includes('o/u') || t.includes('언오버') || t.includes('골합') || t.includes('득점')) return 'ou';
  return 'ml';
}

function detectBoardSide(text, marketKind) {
  const t = (text || '').toLowerCase();
  if (marketKind === 'ou') return (t.includes('언더') || t.includes('under')) ? 'u' : 'o';
  if (marketKind === 'ah') return (t.includes('어웨이') || t.includes('away')) ? 'a' : 'h';
  if (t.includes('무승부') || t.includes('draw')) return 'draw';
  if (t.includes('어웨이') || t.includes('away')) return 'away';
  return 'home';
}

function scrapeBoardSelections() {
  const btns = queryBoardButtons();
  const byEvent = new Map();

  btns.forEach((btn, idx) => {
    const parsed = parseSelectionButton(btn);
    if (!parsed) return;

    const eventText = findEventNameNearButton(btn);
    const eventKey = eventText || `unknown_${idx}`;
    const { home, away } = parseEventTeams(eventText);

    const marketContainer = btn.closest('[class*="market"], [class*="Market"], [class*="selections"]');
    const marketText = marketContainer
      ? (marketContainer.querySelector('[class*="marketName"], [class*="MarketName"]')?.textContent || '').trim()
      : '';

    const marketKind = detectMarketType(marketText || parsed.rawText);
    const side = detectBoardSide(parsed.label || parsed.rawText, marketKind);
    let selectionText = parsed.label || parsed.rawText;
    if (!selectionText || /^\d+\.\d+$/.test(String(selectionText).trim())) {
      selectionText = getTeamLabelFromBoardContext(btn, side, home, away) || selectionText;
    }

    const entry = {
      eventText, homeTeam: home, awayTeam: away,
      selectionText,
      marketText, marketKind, side, line: parsed.line, odds: parsed.odds,
      pointsText: parsed.pointsText,
      eventId: (location.href.match(/\/(\d{10,20})/) || [])[1] || null,
      element: btn
    };

    if (!byEvent.has(eventKey)) byEvent.set(eventKey, []);
    byEvent.get(eventKey).push(entry);
  });

  const events = [];
  for (const [eventText, selections] of byEvent) {
    const { home, away } = parseEventTeams(eventText);
    events.push({
      eventText, homeTeam: home, awayTeam: away, selections,
      moneyline: selections.filter((s) => s.marketKind === 'ml'),
      handicap: selections.filter((s) => s.marketKind === 'ah'),
      totals: selections.filter((s) => s.marketKind === 'ou')
    });
  }

  return {
    ok: events.length > 0 || btns.length > 0,
    frameUrl: location.href,
    isTop: window === window.top,
    buttonCount: btns.length,
    eventCount: events.length,
    events
  };
}

function normalizeTeamName(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
}

function teamNamesMatch(a, b) {
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  if (!na || !nb || na.length < 2 || nb.length < 2) return false;
  if (na === nb) return true;
  const minLen = Math.min(na.length, nb.length, 5);
  if (na.slice(0, minLen) === nb.slice(0, minLen)) return true;
  return na.includes(nb) || nb.includes(na);
}

function matchPeriodInText(text, period) {
  if (!period || period === 'ft') return true;
  const t = (text || '').toLowerCase();
  if (period === '1h') return t.includes('전반') || t.includes('1st half') || t.includes('1h');
  if (period === '2h') return t.includes('후반') || t.includes('2nd half') || t.includes('2h');
  if (period === 'set' || String(period).startsWith('set')) {
    const setM = String(period).match(/(\d+)/);
    if (setM) {
      return t.includes(`${setM[1]}세트`) || t.includes(`set ${setM[1]}`) || t.includes('1st set')
        || t.includes('첫') || t.includes('1세트');
    }
    return t.includes('세트') || t.includes('set');
  }
  const mapM = String(period).match(/map(\d+)/i);
  if (mapM) return t.includes(`맵 ${mapM[1]}`) || t.includes(`map ${mapM[1]}`) || t.includes(`맵${mapM[1]}`);
  return true;
}

function isElementVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const vh = window.innerHeight || 800;
  return r.top < vh + 40 && r.bottom > -40;
}

function pickVisibleBoardEvent(events) {
  let best = null;
  let bestScore = -1;
  for (const ev of events) {
    let visCount = 0;
    let visArea = 0;
    for (const sel of ev.selections) {
      if (!sel.element || !isElementVisible(sel.element)) continue;
      visCount++;
      const r = sel.element.getBoundingClientRect();
      visArea += r.width * r.height;
    }
    const score = visCount * 100 + visArea / 1000 + ev.selections.length;
    if (score > bestScore) {
      bestScore = score;
      best = ev;
    }
  }
  return best || events[0] || null;
}

function collectVisibleMlButtons() {
  const mlLines = Array.from(document.querySelectorAll('[class*="MoneyLineSelection_line"]'))
    .filter(isElementVisible);
  if (mlLines.length >= 2) {
    return mlLines.map((line, i) => {
      const btn = line.querySelector('button[class*="master_fe_Selections_selection"]') || line.querySelector('button') || line;
      const parsed = parseSelectionButton(btn);
      if (!parsed) return null;
      const marketText = (line.closest('[class*="market"], [class*="Market"]')
        ?.querySelector('[class*="marketName"], [class*="MarketName"]')?.textContent || '').trim();
      const side = i === 0 ? 'home' : 'away';
      const evText = findEventNameNearButton(btn);
      const teams = parseEventTeams(evText);
      let selectionText = parsed.label || parsed.rawText;
      if (!selectionText || /^\d+\.\d+$/.test(String(selectionText).trim())) {
        selectionText = getTeamLabelFromBoardContext(btn, side, teams.home, teams.away) || selectionText;
      }
      return {
        selectionText,
        marketText,
        marketKind: 'ml',
        side,
        line: parsed.line,
        odds: parsed.odds,
        element: btn
      };
    }).filter(Boolean);
  }

  const btns = Array.from(document.querySelectorAll('button[class*="master_fe_Selections_selection"]'))
    .filter(isElementVisible);
  const mlBtns = btns.map((btn, i) => {
    const parsed = parseSelectionButton(btn);
    if (!parsed) return null;
    const pointsText = parsed.pointsText || '';
    if (/[+-]\d/.test(pointsText)) return null;
    const raw = (parsed.rawText || '').toLowerCase();
    if (raw.includes('오버') || raw.includes('언더') || raw.includes('over') || raw.includes('under')) return null;
    const side = i === 0 ? 'home' : 'away';
    const evText = findEventNameNearButton(btn);
    const teams = parseEventTeams(evText);
    let selectionText = parsed.label || parsed.rawText;
    if (!selectionText || /^\d+\.\d+$/.test(String(selectionText).trim())) {
      selectionText = getTeamLabelFromBoardContext(btn, side, teams.home, teams.away) || selectionText;
    }
    return {
      selectionText,
      marketText: '',
      marketKind: 'ml',
      side,
      line: parsed.line,
      odds: parsed.odds,
      element: btn
    };
  }).filter(Boolean);
  return mlBtns.length >= 2 ? mlBtns : [];
}

let lastBoardClickAt = 0;
let lastBoardClickBtn = null;

function isBoardButtonSelected(btn) {
  if (!btn) return false;
  const cls = String(btn.className || '');
  return /selected|active|pressed|highlight/i.test(cls)
    || btn.getAttribute('aria-pressed') === 'true'
    || btn.getAttribute('data-selected') === 'true'
    || btn.getAttribute('data-state') === 'on';
}

function pickBoardSelection(pool, hint = {}) {
  const { side, excludeTeam, preferTeam, polyTeam } = hint;
  if (!pool.length) return null;

  if (lastBoardClickBtn) {
    const fromClick = pool.find((s) => s.element === lastBoardClickBtn);
    if (fromClick) return fromClick;
  }

  const clicked = pool.find((s) => {
    const btn = s.element;
    if (!btn) return false;
    const cls = String(btn.className || '');
    return /selected|active|pressed|highlight/i.test(cls)
      || btn.getAttribute('aria-pressed') === 'true'
      || btn.getAttribute('data-selected') === 'true'
      || btn.getAttribute('data-state') === 'on';
  });
  if (clicked) return clicked;

  const oppose = excludeTeam || polyTeam;
  if (oppose) {
    let pick = pool.find((s) => !teamNamesMatch(s.selectionText, oppose) && !teamNamesMatch(s.label, oppose));
    if (!pick && pool.length >= 2) {
      const homeHit = pool.find((s) => teamNamesMatch(s.selectionText, oppose));
      const awayHit = pool.find((s, i) => i > 0 && teamNamesMatch(s.selectionText, oppose));
      if (homeHit) pick = pool.find((s) => s !== homeHit) || pool[pool.length - 1];
      else if (awayHit) pick = pool[0];
      else pick = pool[pool.length - 1];
    }
    if (pick) return pick;
  }

  if (preferTeam) {
    const pick = pool.find((s) => teamNamesMatch(s.selectionText, preferTeam) || teamNamesMatch(s.label, preferTeam));
    if (pick) return pick;
  }

  if (side) {
    const sideMap = { home: 'home', h: 'home', away: 'away', a: 'away', u: 'u', o: 'o' };
    const want = sideMap[side] || side;
    const pick = pool.find((s) => s.side === want);
    if (pick) return pick;
    if (want === 'home' && pool[0]) return pool[0];
    if (want === 'away' && pool.length > 1) return pool[pool.length - 1];
  }

  return pool[0] || null;
}

function inferMarketKindFromSlip() {
  const cards = getRealSlipCards();
  if (!cards.length) return null;
  const slip = parseSlipFromCard(cards[cards.length - 1]);
  return slip?.marketKind || null;
}

function readBtiBoardOdds(hint = {}) {
  const marketKind = hint.marketKind || hint.type || inferMarketKindFromSlip() || 'ml';
  const period = hint.period || 'ft';

  const board = scrapeBoardSelections();
  let event = board.events.length ? pickVisibleBoardEvent(board.events) : null;
  let pool = [];

  if (event) {
    pool = event.selections.filter((s) => {
      if (marketKind && s.marketKind !== marketKind) return false;
      if (period && period !== 'ft' && !matchPeriodInText(`${s.marketText} ${s.selectionText}`, period)) return false;
      return true;
    });
    if (!pool.length && marketKind === 'ml') {
      pool = (event.moneyline.length ? event.moneyline : event.selections.filter((s) => s.marketKind === 'ml'));
    }
    if (!pool.length) pool = event.selections;
  }

  const visiblePool = pool.filter((s) => s.element && isElementVisible(s.element));
  if (visiblePool.length >= 2) pool = visiblePool;
  else if (!pool.length) pool = collectVisibleMlButtons();

  let pick = pickBoardSelection(pool, hint);
  if (!pick?.odds) {
    const fallback = collectVisibleMlButtons();
    if (fallback.length) pick = pickBoardSelection(fallback, hint);
  }
  if (!pick?.odds && pool.length) pick = pool.find((s) => s.odds > 1.01 && s.element && isElementVisible(s.element)) || pool[0];
  if (!pick?.odds) return null;

  const evText = event?.eventText || findEventNameNearButton(pick.element) || '';
  const { home, away } = parseEventTeams(evText);
  let resolvedSide = pick.side || 'home';
  if (marketKind === 'ml' && home && away) {
    if (teamNamesMatch(pick.selectionText, away)) resolvedSide = 'away';
    else if (teamNamesMatch(pick.selectionText, home)) resolvedSide = 'home';
  }

  let selectionText = pick.selectionText || pick.label || '';
  if (!selectionText || /^\d+\.\d+$/.test(String(selectionText).trim()) || /^W[12]$/i.test(selectionText)) {
    selectionText = getTeamLabelFromBoardContext(pick.element, resolvedSide, home, away) || selectionText;
  }

  return enrichBtiSlip({
    odds: pick.odds,
    eventId: pick.eventId || (location.href.match(/\/(\d{10,20})/) || [])[1] || null,
    marketKind: pick.marketKind || marketKind,
    period,
    side: resolvedSide,
    line: pick.line ?? null,
    marketKey: `${period}_${pick.marketKind || marketKind}_${resolvedSide}`,
    mktText: pick.marketText || '',
    selectionText,
    eventText: evText,
    homeTeam: home,
    awayTeam: away,
    source: 'board',
    fromSlip: false,
    boardElement: !!pick.element
  });
}

function readLiveBoardOddsForSlip(slip) {
  if (!slip?.selectionText) return null;
  const ctx = `${slip.mktText || ''} ${slip.marketTitleText || ''} ${slip.eventText || ''}`;
  const live = readOddsFromBoardForSelection(slip.selectionText, ctx, slip.marketKind || 'ml');
  if (live > 1.01) {
    return enrichBtiSlip({
      ...slip,
      odds: live,
      source: 'board-live',
      fromSlip: false
    });
  }
  return null;
}

function readEmergencyBoardOdds(hint = {}) {
  const parsed = queryBoardButtons()
    .map((btn) => parseSelectionButton(btn))
    .filter((p) => p?.odds && p.element && isElementVisible(p.element));
  if (!parsed.length) return null;

  const oppose = hint.excludeTeam || hint.polyTeam;
  let pick = null;
  if (oppose) {
    pick = parsed.find((p) => !teamNamesMatch(p.label, oppose) && !teamNamesMatch(p.rawText, oppose));
  }
  if (!pick) {
    pick = parsed.find((p) => isBoardButtonSelected(p.element)) || parsed[0];
  }
  if (!pick?.odds) return null;

  const evText = findEventNameNearButton(pick.element) || '';
  const { home, away } = parseEventTeams(evText);
  const mktKind = pick.marketKind || detectMarketType(pick.rawText || pick.label || '');
  return enrichBtiSlip({
    odds: pick.odds,
    eventId: (location.href.match(/\/(\d{10,20})/) || [])[1] || null,
    marketKind: mktKind,
    period: 'ft',
    side: pick === parsed[0] ? 'home' : 'away',
    line: pick.line ?? null,
    marketKey: `ft_${mktKind}_${pick === parsed[0] ? 'home' : 'away'}`,
    selectionText: pick.label || pick.rawText || '',
    eventText: evText,
    homeTeam: home,
    awayTeam: away,
    source: 'board-emergency',
    fromSlip: false
  });
}

function readBtiOdds(hint) {
  const hintObj = hint || {};
  if (isMyBetsTabActive()) {
    btiOddsLatch = { odds: 0, source: '', at: 0, key: '' };
    return null;
  }
  if (!slipUiLikelyOpen()) {
    btiOddsLatch = { odds: 0, source: '', at: 0, key: '' };
    return null;
  }

  const wrap = (slip) => (slip?.odds > 1.01 ? finalizeBtiOdds(slip) : slip);
  const hasCards = getRealSlipCards().length > 0;

  const slipDisplay = readActiveSlipDisplayOdds();
  if (slipDisplay?.odds > 1.01) return wrap(slipDisplay);

  let slipFromCard = null;
  if (hasCards) {
    slipFromCard = readBtiSlip({ preferActiveSlip: true });
    if (slipFromCard?.odds > 1.01) return wrap(slipFromCard);
  }

  if (hasCards && btiOddsLatch.source === 'slip' && btiOddsLatch.odds > 1.01
    && Date.now() - btiOddsLatch.at < 8000) {
    return wrap(enrichBtiSlip({
      odds: btiOddsLatch.odds,
      selectionText: (slipDisplay || slipFromCard)?.selectionText || '',
      eventText: (slipDisplay || slipFromCard)?.eventText || '',
      source: 'slip-latched',
      fromSlip: true
    }));
  }

  if (hintObj.excludeTeam || hintObj.polyTeam) {
    const arbSlip = readBtiSlip({ ...hintObj, forArbPick: true });
    if (arbSlip?.odds > 1.01) return wrap(arbSlip);
  }

  if (!hasCards) {
    const board = readBtiBoardOdds(hintObj);
    if (board?.odds > 1.01) return wrap(board);

    if (hintObj.excludeTeam || hintObj.polyTeam) {
      const plain = readBtiBoardOdds({ ...hintObj, excludeTeam: null, polyTeam: null });
      if (plain?.odds > 1.01) return wrap(plain);
    }

    const any = readBtiBoardOdds({});
    if (any?.odds > 1.01) return wrap(any);

    const emergency = readEmergencyBoardOdds(hintObj);
    if (emergency?.odds > 1.01) return wrap(emergency);
  } else {
    const slip = slipFromCard || readBtiSlip({ preferActiveSlip: true });
    if (slip?.selectionText) {
      const live = readLiveBoardOddsForSlip(slip);
      if (live?.odds > 1.01) return wrap(live);
    }
  }

  return null;
}

async function ensureSlipFromBoard(hint = {}) {
  let cards = getRealSlipCards();
  const arbHint = { ...hint, forArbPick: true };
  const existing = readBtiSlip(arbHint);
  const oppose = hint.excludeTeam || hint.polyTeam;

  const wrongTeam = oppose && existing && (
    teamNamesMatch(existing.selectionText, oppose) ||
    teamNamesMatch(existing.teamLabel, oppose) ||
    teamNamesMatch(existing.homeTeam, oppose) && (existing.side === 'home' || existing.side === 'h') ||
    teamNamesMatch(existing.awayTeam, oppose) && (existing.side === 'away' || existing.side === 'a')
  );
  const multiSlip = cards.length > 1;

  if (multiSlip || wrongTeam) {
    const cleared = await clearAllBtiSlips();
    cards = getRealSlipCards();
    if (cleared.slipLeft > 0 && multiSlip) {
      return { ok: false, reason: `슬립 ${cleared.slipLeft}건 정리 실패 — 전체삭제 클릭` };
    }
  }

  const existingAfter = readBtiSlip(arbHint);
  if (cards.length === 1 && existingAfter?.odds > 1.01 && !wrongTeam) {
    const stable = await waitSlipStable(existingAfter.odds, 2500);
    return { ok: true, slip: existingAfter, alreadyHad: true, stable: stable.ready };
  }

  const board = readBtiBoardOdds(hint);
  if (!board) return { ok: false, reason: '배당판 선택 없음' };

  const boardData = scrapeBoardSelections();
  let pool = [];
  const event = boardData.events.length ? pickVisibleBoardEvent(boardData.events) : null;
  if (event) {
    pool = event.selections.filter((s) => s.marketKind === (hint.marketKind || hint.type || 'ml'));
    if (!pool.length) pool = event.moneyline.length ? event.moneyline : event.selections;
  }
  if (!pool.length) pool = collectVisibleMlButtons();

  const pick = pickBoardSelection(pool, hint);
  if (!pick?.element) return { ok: false, reason: '배당 버튼 없음' };

  try {
    pick.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    pick.element.click();
    lastBoardClickAt = Date.now();
    lastBoardClickBtn = pick.element;
  } catch (e) {
    return { ok: false, reason: e.message };
  }

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (getRealSlipCards().length > 0) {
      const slip = readBtiSlip(arbHint);
      if (slip?.odds > 1.01) {
        const stable = await waitSlipStable(board.odds || slip.odds, 2000);
        return {
          ok: true,
          clicked: true,
          slip,
          targetOdds: board.odds,
          selectionText: board.selectionText,
          stable: stable.ready
        };
      }
    }
  }

  return { ok: false, reason: '슬립 생성 타임아웃 — 배당판 다시 클릭' };
}

function normalizeQuery(q) {
  return (q || '').replace(/\s+/g, '').toLowerCase();
}

function searchBtiOdds(query) {
  const board = scrapeBoardSelections();
  const q = normalizeQuery(query);
  if (!q) return { ...board, query, hits: board.events, hitCount: board.eventCount };

  const hits = board.events.filter((ev) => {
    const blob = normalizeQuery(`${ev.homeTeam} ${ev.awayTeam} ${ev.eventText}`);
    if (blob.includes(q)) return true;
    if (normalizeQuery(ev.homeTeam).includes(q)) return true;
    if (normalizeQuery(ev.awayTeam).includes(q)) return true;
    return (ev.selections || []).some((s) => {
      const sel = normalizeQuery(`${s.selectionText} ${s.marketText}`);
      return sel.includes(q);
    });
  });

  return { ...board, query, hits, hitCount: hits.length, slip: readBtiOdds() };
}

function setBtiStakeAmount(amount) {
  const input = findBtiBetInput();
  if (!input) return { ok: false, reason: '입력 필드 없음' };
  const want = Math.max(1000, Math.round(Number(amount) || 0));
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  nativeSetter.call(input, String(want));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  const stake = readBtiStake();
  return stake > 0 ? { ok: true, stake } : { ok: false, reason: '금액 반영 실패' };
}

// popup / background 요청에 응답
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SET_BTI_AMOUNT') {
    sendResponse(setBtiStakeAmount(msg.amount));
    return false;
  }
  if (msg.type === 'READ_SLIP') {
    sendResponse({ slip: readBtiOdds(msg.hint || {}) });
    return false;
  }
  if (msg.type === 'READ_BTI_ODDS') {
    sendResponse({ slip: readBtiOdds(msg.hint || {}) });
    return false;
  }
  if (msg.type === 'READ_BTI_STAKE') {
    sendResponse({ stake: readBtiStake() });
    return false;
  }
  if (msg.type === 'CLEAR_BTI_SLIPS') {
    clearAllBtiSlips().then(sendResponse);
    return true;
  }
  if (msg.type === 'ENSURE_BTI_SLIP') {
    ensureSlipFromBoard(msg.hint || {}).then(sendResponse);
    return true;
  }
  if (msg.type === 'PLACE_BET') {
    placeBtiBet(msg.amount, msg.targetLine, msg.lineTolerance, msg.targetOdds, msg.hint || {})
      .then((result) => sendResponse(result));
    return true;
  }
  if (msg.type === 'VALIDATE_LINE') {
    sendResponse(validateBtiLine(msg.targetLine, msg.tolerance));
    return false;
  }
  if (msg.type === 'FETCH_BTI_JSON') {
    const fetchUrl = msg.url || (location.origin.replace(/\/$/, '') + (msg.path || ''));
    fetch(fetchUrl, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status) + ' @ ' + fetchUrl);
        return r.json();
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'READ_BTI_BOARD') {
    const slip = readBtiBoardOdds(msg.hint || {});
    sendResponse({ slip: slip?.odds > 1.01 ? slip : null });
    return false;
  }
  if (msg.type === 'SEARCH_ODDS' || msg.type === 'BTI_SEARCH') {
    sendResponse(searchBtiOdds(msg.query || msg.team || msg.q || ''));
    return false;
  }
  if (msg.type === 'SCRAPE_BOARD') {
    sendResponse(scrapeBoardSelections());
    return false;
  }
  if (msg.type === 'STABILIZE_SLIP') {
    waitSlipStable(msg.targetOdds, msg.maxWait || 5000).then((result) => sendResponse(result));
    return true;
  }
  if (msg.type === 'PROBE_BET_FRAME') {
    sendResponse(probeBtiBetFrame());
    return false;
  }
  if (msg.type === 'PING') {
    const probe = probeBtiBetFrame();
    sendResponse({
      ok: true,
      version: '2.30',
      href: location.href,
      isTop: window === window.top,
      buttonCount: queryBoardButtons().length,
      hasSlip: probe.hasSlip,
      hasInput: probe.hasInput,
      hasBtn: probe.hasBtn,
      slipOdds: probe.slipOdds
    });
    return false;
  }
});

(function startBtiStakeObserver() {
  let lastStake = 0;
  function notifyStake() {
    const stake = readBtiStake();
    if (stake === lastStake) return;
    lastStake = stake;
    if (stake <= 0) return;
    try {
      chrome.runtime.sendMessage({ type: 'BTI_STAKE_CHANGED', stake });
    } catch (_) {}
  }
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!t) return;
    const isStake = t.id === 'counter' || /counter|Counter|베팅/i.test(String(t.className || '') + (t.placeholder || ''));
    if (!isStake) return;
    notifyStake();
  }, true);
  document.addEventListener('change', notifyStake, true);
  setInterval(notifyStake, 500);
})();

// ── MutationObserver: BTI 배당/슬립 변화 즉시 감지 ──
(function startBtiObserver() {
  let lastOddsKey = '';
  let pending = false;

  function oddsKey(slip) {
    if (!slip?.odds || slip.odds <= 1) return '';
    const o = Math.round(slip.odds * 100) / 100;
    return `${o.toFixed(2)}_${slip.marketKey || ''}_${slip.selectionText || ''}_${slip.teamLabel || ''}`;
  }

  function stabilizeBtiSlip(slip) {
    return finalizeBtiOdds(slip);
  }

  function checkAndNotify() {
    const raw = readBtiOdds();
    if (!raw || !raw.odds || raw.odds <= 1) {
      if (lastOddsKey !== '') {
        lastOddsKey = '';
        btiOddsLatch = { odds: 0, source: '', at: 0, key: '' };
        try {
          chrome.runtime.sendMessage({ type: 'ODDS_CHANGED', source: 'bti', slip: null, suspended: true });
        } catch (e) {}
      }
      return;
    }
    const slip = stabilizeBtiSlip(raw);
    const key = oddsKey(slip);
    if (key === lastOddsKey) return;
    lastOddsKey = key;
    try {
      chrome.runtime.sendMessage({ type: 'ODDS_CHANGED', source: 'bti', slip });
    } catch (e) {}
  }

  function notifyNow() {
    checkAndNotify();
    requestAnimationFrame(() => {
      checkAndNotify();
      requestAnimationFrame(checkAndNotify);
    });
  }

  function scheduleCheck() {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      checkAndNotify();
    });
  }

  if (document.body) {
    document.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('button[class*="master_fe_Selections_selection"]');
      if (!btn) return;
      lastBoardClickAt = Date.now();
      lastBoardClickBtn = btn;
      notifyNow();
    }, true);

    const obs = new MutationObserver(scheduleCheck);
    obs.observe(document.body, {
      subtree: true, childList: true, characterData: true,
      attributes: true,
      attributeFilter: ['class', 'data-testid', 'aria-label', 'aria-pressed', 'data-state', 'data-selected']
    });
    document.addEventListener('input', notifyNow, true);
    setInterval(checkAndNotify, 16);
    notifyNow();
  }
})();

console.log('[텐텐뱃 v5] content script loaded');
try {
  window.__btiReadOdds = readBtiOdds;
  window.__btiEnsureSlip = ensureSlipFromBoard;
} catch (_) {}
