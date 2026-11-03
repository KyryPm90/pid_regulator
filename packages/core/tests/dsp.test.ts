import { describe, expect, it } from "vitest";
import { fft } from "../src/blackbox/fft";
import { findPeaks, welch } from "../src/blackbox/spectrum";
import { estimateStepResponse, stepMetrics } from "../src/blackbox/step";
import { parseBlackboxCsv } from "../src/blackbox/csv";
import { synthLogCsv } from "../src/sim/synthLog";

describe("fft", () => {
  it("пряме і обернене перетворення повертають вихідний сигнал", () => {
    const n = 64;
    const re = new Float64Array(n).map((_, i) => Math.sin(i) + 0.3 * i);
    const orig = re.slice();
    const im = new Float64Array(n);
    fft(re, im);
    fft(re, im, true);
    for (let i = 0; i < n; i++) expect(re[i]).toBeCloseTo(orig[i]!, 9);
  });
});

describe("welch", () => {
  it("знаходить синус на правильній частоті з правильною амплітудою", () => {
    const fs = 2000;
    const sig = new Float64Array(fs * 4).map((_, i) => 10 * Math.sin((2 * Math.PI * 220 * i) / fs));
    const s = welch(sig, fs, 2)!;
    const [peak] = findPeaks(s, 50, 1000);
    expect(peak!.hz).toBeGreaterThan(216);
    expect(peak!.hz).toBeLessThan(224);
    // Синус амплітуди 10 має RMS ≈ 7.07; енергія розмазана вікном Ганна по кількох бінах
    let e = 0;
    for (let k = 0; k < s.freqs.length; k++) if (Math.abs(s.freqs[k]! - 220) < 10) e += s.amp[k]! ** 2;
    expect(Math.sqrt(e)).toBeGreaterThan(6.5);
    expect(Math.sqrt(e)).toBeLessThan(7.6);
  });
});

describe("stepMetrics", () => {
  it("рахує перерегулювання і дзвін", () => {
    const fs = 2000;
    const n = 1000;
    const t = new Float64Array(n).map((_, i) => (i / fs) * 1000);
    const zeta = 0.3, wn = 100;
    const wd = wn * Math.sqrt(1 - zeta * zeta);
    const y = t.map((ms) => {
      const s = ms / 1000;
      return 1 - Math.exp(-zeta * wn * s) * (Math.cos(wd * s) + (zeta / Math.sqrt(1 - zeta * zeta)) * Math.sin(wd * s));
    });
    const m = stepMetrics(t, y);
    expect(m.peak).toBeCloseTo(1 + Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta)), 2);
    expect(m.ringing).toBeGreaterThanOrEqual(2);
  });
});

describe("синтетичний лог", () => {
  const log = parseBlackboxCsv(synthLogCsv({ seconds: 20 }));

  it("розбирається з правильною частотою і колонками", () => {
    expect(log.sampleRate).toBeCloseTo(2000, 0);
    expect(log.gyroUnfilt).not.toBeNull();
    expect(log.setpoint).not.toBeNull();
    expect(log.motors.length).toBe(4);
    expect(log.duration).toBeGreaterThan(19.9);
  });

  it("деконволюція відновлює перерегулювання недодемпфованої осі", () => {
    const roll = estimateStepResponse(log.setpoint!.roll, log.gyro.roll, log.sampleRate)!;
    const yaw = estimateStepResponse(log.setpoint!.yaw, log.gyro.yaw, log.sampleRate)!;
    expect(roll.windows).toBeGreaterThan(5);
    // ζ=0.42 дає ~23% перерегулювання; фільтр гіроскопа трохи його згладжує
    expect(roll.peak).toBeGreaterThan(1.1);
    expect(roll.peak).toBeLessThan(1.35);
    expect(yaw.peak).toBeLessThan(1.08);
    expect(roll.steady).toBeGreaterThan(0.93);
    expect(roll.steady).toBeLessThan(1.07);
  });

  it("бачить резонанс рами на 165 Гц у нефільтрованому гіроскопі", () => {
    const s = welch(log.gyroUnfilt!.roll, log.sampleRate, 4, (a) => log.throttle![a]! < 0.4)!;
    const peaks = findPeaks(s, 80, 1000, 5);
    expect(peaks.some((p) => Math.abs(p.hz - 165) < 6)).toBe(true);
  });
});
