/**
 * Реальні налаштування польотника → Tune.
 * Джерела: змінні CLI (`get` з польотника) або заголовок бінарного логу Blackbox,
 * де Betaflight записує налаштування, з якими літав борт.
 */
import type { Axis, Tune } from "./types";
import { AXES } from "./types";

/** Налаштування у вигляді змінних CLI: ім'я → значення. */
export type CliValues = Record<string, string>;

const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Накладає значення змінних CLI на tune. Повертає новий tune і список змінних,
 * які вдалося застосувати. Невідомі або некоректні значення пропускаються.
 */
export function applyCliValues(base: Tune, values: CliValues): { tune: Tune; applied: string[] } {
  const t: Tune = structuredClone(base);
  const applied: string[] = [];
  const take = (name: string, fn: (n: number) => void) => {
    const n = num(values[name]);
    if (n === null) return;
    fn(n);
    applied.push(name);
  };
  for (const ax of AXES) {
    take(`p_${ax}`, (n) => (t.pid[ax].p = n));
    take(`i_${ax}`, (n) => (t.pid[ax].i = n));
    take(`d_${ax}`, (n) => (t.pid[ax].d = n));
    take(`f_${ax}`, (n) => (t.pid[ax].f = n));
    take(`d_min_${ax}`, (n) => (t.pid[ax].dMin = n));
    take(`${ax}_rc_rate`, (n) => (t.rates[ax].center = n * 10));
    take(`${ax}_srate`, (n) => (t.rates[ax].max = n * 10));
    take(`${ax}_expo`, (n) => (t.rates[ax].expo = n / 100));
  }
  const f = t.filters as unknown as Record<string, number>;
  for (const k of Object.keys(t.filters)) take(k, (n) => (f[k] = n));
  const e = t.extras as unknown as Record<string, number | string | null>;
  for (const k of Object.keys(t.extras)) {
    if (k === "dshot_bidir") {
      const v = values[k]?.trim().toUpperCase();
      if (v === "ON" || v === "OFF") {
        t.extras.dshot_bidir = v;
        applied.push(k);
      }
    } else take(k, (n) => (e[k] = n));
  }
  take("thr_mid", (n) => (t.rates.thrMid = n / 100));
  take("thr_expo", (n) => (t.rates.thrExpo = n / 100));
  take("throttle_limit_percent", (n) => (t.rates.throttleLimit = n));
  return { tune: t, applied };
}

/** Заголовок логу Blackbox → змінні CLI. Підтримує назви полів Betaflight 4.2–4.5. */
export function cliValuesFromLogHeaders(h: Record<string, string>): CliValues {
  const out: CliValues = {};
  const list = (k: string) => (h[k] ?? "").split(",").map((s) => s.trim());
  const perAxis = (key: string, names: (ax: Axis) => string) => {
    if (h[key] === undefined) return;
    const v = list(key);
    AXES.forEach((ax, i) => {
      if (v[i] !== undefined && v[i] !== "") out[names(ax)] = v[i]!;
    });
  };
  for (const ax of AXES) {
    const pid = h[`${ax}PID`];
    if (pid) {
      const [p, i, d] = pid.split(",");
      if (p !== undefined) out[`p_${ax}`] = p;
      if (i !== undefined) out[`i_${ax}`] = i;
      if (d !== undefined) out[`d_${ax}`] = d;
    }
  }
  perAxis("ff_weight", (ax) => `f_${ax}`);
  perAxis("d_min", (ax) => `d_min_${ax}`);
  // Рейти беремо лише для Actual rates (rates_type 3), інакше одиниці інші.
  const ratesType = h["rates_type"];
  if (ratesType === "3" || ratesType?.toUpperCase() === "ACTUAL") {
    perAxis("rc_rates", (ax) => `${ax}_rc_rate`);
    perAxis("rates", (ax) => `${ax}_srate`);
    perAxis("rc_expo", (ax) => `${ax}_expo`);
  }
  const pair = (key: string, a: string, b: string) => {
    const v = h[key];
    if (!v) return;
    const [x, y] = v.split(",");
    if (x) out[a] = x;
    if (y) out[b] = y;
  };
  pair("gyro_lpf1_dyn_hz", "gyro_lpf1_dyn_min_hz", "gyro_lpf1_dyn_max_hz");
  pair("dterm_lpf1_dyn_hz", "dterm_lpf1_dyn_min_hz", "dterm_lpf1_dyn_max_hz");
  const alias: Record<string, string[]> = {
    gyro_lpf2_static_hz: ["gyro_lpf2_static_hz", "gyro_lowpass2_hz"],
    dterm_lpf2_static_hz: ["dterm_lpf2_static_hz", "dterm_lowpass2_hz"],
  };
  for (const [name, keys] of Object.entries(alias)) {
    const k = keys.find((k) => h[k] !== undefined);
    if (k) out[name] = h[k]!;
  }
  for (const k of [
    "dyn_notch_count", "dyn_notch_q", "dyn_notch_min_hz", "dyn_notch_max_hz",
    "rpm_filter_harmonics", "rpm_filter_min_hz", "motor_poles", "dyn_idle_min_rpm",
    "tpa_rate", "tpa_breakpoint", "thrust_linear", "anti_gravity_gain", "vbat_sag_compensation", "iterm_relax_cutoff",
    "feedforward_smooth_factor", "feedforward_jitter_factor", "feedforward_boost", "thr_mid", "thr_expo",
  ]) {
    if (h[k] !== undefined) out[k] = h[k]!;
  }
  if (h["dshot_bidir"] !== undefined) out["dshot_bidir"] = h["dshot_bidir"] === "1" ? "ON" : h["dshot_bidir"] === "0" ? "OFF" : h["dshot_bidir"]!;
  return out;
}
