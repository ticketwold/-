/** Unit tests for X10 line vs odds heuristics (mirrors frame_scanner.js / x10_betslip_probe.js). */

function isX10LineValue(val, leafText, parentText, contextBlob) {
  const blob = `${contextBlob} ${parentText} ${leafText}`.toLowerCase();
  const valStr = String(val);
  if (/\(\s*\d+\.\d+\s*\)/.test(leafText) && leafText.includes(valStr)) return true;
  if (/[+-]\s*\d/.test(leafText) || /[+-]\d/.test(leafText)) {
    const m = leafText.match(/[+-]\s*(\d+(?:\.\d+)?)/);
    if (m && Math.abs(parseFloat(m[1]) - val) < 0.001) return true;
  }
  if (/(over|under|오버|언더|total|토탈|핸디|handicap|spread|기준)/i.test(blob)) {
    if (/^\d+\.5$/.test(valStr) && val >= 1.5) return true;
    if (new RegExp(`(?:over|under|오버|언더)\\s*${valStr.replace(".", "\\.")}`, "i").test(blob)) return true;
    if (val >= 10 && val < 100 && /^\d+\.\d+$/.test(valStr)) return true;
  }
  if (/^\d+\.\d+$/.test(valStr) && val >= 20 && /^\d+\.5$/.test(valStr)) return true;
  return false;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(isX10LineValue(36.5, "36.5", "오버 36.5", "토탈 골"), "36.5 is line on totals");
assert(!isX10LineValue(1.87, "1.87", "오버 36.5", "토탈 골"), "1.87 is odds not line");
assert(isX10LineValue(3.5, "+3.5", "A팀 +3.5", "핸디캡"), "3.5 handicap line");
assert(!isX10LineValue(1.92, "1.92", "A팀 +3.5", "핸디캡"), "1.92 is odds on handicap");
assert(isX10LineValue(6.5, "6.5", "오버 (6.5)", "NPB 토탈"), "6.5 in parens is line not odds");
assert(isX10LineValue(1.5, "1.5", "오버 (1.5)", "Team 1 - 토탈 골"), "1.5 in parens is line not odds");

function isX10SelectionLineText(rawText) {
  const t = String(rawText || "").trim();
  if (!t || t.length > 120) return false;
  if (/^(베팅슬립|베팅 슬립|싱글|조합|멀티|더블)$/i.test(t)) return false;
  if (/배팅\s*수락|베팅하기|배팅하기|당첨/i.test(t)) return false;
  if (/\d+\.\d+\s*@\s*\d/.test(t)) return false;
  if (/(오버|언더|Over|Under)/i.test(t) && /\(\s*\d+\.\d+\s*\)/.test(t)) return true;
  if (/(핸디|핸디캡|Handicap)/i.test(t) && /[+-]?\d+\.?\d*/.test(t)) return true;
  return false;
}

function isX10StandaloneOddsLine(rawText) {
  const t = String(rawText || "").trim().replace(/,/g, "");
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
  if (/당첨\s*예상/.test(t)) return true;
  return false;
}

function extractLineNumbers(selectionText) {
  const nums = new Set();
  for (const m of String(selectionText).matchAll(/\(\s*([+-]?\d+(?:\.\d+)?)\s*\)/g)) {
    nums.add(parseFloat(m[1]));
  }
  return nums;
}

function extractOddsFromLines(innerText) {
  const lines = String(innerText || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  let moneyZone = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (isMoneyZoneLine(lines[i])) {
      moneyZone = true;
      continue;
    }
    if (moneyZone) continue;
    if (!isX10SelectionLineText(lines[i])) continue;
    const lineNums = extractLineNumbers(lines[i]);
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      if (isMoneyZoneLine(lines[j])) break;
      if (isX10SelectionLineText(lines[j])) break;
      if (!isX10StandaloneOddsLine(lines[j])) continue;
      const val = parseFloat(lines[j]);
      if (lineNums.has(val)) continue;
      return val;
    }
  }
  return null;
}

function countSelectionCards(innerText) {
  const lines = String(innerText || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  let count = 0;
  let moneyZone = false;
  for (const line of lines) {
    if (isMoneyZoneLine(line)) moneyZone = true;
    if (!moneyZone && isX10SelectionLineText(line)) count += 1;
  }
  return count;
}

function parseHeaderSlipCountText(innerText) {
  const blob = String(innerText || "").replace(/\r/g, "");
  const m =
    blob.match(/베팅\s*슬립[^\d]*(\d+)[^\n]*\n[^\n]*싱글/i) ||
    blob.match(/베팅슬립[^\d]*(\d+)[^\n]*\n[^\n]*싱글/i);
  return m ? parseInt(m[1], 10) : null;
}

const sampleSlip = `베팅슬립
싱글
NPB
오버 (6.5)
1.93
배팅 수락 및 배팅`;
assert(extractOddsFromLines(sampleSlip) === 1.93, "vertical slip picks 1.93 not 6.5");
assert(isX10SelectionLineText("오버 (6.5)"), "오버 (6.5) is selection");
assert(isX10StandaloneOddsLine("1.93"), "1.93 is standalone odds line");
assert(!isX10SelectionLineText("1.93"), "1.93 is not selection line");

const uefaSlip = `베팅슬립
1
싱글
UEFA 챔피언스 리그 예선 - 여자
프랭크바로스 TC (W) - KFF Mitrovica (Wom)
Live
1 번째 하프 45' 0:0
Team 1 - 토탈 골
오버 (1.5)
1.75
₩
최대
+10,000 ₩
+100,000 ₩
+500,000 ₩
당첨 예상금액`;

assert(parseHeaderSlipCountText(uefaSlip) === 1, "header count is 1");
assert(countSelectionCards(uefaSlip) === 1, "one selection card");
assert(extractOddsFromLines(uefaSlip) === 1.75, "UEFA slip odds 1.75 not 1.5");
assert(extractOddsFromLines(uefaSlip) !== 1.5, "1.5 is line not odds");
assert(extractOddsFromLines(uefaSlip) !== 10000, "stake chip not odds");

console.log("test_x10_odds: PASS");
