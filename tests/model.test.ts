import { describe, expect, it } from "vitest";
import { computeTune, statorVolume } from "../src/model/tuner";
import { buildCli } from "../src/model/cli";
import { adjustFromLog } from "../src/model/adjust";
import { analyzeLog } from "../src/blackbox/analyze";
import { parseBlackboxCsv } from "../src/blackbox/csv";
import { synthLogCsv } from "../src/sim/synthLog";
import type { BuildParams } from "../src/model/types";

const TEN: BuildParams = {
  prop: 10, pitch: 5, blades: 3, frame: "open", stator: "3115", kv: 900, cells: 6, auw: 2600,
  style: "longrange", motorPoles: 14, profile: 0, rateProfile: 0, rpmFilter: true,
};
const PRESETS: Record<number, BuildParams> = {
  8: { ...TEN, prop: 8, pitch: 4.5, stator: "2812", kv: 1000, auw: 1600 },
  10: TEN,
  13: { ...TEN, prop: 13, pitch: 6.5, blades: 2, stator: "4214", kv: 480, cells: 12, auw: 5000, style: "cinematic", motorPoles: 24 },
  15: { ...TEN, prop: 15, pitch: 7, blades: 2, stator: "4215", kv: 400, cells: 12, auw: 7000, style: "cinematic", motorPoles: 24 },
  21: { ...TEN, prop: 21, pitch: 7, blades: 2, stator: "6215", kv: 170, cells: 12, auw: 16000, style: "cinematic", motorPoles: 28 },
};

describe("computeTune", () => {
  it("типові шаблони 8–21\" мають потужність і вагу близькі до типових", () => {
    for (const p of Object.values(PRESETS)) {
      const t = computeTune(p);
      expect(t.metrics.powerRatio).toBeGreaterThan(0.85);
      expect(t.metrics.powerRatio).toBeLessThan(1.2);
      expect(t.metrics.weightRatio).toBeGreaterThan(0.85);
      expect(t.metrics.weightRatio).toBeLessThan(1.15);
    }
  });

  it("зі зростанням пропа P, FF і межі фільтрів спадають, а D/P росте", () => {
    const sizes = [8, 10, 13, 15, 21].map((d) => computeTune({ ...PRESETS[d]!, style: "longrange", blades: 3 }));
    for (let k = 1; k < sizes.length; k++) {
      const a = sizes[k - 1]!, b = sizes[k]!;
      expect(b.pid.roll.p).toBeLessThanOrEqual(a.pid.roll.p);
      expect(b.pid.roll.f).toBeLessThanOrEqual(a.pid.roll.f);
      expect(b.filters.gyro_lpf1_dyn_min_hz).toBeLessThanOrEqual(a.filters.gyro_lpf1_dyn_min_hz);
      expect(b.pid.roll.d / b.pid.roll.p).toBeGreaterThanOrEqual(a.pid.roll.d / a.pid.roll.p - 0.02);
    }
  });

  it("без RPM-фільтра фільтрація сильніша і є попередження", () => {
    const on = computeTune(TEN);
    const off = computeTune({ ...TEN, rpmFilter: false });
    expect(off.filters.gyro_lpf1_dyn_min_hz).toBeLessThan(on.filters.gyro_lpf1_dyn_min_hz);
    expect(off.filters.dyn_notch_count).toBe(3);
    expect(off.warnings.length).toBeGreaterThan(0);
  });

  it("21\" попереджає про низькочастотний шум і напругу 12S", () => {
    const t = computeTune(PRESETS[21]!);
    expect(t.warnings.some((w) => w.includes("60 Гц"))).toBe(true);
    expect(t.warnings.some((w) => w.includes("12S"))).toBe(true);
  });

  it("всі значення в межах Betaflight на крайніх входах", () => {
    for (const prop of [7, 8, 10, 13, 15, 21, 24]) {
      for (const kv of [100, 500, 1500]) {
        for (const cells of [6, 12]) {
          const t = computeTune({ ...TEN, prop, kv, cells, auw: 200 * prop * prop / 10 });
          for (const ax of ["roll", "pitch", "yaw"] as const) {
            const p = t.pid[ax];
            for (const v of [p.p, p.i, p.d, p.f]) {
              expect(Number.isFinite(v)).toBe(true);
              expect(v).toBeGreaterThanOrEqual(0);
              expect(v).toBeLessThanOrEqual(500);
            }
          }
          expect(t.filters.dyn_notch_min_hz).toBeGreaterThanOrEqual(60);
          expect(t.filters.dyn_notch_max_hz).toBeGreaterThanOrEqual(200);
          expect(t.extras.rpm_filter_min_hz!).toBeGreaterThanOrEqual(30);
        }
      }
    }
  });

  it("розбирає позначення статора", () => {
    expect(statorVolume("3115")).toBe(31 * 31 * 15);
    expect(statorVolume("6215")).toBe(62 * 62 * 15);
    expect(statorVolume("abc")).toBeNull();
  });
});

describe("buildCli", () => {
  it("ставить глобальні змінні до profile, а PID після, і закінчується save", () => {
    const cli = buildCli({ ...TEN, profile: 2 }, computeTune(TEN));
    const lines = cli.split("\n");
    const prof = lines.indexOf("profile 2");
    expect(prof).toBeGreaterThan(0);
    expect(lines.findIndex((l) => l.startsWith("set gyro_lpf1_dyn_min_hz"))).toBeLessThan(prof);
    expect(lines.findIndex((l) => l.startsWith("set p_roll"))).toBeGreaterThan(prof);
    expect(lines.findIndex((l) => l.startsWith("set dterm_lpf1_dyn_min_hz"))).toBeGreaterThan(prof);
    expect(lines[lines.length - 1]).toBe("save");
  });
});

const DEMO_10 = { seconds: 30, wn: 55, delayMs: 6, frameHz: 95, motorHzIdle: 40, motorHzSpan: 170, gyroLpfHz: 70, zeta: [0.4, 0.48, 0.8] as [number, number, number] };

describe("adjustFromLog (синтетичний 10\")", () => {
  it("на лозі з перерегулюванням піднімає D по roll і знаходить резонанс рами на 95 Гц", () => {
    const log = parseBlackboxCsv(synthLogCsv(DEMO_10));
    const analysis = analyzeLog(log);
    const { tune, changes, findings } = adjustFromLog(computeTune(TEN), analysis);
    expect(tune.pid.roll.d).toBeGreaterThan(computeTune(TEN).pid.roll.d);
    expect(changes.some((c) => c.param === "d_roll")).toBe(true);
    expect(analysis.frameResonanceHz).not.toBeNull();
    expect(Math.abs(analysis.frameResonanceHz! - 95)).toBeLessThan(8);
    expect(analysis.motorNoiseTracksThrottle).toBe(true);
    expect(findings.length).toBeGreaterThan(0);
  });

  it("на добре задемпфованому лозі не чіпає PID", () => {
    const log = parseBlackboxCsv(synthLogCsv({ ...DEMO_10, zeta: [0.75, 0.75, 0.8], seed: 3 }));
    const { changes } = adjustFromLog(computeTune(TEN), analyzeLog(log));
    expect(changes.filter((c) => c.group === "PID" && /^(p|d)_/.test(c.param))).toEqual([]);
  });
});
