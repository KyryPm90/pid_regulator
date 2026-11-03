import { describe, expect, it } from "vitest";
import { BF_DEFAULTS, computeTune, statorVolume } from "../src/model/tuner";
import { buildCli } from "../src/model/cli";
import { adjustFromLog } from "../src/model/adjust";
import { analyzeLog } from "../src/blackbox/analyze";
import { parseBlackboxCsv } from "../src/blackbox/csv";
import { synthLogCsv } from "../src/sim/synthLog";
import type { BuildParams } from "../src/model/types";

const FIVE: BuildParams = {
  prop: 5, pitch: 4.3, blades: 3, frame: "open", stator: "2207", kv: 1950, cells: 6, auw: 680,
  style: "freestyle", motorPoles: 14, profile: 0, rpmFilter: true,
};

describe("computeTune", () => {
  it('типовий 5" фрістайл дає значення близькі до дефолтів Betaflight', () => {
    const t = computeTune(FIVE);
    for (const ax of ["roll", "pitch"] as const) {
      expect(Math.abs(t.pid[ax].p - BF_DEFAULTS[ax].p)).toBeLessThanOrEqual(3);
      expect(Math.abs(t.pid[ax].d - BF_DEFAULTS[ax].d)).toBeLessThanOrEqual(3);
    }
    expect(t.pid.yaw.d).toBe(0);
  });

  it('7" лонг-рейндж отримує нижчі P і FF, ніж 5"', () => {
    const five = computeTune(FIVE);
    const seven = computeTune({ ...FIVE, prop: 7, pitch: 4, blades: 2, stator: "2807", kv: 1300, auw: 1050, style: "longrange" });
    expect(seven.pid.roll.p).toBeLessThan(five.pid.roll.p);
    expect(seven.pid.roll.f).toBeLessThan(five.pid.roll.f);
    expect(seven.filters.dyn_notch_max_hz).toBeLessThan(five.filters.dyn_notch_max_hz);
  });

  it("без RPM-фільтра фільтрація сильніша і є попередження", () => {
    const on = computeTune(FIVE);
    const off = computeTune({ ...FIVE, rpmFilter: false });
    expect(off.filters.gyro_lpf1_dyn_min_hz).toBeLessThan(on.filters.gyro_lpf1_dyn_min_hz);
    expect(off.filters.dyn_notch_count).toBe(3);
    expect(off.warnings.length).toBeGreaterThan(0);
  });

  it("всі значення в допустимих межах Betaflight на крайніх входах", () => {
    for (const prop of [1.6, 3, 5, 7, 10, 13]) {
      for (const kv of [300, 2000, 12000]) {
        const t = computeTune({ ...FIVE, prop, kv, auw: 50 + prop * 150 });
        for (const ax of ["roll", "pitch", "yaw"] as const) {
          const p = t.pid[ax];
          for (const v of [p.p, p.i, p.d, p.f]) {
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(500);
          }
        }
      }
    }
  });

  it("розбирає позначення статора", () => {
    expect(statorVolume("2207")).toBe(22 * 22 * 7);
    expect(statorVolume("1404")).toBe(14 * 14 * 4);
    expect(statorVolume("abc")).toBeNull();
  });
});

describe("buildCli", () => {
  it("ставить глобальні змінні до profile, а PID після, і закінчується save", () => {
    const cli = buildCli({ ...FIVE, profile: 2 }, computeTune(FIVE));
    const lines = cli.split("\n");
    const prof = lines.indexOf("profile 2");
    expect(prof).toBeGreaterThan(0);
    expect(lines.findIndex((l) => l.startsWith("set gyro_lpf1_dyn_min_hz"))).toBeLessThan(prof);
    expect(lines.findIndex((l) => l.startsWith("set p_roll"))).toBeGreaterThan(prof);
    expect(lines.findIndex((l) => l.startsWith("set dterm_lpf1_dyn_min_hz"))).toBeGreaterThan(prof);
    expect(lines[lines.length - 1]).toBe("save");
  });
});

describe("adjustFromLog", () => {
  it("на лозі з перерегулюванням піднімає D по roll і знаходить резонанс рами", () => {
    const log = parseBlackboxCsv(synthLogCsv({ seconds: 30 }));
    const analysis = analyzeLog(log);
    const { tune, changes, findings } = adjustFromLog(computeTune(FIVE), analysis);
    expect(tune.pid.roll.d).toBeGreaterThan(computeTune(FIVE).pid.roll.d);
    expect(changes.some((c) => c.param === "d_roll")).toBe(true);
    expect(analysis.frameResonanceHz).not.toBeNull();
    expect(Math.abs(analysis.frameResonanceHz! - 165)).toBeLessThan(8);
    expect(analysis.motorNoiseTracksThrottle).toBe(true);
    expect(findings.length).toBeGreaterThan(0);
  });

  it("на добре задемпфованому лозі не чіпає PID", () => {
    const log = parseBlackboxCsv(synthLogCsv({ seconds: 30, zeta: [0.75, 0.75, 0.8], seed: 3 }));
    const { changes } = adjustFromLog(computeTune(FIVE), analyzeLog(log));
    expect(changes.filter((c) => c.group === "PID" && /^(p|d)_/.test(c.param))).toEqual([]);
  });
});
