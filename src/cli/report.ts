import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { bold, dim, green, pad, yellow } from "../core/format.js";
import type { EvalReport } from "../types.js";
import type { OptimizeReport, OptimizeEvalSummary } from "./optimize.js";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function fmtPct(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return "n/a";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}
function fmtInt(v: number | undefined): string { return v === undefined ? "n/a" : Math.round(v).toLocaleString("en-US"); }
function fmtTime(ms: number | undefined): string { return ms === undefined ? "n/a" : `${(ms / 1000).toFixed(1)}s`; }

function readOptimization(file: string): OptimizeReport {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`Optimization report not found: ${resolved}`);
  const value = JSON.parse(fs.readFileSync(resolved, "utf8")) as OptimizeReport;
  if (!value?.project || !value?.proposal || !Array.isArray(value.evaluations)) throw new Error(`Not a ContextGym optimization report: ${resolved}`);
  return value;
}

function readEval(file: string): EvalReport | undefined {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) return undefined;
  try { return JSON.parse(fs.readFileSync(resolved, "utf8")) as EvalReport; }
  catch { return undefined; }
}

function aggregate(rows: Array<{ summary: OptimizeEvalSummary; report?: EvalReport }>) {
  const eligible = rows.filter((r) => r.report?.baseline && r.report?.candidate);
  const weighted = eligible.length || 1;
  const avg = (fn: (r: { summary: OptimizeEvalSummary; report?: EvalReport }) => number) => eligible.reduce((s, r) => s + fn(r), 0) / weighted;
  return {
    probes: rows.length,
    keep: rows.filter((r) => r.summary.verdict.startsWith("KEEP")).length,
    reject: rows.filter((r) => r.summary.verdict.startsWith("REJECT")).length,
    baselineSuccess: eligible.length ? avg((r) => r.report!.baseline!.successRate) : undefined,
    candidateSuccess: eligible.length ? avg((r) => r.report!.candidate!.successRate) : undefined,
    tokenDeltaPct: eligible.length ? avg((r) => r.report!.delta?.meanTotalTokensPct ?? 0) : undefined,
    toolsDeltaPct: eligible.length ? avg((r) => r.report!.delta?.meanObservedToolCallsPct ?? 0) : undefined,
    durationDeltaPct: eligible.length ? avg((r) => r.report!.delta?.meanDurationPct ?? 0) : undefined,
    leverage: eligible.length ? avg((r) => r.report!.roi?.tokenSavingsPerContextToken ?? 0) : undefined,
  };
}

function metric(label: string, value: string, sub: string, good = false): string {
  return `<div class="metric"><div class="metric-label">${esc(label)}</div><div class="metric-value ${good ? "good" : ""}">${esc(value)}</div><div class="metric-sub">${esc(sub)}</div></div>`;
}

function evalCard(row: { summary: OptimizeEvalSummary; report?: EvalReport }): string {
  const r = row.report;
  const roi = r?.roi ?? row.summary.roi;
  return `<section class="card probe">
    <div class="probe-head"><div><div class="eyebrow">${esc(row.summary.verdict)}</div><h3>${esc(row.summary.target)}</h3><p>${esc(row.summary.role)}</p></div><span class="pill ${row.summary.verdict.startsWith("KEEP") ? "keep" : row.summary.verdict.startsWith("REJECT") ? "reject" : "neutral"}">${esc(row.summary.verdict)}</span></div>
    <div class="mini-grid">
      ${metric("Success", r ? `${Math.round((r.baseline?.successRate ?? 0) * 100)}% → ${Math.round((r.candidate?.successRate ?? 0) * 100)}%` : `${Math.round(row.summary.successBaseline * 100)}% → ${Math.round(row.summary.successCandidate * 100)}%`, "baseline → candidate", true)}
      ${metric("Tokens", fmtPct(row.summary.tokenDeltaPct), r ? `${fmtInt(r.baseline?.meanTotalTokens)} → ${fmtInt(r.candidate?.meanTotalTokens)}` : "candidate delta", (row.summary.tokenDeltaPct ?? 0) < 0)}
      ${metric("Observed tools", fmtPct(row.summary.observedToolDeltaPct), r ? `${(r.baseline?.meanObservedToolCalls ?? 0).toFixed(1)} → ${(r.candidate?.meanObservedToolCalls ?? 0).toFixed(1)}` : "best-effort", (row.summary.observedToolDeltaPct ?? 0) < 0)}
      ${metric("Duration", fmtPct(row.summary.durationDeltaPct), r ? `${fmtTime(r.baseline?.meanDurationMs)} → ${fmtTime(r.candidate?.meanDurationMs)}` : "candidate delta", (row.summary.durationDeltaPct ?? 0) < 0)}
    </div>
    ${roi ? `<div class="roi-strip"><strong>${esc((roi.tokenSavingsPerContextToken ?? 0).toFixed(1))}×</strong> gross token leverage · paired token wins ${esc(roi.pairedTokenWins)}/${esc(roi.eligiblePairs)} · tool wins ${esc(roi.pairedObservedToolWins)}/${esc(roi.eligiblePairs)} · duration wins ${esc(roi.pairedDurationWins)}/${esc(roi.eligiblePairs)}</div>` : ""}
  </section>`;
}

function htmlFor(report: OptimizeReport, reportFile: string): string {
  const rows = report.evaluations.map((summary) => ({ summary, report: readEval(summary.reportFile) }));
  const agg = aggregate(rows);
  const title = `${path.basename(report.project)} · ContextGym Optimization`;
  const generated = new Date(report.generatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#0b1020;--panel:#12182a;--panel2:#171f34;--text:#f3f5fb;--muted:#9da8bc;--line:#25304a;--accent:#8ea7ff;--good:#72d6a1;--bad:#ff8b8b;--warn:#f0c66b;--shadow:0 20px 60px rgba(0,0,0,.24)}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0%,rgba(116,137,255,.14),transparent 36%),var(--bg);color:var(--text);font:15px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:1120px;margin:0 auto;padding:56px 24px 80px}.top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}.brand{font-size:14px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}h1{font-size:44px;line-height:1.05;margin:10px 0 14px;letter-spacing:-.035em}.lede{color:var(--muted);max-width:760px;font-size:17px}.verdict{padding:10px 14px;border:1px solid rgba(114,214,161,.35);background:rgba(114,214,161,.08);border-radius:999px;color:var(--good);font-weight:800}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:32px 0}.metric,.card{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)}.metric{padding:18px}.metric-label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.metric-value{font-size:28px;font-weight:800;margin:6px 0 2px;letter-spacing:-.03em}.metric-value.good{color:var(--good)}.metric-sub{font-size:12px;color:var(--muted)}.card{padding:24px;margin-top:18px}.section-title{margin:38px 0 12px;font-size:22px}.probe-head{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}.probe h3{margin:3px 0 4px;font-size:20px}.probe p{margin:0;color:var(--muted)}.eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);font-weight:800}.pill{white-space:nowrap;padding:7px 10px;border-radius:999px;font-size:12px;font-weight:800;border:1px solid var(--line)}.pill.keep{color:var(--good);background:rgba(114,214,161,.08)}.pill.reject{color:var(--bad);background:rgba(255,139,139,.08)}.mini-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:18px}.mini-grid .metric{box-shadow:none;background:rgba(255,255,255,.02)}.roi-strip{margin-top:14px;border-top:1px solid var(--line);padding-top:14px;color:var(--muted)}.roi-strip strong{color:var(--text);font-size:18px}.meta{display:grid;grid-template-columns:180px 1fr;gap:8px 16px;color:var(--muted)}.meta b{color:var(--text);font-weight:600}.footer{margin-top:36px;color:var(--muted);font-size:12px}.note{padding:14px 16px;border:1px solid var(--line);background:rgba(142,167,255,.05);border-radius:14px;color:var(--muted)}code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#c8d2ff}@media(max-width:800px){h1{font-size:34px}.top{display:block}.verdict{display:inline-block;margin-top:18px}.grid,.mini-grid{grid-template-columns:repeat(2,1fr)}.meta{grid-template-columns:1fr}.probe-head{display:block}.pill{display:inline-block;margin-top:12px}}@media(max-width:480px){.grid,.mini-grid{grid-template-columns:1fr}}
</style></head><body><main class="wrap">
<div class="top"><div><div class="brand">ContextGym</div><h1>Experiment-driven context optimization</h1><div class="lede">Measured whether repository context helps a coding agent on deterministic probes. Context is kept only when paired A/B evidence supports it.</div></div><div class="verdict">${esc(report.verdict)}</div></div>
<div class="grid">
${metric("Success", agg.baselineSuccess !== undefined ? `${Math.round(agg.baselineSuccess * 100)}% → ${Math.round((agg.candidateSuccess ?? 0) * 100)}%` : "n/a", "baseline → candidate", (agg.candidateSuccess ?? 0) >= (agg.baselineSuccess ?? 0))}
${metric("Token change", fmtPct(agg.tokenDeltaPct), "candidate vs baseline", (agg.tokenDeltaPct ?? 0) < 0)}
${metric("Observed tools", fmtPct(agg.toolsDeltaPct), "best-effort", (agg.toolsDeltaPct ?? 0) < 0)}
${metric("Duration", fmtPct(agg.durationDeltaPct), "candidate vs baseline", (agg.durationDeltaPct ?? 0) < 0)}
</div>
<div class="note">Added context: ~${esc(report.proposal.estimatedTokens)} tokens · ${esc(report.runs)} paired run(s) per probe · ${esc(agg.keep)}/${esc(agg.probes)} probe(s) kept. Gross token leverage is benchmark-specific and must not be interpreted as a universal causal multiplier.</div>
<h2 class="section-title">Evaluated context</h2>${rows.map(evalCard).join("\n")}
<h2 class="section-title">Run metadata</h2><section class="card"><div class="meta">
<b>Project</b><span><code>${esc(report.project)}</code></span><b>Git HEAD</b><span><code>${esc(report.gitHead)}</code></span><b>Generated</b><span>${esc(generated)}</span><b>Historical findings</b><span>${esc(report.mine.findings)}</span><b>Project candidates</b><span>${esc(report.mine.projectCandidates)}</span><b>Context proposals</b><span>${esc(report.proposal.proposals)}</span><b>Source files inspected</b><span>${esc(report.proposal.inspected)}/${esc(report.proposal.repositoryMap)}</span><b>Historical avoidable calls</b><span>${esc(report.proposal.avoidableToolCalls)}</span><b>Source JSON</b><span><code>${esc(reportFile)}</code></span>
</div></section>
<div class="footer">Generated locally by ContextGym. No telemetry required. Observed tool-call coverage is best effort because agent JSON event streams may omit some internal calls.</div>
</main></body></html>`;
}

function openFile(file: string): void {
  if (process.platform === "win32") spawnSync("cmd.exe", ["/c", "start", "", file], { windowsHide: true, stdio: "ignore" });
  else if (process.platform === "darwin") spawnSync("open", [file], { stdio: "ignore" });
  else spawnSync("xdg-open", [file], { stdio: "ignore" });
}

export function reportCommand(options: { report: string; out?: string; open?: boolean; json?: boolean }): void {
  const reportFile = path.resolve(options.report);
  const report = readOptimization(reportFile);
  const out = path.resolve(options.out ?? path.join(path.dirname(reportFile), `${path.basename(reportFile, path.extname(reportFile))}.html`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, htmlFor(report, reportFile), "utf8");
  const result = { schemaVersion: 1, report: reportFile, html: out, verdict: report.verdict, evaluations: report.evaluations.length };
  if (options.open) openFile(out);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log();
    console.log(bold("ContextGym HTML Report"));
    console.log(dim("────────────────────────────────────────────────────────"));
    console.log(`${pad("Optimization", 28)} ${reportFile}`);
    console.log(`${pad("Verdict", 28)} ${report.verdict === "KEEP" ? green(report.verdict) : yellow(report.verdict)}`);
    console.log(`${pad("Evaluations", 28)} ${report.evaluations.length}`);
    console.log(`${pad("HTML", 28)} ${out}`);
    if (options.open) console.log(`${pad("Browser", 28)} opened`);
    console.log();
  }
}
