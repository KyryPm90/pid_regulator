import { describe, expect, it } from "vitest";
import { buildCli, computeTune, type BuildParams } from "@pid/core";
import { FlightController, type PortLike } from "../src/serial/fc";

/** Імітація польотника Betaflight 4.5 з CLI. */
function fakeFc(opts: { reject?: string } = {}) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const vars: Record<string, string> = { p_roll: "45", roll_srate: "67", gyro_lpf1_dyn_min_hz: "250" };
  const log: string[] = [];
  let saved = false;
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
  const send = (s: string) => ctrl.enqueue(enc.encode(s));
  let pending = "";
  const handle = (cmd: string) => {
    log.push(cmd);
    if (cmd === "version") return send("version\r\n# Betaflight / STM32F7X2 (S7X2) 4.5.1 Jul 26 2024\r\n# ");
    if (cmd === "save") return void (saved = true);
    if (cmd === "exit") return;
    let m = /^get (\w+)$/.exec(cmd);
    if (m) return send(`${cmd}\r\n${m[1]} = ${vars[m[1]!] ?? "0"}\r\nAllowed range: 0 - 250\r\n\r\n# `);
    m = /^set (\w+) = (.+)$/.exec(cmd);
    if (m) {
      if (m[1] === opts.reject) return send(`${cmd}\r\n###ERROR IN set: INVALID NAME: ${m[1]}###\r\n# `);
      vars[m[1]!] = m[2]!;
      return send(`${cmd}\r\n${m[1]} set to ${m[2]}\r\n# `);
    }
    send(`${cmd}\r\n# `);
  };
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      const s = dec.decode(chunk);
      if (s === "#") return send("\r\nEntering CLI Mode, type 'exit' to return, or 'help'\r\n\r\n# ");
      pending += s;
      let i;
      while ((i = pending.indexOf("\n")) >= 0) {
        handle(pending.slice(0, i).trim());
        pending = pending.slice(i + 1);
      }
    },
  });
  const port: PortLike = { readable, writable, close: async () => {} };
  return { port, vars, log, isSaved: () => saved };
}

const TEN: BuildParams = {
  prop: 10, pitch: 5, blades: 3, frame: "open", stator: "3115", kv: 900, cells: 6, auw: 2600,
  style: "longrange", motorPoles: 14, profile: 0, rateProfile: 0, rpmFilter: true,
};

describe("FlightController", () => {
  it("входить у CLI і читає версію", async () => {
    const f = fakeFc();
    const fc = new FlightController(f.port, 500);
    await fc.enterCli();
    expect(fc.version).toBe("4.5.1");
  });

  it("зчитує поточні значення в потрібних профілях", async () => {
    const f = fakeFc();
    const fc = new FlightController(f.port, 500);
    await fc.enterCli();
    const cli = buildCli(TEN, computeTune(TEN));
    const diff = await fc.readCurrent(cli);
    expect(diff.find((d) => d.name === "p_roll")?.current).toBe("45");
    expect(f.log).toContain("profile 0");
    expect(f.log).toContain("rateprofile 0");
    expect(f.log.indexOf("profile 0")).toBeLessThan(f.log.indexOf("get p_roll"));
  });

  it("записує налаштування і зберігає", async () => {
    const f = fakeFc();
    const fc = new FlightController(f.port, 500);
    await fc.enterCli();
    const tune = computeTune(TEN);
    const res = await fc.apply(buildCli(TEN, tune));
    expect(res).toEqual({ saved: true, errors: [] });
    expect(f.isSaved()).toBe(true);
    expect(f.vars.p_roll).toBe(String(tune.pid.roll.p));
  });

  it("не зберігає, якщо прошивка відхилила команду", async () => {
    const f = fakeFc({ reject: "thrust_linear" });
    const fc = new FlightController(f.port, 500);
    await fc.enterCli();
    const res = await fc.apply(buildCli(TEN, computeTune(TEN)));
    expect(res.saved).toBe(false);
    expect(res.errors[0]).toContain("thrust_linear");
    expect(f.isSaved()).toBe(false);
    expect(f.log.at(-1)).toBe("exit");
  });
});
