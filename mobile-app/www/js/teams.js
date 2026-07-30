'use strict';

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
  return (String(name || '').toLowerCase().match(/[a-z]{4,}/g) || []);
}

function hangulChunks(name) {
  return (String(name || '').match(/[가-힣]{2,}/g) || []);
}

function teamMatch(a, b) {
  const na = normTeam(a);
  const nb = normTeam(b);
  if (!na || !nb || na.length < 2 || nb.length < 2) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  if (na.length >= 4 && nb.length >= 4 && na.slice(0, 4) === nb.slice(0, 4)) return true;
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
      if (x === y || (x.length >= 5 && y.length >= 5 && (x.includes(y) || y.includes(x)))) return true;
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
