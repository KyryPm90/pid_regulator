import { fft, hann, nextPow2 } from "./fft";

export interface Spectrum {
  /** Частоти бінів, Гц */
  freqs: Float64Array;
  /** Амплітудний спектр, °/с (RMS на бін) */
  amp: Float64Array;
}

export interface Peak {
  hz: number;
  amp: number;
}

/**
 * Усереднений спектр методом Велча (вікно Ганна, перекриття 50%).
 * `mask` (необов'язково) відбирає вікна: вікно береться, якщо mask(start, end) повертає true.
 */
export function welch(signal: Float64Array, fs: number, resolutionHz = 4, mask?: (start: number, end: number) => boolean): Spectrum | null {
  const nfft = Math.min(nextPow2(fs / resolutionHz), 8192);
  if (signal.length < nfft) return null;
  const win = hann(nfft);
  let winPow = 0;
  for (let i = 0; i < nfft; i++) winPow += win[i]! * win[i]!;
  const bins = nfft / 2 + 1;
  const acc = new Float64Array(bins);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  let count = 0;
  for (let start = 0; start + nfft <= signal.length; start += nfft / 2) {
    if (mask && !mask(start, start + nfft)) continue;
    let mean = 0;
    for (let i = 0; i < nfft; i++) mean += signal[start + i]!;
    mean /= nfft;
    for (let i = 0; i < nfft; i++) {
      re[i] = (signal[start + i]! - mean) * win[i]!;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) acc[k] = acc[k]! + re[k]! * re[k]! + im[k]! * im[k]!;
    count++;
  }
  if (!count) return null;
  const freqs = new Float64Array(bins);
  const amp = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    freqs[k] = (k * fs) / nfft;
    // Односторонній спектр: сума квадратів бінів у смузі дає RMS сигналу в цій смузі.
    const scale = k === 0 || k === bins - 1 ? 1 : 2;
    amp[k] = Math.sqrt((scale * acc[k]!) / count / winPow / nfft);
  }
  return { freqs, amp };
}

/** RMS шуму в смузі частот [lo, hi), °/с. */
export function bandRms(s: Spectrum, lo: number, hi: number): number {
  let sum = 0;
  for (let k = 0; k < s.freqs.length; k++) {
    const f = s.freqs[k]!;
    if (f >= lo && f < hi) sum += s.amp[k]! * s.amp[k]!;
  }
  return Math.sqrt(sum);
}

/** Найвищі локальні піки в смузі [lo, hi), які помітно виділяються над медіанним рівнем. */
export function findPeaks(s: Spectrum, lo: number, hi: number, max = 3): Peak[] {
  const idx: number[] = [];
  for (let k = 1; k < s.freqs.length - 1; k++) {
    const f = s.freqs[k]!;
    if (f >= lo && f < hi) idx.push(k);
  }
  if (!idx.length) return [];
  const sorted = idx.map((k) => s.amp[k]!).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const cand: Peak[] = [];
  for (const k of idx) {
    const a = s.amp[k]!;
    if (a > s.amp[k - 1]! && a >= s.amp[k + 1]! && a > median * 4) cand.push({ hz: s.freqs[k]!, amp: a });
  }
  cand.sort((a, b) => b.amp - a.amp);
  // Прибираємо сусідні піки ближче 15 Гц до вже вибраних.
  const out: Peak[] = [];
  for (const p of cand) {
    if (out.every((q) => Math.abs(q.hz - p.hz) > 15)) out.push(p);
    if (out.length >= max) break;
  }
  return out;
}
