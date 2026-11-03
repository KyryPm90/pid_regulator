import { describe, expect, it } from "vitest";
import { analyzeLog } from "../src/blackbox/analyze";
import { parseBlackboxCsv } from "../src/blackbox/csv";
import { compareLogs } from "../src/blackbox/compare";
import { synthLogCsv } from "../src/sim/synthLog";

const analyze = (o: Parameters<typeof synthLogCsv>[0]) => analyzeLog(parseBlackboxCsv(synthLogCsv({ seconds: 20, ...o })));

describe("порівняння логів", () => {
  it("бачить покращення після тюну", () => {
    const before = analyze({ zeta: [0.3, 0.32, 0.8], motorNoise: 25 });
    const after = analyze({ zeta: [0.62, 0.65, 0.8], motorNoise: 8 });
    const c = compareLogs(before, after);
    const row = (m: string, ax: string) => c.rows.find((r) => r.metric.startsWith(m) && r.axis === ax)!;
    expect(row("Перерегулювання", "roll").verdict).toBe("краще");
    expect(row("Шум після фільтрів", "pitch").verdict).toBe("краще");
    // більше демпфування трохи сповільнює відгук: це чесно показується як компроміс
    expect(row("Затримка", "roll").verdict).toBe("гірше");
    expect(c.better).toBeGreaterThan(c.worse);
    expect(c.summary).toMatch(/^Змішаний/);
  });

  it("однозначне покращення і погіршення", () => {
    const noisy = analyze({ motorNoise: 30, frameHz: 120 });
    const clean = analyze({ motorNoise: 6, frameHz: 120 });
    expect(compareLogs(noisy, clean).summary).toMatch(/^Стало краще/);
    expect(compareLogs(clean, noisy).summary).toMatch(/^Стало гірше/);
  });

  it("не бачить різниці між однаковими логами", () => {
    const a = analyze({});
    const c = compareLogs(a, a);
    expect(c.better + c.worse).toBe(0);
    expect(c.rows.every((r) => r.verdict === "без змін" || r.verdict === "немає даних")).toBe(true);
  });
});
