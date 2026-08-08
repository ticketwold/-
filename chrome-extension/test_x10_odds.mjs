/** Unit tests for X10 line vs odds heuristics (mirrors frame_scanner.js logic). */

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

function isX10SelectionLineText(rawText) {
  const t = String(rawText || "").trim();
  if (!t || t.length > 120) return false;
  if (/^(베팅슬립|베팅 슬립|싱글|조합|멀티|더블)$/i.test(t)) return false;
  if (/배팅\s*수락|베팅하기|배팅하기|당첨/i.test(t)) return false;
  if (/\d+\.\d+\s*@\s*\d/.test(t)) return false;
  if (/(오버|언더|Over|Under)/i.test(t) && /\(\s*\d+\.\d+\s*\)/.test(t)) return true;
  return false;
}

function isX10StandaloneOddsLine(rawText) {
  const t = String(rawText || "").trim();
  const m = t.match(/^@?\s*(\d{1,3}(?:\.\d{1,3})?)$/);
  if (!m) return false;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n >= 1.01 && n <= 100;
}

function extractOddsFromLines(innerText) {
  const lines = String(innerText || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!isX10SelectionLineText(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
      if (/배팅|수락|당첨/i.test(lines[j])) break;
      if (isX10SelectionLineText(lines[j])) break;
      if (!isX10StandaloneOddsLine(lines[j])) continue;
      return parseFloat(lines[j]);
    }
  }
  return null;
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

console.log("test_x10_odds: PASS");
