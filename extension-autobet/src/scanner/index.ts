export { startScanner, ScannerEngine } from './bootstrap';
export type * from './types';
export { detectSiteId } from './site-detector';
export { getAdapter, X10Scanner, BCGameScanner } from './adapters';
export { runDomProbe, logDomProbe, explainScannerZero } from './dom-probe';
export type { DomProbeReport, DomProbeCause } from './dom-probe';
export { startAutoDiagnostic, logAutoDiagnostic, runAutoDiagnostic } from './auto-diagnostic';
export type { AutoDiagnosticReport } from './auto-diagnostic';
