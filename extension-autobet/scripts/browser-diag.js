function browserDiag(lbl) {
  var AT_RE = /@\s*(\d{1,2}\.\d{2,4})/;
  var SUSPENDED_RE = /정지된|suspended|coefSuspended/i;
  var report = {
    label: lbl,
    href: location.href,
    isTop: window === window.top,
    bodyLen: document.body ? document.body.innerHTML.length : 0,
    bodyPreview: (document.body ? document.body.innerHTML : '').slice(0, 1500),
    winnerCoefCount: 0,
    winnerCoef: [],
    counterInput: [],
    slipMarkers: [],
    oddsElements: [],
    shadowHosts: [],
    iframes: [],
    scannerWouldFail: [],
  };

  function cssPath(el) {
    var parts = [];
    var node = el;
    for (var i = 0; i < 8 && node; i++) {
      var seg = node.tagName.toLowerCase();
      if (node.id) seg += '#' + node.id;
      else if (node.className && typeof node.className === 'string') {
        var c = node.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (c) seg += '.' + c;
      }
      parts.unshift(seg);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function getDirectText(el) {
    var t = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n && n.nodeType === 3) t += n.textContent || '';
    }
    return t.replace(/\s+/g, ' ').trim();
  }

  function walkShadow(root, depth, via) {
    if (depth > 32) return;
    if (root.nodeType === 1) {
      var el = root;
      var cls = String(el.className || '');
      var text = (el.textContent || '').trim();
      if (el.shadowRoot) {
        report.shadowHosts.push({ tag: el.tagName, class: cls.slice(0, 80), via: via });
        walkShadow(el.shadowRoot, depth + 1, 'shadow');
      }
      if (/bet__winner-coef|winner-coef/i.test(cls) && report.winnerCoef.length < 25) {
        report.winnerCoef.push({ tag: el.tagName, class: cls, text: text.slice(0, 50), via: via, path: cssPath(el) });
      }
      if ((/betslip|bet-slip|betInformation|BetSecondary|sport-betslip/i.test(cls) || el.id === 'counter') && report.slipMarkers.length < 20) {
        report.slipMarkers.push({ tag: el.tagName, class: cls.slice(0, 120), text: text.slice(0, 80), via: via });
      }
    }
    for (var j = 0; j < root.childNodes.length; j++) walkShadow(root.childNodes[j], depth + 1, via);
  }

  var coefEls = document.querySelectorAll('.bet__winner-coef, [class*="bet__winner-coef"], [class*="winner-coef"], span.bet__winner-coef');
  report.winnerCoefCount = coefEls.length;
  for (var ci = 0; ci < coefEls.length && ci < 25; ci++) {
    var cel = coefEls[ci];
    report.winnerCoef.push({ tag: cel.tagName, class: String(cel.className), text: (cel.textContent || '').trim().slice(0, 50), path: cssPath(cel) });
  }

  var counters = document.querySelectorAll('#counter, input[placeholder*="베팅"], input[id="counter"], input[placeholder*="베팅금"]');
  for (var ki = 0; ki < counters.length && ki < 8; ki++) {
    report.counterInput.push({ id: counters[ki].id, placeholder: counters[ki].placeholder || '', path: cssPath(counters[ki]) });
  }

  if (document.body) walkShadow(document.body, 0, 'light');

  var seen = {};
  var all = document.querySelectorAll('*');
  for (var ai = 0; ai < all.length; ai++) {
    var el2 = all[ai];
    var ownText = getDirectText(el2);
    if (!ownText || ownText.length > 24) continue;
    if (!/^\d{1,2}\.\d{2,4}$/.test(ownText) && !AT_RE.test(ownText)) continue;
    if (SUSPENDED_RE.test(ownText)) continue;
    var n = parseFloat(ownText.replace(/@/g, '').trim());
    if (!n || n <= 1.01 || n >= 100) continue;
    var key = ownText + cssPath(el2);
    if (seen[key]) continue;
    seen[key] = 1;
    if (report.oddsElements.length < 40) {
      report.oddsElements.push({
        text: ownText,
        odds: n,
        tag: el2.tagName,
        class: String(el2.className || '').slice(0, 150),
        path: cssPath(el2),
        inSlip: !!el2.closest('[class*="betslip"],[class*="bet-slip"],[class*="betInformation"],[class*="Betslip"],aside'),
      });
    }
  }

  var iframes = document.querySelectorAll('iframe');
  for (var fi = 0; fi < iframes.length && fi < 25; fi++) {
    var iframe = iframes[fi];
    var src = iframe.src || iframe.getAttribute('src') || '';
    var accessible = false, childBodyLen = 0, childCoefCount = 0, childCounter = 0;
    var childOdds = [];
    var childBodyPreview = '';
    try {
      var doc = iframe.contentDocument;
      if (doc && doc.body) {
        accessible = true;
        childBodyLen = doc.body.innerHTML.length;
        childBodyPreview = doc.body.innerHTML.slice(0, 1200);
        childCoefCount = doc.querySelectorAll('.bet__winner-coef,[class*="winner-coef"],span.bet__winner-coef').length;
        childCounter = doc.querySelectorAll('#counter,input[placeholder*="베팅"]').length;
        var cels = doc.querySelectorAll('*');
        for (var di = 0; di < cels.length; di++) {
          var t = getDirectText(cels[di]);
          if ((/^\d{1,2}\.\d{2,4}$/.test(t) || AT_RE.test(t)) && childOdds.length < 15) {
            childOdds.push({ text: t, class: String(cels[di].className || '').slice(0, 100), path: cssPath(cels[di]) });
          }
        }
      }
    } catch (e) { accessible = false; }
    report.iframes.push({
      src: src.slice(0, 250),
      accessible: accessible,
      childBodyLen: childBodyLen,
      childBodyPreview: childBodyPreview,
      childCoefCount: childCoefCount,
      childCounter: childCounter,
      childOdds: childOdds,
      isBetslip: /betslip|sportscenter|widgets-x|bti-sports|sport-betslip/i.test(src),
    });
  }

  if (report.winnerCoefCount === 0 && report.counterInput.length === 0) report.scannerWouldFail.push('NO_SLIP_MARKERS_IN_THIS_FRAME');
  for (var ii = 0; ii < report.iframes.length; ii++) {
    var f = report.iframes[ii];
    if (f.isBetslip && !f.accessible) report.scannerWouldFail.push('BETSLIP_IFRAME_CROSS_ORIGIN_OR_NOT_LOADED');
    if (f.isBetslip && f.accessible && (f.childCoefCount > 0 || f.childCounter > 0 || f.childOdds.length > 0))
      report.scannerWouldFail.push('ODDS_INSIDE_ACCESSIBLE_BETSLIP_IFRAME');
  }
  if (report.shadowHosts.length > 0 && report.winnerCoefCount === 0) report.scannerWouldFail.push('SHADOW_DOM_PRESENT_COEF_NOT_IN_LIGHT_DOM');
  if (!report.isTop) report.scannerWouldFail.push('RUNNING_INSIDE_IFRAME');
  else if (report.iframes.length > 0 && report.winnerCoefCount === 0 && report.counterInput.length === 0)
    report.scannerWouldFail.push('TOP_FRAME_SHELL_ODDS_LIKELY_IN_CHILD_IFRAME');

  return report;
}

if (typeof module !== 'undefined') module.exports = { browserDiag };
