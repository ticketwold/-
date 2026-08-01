'use strict';

const TEAM_STOPWORDS = new Set([
  'team', 'gaming', 'esports', 'esport', 'club', 'fc', 'sc', 'the', 'of'
]);

function normTeam(name) {
  if (!name) return '';
  return String(name).toLowerCase()
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9가-힣]/g, '');
}

function hasHangul(name) {
  return /[가-힣]/.test(String(name || ''));
}

function latinWords(name) {
  return (String(name || '').toLowerCase().match(/[a-z0-9]{2,}/g) || [])
    .filter((w) => !TEAM_STOPWORDS.has(w));
}

function hangulChunks(name) {
  return (String(name || '').match(/[가-힣]{2,}/g) || []);
}

function teamTokens(name) {
  const tokens = new Set();
  const raw = String(name || '').trim();
  if (!raw) return tokens;

  const norm = normTeam(raw);
  if (norm.length >= 2) tokens.add(norm);

  for (const w of latinWords(raw)) tokens.add(w);
  for (const h of hangulChunks(raw)) tokens.add(h);

  const paren = raw.match(/\(([^)]+)\)/);
  if (paren) {
    for (const w of latinWords(paren[1])) tokens.add(w);
    const pn = normTeam(paren[1]);
    if (pn.length >= 2) tokens.add(pn);
  }

  const dotted = raw.match(/\b([A-Z]{2,6})\b/g);
  if (dotted) dotted.forEach((d) => tokens.add(d.toLowerCase()));

  return tokens;
}

function tokensMatch(a, b) {
  const ta = teamTokens(a);
  const tb = teamTokens(b);
  if (!ta.size || !tb.size) return false;

  for (const x of ta) {
    for (const y of tb) {
      if (x === y) return true;
      const minLen = Math.min(x.length, y.length);
      if (minLen >= 2 && (x.includes(y) || y.includes(x))) return true;
      if (minLen >= 3 && x.slice(0, 3) === y.slice(0, 3)) return true;
    }
  }
  return false;
}

function teamMatch(a, b) {
  const na = normTeam(a);
  const nb = normTeam(b);
  if (!na || !nb || na.length < 2 || nb.length < 2) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  if (na.length >= 4 && nb.length >= 4 && na.slice(0, 4) === nb.slice(0, 4)) return true;
  if (tokensMatch(a, b)) return true;
  if (hasHangul(a) && hasHangul(b)) {
    for (const x of hangulChunks(a)) {
      for (const y of hangulChunks(b)) {
        if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) return true;
        if (x.length >= 3 && y.length >= 3 && x.slice(0, 3) === y.slice(0, 3)) return true;
      }
    }
  }
  for (const x of latinWords(a)) {
    for (const y of latinWords(b)) {
      if (x === y || (x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x)))) return true;
    }
  }
  return false;
}

function collectNameVariants(...names) {
  const out = [];
  for (const n of names) {
    if (!n || normTeam(n).length < 2) continue;
    if (!out.some((x) => normTeam(x) === normTeam(n))) out.push(n);
  }
  return out;
}

function matchupTeamsMatch(a, b) {
  const aHomes = collectNameVariants(a.home, a.homeEn, a.homeKo);
  const aAways = collectNameVariants(a.away, a.awayEn, a.awayKo);
  const bHomes = collectNameVariants(b.home, b.homeEn, b.homeKo, b.eventHome);
  const bAways = collectNameVariants(b.away, b.awayEn, b.awayKo, b.eventAway);
  if (!aHomes.length || !aAways.length || !bHomes.length || !bAways.length) return false;

  function align(h1, aw1, h2, aw2) {
    return teamMatch(h1, h2) && teamMatch(aw1, aw2);
  }

  for (const h1 of aHomes) {
    for (const aw1 of aAways) {
      for (const h2 of bHomes) {
        for (const aw2 of bAways) {
          if (align(h1, aw1, h2, aw2)) return true;
        }
      }
      for (const h2 of bAways) {
        for (const aw2 of bHomes) {
          if (align(h1, aw1, h2, aw2)) return true;
        }
      }
    }
  }
  return false;
}
