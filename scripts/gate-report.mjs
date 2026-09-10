/**
 * @license
 * Gate report core for the Waveform Gatekeeper.
 *
 * Pure, deterministic helpers that shape, finalize and persist the
 * structured gate report. The data-integrity contract applies here in full:
 * this module only describes verification results. It never reads, writes,
 * or transforms Rekordbox source data (ANLZ/PPTH/PWV, SQLCipher DB, XML,
 * audio). The report is an additive artifact placed next to the build
 * output and is never mixed into project or analysis data.
 *
 * Report schema (stable, versioned):
 * {
 *   schema: 'airdox.waveform-gate-report',
 *   version: 1,
 *   generatedAt, appVersion, platform, node, commit?, root,
 *   overall: 'RUNNING' | 'PASS' | 'BLOCKED',
 *   gates: [
 *     {
 *       agent,             // responsible roadmap agent role
 *       gate,              // human-readable gate name
 *       status,            // 'PASS' | 'FAIL' | 'BLOCKED'
 *       evidence: string[],// concrete, inspectable facts
 *       attempts,          // 1 or 2 (one automatic retry)
 *       retried: boolean,
 *       durationMs,
 *       reason?,           // final failures only: which invariant was violated
 *       nextAction?        // final failures only: concrete next step
 *     }
 *   ],
 *   escalations: [ { gate, agent, reason, nextAction } ]
 * }
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const GATE_REPORT_SCHEMA = 'airdox.waveform-gate-report';
export const GATE_REPORT_VERSION = 1;
export const REPORT_FILE_NAME = 'gate-report.json';
export const ESCALATION_FILE_NAME = 'gate-escalation.md';

export const DEFAULT_REASON = 'Gate failed without a recorded reason.';
export const DEFAULT_NEXT_ACTION =
  'Inspect the gate evidence, fix the source contract, then rerun npm run verify:waveform.';

/**
 * Create an empty report. `meta` carries run metadata (timestamp, app
 * version, platform, node version, optional git commit, repo root).
 */
export function createGateReport(meta) {
  return {
    schema: GATE_REPORT_SCHEMA,
    version: GATE_REPORT_VERSION,
    generatedAt: meta.generatedAt,
    appVersion: meta.appVersion,
    platform: meta.platform,
    node: meta.node,
    commit: meta.commit ?? null,
    root: meta.root,
    overall: 'RUNNING',
    gates: [],
    escalations: [],
  };
}

/** Record one finished gate result; returns the result for chaining. */
export function addGate(report, gateResult) {
  report.gates.push(gateResult);
  return gateResult;
}

/**
 * Derive the escalation entry for a finally-failed gate: which gate, which
 * agent owns it, which invariant was violated (reason), and what concretely
 * happens next (nextAction). Missing details fall back to explicit defaults
 * so an escalation is never empty.
 */
export function escalationFor(gateResult) {
  return {
    gate: gateResult.gate,
    agent: gateResult.agent,
    reason: gateResult.reason && gateResult.reason.trim() ? gateResult.reason : DEFAULT_REASON,
    nextAction: gateResult.nextAction && gateResult.nextAction.trim()
      ? gateResult.nextAction
      : DEFAULT_NEXT_ACTION,
  };
}

/**
 * Finalize the report: derive `escalations` from all finally-failed gates
 * and set `overall` to 'PASS' or 'BLOCKED'.
 */
export function finalizeGateReport(report) {
  const failed = report.gates.filter((g) => g.status === 'FAIL' || g.status === 'BLOCKED');
  report.escalations = failed.map(escalationFor);
  report.overall = failed.length > 0 ? 'BLOCKED' : 'PASS';
  return report;
}

/** Human-readable escalation document (written only for BLOCKED runs). */
export function renderEscalationMarkdown(report) {
  const lines = [
    '# Airdox Waveform Gate — Eskalation',
    '',
    `- **Erstellt:** ${report.generatedAt}`,
    `- **Gesamtstatus:** BLOCKED`,
    `- **App-Version:** ${report.appVersion}`,
    `- **Commit:** ${report.commit ?? 'unbekannt'}`,
    `- **Bericht:** ${REPORT_FILE_NAME}`,
    '',
    'Keine Rekordbox-Daten (ANLZ/PPTH/PWV, DB, XML, Audio) wurden verändert, ergänzt oder',
    'weggelassen — die Eskalation beschreibt ausschließlich verletzte Prüfkontrakte.',
    '',
  ];

  report.escalations.forEach((e, i) => {
    const gate = report.gates.find((g) => g.gate === e.gate);
    lines.push(`## ${i + 1}. ${e.gate}`);
    lines.push('');
    lines.push(`- **Verantwortlicher Agent:** ${e.agent}`);
    lines.push(`- **Grund:** ${e.reason}`);
    lines.push(`- **Nächste Aktion:** ${e.nextAction}`);
    if (gate) {
      lines.push(`- **Versuche:** ${gate.attempts}${gate.retried ? ' (ein automatischer Retry)' : ''}`);
      lines.push(`- **Dauer:** ${gate.durationMs} ms`);
      lines.push('- **Evidenz:**');
      for (const item of gate.evidence) lines.push(`  - ${item}`);
    }
    lines.push('');
  });

  lines.push('Nächster Schritt: die oben genannten Aktionen ausführen und `npm run verify:waveform` erneut starten.');
  lines.push('');
  return lines.join('\n');
}

/**
 * Persist the report into `outDir` (the build output directory, e.g.
 * `release/`). Always writes `gate-report.json`; writes
 * `gate-escalation.md` only for BLOCKED runs and removes a stale
 * escalation file from a previous run when this run is green.
 * Returns { report, escalation? }.
 */
export function writeGateReport(report, outDir) {
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, REPORT_FILE_NAME);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const paths = { report: reportPath };

  const escalationPath = join(outDir, ESCALATION_FILE_NAME);
  if (report.overall === 'BLOCKED') {
    writeFileSync(escalationPath, renderEscalationMarkdown(report), 'utf8');
    paths.escalation = escalationPath;
  } else {
    rmSync(escalationPath, { force: true });
  }
  return paths;
}
