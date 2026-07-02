#!/usr/bin/env python3
"""실제 Pinnacle + pbc00 가상배팅 테스트."""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from src.config import load_config, setup_logging
from src.core.calculator import ArbitrageCalculator
from src.core.executor import BetExecutor
from src.core.monitor import OddsMonitor
from src.main import create_adapter

console = Console()


async def run_real_virtual_test(max_scans: int = 3):
  cfg = load_config("config/settings.real.yaml")
  setup_logging(cfg.log_level)

  console.print(Panel(
    "[bold]실제 사이트 가상배팅 (Dry-Run)[/bold]\n"
    f"A: {cfg.site_a.name} (API)\n"
    f"B: {cfg.site_b.name} (Playwright)\n"
    f"투자금: {cfg.total_stake:,.0f}원 | 최소수익률: {cfg.min_profit_margin}%\n"
    "실제 배팅 없음 - 시뮬레이션만",
    title="Real Virtual Bet Test",
    border_style="cyan",
  ))

  site_a = create_adapter(cfg.site_a)
  site_b = create_adapter(cfg.site_b)

  console.print("[bold]사이트 연결 중...[/bold]")
  ok_a = await site_a.connect()
  ok_b = await site_b.connect()

  console.print(f"  Pinnacle: {'[green]연결됨[/green]' if ok_a else '[red]실패[/red]'}")
  console.print(f"  PBC00:    {'[green]연결됨[/green]' if ok_b else '[red]실패 (Cloudflare 차단 가능)[/red]'}")

  if not ok_a:
    console.print("[red]Pinnacle 연결 실패 - 테스트 중단[/red]")
    return

  if not ok_b:
    console.print("[yellow]pbc00 연결 실패 - Pinnacle 배당만 조회합니다[/yellow]")

  # 배당 조회
  console.print("\n[bold]배당 조회 중...[/bold]")
  odds_a = await site_a.fetch_odds(cfg.sports)
  console.print(f"  Pinnacle: {len(odds_a)}개 마켓")

  odds_b = []
  if ok_b:
    odds_b = await site_b.fetch_odds(cfg.sports)
    console.print(f"  PBC00:    {len(odds_b)}개 마켓")

  if not odds_b:
    await _show_pinnacle_only(odds_a, site_a)
    await site_a.disconnect()
    if ok_b:
      await site_b.disconnect()
    return

  calculator = ArbitrageCalculator(
    min_profit_margin=cfg.min_profit_margin,
    total_stake=cfg.total_stake,
  )
  executor = BetExecutor(site_a=site_a, site_b=site_b, dry_run=True)
  simulated: list = []

  async def on_opportunity(opp):
    result = await executor.execute(opp)
    if result["status"] == "simulated":
      simulated.append(result)
      console.print(Panel(opp.summary(), title=f"[green]가상배팅 #{len(simulated)}[/green]"))

  monitor = OddsMonitor(
    site_a=site_a, site_b=site_b, calculator=calculator,
    sports=cfg.sports, on_opportunity=on_opportunity,
  )

  for i in range(max_scans):
    console.print(f"\n[dim]스캔 {i + 1}/{max_scans}...[/dim]")
    odds_a = await site_a.fetch_odds(cfg.sports)
    odds_b = await site_b.fetch_odds(cfg.sports)
    opportunities = calculator.find_opportunities(odds_a, odds_b)

    if opportunities:
      for opp in opportunities:
        await on_opportunity(opp)
    else:
      console.print("  양방배팅 기회 없음")

    if i < max_scans - 1:
      await asyncio.sleep(cfg.poll_interval)

  await site_a.disconnect()
  await site_b.disconnect()

  _print_summary(simulated, odds_a, odds_b)


async def _show_pinnacle_only(odds_a, site_a):
  ml = [o for o in odds_a if o.market_type.value == "moneyline"][:10]
  table = Table(title="Pinnacle 실시간 배당 (pbc00 미연결)")
  table.add_column("리그", style="dim")
  table.add_column("경기", style="cyan")
  table.add_column("홈", justify="right")
  table.add_column("무", justify="right")
  table.add_column("원정", justify="right")
  for mo in ml:
    h = d = a = "-"
    for o in mo.odds:
      if o.outcome.value == "home": h = f"{o.value:.2f}"
      elif o.outcome.value == "draw": d = f"{o.value:.2f}"
      elif o.outcome.value == "away": a = f"{o.value:.2f}"
    table.add_row(mo.match.league, mo.match.display_name, h, d, a)
  console.print(table)
  console.print(Panel(
    "pbc00.com은 Cloudflare 보호로 서버에서 접근 불가합니다.\n"
    "로컬 PC에서 아래 명령으로 실행하세요:\n\n"
    "  python -m src.main virtual-test-real\n\n"
    "또는 settings.yaml에 pbc00 로그인 정보 + cookies_path 설정 후\n"
    "  python -m src.main scan",
    title="pbc00 연동 필요",
    border_style="yellow",
  ))


def _print_summary(simulated, odds_a, odds_b):
  # 공통 경기 수
  from src.utils.match_matcher import match_key
  keys_a = {match_key(mo.match.home_team, mo.match.away_team) for mo in odds_a}
  keys_b = {match_key(mo.match.home_team, mo.match.away_team) for mo in odds_b}
  common = keys_a & keys_b

  console.print(f"\n[bold]매칭 현황[/bold]")
  console.print(f"  Pinnacle 경기: {len(keys_a)} | PBC00 경기: {len(keys_b)} | 공통: {len(common)}")

  if common:
    console.print("\n[bold]공통 경기 샘플:[/bold]")
    for k in list(common)[:5]:
      console.print(f"  - {k.replace('|', ' vs ')}")

  if simulated:
    table = Table(title=f"가상배팅 결과 ({len(simulated)}건)")
    table.add_column("경기", style="cyan")
    table.add_column("마켓")
    table.add_column("수익률", justify="right", style="green")
    table.add_column("확정수익", justify="right")
    table.add_column("배팅 상세")
    for bet in simulated:
      detail = " | ".join(
        f"{b['site']}:{b['outcome']}@{b['odds']:.2f}({b['stake']:,.0f})"
        for b in bet.get("bets", [])
      )
      table.add_row(
        bet["match"], "-", f"{bet['profit_margin']:.2f}%",
        f"{bet['guaranteed_profit']:,.0f}원", detail,
      )
    console.print(table)
    total = sum(b["guaranteed_profit"] for b in simulated)
    console.print(Panel(
      f"가상배팅 {len(simulated)}건 | 총 확정수익 [green]{total:,.0f}원[/green]\n실제 배팅: 없음",
      title="완료", border_style="green",
    ))
  else:
    console.print("[yellow]양방배팅 기회 없음[/yellow]")
    if not common:
      console.print("두 사이트 간 공통 경기가 없습니다. 팀명 매칭 또는 리그 설정을 확인하세요.")


if __name__ == "__main__":
  asyncio.run(run_real_virtual_test())
