/** Unit tests for X10 line vs odds heuristics (mirrors frame_scanner.js logic). */

function isX10LineValue(val, leafText, parentText, contextBlob) {
  const blob = `${contextBlob} ${parentText} ${leafText}`.toLowerCase();
  const valStr = String(val);
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

console.log("test_x10_odds: PASS");
