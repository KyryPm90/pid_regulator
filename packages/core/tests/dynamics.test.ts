import { describe, expect, it } from "vitest";
import { analyzeLog, type LogAnalysis } from "../src/blackbox/analyze";
import { parseBlackboxBinary } from "../src/blackbox/bbl";
import { synthBbl } from "../src/sim/synthBbl";
import { adjustFromLog, tuneDynamics, type Change } from "../src/model/adjust";
import { computeTune } from "../src/model/tuner";
import { buildCli } from "../src/model/cli";

const x = { prop: 13, pitch: 6, blades: 3, frame: "open", stator: "4214", kv: 400, cells: 12, auw: 7000, style: "longrange", motorPoles: 24, profile: 0, rateProfile: 0, rpmFilter: true } as const;
const log = () => parseBlackboxBinary(synthBbl({ seconds: 20 }).bytes);

describe("динаміка важких бортів", () => {
  it("оцінює просідання батареї незалежно від розряду за політ", () => {
    const l = log();
    const v = new Float64Array(l.length);
    for (let i = 0; i < l.length; i++) v[i] = 4800 * (1 - 0.15 * l.throttle![i]!) - 20 * l.time[i]!;
    const a = analyzeLog({ ...l, vbat: v });
    expect(a.batterySag).toBeGreaterThan(0.13);
    expect(a.batterySag).toBeLessThan(0.17);
    const adj = adjustFromLog(computeTune(x), a);
    expect(adj.changes.find((c) => c.param === "vbat_sag_compensation")?.to).toBe(80);
  });

  it("бачить гірше утримання кута при різких змінах газу", () => {
    const l = log();
    const fs = l.sampleRate;
    // Газ із різкими «панчами»: 0.3 → 0.8 за 0.2 с кожні 2 с.
    const throttle = new Float64Array(l.length);
    for (let i = 0; i < l.length; i++) {
      const ph = (i / fs) % 2;
      throttle[i] = ph < 1 ? 0.3 : ph < 1.2 ? 0.3 + ((ph - 1) / 0.2) * 0.5 : ph < 1.8 ? 0.8 : 0.8 - ((ph - 1.8) / 0.2) * 0.5;
    }
    const gyro = { ...l.gyro, roll: Float64Array.from(l.gyro.roll) };
    for (let i = 0; i < l.length; i++) {
      const ph = (i / fs) % 2;
      const punching = (ph >= 1 && ph < 1.2) || ph >= 1.8;
      if (punching) gyro.roll[i] = gyro.roll[i]! + 12 * Math.sin((2 * Math.PI * 4 * i) / fs);
    }
    const base = analyzeLog({ ...l, throttle });
    const punched = analyzeLog({ ...l, throttle, gyro });
    expect(base.punchErrorRatio).not.toBeNull();
    expect(base.punchErrorRatio!).toBeLessThan(1.5);
    expect(punched.punchErrorRatio!).toBeGreaterThan(1.8);
  });

  it("правила TPA, anti-gravity і батареї", () => {
    const a = analyzeLog(log());
    const t = computeTune(x);
    const changes: Change[] = [];
    const findings: string[] = [];
    const tune = structuredClone(t);
    const crafted: LogAnalysis = { ...a, throttleOscillation: { mid: 0.6, high: 1.5 }, punchErrorRatio: 2.4, batterySag: 0.22, hoverThrottle: 0.42 };
    tuneDynamics(tune, crafted, changes, findings);
    const by = (p: string) => changes.find((c) => c.param === p);
    expect(by("tpa_rate")!.to).toBe(Math.min(90, t.extras.tpa_rate + 10));
    expect(by("tpa_breakpoint")!.to).toBe(1500);
    expect(by("anti_gravity_gain")!.to).toBeGreaterThan(t.extras.anti_gravity_gain);
    expect(by("vbat_sag_compensation")!.to).toBe(100);
    expect(findings.some((f) => f.includes("батарея слабка"))).toBe(true);
    // Спокійний лог нічого не змінює
    const calm: Change[] = [];
    tuneDynamics(structuredClone(t), { ...a, throttleOscillation: { mid: 0.6, high: 0.7 }, punchErrorRatio: 1.1, batterySag: 0.04 }, calm, []);
    expect(calm).toEqual([]);
  });

  it("CLI містить vbat_sag_compensation", () => {
    expect(buildCli(x, computeTune(x))).toMatch(/set vbat_sag_compensation = 0/);
  });
});
