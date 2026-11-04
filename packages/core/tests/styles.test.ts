import { describe, expect, it } from "vitest";
import { computeTune, STYLE_ORDER, STYLES, styleEffects, type BuildParams } from "../src";

const TEN: BuildParams = {
  prop: 10, pitch: 5, blades: 3, frame: "open", stator: "3115", kv: 900, cells: 6, auw: 2600,
  style: "longrange", motorPoles: 14, profile: 0, rateProfile: 0, rpmFilter: true,
};

describe("стилі польоту", () => {
  it("кожен стиль має назву, опис і місце в інтерфейсі", () => {
    expect(new Set(STYLE_ORDER)).toEqual(new Set(Object.keys(STYLES)));
    for (const k of STYLE_ORDER) expect(STYLES[k].desc.length).toBeGreaterThan(10);
  });

  it("вантаж тримає положення сильніше і плавніший за газом, ніж плавний", () => {
    const pay = computeTune({ ...TEN, style: "payload" });
    const cin = computeTune({ ...TEN, style: "cinematic" });
    expect(pay.pid.roll.i).toBeGreaterThan(cin.pid.roll.i);
    expect(pay.extras.anti_gravity_gain).toBeGreaterThan(cin.extras.anti_gravity_gain);
    expect(pay.rates.thrExpo).toBeGreaterThan(cin.rates.thrExpo);
    expect(pay.rates.roll.max).toBeLessThanOrEqual(cin.rates.roll.max);
  });

  it("styleEffects показує відмінності від базового стилю", () => {
    expect(styleEffects({ ...TEN, style: "freestyle" })).toEqual([]);
    const fx = styleEffects({ ...TEN, style: "race" });
    const ff = fx.find((r) => r.label.startsWith("Feedforward"))!;
    expect(ff.value).toBeGreaterThan(ff.base);
    const rate = fx.find((r) => r.label.startsWith("Макс"))!;
    expect(rate.value).toBeGreaterThan(rate.base);
    for (const r of fx) expect(r.value).not.toBe(r.base);
  });
});
