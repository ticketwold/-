/** Per-site slip aggregation — revision-aware, multi-frame. */

const siteState = {
  bc: createSiteBucket(),
  x10: createSiteBucket(),
};

const frameSlipCache = {};
const FRAME_CACHE_TTL_MS = 45_000;
const siteStatusDebounce = {
  bc: { code: "empty", hits: 0, since: 0, confirmed: "empty" },
  x10: { code: "empty", hits: 0, since: 0, confirmed: "empty" },
};

function createSiteBucket() {
  return {
    tab_id: null,
    frame_id: null,
    frame_url: "",
    revision: 0,
    dom_hash: "",
    odds: null,
    status: "empty",
    slip: null,
    updated_at: 0,
    tab_found: false,
  };
}

function frameCacheKey(site, tabId, frameId) {
  return `${site}:${tabId ?? "x"}:${frameId ?? 0}`;
}

function pruneFrameCache() {
  const now = Date.now();
  for (const [key, entry] of Object.entries(frameSlipCache)) {
    if (now - entry.ts > FRAME_CACHE_TTL_MS) delete frameSlipCache[key];
  }
}

export function slipPriority(result) {
  if (!result) return 0;
  if (!result.empty && result.items?.length) {
    const st = String(result.items[0]?.status || "active").toLowerCase();
    if (st === "active") return 100;
    if (["closed", "suspended", "disabled", "closed_pending"].includes(st)) return 80;
    if (st === "odds_missing") return 60;
    return 55;
  }
  if (result.invalidated) return 5;
  if (result.slip_root_found === "YES" || (result.slip_count || 0) > 0) return 60;
  return 0;
}

/** X10 multi-frame priority — top EMPTY must not beat iframe ACTIVE */
export function x10SlipPriority(result) {
  if (!result) return 0;
  const rootFound = result.slip_root_found === "YES" || result.root_found === "YES";
  const slipCount = Number(result.slip_count || 0);
  const odds = result.extracted_odds ?? result.items?.[0]?.odds ?? null;
  const status = String(result.parsed_status || result.items?.[0]?.status || "").toLowerCase();

  if (!rootFound) {
    const blob = String(result.slip_inner_text || "");
    const hasKw = /베팅\s*슬립|베팅슬립|\b싱글\b|배당\s*수락|배팅\s*수락/i.test(blob);
    return hasKw ? 10 : 0;
  }
  if (status === "active" && odds != null) return 100;
  if (slipCount === 1) return 80;
  if (["closed", "suspended", "disabled", "closed_pending"].includes(status)) return 70;
  return 50;
}

export function x10FrameScanPriority(entry) {
  if (!entry) return 0;
  const rootFound = entry.root_found === true || entry.root_found === "YES";
  const slipCount = Number(entry.slip_count || 0);
  const odds = entry.odds != null && entry.odds !== "" ? Number(entry.odds) : null;
  const status = String(entry.status || "").toLowerCase();

  if (!rootFound) return entry.body_has_keywords ? 10 : 0;
  if (status === "active" && odds != null && Number.isFinite(odds)) return 100;
  if (slipCount === 1) return 80;
  if (["closed", "suspended", "disabled", "closed_pending"].includes(status)) return 70;
  return 50;
}

function pickBestSiteResult(site) {
  pruneFrameCache();
  let best = null;
  let bestPriority = -1;
  for (const [key, entry] of Object.entries(frameSlipCache)) {
    if (!key.startsWith(`${site}:`)) continue;
    if (entry.priority > bestPriority || (entry.priority === bestPriority && entry.ts > (best?.ts || 0))) {
      bestPriority = entry.priority;
      best = entry;
    }
  }
  return best;
}

function mapRawSlipStatus(result) {
  if (!result || result.empty || !result.items?.length) {
    if (result?.invalidated) return "scanning";
    return "empty";
  }
  const st = String(result.items[0]?.status || "empty").toLowerCase();
  return st;
}

function confirmSiteStatus(site, rawCode) {
  const d = siteStatusDebounce[site];
  const now = Date.now();
  if (rawCode === d.code) d.hits += 1;
  else {
    d.code = rawCode;
    d.hits = 1;
    d.since = now;
  }
  if (d.hits >= 2 || now - d.since >= 200) d.confirmed = rawCode;
  return d.confirmed;
}

export function ingestSlipUpdate(site, result, meta) {
  const key = site === "bc" ? "bc" : "x10";
  const rev = Number(result?.revision || 0);
  const bucket = siteState[key];

  if (rev > 0 && rev < bucket.revision && !result?.invalidated) {
    return { accepted: false, reason: "stale-revision", bucket: { ...bucket } };
  }

  const cacheKey = frameCacheKey(key, meta.tab_id, meta.frame_id);
  const priority = key === "x10" ? x10SlipPriority(result) : slipPriority(result);
  frameSlipCache[cacheKey] = {
    result,
    meta,
    priority,
    ts: Date.now(),
  };

  const best = pickBestSiteResult(key);
  if (!best) return { accepted: false, reason: "no-best", bucket: { ...bucket } };

  const bestResult = best.result;
  const bestRev = Number(bestResult?.revision || 0);
  if (bestRev < bucket.revision && !bestResult?.invalidated) {
    return { accepted: false, reason: "lower-best-revision", bucket: { ...bucket } };
  }

  const item = bestResult?.items?.[0];
  const odds = bestResult?.invalidated || bestResult?.empty
    ? null
    : (item?.odds ?? bestResult?.extracted_odds ?? null);
  const status = bestResult?.invalidated
    ? confirmSiteStatus(key, "scanning")
    : confirmSiteStatus(key, mapRawSlipStatus(bestResult));

  bucket.tab_id = meta.tab_id ?? best.meta?.tab_id ?? bucket.tab_id;
  bucket.frame_id = meta.frame_id ?? best.meta?.frame_id ?? bucket.frame_id;
  bucket.frame_url = meta.frame_url || best.meta?.frame_url || bestResult?.frame_url || "";
  bucket.revision = bestRev;
  bucket.dom_hash = bestResult?.dom_hash || "";
  bucket.odds = odds != null ? Number(odds) : null;
  bucket.status = status;
  bucket.slip = bestResult;
  bucket.updated_at = Date.now();

  return { accepted: true, bucket: { ...bucket }, prev_odds: bucket.odds };
}

export function setTabFound(site, tabId, found) {
  const bucket = siteState[site];
  if (found) {
    bucket.tab_id = tabId;
    bucket.tab_found = true;
  } else if (bucket.tab_id === tabId) {
    bucket.tab_found = false;
  }
}

export function getSiteState(site) {
  return { ...siteState[site] };
}

export function getAllSiteState() {
  return { bc: getSiteState("bc"), x10: getSiteState("x10") };
}

export function bothSitesActive() {
  return siteState.bc.status === "active" && siteState.x10.status === "active";
}

export function siteLabel(site) {
  const b = siteState[site];
  if (!b.tab_found) return "탭 없음";
  if (b.status === "active") return "ACTIVE";
  if (b.status === "empty" || b.status === "scanning") return b.status === "scanning" ? "SCANNING" : "EMPTY";
  if (b.status === "closed" || b.status === "closed_pending") return "CLOSED";
  return String(b.status || "unknown").toUpperCase();
}
