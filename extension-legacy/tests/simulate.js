#!/usr/bin/env node
'use strict';

/**
 * 양방 베팅 봇 — 오프라인 시뮬레이션 테스트
 * 실행: node extension-legacy/tests/simulate.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;

function loadScript(file, exportsExpr) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const sandbox = {};
  vm.runInNewContext(`${code}\n;(${exportsExpr})`, sandbox, { filename: file });
  return sandbox;
}

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function assertNear(a, b, eps, msg) {
  assert(Math.abs(a - b) <= eps, `${msg} (got ${a}, want ~${b})`);
}

// ── odds.js ──
console.log('\n[1] odds.js 수학 검증');
const odds = loadScript('odds.js', '{ calcProfit, calcPolyBetUsd, calcArb, calcBtiTotalPayoutKrw, calcNetProfitIfBtiWins }');

assertNear(odds.calcProfit(2.0, 2.0), 0, 0.01, '마진 100% 배당 수익률 ≈ 0%');
const profit = odds.calcProfit(2.2, 2.0);
assert(profit > 0 && profit < 6, `양방 수익률 양수 (${profit?.toFixed(2)}%)`);
assertNear(odds.calcPolyBetUsd(10000, 2.2, 2.0, 1400), 7.86, 0.1, 'Poly USD 스테이크 계산');
assert(odds.calcArb(2.2, 2.0) > 0, 'calcArb 양수');
const btiWin = odds.calcNetProfitIfBtiWins(10000, 2.2, 3.93, 1400);
assert(typeof btiWin === 'number', 'BTI 승리 시 순이익 계산');

// ── 탭 병합 시뮬 ──
console.log('\n[2] findTabs 병합 로직');
function mergeTabs(remote, local) {
  let btiTab = remote?.btiTab || null;
  let polyTab = remote?.polyTab || null;
  if (!btiTab && local?.btiTab) btiTab = local.btiTab;
  if (!polyTab && local?.polyTab) polyTab = local.polyTab;
  return { btiTab, polyTab };
}

{
  const r = mergeTabs({ btiTab: { id: 1 } }, { polyTab: { id: 2 } });
  assert(r.btiTab?.id === 1 && r.polyTab?.id === 2, 'remote BTI + local Poly 병합');
}
{
  const r = mergeTabs({ btiTab: { id: 1 } }, { btiTab: { id: 9 }, polyTab: { id: 2 } });
  assert(r.btiTab?.id === 1 && r.polyTab?.id === 2, 'remote 우선, local로 Poly 보완');
}
{
  const r = mergeTabs(null, { btiTab: { id: 3 }, polyTab: { id: 4 } });
  assert(r.btiTab?.id === 3 && r.polyTab?.id === 4, 'local 전용');
}

// ── strikeBothSides 순서 시뮬 ──
console.log('\n[3] 배팅 순서 시뮬레이션 (BTI → Poly)');

async function simulateStrike(btiFn, polyFn) {
  const btiRes = await btiFn();
  if (!btiRes.success) {
    return { ok: false, btiRes, polyRes: { success: false, reason: '텐텐뱃 실패 — Polymarket 미실행' } };
  }
  const polyRes = await polyFn();
  return { ok: !!(btiRes.success && polyRes.success), btiRes, polyRes };
}

(async () => {
  let r1 = await simulateStrike(
    async () => ({ success: false, reason: '슬립 없음' }),
    async () => ({ success: true })
  );
  assert(!r1.ok && r1.polyRes.reason.includes('미실행'), 'BTI 실패 시 Poly 미실행');

  let r2 = await simulateStrike(
    async () => ({ success: true, btnText: '확정' }),
    async () => ({ success: false, reason: 'Buy 버튼 없음' })
  );
  assert(!r2.ok && r2.btiRes.success && !r2.polyRes.success, 'BTI 성공 + Poly 실패');

  let r3 = await simulateStrike(
    async () => ({ success: true }),
    async () => ({ success: true, method: 'main-world' })
  );
  assert(r3.ok, '양쪽 성공');

  // ── placePolyBet 재시도 시뮬 ──
  console.log('\n[4] Poly 배팅 재시도 시뮬');
  async function simulatePlacePoly(mainResults) {
    let lastErr = null;
    for (const res of mainResults) {
      if (res?.success) return res;
      lastErr = res;
    }
    return lastErr || { success: false, reason: '실패' };
  }

  const retry = await simulatePlacePoly([
    { success: false, reason: 'skipFill fail' },
    { success: true, method: 'main-world' }
  ]);
  assert(retry.success, 'MAIN 2차 시도 성공');

  const fail = await simulatePlacePoly([
    { success: false },
    { success: false }
  ]);
  assert(!fail.success, '모두 실패');

  // ── 수익 구간 자동배팅 시뮬 ──
  console.log('\n[5] 자동배팅 수익 구간 시뮬');
  const PROFIT_ZONE_SETTLE_MS = 500;
  let profitZoneSince = 0;
  const minProfit = 2;

  function checkAutoBet(profit, now) {
    if (profit == null || profit < minProfit) {
      profitZoneSince = 0;
      return 'wait';
    }
    if (!profitZoneSince) profitZoneSince = now;
    const waited = now - profitZoneSince;
    if (waited < PROFIT_ZONE_SETTLE_MS) return 'settling';
    profitZoneSince = 0;
    return 'bet';
  }

  assert(checkAutoBet(1, 1000) === 'wait', '수익률 미달 → 대기');
  assert(checkAutoBet(3, 1000) === 'settling', '수익 구간 진입 → 안정화');
  assert(checkAutoBet(3, 1200) === 'settling', '0.2초 — 아직 안정화');
  assert(checkAutoBet(3, 1600) === 'bet', '0.6초 후 배팅');

  // ── mergeSlipCached 시뮬 (¢ 우선) ──
  console.log('\n[6] 슬립 캐시 병합 시뮬');
  function slipOdds(slip) {
    if (!slip) return null;
    if (slip.odds > 1 && slip.odds <= 50) return slip.odds;
    if (slip.priceCents >= 1 && slip.priceCents < 100) return 100 / slip.priceCents;
    return null;
  }

  function mergeSlipCached(cached, fresh) {
    if (!fresh) return cached;
    if (fresh.pendingToWin && cached) {
      return { ...cached, stake: fresh.stake || cached.stake, pendingToWin: true };
    }
    const freshOdds = slipOdds(fresh);
    if (!freshOdds) return cached;
    if (!cached) return { ...fresh, odds: freshOdds };
    if (cached.fromPayout && fresh.priceCents && !fresh.fromPayout) {
      return { ...fresh, odds: freshOdds };
    }
    return { ...cached, ...fresh, odds: freshOdds };
  }

  const stale = { odds: 1.927, fromPayout: true, stake: 5 };
  const board = { priceCents: 29, odds: 3.45, fromPayout: false, stake: 5 };
  const merged = mergeSlipCached(stale, board);
  assert(merged.priceCents === 29, '보드 ¢ 우선 (29¢)');
  assertNear(merged.odds, 3.45, 0.01, '보드 배당 우선');

  // ── 홈/원정 전환 시뮬 ──
  console.log('\n[7] 홈/원정 outcome 전환');
  function teamMatchesButton(team, text) {
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
    const nt = norm(team);
    const bt = norm(text);
    return nt && bt && (bt.includes(nt) || nt.includes(bt));
  }
  function resolveTeamCents(buyTeam, activeOutcome) {
    let team = buyTeam || activeOutcome?.team || '';
    if (buyTeam && activeOutcome && !teamMatchesButton(buyTeam, activeOutcome.team)) team = buyTeam;
    let cents = null;
    if (activeOutcome && teamMatchesButton(team, activeOutcome.team)) cents = activeOutcome.cents;
    return { team, cents };
  }
  const home = resolveTeamCents('LGD Gaming', { team: 'LGD Gaming', cents: 65 });
  assert(home.team === 'LGD Gaming' && home.cents === 65, '홈팀 선택');
  const away = resolveTeamCents('Team WE', { team: 'LGD Gaming', cents: 65 });
  assert(away.team === 'Team WE' && away.cents === null, '원정 전환 — Buy 버튼 우선');
  const away2 = resolveTeamCents('Team WE', { team: 'Team WE', cents: 35 });
  assert(away2.cents === 35, '원정팀 ¢ 인식');

  function mergeOnTeamSwitch(cached, fresh) {
    if (cached?.teamLabel && fresh?.teamLabel && cached.teamLabel !== fresh.teamLabel) {
      return { ...fresh, teamSwitched: true };
    }
    return { ...cached, ...fresh };
  }
  const switched = mergeOnTeamSwitch(
    { teamLabel: 'Home', odds: 1.5, priceCents: 67 },
    { teamLabel: 'Away', odds: 2.86, priceCents: 35 }
  );
  assert(switched.teamSwitched && switched.priceCents === 35, '팀 전환 시 캐시 갱신');

  // ── 결과 ──
  console.log(`\n═══ 결과: ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
