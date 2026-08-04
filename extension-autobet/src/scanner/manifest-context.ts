export type ManifestScriptEntry = {
  js: string;
  matches: string[];
  allFrames: boolean;
  runAt: string;
  world?: string;
};

/** manifest.json content_scripts — 진단 시 어떤 패턴으로 주입됐는지 표시 */
export const MANIFEST_CONTENT_SCRIPTS: ManifestScriptEntry[] = [
  {
    js: 'bti_content.js',
    matches: [
      '*://x10x10s.com/*',
      '*://www.x10x10s.com/*',
      '*://*.bti-sports.io/*',
      '*://*.bti-sports.com/*',
      '*://*.x10x10s.com/*',
      '*://*.live8588.com/*',
      '*://*.fxf774.com/*',
      '*://*.pbc00.com/*',
      '*://*.v210x10b.com/*',
      '*://v210x10b.com/*',
      '*://*.y10x103.com/*',
      '*://y10x103.com/*',
      '*://*.v210x10g.com/*',
      '*://v210x10g.com/*',
      '*://*.z10x104.com/*',
      '*://z10x104.com/*',
      '*://*.streambridge.feedconstruct.com/*',
      '*://streambridge.feedconstruct.com/*',
      '*://*.sptpub.com/*',
      '*://*.sptsportscdn.com/*',
      '*://*.biahosted.com/*',
      '*://*.cocoesports.com/*',
    ],
    allFrames: true,
    runAt: 'document_idle',
  },
  {
    js: 'polymarket_content.js',
    matches: ['*://bc.game/*', '*://*.bc.game/*'],
    allFrames: true,
    runAt: 'document_idle',
  },
  {
    js: 'bc_slip_read.js',
    matches: ['*://bc.game/*', '*://*.bc.game/*'],
    allFrames: true,
    runAt: 'document_idle',
  },
  {
    js: 'bc_slip_read.js',
    matches: [
      '*://*.betby.com/*',
      '*://*.sptpub.com/*',
      '*://*.sptsportscdn.com/*',
      '*://*.cocoesports.com/*',
      '*://*.biahosted.com/*',
    ],
    allFrames: true,
    runAt: 'document_idle',
  },
];

function hostMatchesPattern(hostname: string, pattern: string): boolean {
  const m = pattern.match(/^\*:\/\/([^/]+)\/\*$/);
  if (!m?.[1]) return false;
  const rule = m[1].toLowerCase();
  const host = hostname.toLowerCase().replace(/^www\./, '');
  if (rule.startsWith('*.')) {
    const base = rule.slice(2);
    return host === base || host.endsWith('.' + base);
  }
  return host === rule.replace(/^www\./, '');
}

export function resolveManifestInjection(scriptEntry: string, href = location.href): {
  scriptEntry: string;
  matchedPatterns: string[];
  allFrames: boolean;
  runAt: string;
} {
  const entries = MANIFEST_CONTENT_SCRIPTS.filter((e) => e.js === scriptEntry);
  let hostname = '';
  try {
    hostname = new URL(href).hostname;
  } catch {
    return { scriptEntry, matchedPatterns: [], allFrames: false, runAt: 'unknown' };
  }

  const matched: string[] = [];
  let allFrames = false;
  let runAt = 'document_idle';

  for (const entry of entries) {
    for (const pattern of entry.matches) {
      if (hostMatchesPattern(hostname, pattern)) {
        matched.push(pattern);
        allFrames = entry.allFrames;
        runAt = entry.runAt;
      }
    }
  }

  return { scriptEntry, matchedPatterns: [...new Set(matched)], allFrames, runAt };
}
