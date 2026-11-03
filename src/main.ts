import "./style.css";
import type { Axis, BuildParams, Tune } from "./model/types";
import { AXES } from "./model/types";
import { BF_DEFAULTS, computeTune } from "./model/tuner";
import { buildCli } from "./model/cli";
import { adjustFromLog, type Adjustment } from "./model/adjust";
import { actualRate } from "./model/rates";
import { parseBlackboxCsv, LogParseError } from "./blackbox/csv";
import { analyzeLog, type LogAnalysis } from "./blackbox/analyze";
import { drawChart } from "./ui/chart";
import { synthLogCsv } from "./sim/synthLog";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const PRESETS: Record<string, Partial<BuildParams>> = {
  p8: { prop: 8, pitch: 4.5, blades: 3, frame: "open", stator: "2812", kv: 1000, cells: 6, auw: 1600, style: "longrange", motorPoles: 14, rpmFilter: true },
  p10: { prop: 10, pitch: 5, blades: 3, frame: "open", stator: "3115", kv: 900, cells: 6, auw: 2600, style: "longrange", motorPoles: 14, rpmFilter: true },
  p13: { prop: 13, pitch: 6.5, blades: 2, frame: "open", stator: "4214", kv: 480, cells: 12, auw: 5000, style: "cinematic", motorPoles: 24, rpmFilter: true },
  p15: { prop: 15, pitch: 7, blades: 2, frame: "open", stator: "4215", kv: 400, cells: 12, auw: 7000, style: "cinematic", motorPoles: 24, rpmFilter: true },
  p21: { prop: 21, pitch: 7, blades: 2, frame: "open", stator: "6215", kv: 170, cells: 12, auw: 16000, style: "cinematic", motorPoles: 28, rpmFilter: true },
};

const STORE_KEY = "fpv-pid-tuner:build-large";
/** Синтетичний 10": повільніший контур, шум моторів 40–210 Гц, резонанс рами 95 Гц. */
const DEMO_10_INCH = { seconds: 30, wn: 55, delayMs: 6, frameHz: 95, motorHzIdle: 40, motorHzSpan: 170, gyroLpfHz: 70, zeta: [0.4, 0.48, 0.8] as [number, number, number] };
const AXIS_NAME: Record<Axis, string> = { roll: "Roll", pitch: "Pitch", yaw: "Yaw" };
const AXIS_COLOR: Record<Axis, string> = { roll: "--s-roll", pitch: "--s-pitch", yaw: "--s-yaw" };
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let analysis: LogAnalysis | null = null;
let adjustment: Adjustment | null = null;
let mode: "base" | "log" = "log";

function readParams(): BuildParams {
  const num = (id: string, fallback: number) => {
    const v = Number($<HTMLInputElement>(id).value);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    prop: num("prop", 10),
    pitch: num("pitch", 4),
    blades: Number($<HTMLSelectElement>("blades").value) as 2 | 3 | 4,
    frame: $<HTMLSelectElement>("frame").value as BuildParams["frame"],
    stator: $<HTMLInputElement>("stator").value,
    kv: num("kv", 1950),
    cells: num("cells", 6),
    auw: num("auw", 600),
    style: $<HTMLSelectElement>("style").value as BuildParams["style"],
    motorPoles: num("motorPoles", 14),
    profile: Number($<HTMLSelectElement>("profile").value) || 0,
    rateProfile: Number($<HTMLSelectElement>("rateProfile").value) || 0,
    rpmFilter: $<HTMLInputElement>("rpmFilter").checked,
  };
}

function applyParams(p: Partial<BuildParams>) {
  for (const [k, v] of Object.entries(p)) {
    const el = document.getElementById(k) as HTMLInputElement | null;
    if (!el) continue;
    if (el.type === "checkbox") el.checked = Boolean(v);
    else el.value = String(v);
  }
}

function delta(v: number, b: number): string {
  if (!b) return "";
  const p = Math.round((v / b - 1) * 100);
  if (Math.abs(p) < 2) return "";
  return `<span class="d ${p > 0 ? "up" : "down"}">${p > 0 ? "+" : ""}${p}%</span>`;
}

function stat(value: string, label: string, cls = "") {
  return `<div class="stat ${cls}"><b>${value}</b><span>${label}</span></div>`;
}

function render() {
  const x = readParams();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(x));
  } catch {
    /* сховище недоступне: нічого страшного */
  }
  const base = computeTune(x);
  adjustment = analysis ? adjustFromLog(base, analysis) : null;
  const showLog = !!adjustment && mode === "log";
  const tune: Tune = showLog ? adjustment!.tune : base;
  const ref: Tune = showLog ? base : { pid: BF_DEFAULTS, filters: base.filters, extras: base.extras, rates: base.rates };

  $("summary").innerHTML = [
    stat(base.metrics.master.toFixed(2), "Майстер-множник"),
    stat(`${Math.round(base.metrics.powerRatio * 100)}%`, "Потужність від типової"),
    stat(`${Math.round(base.metrics.weightRatio * 100)}%`, "Вага від типової"),
    stat(`${Math.round(base.metrics.motorHzHover)} Гц`, "Шум моторів на висінні"),
  ].join("");

  $("pidBody").innerHTML = AXES.map((ax) => {
    const p = tune.pid[ax];
    const b = ref.pid[ax];
    return `<tr><td>${AXIS_NAME[ax]}</td><td>${p.p}${delta(p.p, b.p)}</td><td>${p.i}${delta(p.i, b.i)}</td><td>${p.d}${delta(p.d, b.d)}</td><td>${p.dMin}</td><td>${p.f}${delta(p.f, b.f)}</td></tr>`;
  }).join("");

  const kv = (o: object, refObj: object) =>
    Object.entries(o)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => {
        const changed = showLog && (refObj as Record<string, unknown>)[k] !== v;
        return `<dt>${k}</dt><dd class="${changed ? "changed" : ""}">${v}</dd>`;
      })
      .join("");
  $("filters").innerHTML = kv(tune.filters, base.filters);
  $("extras").innerHTML = kv(tune.extras, base.extras);
  $("why").innerHTML = base.why.map((t) => `<li>${t}</li>`).join("");
  $("rateWhy").innerHTML = base.rateWhy.map((t) => `<li>${t}</li>`).join("");
  renderRates(tune, ref, showLog);
  $("warns").innerHTML = base.warnings.map((t) => `<li>${t}</li>`).join("");
  $("warnBox").hidden = !base.warnings.length;

  $("modeSeg").hidden = !adjustment;
  $("modeSeg").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  $("cliTitle").textContent = showLog ? "CLI для Betaflight: після корекції за логом" : "CLI для Betaflight: стартовий тюн";
  $("cli").textContent = buildCli(x, tune, showLog ? `Скориговано за Blackbox-логом (${adjustment!.changes.length} змін)` : undefined);

  if (analysis && adjustment) renderAnalysis(analysis, adjustment, base);
}

function renderRates(tune: Tune, ref: Tune, showLog: boolean) {
  const r = tune.rates;
  const mark = (v: number, b: number) => (showLog && v !== b ? ` class="changed"` : "");
  $("ratesBody").innerHTML = AXES.map((ax) => {
    const a = r[ax], b = ref.rates[ax];
    return `<tr><td>${AXIS_NAME[ax]}</td><td${mark(a.center, b.center)}>${a.center}</td><td${mark(a.max, b.max)}>${a.max}</td><td>${a.expo.toFixed(2)}</td></tr>`;
  }).join("");
  const thr: Array<[string, string, boolean]> = [
    ["thr_mid", `${Math.round(r.thrMid * 100)}%`, r.thrMid !== ref.rates.thrMid],
    ["thr_expo", `${Math.round(r.thrExpo * 100)}%`, false],
    ["throttle_limit", r.throttleLimit < 100 ? `${r.throttleLimit}%` : "без обмеження", false],
  ];
  $("thrKv").innerHTML = thr.map(([k, v, ch]) => `<dt>${k}</dt><dd class="${showLog && ch ? "changed" : ""}">${v}</dd>`).join("");
  const xs = Array.from({ length: 101 }, (_, i) => i / 100);
  const top = Math.max(r.roll.max, r.pitch.max, r.yaw.max);
  const yMax = Math.ceil(top / 100) * 100;
  drawChart($<HTMLCanvasElement>("rateChart"),
    (["roll", "yaw"] as const).map((ax) => ({ x: xs.map((v) => v * 100), y: xs.map((v) => actualRate(r[ax], v)), color: css(AXIS_COLOR[ax]), label: ax })),
    { xMin: 0, xMax: 100, yMin: 0, yMax, xLabel: "стік, %", yLabel: "°/с", xTicks: [0, 25, 50, 75, 100], yTicks: Array.from({ length: yMax / 100 + 1 }, (_, i) => i * 100).filter((_, i, arr) => arr.length <= 8 || i % 2 === 0) });
  $("rateLegend").innerHTML = `<span><i style="background:var(--s-roll)"></i>Roll / Pitch</span><span><i style="background:var(--s-yaw)"></i>Yaw</span>`;
}

function renderAnalysis(a: LogAnalysis, adj: Adjustment, base: Tune) {
  $("bbResult").hidden = false;
  const worst = Math.max(a.axes.roll.step?.peak ?? 0, a.axes.pitch.step?.peak ?? 0);
  const noise = Math.max(a.axes.roll.filteredHfRms, a.axes.pitch.filteredHfRms);
  $("bbSummary").innerHTML = [
    stat(`${(a.sampleRate / 1000).toFixed(a.sampleRate % 1000 ? 2 : 0)} кГц`, `Запис, ${Math.round(a.duration)} с`),
    stat(worst ? worst.toFixed(2) : "немає", "Пік відгуку roll/pitch", worst > 1.12 || (worst && worst < 0.97) ? "bad" : worst ? "good" : ""),
    stat(`${noise.toFixed(2)}`, "Шум після фільтрів, °/с", noise > 2.5 ? "bad" : noise < 0.6 ? "good" : ""),
    stat(a.frameResonanceHz ? `${a.frameResonanceHz} Гц` : "немає", "Резонанс рами", a.frameResonanceHz ? "bad" : "good"),
  ].join("");

  // Відгук на крок
  const stepSeries = AXES.flatMap((ax) => {
    const s = a.axes[ax].step;
    return s ? [{ x: s.t, y: s.y, color: css(AXIS_COLOR[ax]), label: AXIS_NAME[ax] }] : [];
  });
  drawChart($<HTMLCanvasElement>("stepChart"), stepSeries, {
    xMin: 0, xMax: 500, yMin: 0, yMax: 1.6, xLabel: "мс", yLabel: "відгук",
    xTicks: [0, 100, 200, 300, 400, 500], yTicks: [0, 0.5, 1, 1.5],
    markers: [{ y: 1, label: "", color: css("--muted") }],
  });
  $("stepLegend").innerHTML = AXES.map((ax) => {
    const s = a.axes[ax].step;
    return `<span><i style="background:var(${AXIS_COLOR[ax]})"></i>${AXIS_NAME[ax]}: ${s ? `пік ${s.peak.toFixed(2)}, 50% за ${s.delayMs.toFixed(0)} мс` : "мало даних"}</span>`;
  }).join("");

  renderSpectrum(a, base);

  $("changesBody").innerHTML = adj.changes.length
    ? adj.changes.map((c) => `<tr><td>${c.param}<span class="d">${c.group}</span></td><td>${c.from}</td><td>${c.to}${c.group === "PID" ? delta(c.to, c.from) : ""}</td><td>${c.reason}</td></tr>`).join("")
    : `<tr><td colspan="4">Змін немає</td></tr>`;
  $("findings").innerHTML = [...a.notes, ...adj.findings].map((t) => `<li>${t}</li>`).join("");
}

function renderSpectrum(a: LogAnalysis, base: Tune) {
  const ax = $<HTMLSelectElement>("specAxis").value as Axis;
  const raw = a.axes[ax].spectrumRaw;
  const filt = a.axes[ax].spectrumFiltered;
  const db = (s: { amp: Float64Array }) => Array.from(s.amp, (v) => 20 * Math.log10(v + 1e-3));
  const xMax = Math.min(600, Math.floor(a.sampleRate / 2 / 100) * 100);
  const series = [];
  if (raw && a.hasUnfiltered) series.push({ x: raw.freqs, y: db(raw), color: css("--s-raw"), label: "до фільтрів", width: 1.2 });
  if (filt) series.push({ x: filt.freqs, y: db(filt), color: css("--s-filt"), label: "після фільтрів" });
  const markers = [{ x: base.filters.gyro_lpf1_dyn_min_hz, label: "LPF1 min", color: css("--muted") }];
  if (a.frameResonanceHz) markers.push({ x: a.frameResonanceHz, label: "рама", color: css("--amber") });
  drawChart($<HTMLCanvasElement>("specChart"), series, {
    xMin: 0, xMax, yMin: -40, yMax: 20, xLabel: "Гц", yLabel: "дБ (°/с)",
    xTicks: Array.from({ length: Math.floor(xMax / 100) + 1 }, (_, i) => i * 100), yTicks: [-40, -20, 0, 20],
    markers,
  });
  $("specLegend").innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join("");
}

function setStatus(text: string, error = false) {
  const el = $("bbStatus");
  el.textContent = text;
  el.classList.toggle("error", error);
}

async function loadLog(getText: () => Promise<string>, name: string) {
  setStatus(`Аналізую ${name}…`);
  await new Promise((r) => setTimeout(r, 30));
  try {
    const text = await getText();
    const log = parseBlackboxCsv(text);
    analysis = analyzeLog(log);
    mode = "log";
    render();
    const n = adjustment?.changes.length ?? 0;
    setStatus(`${name}: ${Math.round(log.duration)} с польоту. ${n ? `Запропоновано ${n} змін, CLI нижче вже їх містить.` : "Змін не потрібно."}`);
  } catch (e) {
    analysis = null;
    $("bbResult").hidden = true;
    render();
    setStatus(e instanceof LogParseError ? e.message : `Не вдалося обробити файл: ${(e as Error).message}`, true);
  }
}

// Події
document.querySelectorAll<HTMLButtonElement>(".presets button").forEach((b) =>
  b.addEventListener("click", () => {
    applyParams(PRESETS[b.dataset.p!]!);
    render();
  }),
);
const form = $<HTMLFormElement>("f");
form.addEventListener("input", render);
form.addEventListener("change", render);
form.addEventListener("submit", (e) => e.preventDefault());
$("modeSeg").querySelectorAll<HTMLButtonElement>("button").forEach((b) =>
  b.addEventListener("click", () => {
    mode = b.dataset.mode as "base" | "log";
    render();
  }),
);
$("specAxis").addEventListener("change", () => analysis && renderSpectrum(analysis, computeTune(readParams())));
$<HTMLInputElement>("logFile").addEventListener("change", (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void loadLog(() => file.text(), file.name);
});
$("demoLog").addEventListener("click", () => {
  void loadLog(async () => synthLogCsv(DEMO_10_INCH), "приклад логу (синтетичний 10\")");
});
$("copy").addEventListener("click", () => {
  const btn = $("copy");
  const text = $("cli").textContent ?? "";
  const done = () => {
    btn.textContent = "Скопійовано";
    setTimeout(() => (btn.textContent = "Скопіювати"), 1600);
  };
  const fallback = () => {
    const range = document.createRange();
    range.selectNodeContents($("cli"));
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    btn.textContent = "Виділено, натисніть Ctrl+C";
    setTimeout(() => (btn.textContent = "Скопіювати"), 2500);
  };
  try {
    navigator.clipboard.writeText(text).then(done, fallback);
  } catch {
    fallback();
  }
});
let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(render, 150);
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);

try {
  const saved = localStorage.getItem(STORE_KEY);
  if (saved) applyParams(JSON.parse(saved) as Partial<BuildParams>);
} catch {
  /* ігноруємо */
}
render();
