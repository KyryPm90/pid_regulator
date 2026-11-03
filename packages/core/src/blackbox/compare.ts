import type { Axis } from "../model/types";
import type { LogAnalysis } from "./analyze";

export type Verdict = "краще" | "гірше" | "без змін" | "немає даних";

export interface CompareRow {
  metric: string;
  axis: Axis | null;
  unit: string;
  before: number | null;
  after: number | null;
  verdict: Verdict;
}

export interface LogComparison {
  rows: CompareRow[];
  better: number;
  worse: number;
  /** Короткий підсумок українською */
  summary: string;
}

interface MetricDef {
  metric: string;
  unit: string;
  axes: Array<Axis | null>;
  get: (a: LogAnalysis, ax: Axis | null) => number | null;
  /** Зміна, меншу за яку не вважаємо значущою (абсолютна, в одиницях метрики) */
  minDelta: number;
  /** Відносна зміна, меншу за яку не вважаємо значущою */
  minRel: number;
}

const RP: Axis[] = ["roll", "pitch"];

const METRICS: MetricDef[] = [
  {
    metric: "Перерегулювання",
    unit: "%",
    axes: RP,
    // Відхилення піку від ідеалу 1.0 в будь-який бік: і перерегулювання, і недорегулювання погані.
    get: (a, ax) => {
      const s = a.axes[ax!].step;
      return s ? Math.abs(s.peak - 1) * 100 : null;
    },
    minDelta: 2,
    minRel: 0.1,
  },
  {
    metric: "Затримка відгуку (50%)",
    unit: "мс",
    axes: RP,
    get: (a, ax) => a.axes[ax!].step?.delayMs ?? null,
    minDelta: 1,
    minRel: 0.05,
  },
  {
    metric: "Похибка утримання",
    unit: "%",
    axes: RP,
    get: (a, ax) => {
      const s = a.axes[ax!].step;
      return s ? Math.abs(s.steady - 1) * 100 : null;
    },
    minDelta: 2,
    minRel: 0.15,
  },
  {
    metric: "Шум після фільтрів (80+ Гц)",
    unit: "°/с",
    axes: RP,
    get: (a, ax) => a.axes[ax!].filteredHfRms,
    minDelta: 0.1,
    minRel: 0.1,
  },
  {
    metric: "Пропвош і низькочастотний шум (20–80 Гц)",
    unit: "°/с",
    axes: RP,
    get: (a, ax) => a.axes[ax!].filteredLowRms,
    minDelta: 0.2,
    minRel: 0.1,
  },
  {
    metric: "Мотори на максимумі",
    unit: "% часу",
    axes: [null],
    get: (a) => (a.motorSaturation === null ? null : a.motorSaturation * 100),
    minDelta: 0.5,
    minRel: 0.2,
  },
];

/** «1 показник», «3 показники», «5 показників» */
function indicators(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? "показник" : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "показники" : "показників";
  return `${n} ${w}`;
}

/** Порівнює два аналізи логу (до і після змін). Для всіх метрик менше означає краще. */
export function compareLogs(before: LogAnalysis, after: LogAnalysis): LogComparison {
  const rows: CompareRow[] = [];
  for (const m of METRICS) {
    for (const ax of m.axes) {
      const b = m.get(before, ax);
      const a = m.get(after, ax);
      let verdict: Verdict = "немає даних";
      if (b !== null && a !== null) {
        const d = a - b;
        const significant = Math.abs(d) >= m.minDelta && Math.abs(d) >= m.minRel * Math.max(Math.abs(b), 1e-9);
        verdict = !significant ? "без змін" : d < 0 ? "краще" : "гірше";
      }
      rows.push({ metric: m.metric, axis: ax, unit: m.unit, before: b, after: a, verdict });
    }
  }
  const better = rows.filter((r) => r.verdict === "краще").length;
  const worse = rows.filter((r) => r.verdict === "гірше").length;
  const summary =
    better === 0 && worse === 0
      ? "Помітної різниці між логами немає."
      : worse === 0
        ? `Стало краще: покращилось ${indicators(better)} з ${rows.length}, погіршень немає.`
        : better === 0
          ? `Стало гірше: погіршилось ${indicators(worse)}. Варто повернути попередні налаштування.`
          : `Змішаний результат: краще ${indicators(better)}, гірше ${indicators(worse)}. Подивіться, що саме погіршилось.`;
  return { rows, better, worse, summary };
}
