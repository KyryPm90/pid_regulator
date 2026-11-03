import { describe, expect, it } from "vitest";
import { buildCli, cliError, computeTune, parseBetaflightVersion, parseCliScript, parseGetOutput } from "../src";
import type { BuildParams } from "../src";

const TEN: BuildParams = {
  prop: 10, pitch: 5, blades: 3, frame: "open", stator: "3115", kv: 900, cells: 6, auw: 2600,
  style: "longrange", motorPoles: 14, profile: 2, rateProfile: 1, rpmFilter: true,
};

describe("parseCliScript", () => {
  it("розносить змінні за контекстами профілів", () => {
    const s = parseCliScript(buildCli(TEN, computeTune(TEN)));
    expect(s.find((x) => x.name === "gyro_lpf1_dyn_min_hz")?.scope).toBe("global");
    expect(s.find((x) => x.name === "p_roll")).toMatchObject({ scope: "profile", index: 2 });
    expect(s.find((x) => x.name === "roll_srate")).toMatchObject({ scope: "rateprofile", index: 1 });
    expect(s.some((x) => x.name === "save")).toBe(false);
  });
});

describe("розбір відповідей CLI", () => {
  it("get", () => {
    const out = "get p_roll\r\np_roll = 45\r\nAllowed range: 0 - 250\r\nDefault value: 45\r\n\r\n# ";
    expect(parseGetOutput(out, "p_roll")).toBe("45");
    expect(parseGetOutput(out, "i_roll")).toBeNull();
  });
  it("помилки", () => {
    expect(cliError("set foo = 1\r\n###ERROR IN set: INVALID NAME: FOO###")).toContain("ERROR");
    expect(cliError("set p_roll = 45\r\np_roll set to 45")).toBeNull();
  });
  it("версія", () => {
    expect(parseBetaflightVersion("# Betaflight / STM32F7X2 (S7X2) 4.5.1 Jul 26 2024 / 10:58:12 (77d01ba3b) MSP API: 1.46")).toBe("4.5.1");
  });
});
