// GA4 telemetry via the Measurement Protocol — server-to-server events from the
// Node extension host (gtag.js can't run here, there's no web page). Mirrors the
// approach used across Lynx DI's extensions.
//
// Purpose: learn which FEATURES and OPERATIONS are used most, so high-use ones
// can be prioritized. Events: activated · feature_used {feature} ·
// operation_added {op} · operation_used {op} · workflow_rendered {ops, ok}.
//
// Privacy: OFF BY DEFAULT — `pdfStudio.telemetry.enabled` must be turned on, and
// VS Code's global telemetry setting must also allow it; no-ops when either is
// off, which is the shipped state. Opt-in rather than opt-out because a
// local-first document tool that quietly reports to Google is a contradiction,
// whatever the payload is. When on, sends only `client_id = vscode.env.machineId`
// (a stable, anonymized per-install id) — never file paths, contents, names, or
// any PII.
//
// Debugging: set `pdfStudio.telemetry.debug` to log every event + its HTTP status
// to the "Lynx PDF Studio: Telemetry" output channel (View → Output).

import * as vscode from "vscode";

// Both of these are public, deliberately, and there is no version of this file in
// which they are not. A GA4 Measurement Protocol api_secret is designed for a
// server; in a client app it ships inside the bundle, so anyone who unzips the
// .vsix has it whether or not this repo is public. Redacting it from the source
// would buy no secrecy and cost the property that the published source matches
// the shipped binary.
//
// What it actually gates is event WRITES to this GA property — not reads, not
// account access, not billing. The exposure is that someone could post forged
// events and skew the usage numbers. Accepted: the data is directional input for
// prioritisation, not something load-bearing. If that changes, the fix is to
// move sends behind a proxy that holds the secret server-side and then rotate
// this value — not to hide it here.
//
// public-safe-ignore — reviewed 2026-07-29, see above. The scanner is meant to
// find this line; this comment is the decision it should stop asking about.
const MEASUREMENT_ID = "G-SQKVZ4XNMB";
const API_SECRET = "hSHGCQ12Q_qlW3zZrFJheg"; // public-safe-ignore
const MP_ENDPOINT = `https://www.google-analytics.com/mp/collect?measurement_id=${MEASUREMENT_ID}&api_secret=${API_SECRET}`;

let extContext: vscode.ExtensionContext | undefined;
let clientId: string | undefined;
let sessionId: string | undefined;
let extVersion = "0.0.0";
let settingEnabled = false; // opt-in: see readSetting()
let debugEnabled = false;
let output: vscode.OutputChannel | undefined;

/** True only when GA is configured AND both telemetry toggles are on. `isTelemetryEnabled`
 *  is VS Code's official consent gate (false unless the user allows telemetry); it is also
 *  true at the crash-only "error" level — an acceptable over-read here since we send only
 *  anonymous enum op names (future work: migrate to a TelemetryLogger for level-aware gating). */
function telemetryOn(): boolean {
  return vscode.env.isTelemetryEnabled && settingEnabled && !!clientId && !!API_SECRET;
}

function readSetting(): boolean {
  return vscode.workspace.getConfiguration("pdfStudio").get<boolean>("telemetry.enabled", false);
}

function readDebugSetting(): boolean {
  return vscode.workspace.getConfiguration("pdfStudio").get<boolean>("telemetry.debug", false);
}

function logLine(msg: string): void {
  if (!output) {
    output = vscode.window.createOutputChannel("Lynx PDF Studio: Telemetry");
    extContext?.subscriptions.push(output);
  }
  output.appendLine(`${new Date().toISOString().slice(11, 19)}  ${msg}`);
}

/** Call once during activate(). */
export function initTelemetry(context: vscode.ExtensionContext): void {
  extContext = context;
  clientId = vscode.env.machineId;
  sessionId = String(Date.now()); // one session per activation
  try {
    extVersion = (context.extension?.packageJSON?.version as string) ?? "0.0.0";
  } catch {
    /* version is best-effort */
  }
  settingEnabled = readSetting();
  debugEnabled = readDebugSetting();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("pdfStudio.telemetry.enabled")) settingEnabled = readSetting();
      if (e.affectsConfiguration("pdfStudio.telemetry.debug")) {
        debugEnabled = readDebugSetting();
        if (debugEnabled) {
          logLine(`debug logging ON — clientId=${clientId} version=${extVersion} isTelemetryEnabled=${vscode.env.isTelemetryEnabled} setting=${settingEnabled}`);
          output?.show(true);
        }
      }
    }),
  );
  if (debugEnabled) {
    logLine(`telemetry init — clientId=${clientId} version=${extVersion} isTelemetryEnabled=${vscode.env.isTelemetryEnabled} setting=${settingEnabled}`);
  }
}

/**
 * Record one anonymous GA4 event. Fire-and-forget — never throws, never blocks,
 * no-ops when telemetry is disabled. `params` values are strings/numbers/booleans;
 * never pass file paths, contents, or any personal data.
 */
export function track(name: string, params: Record<string, string | number | boolean> = {}): void {
  if (debugEnabled) logLine(`event "${name}" ${JSON.stringify(params)}`);
  if (!telemetryOn()) {
    if (debugEnabled) logLine(`  -> SKIPPED (isTelemetryEnabled=${vscode.env.isTelemetryEnabled}, setting=${settingEnabled})`);
    return;
  }
  const body = JSON.stringify({
    client_id: clientId,
    events: [{ name, params: { ...params, session_id: sessionId, engagement_time_msec: 100, ext_version: extVersion } }],
  });
  try {
    void fetch(MP_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body })
      .then((res) => {
        if (debugEnabled) logLine(`  -> ${res.status} ${res.statusText} (sent "${name}")`);
      })
      .catch((e) => {
        if (debugEnabled) logLine(`  -> ERROR sending "${name}": ${e}`);
      });
  } catch {
    /* telemetry must never disrupt the extension */
  }
}
