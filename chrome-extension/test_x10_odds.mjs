/** Unit tests for X10 BetSlip text parser (mirrors x10_betslip_probe.js). */

function isSelectionLineText(lineText) {
  const t = String(lineText || "").trim();
  if (!t) return false;
  if (/(오버|언더|Over|Under)/i.test(t) && /\(\s*\d+\.\d+\s*\)/.test(t)) return true;
  if (/(핸디|핸디캡|Handicap)/i.test(t) && /[+-]?\d+\.?\d*/.test(t)) return true;
  if (/^W[12]$/i.test(t)) return true;
  return false;
}

function isStandaloneOddsLine(lineText) {
  const t = String(lineText || "").trim().replace(/,/g, "");
  const m = t.match(/^@?\s*(\d{1,2}\.\d{2})$/);
  if (!m) return false;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n >= 1.01 && n <= 100;
}

function isMoneyZoneLine(lineText) {
  const t = String(lineText || "").trim();
  if (t === "₩" || t === "원") return true;
  if (/^최대$/.test(t)) return true;
  if (/^\+[\d,]+/.test(t)) return true;
  if (/^[\d,]+\s*₩$/.test(t)) return true;
  if (/당첨\s*예상/.test(t)) return true;
  if (/^베팅하기$/.test(t)) return true;
  return false;
}

function extractLineNumbersFromSelection(selectionText) {
  const nums = new Set();
  for (const m of String(selectionText).matchAll(/\(\s*([+-]?\d+(?:\.\d+)?)\s*\)/g)) {
    nums.add(parseFloat(m[1]));
  }
  const hc = String(selectionText).match(/[+-]\s*(\d+(?:\.\d+)?)/);
  if (hc) nums.add(parseFloat(hc[1]));
  return nums;
}

function parseX10SlipText(rawText) {
  const lines = String(rawText || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let slip_count = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/베팅\s*슬립|베팅슬립/.test(lines[i])) continue;
    const inline = lines[i].match(/베팅\s*슬립\s*(\d+)|베팅슬립\s*(\d+)/i);
    if (inline) {
      slip_count = parseInt(inline[1] || inline[2], 10);
      break;
    }
    if (i + 1 < lines.length && /^\d+$/.test(lines[i + 1])) {
      slip_count = parseInt(lines[i + 1], 10);
      break;
    }
  }

  let selection = "";
  let market = "";
  let line = null;
  let odds = null;
  let moneyZone = false;

  for (let i = 0; i < lines.length; i += 1) {
    if (isMoneyZoneLine(lines[i])) {
      moneyZone = true;
      continue;
    }
    if (moneyZone) continue;
    if (!isSelectionLineText(lines[i])) continue;
    selection = lines[i];
    const lineNums = extractLineNumbersFromSelection(selection);
    line = lineNums.size ? [...lineNums][0] : null;
    if (i > 0 && !isSelectionLineText(lines[i - 1])) market = lines[i - 1];
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      if (isMoneyZoneLine(lines[j])) break;
      if (isSelectionLineText(lines[j])) break;
      if (!isStandaloneOddsLine(lines[j])) continue;
      const val = parseFloat(lines[j]);
      if (lineNums.has(val)) continue;
      odds = val;
      break;
    }
    break;
  }

  const closed = /betting\s*closed|마감|suspended/i.test(String(rawText));
  const effectiveCount = slip_count != null ? slip_count : selection ? 1 : 0;
  const oddsOk = odds != null && odds >= 1.01 && odds <= 100;
  const status = closed ? "closed" : oddsOk && effectiveCount === 1 ? "active" : "odds_missing";
  return { slip_count: effectiveCount, line, odds, selection, market, status, ok: effectiveCount === 1 && oddsOk && !closed };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const uefaSlip = `베팅슬립
1
싱글
UEFA 챔피언스 리그 예선 - 여자
프랭크바로스 TC (W) - KFF Mitrovica (Wom)
Live
하프타임 0:0
토탈 골
오버 (1.5)
1.45
₩
최대
+10,000 ₩
+100,000 ₩
+500,000 ₩
당첨 예상금액
14,500 ₩
베팅하기`;

const pollutedSbCol = `프랭크바로스 TC (W)
0
:
0
KFF Mitrovica (Wom)
베팅슬립
1
싱글
UEFA 챔피언스 리그 예선 - 여자
프랭크바로스 TC (W) - KFF Mitrovica (Wom)
Live
하프타임 0:0
토탈 골
오버 (1.5)
1.45
₩
최대
+10,000 ₩
+100,000 ₩
+500,000 ₩
당첨 예상금액
14,500 ₩
베팅하기
1.38
3.95
10.00`;

function extractBetSlipTextBlock(rawText) {
  const t = String(rawText || "").replace(/\r/g, "");
  const start = t.search(/베팅\s*슬립|베팅슬립/);
  if (start < 0) return null;
  const slice = t.slice(start);
  const endMatch = slice.match(/베팅하기|배당\s*수락(?:\s*및\s*배팅)?/);
  if (!endMatch || endMatch.index == null) return null;
  return slice.slice(0, endMatch.index + endMatch[0].length).trim();
}

const extracted = extractBetSlipTextBlock(pollutedSbCol);
assert(extracted && /베팅슬립/.test(extracted), "extract block from SBCol");
assert(!/1\.38/.test(extracted), "match list odds excluded from block");
const fromPolluted = parseX10SlipText(extracted);
assert(fromPolluted.odds === 1.45, `polluted SBCol odds 1.45 got ${fromPolluted.odds}`);

const parsed = parseX10SlipText(uefaSlip);
assert(parsed.slip_count === 1, `slip_count=1 got ${parsed.slip_count}`);
assert(parsed.line === 1.5, `line=1.5 got ${parsed.line}`);
assert(parsed.odds === 1.45, `odds=1.45 got ${parsed.odds}`);
assert(parsed.status === "active", `status=active got ${parsed.status}`);
assert(parsed.selection === "오버 (1.5)", `selection got ${parsed.selection}`);
assert(parsed.market === "토탈 골", `market got ${parsed.market}`);

const npbSlip = `베팅슬립
싱글
NPB
오버 (6.5)
1.93
배팅 수락 및 배팅`;
assert(parseX10SlipText(npbSlip).odds === 1.93, "NPB slip 1.93");

console.log("test_x10_odds: PASS");
