import { fft, hann, nextPow2 } from "./fft";

export interface StepResponse {
  /** Час, мс */
  t: Float64Array;
  /** Усереднений відгук на одиничний крок setpoint */
  y: Float64Array;
  /** Скільки вікон польоту увійшло в оцінку */
  windows: number;
  /** Максимум відгуку (1.0 = без перерегулювання) */
  peak: number;
  /** Час досягнення максимуму, мс */
  peakMs: number;
  /** Час досягнення 50% (затримка), мс */
  delayMs: number;
  /** Час наростання 10→90%, мс */
  riseMs: number;
  /** Середнє значення на 200–400 мс (точність утримання) */
  steady: number;
  /** Скільки разів відгук перетинає 1.0 після піку з амплітудою > 5% (дзвін) */
  ringing: number;
}

export interface StepOptions {
  /** Довжина відгуку, мс */
  lengthMs?: number;
  /** Мінімальна амплітуда setpoint у вікні, °/с, щоб вікно мало достатньо збудження */
  minSetpoint?: number;
  /** Регуляризація деконволюції (частка від середньої потужності входу) */
  regularization?: number;
}

/**
 * Оцінює перехідну характеристику setpoint → gyro деконволюцією Вінера
 * по ковзних вікнах, як це робить PIDtoolbox. Повертає null, якщо в лозі мало маневрів.
 */
export function estimateStepResponse(setpoint: Float64Array, gyro: Float64Array, fs: number, opts: StepOptions = {}): StepResponse | null {
  const lengthMs = opts.lengthMs ?? 500;
  const minSp = opts.minSetpoint ?? 20;
  const reg = opts.regularization ?? 1e-3;
  const n = Math.min(setpoint.length, gyro.length);
  const win = nextPow2(fs * 2); // ~2 с
  const respLen = Math.min(Math.round((lengthMs / 1000) * fs), win / 2);
  if (n < win) return null;
  const w = hann(win);
  const xr = new Float64Array(win), xi = new Float64Array(win);
  const yr = new Float64Array(win), yi = new Float64Array(win);
  const hr = new Float64Array(win), hi = new Float64Array(win);
  const sum = new Float64Array(respLen);
  let count = 0;

  for (let start = 0; start + win <= n; start += win / 4) {
    let maxSp = 0;
    for (let i = 0; i < win; i++) maxSp = Math.max(maxSp, Math.abs(setpoint[start + i]!));
    if (maxSp < minSp) continue;
    for (let i = 0; i < win; i++) {
      xr[i] = setpoint[start + i]! * w[i]!;
      yr[i] = gyro[start + i]! * w[i]!;
      xi[i] = 0;
      yi[i] = 0;
    }
    fft(xr, xi);
    fft(yr, yi);
    let pxx = 0;
    for (let k = 0; k < win; k++) pxx += xr[k]! * xr[k]! + xi[k]! * xi[k]!;
    const lambda = (reg * pxx) / win;
    for (let k = 0; k < win; k++) {
      // H = Y·conj(X) / (|X|² + λ)
      const den = xr[k]! * xr[k]! + xi[k]! * xi[k]! + lambda;
      hr[k] = (yr[k]! * xr[k]! + yi[k]! * xi[k]!) / den;
      hi[k] = (yi[k]! * xr[k]! - yr[k]! * xi[k]!) / den;
    }
    fft(hr, hi, true);
    // Інтегруємо імпульсну характеристику в перехідну.
    let acc = 0;
    const step = new Float64Array(respLen);
    for (let i = 0; i < respLen; i++) {
      acc += hr[i]!;
      step[i] = acc;
    }
    // Відкидаємо нефізичні оцінки (вікна з поганою когерентністю).
    const tail = mean(step, Math.floor(respLen * 0.4), respLen);
    if (!(tail > 0.5 && tail < 2)) continue;
    for (let i = 0; i < respLen; i++) sum[i] = sum[i]! + step[i]!;
    count++;
  }
  if (!count) return null;

  const t = new Float64Array(respLen);
  const y = new Float64Array(respLen);
  for (let i = 0; i < respLen; i++) {
    t[i] = (i / fs) * 1000;
    y[i] = sum[i]! / count;
  }
  return { t, y, windows: count, ...stepMetrics(t, y) };
}

function mean(a: Float64Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i]!;
  return s / Math.max(1, to - from);
}

/** Метрики перехідної характеристики. Нормування відбувається відносно 1.0 (ідеальне відстеження). */
export function stepMetrics(t: Float64Array, y: Float64Array): Omit<StepResponse, "t" | "y" | "windows"> {
  const n = y.length;
  let peak = -Infinity;
  let peakIdx = 0;
  for (let i = 0; i < n; i++) {
    if (y[i]! > peak) {
      peak = y[i]!;
      peakIdx = i;
    }
  }
  const crossTime = (level: number) => {
    for (let i = 1; i < n; i++) {
      if (y[i]! >= level) {
        const frac = (level - y[i - 1]!) / (y[i]! - y[i - 1]! || 1);
        return t[i - 1]! + frac * (t[i]! - t[i - 1]!);
      }
    }
    return NaN;
  };
  const steadyFrom = t.findIndex((v) => v >= 200);
  const steadyTo = t.findIndex((v) => v >= 400);
  const steady = mean(y, steadyFrom < 0 ? Math.floor(n * 0.4) : steadyFrom, steadyTo < 0 ? n : steadyTo);
  let ringing = 0;
  let above = y[peakIdx]! > 1;
  let extreme = 0;
  for (let i = peakIdx; i < n; i++) {
    const dev = y[i]! - 1;
    extreme = Math.max(extreme, Math.abs(dev));
    if (dev > 0 !== above) {
      if (extreme > 0.05) ringing++;
      above = dev > 0;
      extreme = 0;
    }
  }
  return {
    peak,
    peakMs: t[peakIdx]!,
    delayMs: crossTime(0.5),
    riseMs: crossTime(0.9) - crossTime(0.1),
    steady,
    ringing,
  };
}
