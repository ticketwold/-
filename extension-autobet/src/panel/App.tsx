import { useEffect } from 'react';
import { installLegacyGlobals } from '@shared/legacy/install-globals';
import { RafLoopScheduler } from '@shared/dom/observer-scheduler';
import '../engine';
import { bootstrapPanel } from './hooks/panel-controller.legacy';
import './panel.css';

function App() {
  useEffect(() => {
    installLegacyGlobals();
    const scheduler = new RafLoopScheduler();
    bootstrapPanel(scheduler);
    return () => scheduler.clear();
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            ⚡
          </div>
          <div className="brand-text">
            <h1>양방 자동배팅</h1>
            <p className="version" id="versionLabel">
              Pro · v3.0.0
            </p>
          </div>
        </div>
        <div id="armStatus" className="status-pill disarmed" role="status">
          대기
        </div>
      </header>

      <section className="card dashboard-card">
        <div className="metric-grid">
          <div className="metric">
            <span className="metric-label">수익률</span>
            <strong id="profitVal" className="metric-value">
              —
            </strong>
          </div>
          <div className="metric">
            <span className="metric-label" id="oddsLabel">
              텐텐뱃 / B
            </span>
            <strong id="oddsVal" className="metric-value mono">
              — / —
            </strong>
          </div>
        </div>
        <p className="status-hint" id="statusHint">
          오른쪽 사이트를 선택하고 [연결]을 눌러 시작하세요
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">왼쪽(A) 텐텐뱃</h2>
          <span id="btiSyncStatus" className="sync-badge">
            미확인
          </span>
        </div>
        <div className="site-sync-row">
          <button id="btiOpenBtn" type="button" className="btn btn-open">
            텐텐뱃 열기
          </button>
          <button id="btiVerifyBtn" type="button" className="btn btn-accent">
            연결확인
          </button>
        </div>
        <p className="field-hint warn-hint">
          ⚠ v3.0.0 — TypeScript · MV3 · React 패널
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">오른쪽(B) 사이트</h2>
          <span id="syncStatus" className="sync-badge">
            미연결
          </span>
        </div>
        <div className="site-sync-row">
          <select id="leg2Site" className="input-select" aria-label="오른쪽 사이트 선택">
            <option value="bcgame">BC.Game</option>
            <option value="stake">Stake.com</option>
          </select>
          <button id="leg2OpenBtn" type="button" className="btn btn-open">
            사이트 열기
          </button>
          <button id="syncBtn" type="button" className="btn btn-accent">
            연결
          </button>
        </div>
        <p className="field-hint warn-hint">⚠ [사이트 열기] → 스포츠 페이지 → [연결]</p>
      </section>

      <section className="card">
        <h2 className="card-title">설정</h2>
        <div className="field">
          <label htmlFor="minProfit">최소 수익률 (%)</label>
          <input type="number" id="minProfit" className="input" defaultValue={1} step={0.1} />
        </div>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="btiBet">텐텐뱃 금액 (원)</label>
            <input type="number" id="btiBet" className="input" defaultValue={10000} min={1000} step={1000} />
          </div>
          <div className="field">
            <label htmlFor="usdRate">USDT 환율</label>
            <input type="number" id="usdRate" className="input" defaultValue={1400} min={1000} step={10} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="cooldownMs">재배팅 쿨다운 (ms)</label>
          <input type="number" id="cooldownMs" className="input" defaultValue={0} min={0} step={100} />
        </div>
        <label className="toggle">
          <input type="checkbox" id="useBridge" defaultChecked />
          <span className="toggle-ui" />
          <span className="toggle-text">양방배팅봇 신호 우선</span>
        </label>
        <label className="toggle">
          <input type="checkbox" id="preSync" defaultChecked />
          <span className="toggle-ui" />
          <span className="toggle-text" id="preSyncLabel">
            실시간 금액 동기화
          </span>
        </label>
      </section>

      <section className="card actions-card">
        <div className="btn-grid">
          <button id="armBtn" type="button" className="btn btn-danger" disabled>
            오토시작
          </button>
          <button id="disarmBtn" type="button" className="btn btn-ghost" disabled>
            오토 멈춤
          </button>
        </div>
        <div className="btn-grid">
          <button id="scanBtn" type="button" className="btn btn-primary" disabled>
            배당 스캔
          </button>
          <button id="testBetBtn" type="button" className="btn btn-ghost" disabled>
            테스트 배팅
          </button>
        </div>
      </section>

      <section className="card log-card">
        <div className="card-head">
          <h2 className="card-title">로그</h2>
        </div>
        <div id="log" className="log" role="log" aria-live="polite" />
      </section>
    </div>
  );
}

export default App;
