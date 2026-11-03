import { describe, expect, it } from "vitest";
import { applyCliValues, cliValuesFromLogHeaders } from "../src/model/settings";
import { computeTune } from "../src/model/tuner";
import { parseBlackboxBinary } from "../src/blackbox/bbl";
import { synthBbl } from "../src/sim/synthBbl";

const x = { prop: 10, pitch: 5, blades: 3, frame: "open", stator: "3115", kv: 900, cells: 6, auw: 2600, style: "longrange", motorPoles: 14, profile: 0, rateProfile: 0, rpmFilter: true } as const;

describe("реальні налаштування", () => {
  it("накладає змінні CLI на tune з правильними одиницями", () => {
    const base = computeTune(x);
    const { tune, applied } = applyCliValues(base, { p_roll: "50", d_min_pitch: "30", roll_rc_rate: "20", roll_srate: "67", roll_expo: "35", thr_mid: "45", gyro_lpf2_static_hz: "300", dshot_bidir: "OFF", tpa_rate: "abc" });
    expect(tune.pid.roll.p).toBe(50);
    expect(tune.pid.pitch.dMin).toBe(30);
    expect(tune.rates.roll).toEqual({ center: 200, max: 670, expo: 0.35 });
    expect(tune.rates.thrMid).toBeCloseTo(0.45);
    expect(tune.filters.gyro_lpf2_static_hz).toBe(300);
    expect(tune.extras.dshot_bidir).toBe("OFF");
    expect(applied).not.toContain("tpa_rate");
    expect(base.pid.roll.p).not.toBe(50); // оригінал не змінено
  });

  it("читає налаштування з заголовка логу", () => {
    const log = parseBlackboxBinary(synthBbl({ seconds: 2 }).bytes);
    const v = cliValuesFromLogHeaders(log.meta);
    expect(v).toMatchObject({ p_roll: "41", i_roll: "76", d_roll: "33", d_min_pitch: "28", f_yaw: "80", roll_rc_rate: "18", pitch_srate: "50", gyro_lpf1_dyn_min_hz: "180", gyro_lpf1_dyn_max_hz: "360", dshot_bidir: "ON", thr_mid: "38" });
    const { tune } = applyCliValues(computeTune(x), v);
    expect(tune.pid.pitch).toMatchObject({ p: 44, i: 80, d: 36, dMin: 28, f: 95 });
    expect(tune.rates.yaw.max).toBe(400);
  });

  it("не бере рейти, якщо вони не Actual", () => {
    const v = cliValuesFromLogHeaders({ rates_type: "0", rc_rates: "100,100,100", rates: "70,70,70" });
    expect(v.roll_rc_rate).toBeUndefined();
  });
});
