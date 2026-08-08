import fs from "fs";
import vm from "vm";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadProbe() {
  const code = fs.readFileSync(path.join(__dirname, "x10_betslip_probe.js"), "utf8");
  const sandbox = { globalThis: {}, window: {}, document: { body: null, readyState: "complete" }, location: { href: "test://" } };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInContext(code, vm.createContext(sandbox));
  return sandbox.ArbX10Probe;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const probe = loadProbe();
const { parseX10BetSlipText, parseX10SlipText, extractBetSlipTextBlock, runPipeline } = probe;

const X10_BETSLIP_TEXT_FIXTURE = `베팅슬립
1
싱글
UEFA 챔피언스 리그 예선 - 여자
프랭크바로스 TC (W) - KFF Mitrovica (Wom)
Live
하프타임 0:0
Team 1 - 토탈 골
오버 (1.5)
1.75
₩
최대
+10,000 ₩
+100,000 ₩
+500,000 ₩
당첨 예상금액
17,500 ₩
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

const extracted = extractBetSlipTextBlock(pollutedSbCol);
assert(extracted && /베팅슬립/.test(extracted), "extract block from SBCol");
assert(!/1\.38/.test(extracted), "match list odds excluded from block");

const fixtureParsed = parseX10BetSlipText(X10_BETSLIP_TEXT_FIXTURE);
assert(fixtureParsed.ok === true, "parseX10BetSlipText: ok");
assert(fixtureParsed.odds === 1.75, `parseX10BetSlipText: odds 1.75 got ${fixtureParsed.odds}`);
assert(fixtureParsed.line === 1.5, `parseX10BetSlipText: line 1.5 got ${fixtureParsed.line}`);
assert(fixtureParsed.slip_count === 1, `parseX10BetSlipText: slip_count 1 got ${fixtureParsed.slip_count}`);
assert(fixtureParsed.status === "ACTIVE", `parseX10BetSlipText: status ACTIVE got ${fixtureParsed.status}`);

const fromPolluted = parseX10SlipText(extracted);
assert(fromPolluted.odds === 1.45, `polluted SBCol odds 1.45 got ${fromPolluted.odds}`);

const npbSlip = `베팅슬립
1
싱글
NPB
오버 (6.5)
1.93
배팅 수락 및 배팅`;
assert(parseX10BetSlipText(npbSlip).odds === 1.93, "NPB slip 1.93");

const anchorOnlyFrame = {
  frame_url: "test://",
  readyState: "complete",
  bodyLength: 0,
  hasBetSlipKeyword: true,
  body_has_keywords: true,
  anchor_hits: {
    베팅슬립: { text: X10_BETSLIP_TEXT_FIXTURE },
  },
  bodySnippet: "",
};

const anchorOnlyResult = runPipeline(null, { frame: anchorOnlyFrame });
assert(anchorOnlyResult.fallback_attempted === true, "runPipeline: anchor text → fallback_attempted");
assert(anchorOnlyResult.fallback_used === true, "runPipeline: anchor text → fallback_used");
assert(anchorOnlyResult.ok === true, "runPipeline: anchor text → ok");
assert(anchorOnlyResult.odds === 1.75, `runPipeline: anchor text → odds 1.75 got ${anchorOnlyResult.odds}`);
assert(anchorOnlyResult.slip_count === 1, "runPipeline: anchor text → slip_count 1");
assert(anchorOnlyResult.root_found === false, "runPipeline: anchor text → root_found false");
assert(anchorOnlyResult.steps.X10_ROOT === "WARN", "runPipeline: anchor text → X10_ROOT WARN");
assert(anchorOnlyResult.steps.X10_TEXT_BLOCK === "PASS", "runPipeline: anchor text → X10_TEXT_BLOCK PASS");
assert(anchorOnlyResult.steps.X10_ITEM === "PASS", "runPipeline: anchor text → X10_ITEM PASS");
assert(anchorOnlyResult.steps.X10_ODDS === "PASS", "runPipeline: anchor text → X10_ODDS PASS");
assert(anchorOnlyResult.steps.X10_STATUS === "PASS", "runPipeline: anchor text → X10_STATUS PASS");
assert(anchorOnlyResult.steps.first_failure === null, "runPipeline: anchor text → first_failure null");

if (
  anchorHits["베팅슬립"]?.text?.includes("베팅슬립") &&
  anchorHits["베팅슬립"]?.text?.includes("베팅하기")
) {
  assert(anchorOnlyResult.fallback_attempted === true, "regression: anchor text present must attempt fallback");
  assert(anchorOnlyResult.fallback_used === true, "regression: anchor text present must use fallback");
  assert(anchorOnlyResult.steps.X10_TEXT_BLOCK === "PASS", "regression: anchor text present must not fail TEXT_BLOCK");
}

const emptyDomFrame = {
  frame_url: "test://",
  readyState: "complete",
  bodyLength: 0,
  hasBetSlipKeyword: false,
  body_has_keywords: false,
  anchor_hits: {},
  bodySnippet: "",
};
const emptyDomResult = runPipeline(null, { frame: emptyDomFrame });
assert(emptyDomResult.fallback_attempted === false, "runPipeline: no anchor text → no fallback attempt");

console.log("test_x10_odds: PASS");
