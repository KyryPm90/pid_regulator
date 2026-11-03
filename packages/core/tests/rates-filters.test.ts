import { describe, expect, it } from "vitest";
import { computeTune } from "../src/model/tuner";
import { actualRate } from "../src/model/rates";
import { buildCli } from "../src/model/cli";
import { adjustFromLog } from "../src/model/adjust";
import { analyzeLog } from "../src/blackbox/analyze";
import { parseBlackboxCsv } from "../src/blackbox/csv";
import { synthLogCsv } from "../src/sim/synthLog";
import type { BuildParams } from "../src/model/types";

const TEN: BuildParams = {
  prop: 10, pitch: 5, blades: 3, frame: "open", stator: "3115", kv: 900, cells: 6, auw: 2600,
  style: "longrange", motorPoles: 14, profile: 0, rateProfile: 1, rpmFilter: true,
};
const DEMO_10 = { seconds: 30, wn: 55, delayMs: 6, frameHz: 95, motorHzIdle: 40, motorHzSpan: 170, gyroLpfHz: 70, zeta: [0.4, 0.48, 0.8] as [number, number, number] };
const analysis = analyzeLog(parseBlackboxCsv(synthLogCsv(DEMO_10)));

describe("rates", () => {
  it("крива Actual rates проходить через 0 і максимум", () => {
    const r = { center: 100, max: 450, expo: 0.4 };
    expect(actualRate(r, 0)).toBe(0);
    expect(actualRate(r, 1)).toBeCloseTo(450, 6);
    expect(actualRate(r, -1)).toBeCloseTo(-450, 6);
    expect(actualRate(r, 0.5)).toBeLessThan(225);
  });

  it("максимальні рейти спадають з розміром і нижчі для плавного стилю", () => {
    const r8 = computeTune({ ...TEN, prop: 8 }).rates.roll.max;
    const r21 = computeTune({ ...TEN, prop: 21, kv: 170, cells: 12, auw: 16000, stator: "6215" }).rates.roll.max;
    expect(r21).toBeLessThan(r8);
    expect(computeTune({ ...TEN, style: "cinematic" }).rates.roll.max).toBeLessThan(computeTune({ ...TEN, style: "race" }).rates.roll.max);
  });

  it("CLI містить rate-профіль у одиницях Betaflight", () => {
    const t = computeTune(TEN);
    const cli = buildCli(TEN, t);
    expect(cli).toContain("rateprofile 1");
    expect(cli).toContain("set rates_type = ACTUAL");
    expect(cli).toContain(`set roll_srate = ${Math.round(t.rates.roll.max / 10)}`);
    expect(cli).toContain(`set thr_mid = ${Math.round(t.rates.thrMid * 100)}`);
    expect(cli.indexOf("rateprofile 1")).toBeGreaterThan(cli.indexOf("profile 0"));
  });
});

describe("автоналаштування фільтрів і рейтів за логом", () => {
  it("знаходить діапазон частот моторів і газ висіння", () => {
    expect(analysis.motorHzRange).not.toBeNull();
    expect(analysis.motorHzRange!.min).toBeGreaterThan(50);
    expect(analysis.motorHzRange!.max).toBeLessThan(220);
    expect(analysis.hoverThrottle).toBeGreaterThan(0.3);
    expect(analysis.hoverThrottle).toBeLessThan(0.8);
  });

  it("з RPM-фільтром підлаштовує rpm_filter_min_hz під моторний шум і thr_mid під висіння", () => {
    const { tune, changes } = adjustFromLog(computeTune(TEN), analysis);
    expect(tune.extras.rpm_filter_min_hz!).toBeLessThanOrEqual(Math.round(analysis.motorHzRange!.min * 0.7 / 10) * 10 + 10);
    expect(Math.abs(tune.rates.thrMid - analysis.hoverThrottle!)).toBeLessThan(0.03);
    expect(changes.some((c) => c.group === "Рейти")).toBe(true);
  });

  it("без RPM-фільтра розтягує динамічний режекторний фільтр на весь шум моторів", () => {
    const { tune } = adjustFromLog(computeTune({ ...TEN, rpmFilter: false }), analysis);
    expect(tune.filters.dyn_notch_count).toBe(3);
    expect(tune.filters.dyn_notch_min_hz).toBeLessThanOrEqual(analysis.motorHzRange!.min);
    expect(tune.filters.dyn_notch_max_hz).toBeGreaterThanOrEqual(analysis.motorHzRange!.max);
  });
});
