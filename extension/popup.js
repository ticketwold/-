/**
 * 양방배팅 Popup UI
 */

const $ = (id) => document.getElementById(id);

function send(action, data = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...data }, resolve);
  });
}

function setStatus(text, type = "") {
  const el = $("status");
  el.textContent = text;
  el.className = `status ${type}`;
}

function renderOpportunities(opps) {
  const box = $("results");
  if (!opps?.length) {
    box.innerHTML = '<p class="empty">양방 기회 없음</p>';
    return;
  }

  box.innerHTML = opps.map((o, i) => `
    <div class="opp">
      <div class="opp-head">
        <strong>#${i + 1} ${o.match.home} vs ${o.match.away}</strong>
        <span class="margin">+${o.profitMargin}%</span>
      </div>
      <div class="profit">확정수익 약 ${o.guaranteedProfit.toLocaleString()}원</div>
      <table>
        <thead><tr><th>사이트</th><th>선택</th><th>배당</th><th>금액</th></tr></thead>
        <tbody>
          ${o.allocations.map((a) => `
            <tr>
              <td>${a.site}</td>
              <td>${a.outcome}</td>
              <td>${a.odds.toFixed(2)}</td>
              <td>${a.stake.toLocaleString()}원</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `).join("");
}

function renderJson(title, data) {
  $("results").innerHTML = `<h3>${title}</h3><pre>${JSON.stringify(data, null, 2)}</pre>`;
}

async function loadSettings() {
  const s = await send("get-settings");
  if (s.sport) $("sport").value = s.sport;
  if (s.minProfitMargin) $("minProfit").value = s.minProfitMargin;
  if (s.totalStake) $("totalStake").value = s.totalStake;
}

async function saveSettingsFromUI() {
  await send("save-settings", {
    settings: {
      sport: $("sport").value,
      minProfitMargin: parseFloat($("minProfit").value),
      totalStake: parseInt($("totalStake").value, 10),
    },
  });
}

$("btnOpen").addEventListener("click", async () => {
  setStatus("pbc00 열는 중...");
  const res = await send("open-pbc00");
  if (res.ok) setStatus("pbc00 열림 — 로그인 후 BTI 경기 화면으로 이동", "ok");
  else setStatus("열기 실패", "err");
});

$("btnScan").addEventListener("click", async () => {
  await saveSettingsFromUI();
  setStatus("스캔 중... (Pinnacle API + BTI iframe)");
  $("results").innerHTML = "";

  const res = await send("scan-arb", {
    sport: $("sport").value,
    query: $("query").value.trim(),
    minProfit: parseFloat($("minProfit").value),
    totalStake: parseInt($("totalStake").value, 10),
  });

  if (!res.ok) {
    setStatus(`오류: ${res.error}`, "err");
    return;
  }

  const msg = [
    `Pinnacle ${res.pinnacle.matched}건`,
    `BTI 버튼 ${res.bti.buttonCount}개 / 경기 ${res.bti.eventCount}건`,
    `양방 ${res.opportunityCount}건`,
  ].join(" · ");

  if (res.bti.buttonCount === 0) {
    setStatus(`${msg} — BTI 배당 화면을 열어주세요`, "warn");
  } else {
    setStatus(msg, res.opportunityCount > 0 ? "ok" : "warn");
  }

  renderOpportunities(res.opportunities);

  if (res.opportunityCount === 0 && res.bti.hint) {
    $("results").innerHTML += `<p class="hint">${res.bti.hint}</p>`;
  }
});

$("btnPinnacle").addEventListener("click", async () => {
  setStatus("Pinnacle 조회 중...");
  const res = await send("pinnacle-fetch", {
    sport: $("sport").value,
    query: $("query").value.trim(),
  });
  setStatus(`Pinnacle ${res.hitCount ?? res.count ?? 0}건`);
  renderJson("Pinnacle", res.hits || res.matches?.slice(0, 10) || res);
});

$("btnBti").addEventListener("click", async () => {
  setStatus("BTI 검색 중...");
  const res = await send("bti-search", { query: $("query").value.trim() });
  if (res.error === "pbc00_tab_not_found") {
    setStatus("pbc00 탭 없음 — 먼저 pbc00 열기", "err");
    return;
  }
  setStatus(`BTI 버튼 ${res.buttonCount || 0} · 검색 ${res.selectionHitCount || res.hitCount || 0}건`);
  renderJson("BTI", res);
});

$("btnSlip").addEventListener("click", async () => {
  const res = await send("bti-slip");
  if (res?.slip) {
    setStatus(`슬립 배당 ${res.slip.odds} · ${res.slip.selectionText}`, "ok");
  } else {
    setStatus("슬립 없음 — 배당 버튼을 먼저 클릭", "warn");
  }
  renderJson("BTI 슬립", res);
});

loadSettings();
