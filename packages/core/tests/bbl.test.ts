import { describe, expect, it } from "vitest";
import { parseBblSessions, parseBlackboxBinary, isBlackboxBinary, BblParseError } from "../src/blackbox/bbl";
import { synthBbl, SYNTH_FIELDS } from "../src/sim/synthBbl";
import { analyzeLog } from "../src/blackbox/analyze";

describe("бінарний лог Blackbox", () => {
  it("розкодовує всі кадри без втрат", () => {
    const { bytes, rows } = synthBbl({ seconds: 4 });
    expect(isBlackboxBinary(bytes)).toBe(true);
    const [s] = parseBblSessions(bytes);
    expect(s!.corrupt).toBe(0);
    expect(s!.fields).toEqual(SYNTH_FIELDS);
    expect(s!.frames.length).toBe(rows.length);
    for (let k = 0; k < rows.length; k++) expect(Array.from(s!.frames[k]!)).toEqual(rows[k]);
  });

  it("відновлюється після пошкоджених байтів і вибирає найдовшу сесію", () => {
    const { bytes, rows } = synthBbl({ seconds: 4, garbageBeforeFrame: 2000, secondSessionFrames: 1500 });
    const sessions = parseBblSessions(bytes);
    expect(sessions.length).toBe(2);
    expect(sessions[0]!.corrupt).toBeGreaterThan(0);
    // втрачено щонайбільше один кадр перед сміттям
    expect(sessions[0]!.frames.length).toBeGreaterThanOrEqual(rows.length - 1);
    const times = new Map(rows.map((r) => [r[1], r]));
    for (const f of sessions[0]!.frames) expect(Array.from(f)).toEqual(times.get(f[1]!));
    const log = parseBlackboxBinary(bytes);
    expect(log.sessions).toBe(2);
    expect(log.length).toBe(sessions[0]!.frames.length);
  });

  it("дає той самий аналіз, що й CSV", () => {
    const { bytes } = synthBbl({ seconds: 20 });
    const log = parseBlackboxBinary(bytes);
    expect(log.sampleRate).toBeCloseTo(2000, 0);
    expect(log.gyroUnfilt).not.toBeNull();
    const a = analyzeLog(log);
    expect(a.frameResonanceHz).toBeGreaterThan(140);
    expect(a.frameResonanceHz).toBeLessThan(190);
  });

  it("відкидає файл без заголовка", () => {
    expect(() => parseBblSessions(new TextEncoder().encode("hello"))).toThrow(BblParseError);
  });
});
