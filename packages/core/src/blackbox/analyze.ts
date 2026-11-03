import type { Axis } from "../model/types";
import { AXES } from "../model/types";
import type { FlightLog } from "./csv";
import { bandRms, findPeaks, welch, type Peak, type Spectrum } from "./spectrum";
import { estimateStepResponse, type StepResponse } from "./step";

export interface AxisAnalysis {
  step: StepResponse | null;
  /** Спектр нефільтрованого гіроскопа (або відфільтрованого, якщо gyroUnfilt не записано) */
  spectrumRaw: Spectrum | null;
  /** Спектр відфільтрованого гіроскопа (те, що бачить PID-контролер) */
  spectrumFiltered: Spectrum | null;
  /** Найсильніші піки шуму до фільтрів */
  rawPeaks: Peak[];
  /** Залишковий шум після фільтрів, RMS °/с у смузі 80 Гц і вище */
  filteredHfRms: number;
  /** Залишковий шум після фільтрів у смузі 20–80 Гц (пропвош, резонанси рами) */
  filteredLowRms: number;
}

export interface ThrottleBand {
  label: string;
  lo: number;
  hi: number;
  peaks: Peak[];
  /** Спектр roll+pitch у цьому діапазоні газу */
  spectrum: Spectrum;
  /** Основна частота шуму моторів у діапазоні, Гц */
  motorHz: number | null;
}

export interface LogAnalysis {
  sampleRate: number;
  duration: number;
  hasUnfiltered: boolean;
  hasSetpoint: boolean;
  axes: Record<Axis, AxisAnalysis>;
  throttleBands: ThrottleBand[];
  /** Частота, що лишається на місці при різному газі (резонанс рами), Гц */
  frameResonanceHz: number | null;
  /** Чи росте частота головного піку разом із газом (шум моторів) */
  motorNoiseTracksThrottle: boolean | null;
  /** Частка часу, коли хоч один мотор на максимумі */
  motorSaturation: number | null;
  /** Діапазон основної частоти моторів у польоті, Гц */
  motorHzRange: { min: number; max: number } | null;
  /** Скільки гармонік моторів помітно в спектрі (1–3) */
  motorHarmonics: number | null;
  /** Газ висіння (0..1): медіана газу, коли стіки крену й тангажу майже в центрі */
  hoverThrottle: number | null;
  /** Коливання після фільтрів (30 Гц і вище, roll+pitch, °/с) на середньому і високому газі: для TPA */
  throttleOscillation: { mid: number; high: number } | null;
  /** У скільки разів похибка утримання кута більша під час різких змін газу, ніж у спокої: для anti-gravity */
  punchErrorRatio: number | null;
  /** Просідання напруги на повному газі відносно холостого, частка (0.12 = 12%) */
  batterySag: number | null;
  /** 99-й перцентиль заданої швидкості обертання, °/с: скільки з рейтів реально використано */
  setpointP99: Record<Axis, number> | null;
  notes: string[];
}

const BANDS: Array<[string, number, number]> = [
  ["низький газ", 0, 0.35],
  ["середній газ", 0.35, 0.55],
  ["високий газ", 0.55, 1.01],
];

export function analyzeLog(log: FlightLog): LogAnalysis {
  const fs = log.sampleRate;
  const nyq = fs / 2;
  const notes: string[] = [];
  if (fs < 1000) notes.push(`Частота запису ${Math.round(fs)} Гц замала для аналізу шуму. Поставте blackbox rate хоча б 1–2 кГц.`);
  if (!log.gyroUnfilt) notes.push("У лозі немає gyroUnfilt, тому шум до фільтрів оцінено за відфільтрованим гіроскопом. Увімкніть запис gyroUnfilt у Blackbox.");
  if (!log.setpoint) notes.push("У лозі немає setpoint, тому відгук на крок не розраховано.");
  if (log.duration < 20) notes.push("Лог коротший за 20 секунд. Для надійної оцінки потрібна хвилина польоту з різкими маневрами.");

  const axes = {} as Record<Axis, AxisAnalysis>;
  for (const ax of AXES) {
    const raw = (log.gyroUnfilt ?? log.gyro)[ax];
    const spectrumRaw = welch(raw, fs, 4);
    const spectrumFiltered = welch(log.gyro[ax], fs, 4);
    axes[ax] = {
      step: log.setpoint ? estimateStepResponse(log.setpoint[ax], log.gyro[ax], fs) : null,
      spectrumRaw,
      spectrumFiltered,
      rawPeaks: spectrumRaw ? findPeaks(spectrumRaw, 30, nyq * 0.95, 4) : [],
      filteredHfRms: spectrumFiltered ? bandRms(spectrumFiltered, 80, nyq) : 0,
      filteredLowRms: spectrumFiltered ? bandRms(spectrumFiltered, 20, 80) : 0,
    };
    if (log.setpoint && !axes[ax].step) notes.push(`На осі ${ax} замало різких рухів стіків для оцінки відгуку.`);
  }

  // Піки при різному газі: шум моторів рухається, резонанс рами стоїть на місці.
  const throttleBands: ThrottleBand[] = [];
  if (log.throttle) {
    const thr = log.throttle;
    for (const [label, lo, hi] of BANDS) {
      const mask = (a: number, b: number) => {
        let s = 0;
        for (let i = a; i < b; i += 16) s += thr[i]!;
        const m = s / Math.ceil((b - a) / 16);
        return m >= lo && m < hi;
      };
      const raw = log.gyroUnfilt ?? log.gyro;
      const sr = welch(raw.roll, fs, 4, mask);
      const sp = welch(raw.pitch, fs, 4, mask);
      if (!sr || !sp) continue;
      const combined: Spectrum = { freqs: sr.freqs, amp: sr.amp.map((v, k) => Math.hypot(v, sp.amp[k]!)) };
      throttleBands.push({ label, lo, hi, spectrum: combined, peaks: findPeaks(combined, 30, nyq * 0.95, 6), motorHz: null });
    }
  }

  let frameResonanceHz: number | null = null;
  let motorNoiseTracksThrottle: boolean | null = null;
  if (throttleBands.length >= 2) {
    const all = throttleBands.flatMap((b) => b.peaks.map((p) => ({ ...p, band: b.label })));
    // Резонанс: пік, що повторюється (±5 Гц) у найбільшій кількості діапазонів газу.
    let best = { bands: 1, amp: 0 };
    for (const p of all) {
      const same = all.filter((q) => Math.abs(q.hz - p.hz) <= 5);
      const bands = new Set(same.map((q) => q.band)).size;
      const amp = same.reduce((s, q) => s + q.amp, 0);
      if (bands >= 2 && (bands > best.bands || (bands === best.bands && amp > best.amp))) {
        best = { bands, amp };
        frameResonanceHz = Math.round(same.reduce((s, q) => s + q.hz, 0) / same.length);
      }
    }
    for (const b of throttleBands) {
      // Основна частота моторів: найнижчий сильний пік (≥ 40% найсильнішого), що не є резонансом рами.
      const cand = b.peaks.filter((p) => frameResonanceHz === null || Math.abs(p.hz - frameResonanceHz) > 6);
      const top = Math.max(0, ...cand.map((p) => p.amp));
      const strong = cand.filter((p) => p.amp >= top * 0.4).sort((x, y) => x.hz - y.hz);
      b.motorHz = strong[0] ? Math.round(strong[0].hz) : null;
    }
    const tops = throttleBands.map((b) => b.motorHz).filter((v): v is number => v !== null);
    if (tops.length >= 2) motorNoiseTracksThrottle = tops[tops.length - 1]! > tops[0]! * 1.25;
  }
  const motorTops = throttleBands.map((b) => b.motorHz).filter((v): v is number => v !== null);
  const motorHzRange = motorNoiseTracksThrottle && motorTops.length ? { min: Math.min(...motorTops), max: Math.max(...motorTops) } : null;

  // Гармоніки: порівнюємо амплітуду на 2f і 3f з основною в діапазоні високого газу.
  let motorHarmonics: number | null = null;
  const hiBand = [...throttleBands].reverse().find((b) => b.motorHz);
  if (motorHzRange && hiBand?.motorHz) {
    const ampAt = (hz: number) => {
      const s = hiBand.spectrum;
      let best = 0;
      for (let k = 0; k < s.freqs.length; k++) if (Math.abs(s.freqs[k]! - hz) <= Math.max(6, hz * 0.04)) best = Math.max(best, s.amp[k]!);
      return best;
    };
    const f0 = ampAt(hiBand.motorHz);
    const f2 = hiBand.motorHz * 2 < nyq ? ampAt(hiBand.motorHz * 2) : 0;
    const f3 = hiBand.motorHz * 3 < nyq ? ampAt(hiBand.motorHz * 3) : 0;
    motorHarmonics = f3 > f0 * 0.15 ? 3 : f2 > f0 * 0.15 ? 2 : 1;
  }

  let hoverThrottle: number | null = null;
  if (log.throttle) {
    const calm: number[] = [];
    for (let i = 0; i < log.length; i += 4) {
      const sp = log.setpoint;
      const still = sp ? Math.abs(sp.roll[i]!) < 30 && Math.abs(sp.pitch[i]!) < 30 : Math.abs(log.gyro.roll[i]!) < 30 && Math.abs(log.gyro.pitch[i]!) < 30;
      if (still && log.throttle[i]! > 0.08) calm.push(log.throttle[i]!);
    }
    if (calm.length > 200) {
      calm.sort((a, b) => a - b);
      hoverThrottle = calm[Math.floor(calm.length / 2)]!;
    }
  }

  let setpointP99: Record<Axis, number> | null = null;
  if (log.setpoint) {
    setpointP99 = {} as Record<Axis, number>;
    for (const ax of AXES) {
      const v = Array.from(log.setpoint[ax], Math.abs).sort((a, b) => a - b);
      setpointP99[ax] = v[Math.floor(v.length * 0.99)] ?? 0;
    }
  }

  let motorSaturation: number | null = null;
  if (log.motors.length) {
    const fromMeta = Number((log.meta["motorOutput"] ?? "").split(",")[1]);
    let maxSeen = 0;
    for (const m of log.motors) for (let i = 0; i < m.length; i++) maxSeen = Math.max(maxSeen, m[i]!);
    const high = fromMeta > 0 ? fromMeta : maxSeen > 1000 ? 2047 : 2000;
    let sat = 0;
    for (let i = 0; i < log.length; i++) {
      if (log.motors.some((m) => m[i]! >= high - 5)) sat++;
    }
    motorSaturation = sat / log.length;
    if (motorSaturation > 0.02) {
      notes.push(`Мотори впираються в максимум ${(motorSaturation * 100).toFixed(1)}% часу. У ці моменти PID не має запасу, і відгук на крок буде гіршим, ніж показано.`);
    }
  }

  // TPA: чи сильніше коливається борт після фільтрів на високому газі, ніж на середньому.
  let throttleOscillation: { mid: number; high: number } | null = null;
  if (log.throttle) {
    const thr = log.throttle;
    const rmsAt = (lo: number, hi: number) => {
      const mask = (a: number, b: number) => {
        let s = 0;
        for (let i = a; i < b; i += 16) s += thr[i]!;
        const m = s / Math.ceil((b - a) / 16);
        return m >= lo && m < hi;
      };
      const r = welch(log.gyro.roll, fs, 4, mask);
      const p = welch(log.gyro.pitch, fs, 4, mask);
      return r && p ? Math.hypot(bandRms(r, 30, nyq * 0.9), bandRms(p, 30, nyq * 0.9)) : null;
    };
    const mid = rmsAt(0.35, 0.55);
    const high = rmsAt(0.6, 1.01);
    if (mid !== null && high !== null) throttleOscillation = { mid, high };
  }

  // Anti-gravity: похибка утримання кута (низькі частоти, до ~20 Гц) при різких змінах газу і стіках біля центру.
  let punchErrorRatio: number | null = null;
  if (log.throttle && log.setpoint) {
    const thr = log.throttle;
    const sp = log.setpoint;
    const k = Math.max(1, Math.round(fs * 0.02));
    // Ковзне середнє похибки прибирає шум моторів і рами, лишаючи повільний «провал» кута.
    const lowErr = (ax: "roll" | "pitch") => {
      const out = new Float64Array(log.length);
      let acc = 0;
      for (let i = 0; i < log.length; i++) {
        acc += sp[ax][i]! - log.gyro[ax][i]!;
        if (i >= k) acc -= sp[ax][i - k]! - log.gyro[ax][i - k]!;
        out[i] = acc / Math.min(i + 1, k);
      }
      return out;
    };
    const er = lowErr("roll");
    const ep = lowErr("pitch");
    // Стіки мають бути біля центру ще 100 мс до і після, інакше похибка — це просто відставання від стіка.
    const w = Math.round(fs * 0.1);
    const still = (i: number) =>
      [i - w, i, i + w].every((j) => j >= 0 && j < log.length && Math.abs(sp.roll[j]!) <= 15 && Math.abs(sp.pitch[j]!) <= 15);
    const fast: number[] = [];
    const calm: number[] = [];
    for (let i = k; i < log.length - k; i += 2) {
      if (!still(i)) continue;
      const e = Math.hypot(er[i]!, ep[i]!);
      const rate = Math.abs(thr[i + k]! - thr[i - k]!) / ((2 * k) / fs);
      if (rate > 1.5) fast.push(e);
      else if (rate < 0.3) calm.push(e);
    }
    // Медіана стійка до поодиноких різких рухів, які не стосуються газу.
    const median = (v: number[]) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
    if (fast.length > fs * 0.1 && calm.length > fs * 0.5) punchErrorRatio = median(fast) / Math.max(0.5, median(calm));
  }

  // Просідання батареї: vbat = a + b·газ + c·час (час враховує розряд за політ).
  let batterySag: number | null = null;
  if (log.vbat && log.throttle) {
    const v = log.vbat, thr = log.throttle, t = log.time;
    let n = 0;
    const S = { t: 0, x: 0, y: 0, tt: 0, xx: 0, tx: 0, ty: 0, xy: 0 };
    for (let i = 0; i < log.length; i += 8) {
      if (!(v[i]! > 0)) continue;
      const x = thr[i]!, ti = t[i]!, y = v[i]!;
      n++;
      S.t += ti; S.x += x; S.y += y; S.tt += ti * ti; S.xx += x * x; S.tx += ti * x; S.ty += ti * y; S.xy += x * y;
    }
    if (n > 200) {
      // Нормальні рівняння для 3 параметрів (метод Крамера).
      const A = [[n, S.x, S.t], [S.x, S.xx, S.tx], [S.t, S.tx, S.tt]];
      const B = [S.y, S.xy, S.ty];
      const det3 = (m: number[][]) =>
        m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) - m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) + m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
      const d = det3(A);
      if (Math.abs(d) > 1e-9) {
        const col = (j: number) => A.map((row, r) => row.map((c, k) => (k === j ? B[r]! : c)));
        const a0 = det3(col(0)) / d;
        const b1 = det3(col(1)) / d;
        if (a0 > 0) batterySag = Math.max(0, -b1 / a0);
      }
    }
  }

  return {
    sampleRate: fs,
    duration: log.duration,
    hasUnfiltered: !!log.gyroUnfilt,
    hasSetpoint: !!log.setpoint,
    axes,
    throttleBands,
    frameResonanceHz,
    motorNoiseTracksThrottle,
    motorSaturation,
    motorHzRange,
    motorHarmonics,
    hoverThrottle,
    setpointP99,
    throttleOscillation,
    punchErrorRatio,
    batterySag,
    notes,
  };
}
