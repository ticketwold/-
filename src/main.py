#!/usr/bin/env python3
"""양방배팅 자동화 CLI."""

from __future__ import annotations

import asyncio
import signal
import sys
from pathlib import Path

import click
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.config import AppConfig, load_config, setup_logging
from src.core.calculator import ArbitrageCalculator
from src.core.executor import BetExecutor
from src.core.monitor import OddsMonitor
from src.sites.mock import MockSiteAdapter
from src.sites.pbc00 import Pbc00Adapter
from src.sites.pinnacle import PinnacleAdapter
from src.sites.playwright_adapter import PlaywrightSiteAdapter

console = Console()


def create_adapter(config):
  common = dict(
    name=config.name,
    base_url=config.base_url,
    username=config.username,
    password=config.password,
  )

  if config.adapter == "mock":
    return MockSiteAdapter(**common)

  if config.adapter == "pinnacle":
    return PinnacleAdapter(
      **common,
      skip_live=config.skip_live,
      league_filter=config.league_filter,
    )

  if config.adapter == "pbc00":
    return Pbc00Adapter(
      **common,
      gamecode=config.gamecode,
      game_child_seq=config.game_child_seq,
      cookies_path=config.cookies_path,
      headless=config.headless,
      selectors=config.selectors or None,
    )

  if config.adapter == "playwright":
    return PlaywrightSiteAdapter(**common)

  raise ValueError(f"알 수 없는 어댑터: {config.adapter}")


@click.group()
@click.version_option(version="0.1.0")
def cli():
  """양방배팅(Arbitrage Betting) 자동화 프로그램."""
  pass


@cli.command()
@click.option("--config", "-c", default=None, help="설정 파일 경로")
@click.option("--dry-run/--live", default=None, help="드라이런 모드")
@click.option("--interval", "-i", default=None, type=float, help="폴링 간격(초)")
@click.option("--min-profit", "-m", default=None, type=float, help="최소 수익률(%)")
def monitor(config, dry_run, interval, min_profit):
  """실시간 배당 모니터링 및 자동 배팅."""
  cfg = load_config(config)
  setup_logging(cfg.log_level)

  if dry_run is not None:
    cfg.dry_run = dry_run
  if interval is not None:
    cfg.poll_interval = interval
  if min_profit is not None:
    cfg.min_profit_margin = min_profit

  asyncio.run(_run_monitor(cfg))


async def _run_monitor(cfg: AppConfig):
  site_a = create_adapter(cfg.site_a)
  site_b = create_adapter(cfg.site_b)

  console.print(Panel(
    f"[bold]양방배팅 모니터링 시작[/bold]\n"
    f"A사이트: {cfg.site_a.name} ({cfg.site_a.adapter})\n"
    f"B사이트: {cfg.site_b.name} ({cfg.site_b.adapter})\n"
    f"최소 수익률: {cfg.min_profit_margin}%\n"
    f"총 투자금: {cfg.total_stake:,.0f}원\n"
    f"모드: {'드라이런' if cfg.dry_run else '실제 배팅'}\n"
    f"폴링 간격: {cfg.poll_interval}초",
    title="Arbitrage Bot",
    border_style="green",
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
    dry_run=cfg.dry_run,
    max_concurrent_bets=cfg.max_concurrent_bets,
  )

  async def on_opportunity(opp):
    result = await executor.execute(opp)
    if result["status"] in ("simulated", "executed"):
      console.print(Panel(
        opp.summary(),
        title=f"[green]배팅 {'시뮬레이션' if cfg.dry_run else '실행'}[/green]",
        border_style="green",
      ))

  odds_monitor = OddsMonitor(
    site_a=site_a,
    site_b=site_b,
    calculator=calculator,
    poll_interval=cfg.poll_interval,
    sports=cfg.sports,
    on_opportunity=on_opportunity,
  )

  loop = asyncio.get_event_loop()

  def shutdown():
    odds_monitor.stop()

  for sig in (signal.SIGINT, signal.SIGTERM):
    loop.add_signal_handler(sig, shutdown)

  try:
    await odds_monitor.start()
  finally:
    await site_a.disconnect()
    await site_b.disconnect()
  _print_summary(executor, odds_monitor)


@cli.command()
@click.option("--config", "-c", default=None, help="설정 파일 경로")
def scan(config):
  """1회 스캔으로 양방배팅 기회 확인."""
  cfg = load_config(config)
  setup_logging(cfg.log_level)
  asyncio.run(_run_scan(cfg))


async def _run_scan(cfg: AppConfig):
  site_a = create_adapter(cfg.site_a)
  site_b = create_adapter(cfg.site_b)

  await site_a.connect()
  await site_b.connect()

  calculator = ArbitrageCalculator(
    min_profit_margin=cfg.min_profit_margin,
    total_stake=cfg.total_stake,
  )
  odds_monitor = OddsMonitor(
    site_a=site_a,
    site_b=site_b,
    calculator=calculator,
    sports=cfg.sports,
  )

  console.print("[bold]배당 스캔 중...[/bold]")
  opportunities = await odds_monitor.scan_once()

  if not opportunities:
    console.print("[yellow]양방배팅 기회 없음[/yellow]")
  else:
    table = Table(title=f"양방배팅 기회 {len(opportunities)}건")
    table.add_column("경기", style="cyan")
    table.add_column("마켓")
    table.add_column("수익률", justify="right", style="green")
    table.add_column("확정수익", justify="right")
    table.add_column("배팅 상세")

    for opp in opportunities:
      bet_detail = " | ".join(
        f"{a.site}:{a.outcome.value}@{a.odds:.2f}({a.stake:,.0f})"
        for a in opp.allocations
      )
      table.add_row(
        opp.match.display_name,
        opp.market_type.value,
        f"{opp.profit_margin:.2f}%",
        f"{opp.guaranteed_profit:,.0f}원",
        bet_detail,
      )
    console.print(table)

  await site_a.disconnect()
  await site_b.disconnect()


@cli.command()
@click.argument("odds_a", type=float)
@click.argument("odds_b", type=float)
@click.option("--stake", "-s", default=100_000, type=float, help="총 투자금")
def calc(odds_a, odds_b, stake):
  """2-way 양방배팅 계산기."""
  calculator = ArbitrageCalculator(total_stake=stake)
  implied_sum = 1 / odds_a + 1 / odds_b

  if implied_sum >= 1:
    console.print(f"[red]양방배팅 불가[/red] (합산 확률: {implied_sum:.4f})")
    return

  margin = (1 - implied_sum) * 100
  stakes = calculator.calc_optimal_stakes([odds_a, odds_b], stake)
  profit = stakes[0] * odds_a - sum(stakes)

  table = Table(title="양방배팅 계산 결과")
  table.add_column("항목")
  table.add_column("값", justify="right")
  table.add_row("A사이트 배당", f"{odds_a:.2f}")
  table.add_row("B사이트 배당", f"{odds_b:.2f}")
  table.add_row("수익률", f"[green]{margin:.2f}%[/green]")
  table.add_row("A사이트 배팅금", f"{stakes[0]:,.0f}원")
  table.add_row("B사이트 배팅금", f"{stakes[1]:,.0f}원")
  table.add_row("확정 수익", f"[green]{profit:,.0f}원[/green]")
  console.print(table)


@cli.command()
@click.option("--config", "-c", default=None, help="설정 파일 경로")
def discover(config):
  """pbc00 사이트 구조 탐색 (로컬 PC에서 실행)."""
  cfg = load_config(config)
  setup_logging(cfg.log_level)

  if cfg.site_a.adapter == "pbc00":
    site_cfg = cfg.site_a
  elif cfg.site_b.adapter == "pbc00":
    site_cfg = cfg.site_b
  else:
    console.print("[red]설정에서 site_a 또는 site_b의 adapter를 pbc00으로 설정하세요[/red]")
    return

  asyncio.run(_run_discover(site_cfg))


async def _run_discover(site_cfg):
  adapter = create_adapter(site_cfg)
  connected = await adapter.connect()
  if not connected:
    console.print("[red]연결 실패 (Cloudflare 차단 가능)[/red]")
    return

  console.print("[bold]사이트 구조 탐색 중...[/bold]")
  await adapter.fetch_odds()
  result = await adapter.discover()

  table = Table(title="탐색 결과")
  table.add_column("항목")
  table.add_column("값")
  table.add_row("URL", result.get("url", ""))
  table.add_row("Title", result.get("title", ""))
  table.add_row("API 호출 수", str(len(result.get("api_calls", []))))
  table.add_row("셀렉터 발견", str(len(result.get("selectors_found", {}))))
  console.print(table)

  if result.get("api_calls"):
    console.print("\n[bold]캡처된 API:[/bold]")
    for api in result["api_calls"][:5]:
      console.print(f"  {api['url']}")
      console.print(f"    {api['sample'][:200]}")

  await adapter.disconnect()


@cli.command()
@click.option("--sport", "-s", default="football", help="스포츠 (football, basketball)")
@click.option("--limit", "-l", default=10, type=int, help="표시할 경기 수")
def pinnacle(sport, limit):
  """Pinnacle 배당 조회 테스트."""
  setup_logging("INFO")
  asyncio.run(_run_pinnacle_test(sport, limit))


async def _run_pinnacle_test(sport: str, limit: int):
  adapter = PinnacleAdapter(name="Pinnacle")
  await adapter.connect()

  console.print(f"[bold]Pinnacle {sport} 배당 조회 중...[/bold]")
  odds_list = await adapter.fetch_odds([sport])
  console.print(f"총 {len(odds_list)}개 마켓")

  ml = [o for o in odds_list if o.market_type.value == "moneyline"]
  table = Table(title=f"승무패 배당 (상위 {limit}건)")
  table.add_column("리그", style="dim")
  table.add_column("경기", style="cyan")
  table.add_column("홈", justify="right")
  table.add_column("무", justify="right")
  table.add_column("원정", justify="right")

  for mo in ml[:limit]:
    home = draw = away = "-"
    for o in mo.odds:
      if o.outcome.value == "home":
        home = f"{o.value:.2f}"
      elif o.outcome.value == "draw":
        draw = f"{o.value:.2f}"
      elif o.outcome.value == "away":
        away = f"{o.value:.2f}"
    table.add_row(mo.match.league, mo.match.display_name, home, draw, away)

  console.print(table)
  await adapter.disconnect()


def _print_summary(executor: BetExecutor, monitor: OddsMonitor):
  stats = monitor.stats
  console.print(Panel(
    f"총 스캔: {stats['scan_count']}회\n"
    f"기회 발견: {stats['opportunities_found']}건\n"
    f"배팅 기록: {len(executor.history)}건",
    title="실행 요약",
  ))


if __name__ == "__main__":
  cli()
