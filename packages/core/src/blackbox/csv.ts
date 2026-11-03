import type { Axis } from "../model/types";
import { AXES } from "../model/types";

/** Дані польоту, потрібні для аналізу. Значення гіроскопа і setpoint у °/с. */
export interface FlightLog {
  /** Частота запису, Гц */
  sampleRate: number;
  /** Тривалість, с */
  duration: number;
  length: number;
  /** Час кожного семпла, с від початку */
  time: Float64Array;
  /** Відфільтрований гіроскоп (gyroADC) */
  gyro: Record<Axis, Float64Array>;
  /** Нефільтрований гіроскоп (gyroUnfilt), якщо є в лозі */
  gyroUnfilt: Record<Axis, Float64Array> | null;
  setpoint: Record<Axis, Float64Array> | null;
  /** Газ у діапазоні 0..1 */
  throttle: Float64Array | null;
  /** Напруга батареї (одиниці як у лозі), якщо записана */
  vbat: Float64Array | null;
  /** Виходи моторів, як записано в лозі */
  motors: Float64Array[];
  /** Метадані з заголовка логу, якщо вони є в CSV */
  meta: Record<string, string>;
}

export class LogParseError extends Error {}

const clean = (s: string) => s.trim().replace(/^"|"$/g, "").trim();

function splitRow(line: string): string[] {
  return line.split(",").map(clean);
}

/**
 * Розбирає CSV, експортований з Betaflight Blackbox Explorer або `blackbox_decode`.
 * Рядок заголовка шукається за колонкою `gyroADC[0]`; рядки «ключ,значення» над ним
 * сприймаються як метадані.
 */
export function parseBlackboxCsv(text: string): FlightLog {
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.includes("gyroADC[0]"));
  if (headerIdx < 0) {
    throw new LogParseError("У файлі немає колонки gyroADC[0]. Експортуйте CSV з Blackbox Explorer або blackbox_decode.");
  }
  const meta: Record<string, string> = {};
  for (let i = 0; i < headerIdx; i++) {
    const cells = splitRow(lines[i]!);
    if (cells.length >= 2 && cells[0]) meta[cells[0]] = cells.slice(1).join(",");
  }
  const header = splitRow(lines[headerIdx]!);
  const timeCol = header.findIndex((h) => /^time/i.test(h));
  if (timeCol < 0) throw new LogParseError("У файлі немає колонки часу (time).");
  const timeInUs = /us|µs/i.test(header[timeCol]!) || !/\(s\)/.test(header[timeCol]!);

  const rows: string[][] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const cells = line.split(",");
    if (cells.length < header.length - 1) continue;
    rows.push(cells);
  }
  const n = rows.length;
  const column = (name: string): Float64Array | null => {
    // Blackbox Explorer додає одиниці до назви колонки: "vbatLatest (V)".
    const c = name === "time" ? timeCol : header.findIndex((h) => h === name || h.startsWith(`${name} (`));
    if (c < 0) return null;
    const out = new Float64Array(n);
    for (let r = 0; r < n; r++) out[r] = Number(rows[r]![c]);
    return out;
  };
  return buildFlightLog(column, n, timeInUs ? 1e-6 : 1, meta);
}

/**
 * Збирає FlightLog з колонок логу (спільне для CSV і бінарного .bbl).
 * `column(name)` повертає колонку за іменем поля Betaflight або null; "time" — колонка часу.
 */
export function buildFlightLog(
  column: (name: string) => Float64Array | null,
  n: number,
  timeScale: number,
  meta: Record<string, string>,
): FlightLog {
  if (n < 512) throw new LogParseError(`Замало даних: ${n} кадрів. Потрібно хоча б кілька секунд польоту.`);
  const rawTime = column("time");
  if (!rawTime) throw new LogParseError("У логу немає поля часу (time).");
  const t0 = rawTime[0]!;
  const time = new Float64Array(n);
  for (let r = 0; r < n; r++) time[r] = (rawTime[r]! - t0) * timeScale;

  // Частота запису за медіаною кроку часу: стійко до пропусків кадрів.
  const steps: number[] = [];
  for (let r = 1; r < Math.min(n, 4000); r++) steps.push(time[r]! - time[r - 1]!);
  steps.sort((a, b) => a - b);
  const dt = steps[Math.floor(steps.length / 2)]!;
  if (!(dt > 0)) throw new LogParseError("Не вдалося визначити частоту запису з колонки часу.");
  const sampleRate = 1 / dt;

  const byAxis = (prefix: string): Record<Axis, Float64Array> | null => {
    const cols = [0, 1, 2].map((i) => column(`${prefix}[${i}]`));
    if (cols.some((c) => !c)) return null;
    const out = {} as Record<Axis, Float64Array>;
    AXES.forEach((ax, i) => (out[ax] = cols[i]!));
    return out;
  };

  const gyro = byAxis("gyroADC");
  if (!gyro) throw new LogParseError("Не знайдено всі три осі gyroADC.");

  const throttle = column("rcCommand[3]");
  if (throttle) for (let r = 0; r < n; r++) throttle[r] = Math.min(1, Math.max(0, (throttle[r]! - 1000) / 1000));

  const motors: Float64Array[] = [];
  for (let i = 0; i < 8; i++) {
    const m = column(`motor[${i}]`);
    if (m) motors.push(m);
  }

  return {
    sampleRate,
    duration: time[n - 1]!,
    length: n,
    time,
    gyro,
    gyroUnfilt: byAxis("gyroUnfilt"),
    setpoint: byAxis("setpoint"),
    throttle,
    vbat: column("vbatLatest"),
    motors,
    meta,
  };
}
