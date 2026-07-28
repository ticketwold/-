#!/usr/bin/env python3
"""가상배팅(드라이런) 테스트 스크립트."""

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


async def run_virtual_bet_test(max_scans: int = 10):
  cfg = load_config("config/settings.test.yaml")
  setup_logging(cfg.log_level)

  # Mock 사이트 간 배당 차이 시뮬레이션
  site_a = create_adapter(cfg.site_a)
  site_b = create_adapter(cfg.site_b)
  if hasattr(site_a, "bias"):
    site_a.bias = 0.08
  if hasattr(site_b, "bias"):
    site_b.bias = -0.08

  console.print(Panel(
    "[bold]가상배팅 테스트 (Dry-Run)[/bold]\n"
    f"A사이트: {cfg.site_a.name}\n"
    f"B사이트: {cfg.site_b.name}\n"
    f"총 투자금: {cfg.total_stake:,.0f}원\n"
    f"최소 수익률: {cfg.min_profit_margin}%\n"
    f"스캔 횟수: {max_scans}회",
    title="Virtual Bet Test",
    border_style="cyan",
  ))

  await site_a.connect()
  await site_b.connect()

  calculator = ArbitrageCalculator(
    min_profit_margin=cfg.min_profit_margin,
    total_stake=cfg.total_stake,
  )
  executor = BetExecutor(
    site_a=site_a,
    site_b=site_b,
    dry_run=True,
    max_concurrent_bets=cfg.max_concurrent_bets,
  )

  simulated_bets: list[dict] = []

  async def on_opportunity(opp):
    result = await executor.execute(opp)
    if result["status"] == "simulated":
      simulated_bets.append(result)
      console.print(Panel(
        opp.summary(),
        title=f"[green]가상배팅 #{len(simulated_bets)}[/green]",
        border_style="green",
      ))

  monitor = OddsMonitor(
    site_a=site_a,
    site_b=site_b,
    calculator=calculator,
    poll_interval=cfg.poll_interval,
    sports=cfg.sports,
    on_opportunity=on_opportunity,
  )

  for i in range(max_scans):
    console.print(f"[dim]스캔 {i + 1}/{max_scans}...[/dim]")
    await monitor.scan_once()
    await asyncio.sleep(cfg.poll_interval)

  await site_a.disconnect()
  await site_b.disconnect()

  # 결과 요약
  console.print()
  if not simulated_bets:
    console.print("[yellow]이번 테스트에서 양방배팅 기회가 발생하지 않았습니다.[/yellow]")
    console.print("배당 랜덤 변동으로 기회가 없을 수 있습니다. 다시 실행해 보세요.")
  else:
    table = Table(title=f"가상배팅 결과 요약 ({len(simulated_bets)}건)")
    table.add_column("#", justify="right")
    table.add_column("경기", style="cyan")
    table.add_column("수익률", justify="right", style="green")
    table.add_column("확정수익", justify="right")
    table.add_column("총 배팅금", justify="right")

    total_profit = 0
    total_stake = 0
    for i, bet in enumerate(simulated_bets, 1):
      table.add_row(
        str(i),
        bet["match"],
        f"{bet['profit_margin']:.2f}%",
        f"{bet['guaranteed_profit']:,.0f}원",
        f"{bet['total_stake']:,.0f}원",
      )
      total_profit += bet["guaranteed_profit"]
      total_stake += bet["total_stake"]

    console.print(table)
    console.print(Panel(
      f"가상배팅 건수: {len(simulated_bets)}건\n"
      f"총 배팅금: {total_stake:,.0f}원\n"
      f"총 확정수익: [green]{total_profit:,.0f}원[/green]\n"
      f"실제 배팅: [bold]없음 (시뮬레이션)[/bold]",
      title="테스트 완료",
      border_style="green",
    ))

  return len(simulated_bets)


if __name__ == "__main__":
  count = asyncio.run(run_virtual_bet_test(max_scans=15))
  sys.exit(0 if count > 0 else 1)
