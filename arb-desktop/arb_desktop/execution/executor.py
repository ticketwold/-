from __future__ import annotations

from dataclasses import dataclass

from playwright.async_api import Page

from arb_desktop.models import ArbOpportunity, SiteId


@dataclass
class ExecutionResult:
    ok: bool
    site: SiteId
    message: str


class AutoExecutor:
    """배팅 금액 입력 + 버튼 클릭 — Playwright 기반."""

    def __init__(self, bti_page: Page | None, bc_page: Page | None):
        self._bti_page = bti_page
        self._bc_page = bc_page

    async def execute(self, opp: ArbOpportunity, *, dry_run: bool = True) -> list[ExecutionResult]:
        results: list[ExecutionResult] = []
        if dry_run:
            results.append(ExecutionResult(True, SiteId.BTI_X10, f"DRY RUN BTI {opp.bti_side} @ {opp.bti_odds}"))
            results.append(ExecutionResult(True, SiteId.BC_GAME, f"DRY RUN BC {opp.bc_team} @ {opp.bc_odds} USDT {opp.bc_stake_usdt}"))
            return results

        if self._bti_page:
            results.append(await self._place_bti(opp))
        if self._bc_page:
            results.append(await self._place_bc(opp))
        return results

    async def _place_bti(self, opp: ArbOpportunity) -> ExecutionResult:
        try:
            # BTI stake input: #counter
            for frame in self._bti_page.frames:
                try:
                    inp = frame.locator("input#counter").first
                    if await inp.count() == 0:
                        continue
                    await inp.fill(str(int(opp.bti_stake_krw)))
                    btn = frame.locator('button.sportsbook-Button:has-text("베팅"), button:has-text("Place")').first
                    if await btn.count():
                        await btn.click()
                        return ExecutionResult(True, SiteId.BTI_X10, "BTI bet submitted")
                except Exception:
                    continue
            return ExecutionResult(False, SiteId.BTI_X10, "BTI stake input / bet button not found")
        except Exception as exc:
            return ExecutionResult(False, SiteId.BTI_X10, str(exc))

    async def _place_bc(self, opp: ArbOpportunity) -> ExecutionResult:
        try:
            for frame in self._bc_page.frames:
                try:
                    filled = await frame.evaluate(
                        """(amount) => {
                          const inputs = document.querySelectorAll('input, textarea');
                          for (const el of inputs) {
                            const hint = `${el.id} ${el.className} ${el.placeholder||''} ${el.getAttribute('aria-label')||''}`;
                            if (/search|email|password/i.test(hint)) continue;
                            if (/USDT|stake|amount|bet|베팅/i.test(hint)) {
                              el.focus();
                              const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
                              const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
                              if (setter) setter.call(el, String(amount));
                              else el.value = String(amount);
                              el.dispatchEvent(new Event('input', { bubbles: true }));
                              el.dispatchEvent(new Event('change', { bubbles: true }));
                              return true;
                            }
                          }
                          return false;
                        }""",
                        opp.bc_stake_usdt,
                    )
                    if not filled:
                        continue
                    btn = frame.locator('button:has-text("베팅하기"), button:has-text("Place bet")').first
                    if await btn.count():
                        await btn.click()
                        return ExecutionResult(True, SiteId.BC_GAME, "BC bet submitted")
                except Exception:
                    continue
            return ExecutionResult(False, SiteId.BC_GAME, "BC stake input / bet button not found")
        except Exception as exc:
            return ExecutionResult(False, SiteId.BC_GAME, str(exc))
