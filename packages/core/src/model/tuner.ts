import type { Axis, AxisPid, BuildParams, ExtraSettings, FilterSettings, FlyingStyle, TuneResult } from "./types";
import { AXES } from "./types";
import { computeRates } from "./rates";

/** Дефолтні PID Betaflight 4.4–4.5 (профіль за замовчуванням). */
export const BF_DEFAULTS: Record<Axis, AxisPid> = {
  roll: { p: 45, i: 80, d: 40, dMin: 30, f: 120 },
  pitch: { p: 47, i: 84, d: 46, dMin: 34, f: 125 },
  yaw: { p: 45, i: 80, d: 0, dMin: 0, f: 120 },
};

interface StyleProfile {
  name: string;
  p: number;
  i: number;
  ff: number;
  relax: number;
  smooth: number;
  jitter: number;
  boost: number;
  antiGravity: number;
}

export const STYLES: Record<FlyingStyle, StyleProfile> = {
  freestyle: { name: "агресивний", p: 1, i: 1, ff: 1, relax: 15, smooth: 25, jitter: 7, boost: 15, antiGravity: 80 },
  race: { name: "швидкий", p: 1.05, i: 1.05, ff: 1.3, relax: 30, smooth: 15, jitter: 5, boost: 20, antiGravity: 100 },
  cinematic: { name: "плавний", p: 0.95, i: 1.05, ff: 0.55, relax: 10, smooth: 50, jitter: 12, boost: 5, antiGravity: 90 },
  longrange: { name: "лонг-рейндж", p: 0.95, i: 1.1, ff: 0.75, relax: 10, smooth: 40, jitter: 10, boost: 10, antiGravity: 100 },
};

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const round5 = (v: number): number => Math.round(v / 5) * 5;
export const round10 = (v: number): number => Math.round(v / 10) * 10;

/** Кусково-лінійна інтерполяція по таблиці [x, y], відсортованій за x. */
export function interp(table: ReadonlyArray<readonly [number, number]>, x: number): number {
  const first = table[0]!;
  if (x <= first[0]) return first[1];
  for (let k = 1; k < table.length; k++) {
    const [x1, y1] = table[k]!;
    if (x <= x1) {
      const [x0, y0] = table[k - 1]!;
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1]![1];
}

/** Об'єм статора (ширина² × висота, мм³ умовно) з рядка на кшталт "2207". */
export function statorVolume(stator: string): number | null {
  const digits = String(stator).replace(/\D/g, "");
  if (digits.length < 3) return null;
  const w = Number(digits.slice(0, 2));
  const h = Number(digits.slice(2));
  if (!w || !h) return null;
  return w * w * h;
}

/** Мінімальний і максимальний діаметр пропа, який підтримує модель, дюйми. */
export const PROP_MIN = 7;
export const PROP_MAX = 24;

/** Типовий KV × S для пропа (8" ≈ 1000KV × 6S, 15" ≈ 400KV × 12S, 21" ≈ 170KV × 12S). */
export const typicalKvCells = (prop: number): number =>
  interp([[5, 11700], [7, 7800], [8, 6000], [10, 5400], [13, 5200], [15, 4800], [18, 3400], [21, 2100], [24, 1700]], prop);
/** Типова злітна вага для пропа, г. */
export const typicalWeight = (prop: number, ducted: boolean): number =>
  interp([[5, 650], [7, 1050], [8, 1600], [10, 2600], [13, 5000], [15, 7000], [18, 11000], [21, 16000], [24, 22000]], prop) * (ducted ? 1.35 : 1);
/** Типовий об'єм статора (ширина² × висота) для пропа: 2810 на 8", 3115 на 10", 4214 на 13", 6215 на 21". */
export const typicalStatorVolume = (prop: number): number =>
  interp([[5, 3388], [7, 4700], [8, 8000], [10, 14000], [13, 24000], [15, 27000], [18, 40000], [21, 58000], [24, 75000]], prop);

/** Основна частота обертання мотора на повному газі під навантаженням, Гц. */
export const motorHzAtFullThrottle = (kv: number, cells: number): number => (kv * cells * 4.2 * 0.78) / 60;

export function computeTune(x: BuildParams): TuneResult {
  const d = clamp(x.prop, PROP_MIN, PROP_MAX);
  const st = STYLES[x.style];
  const ducted = x.frame === "ducted";
  const why: string[] = [];
  const warnings: string[] = [];
  if (x.prop !== d) warnings.push(`Проп ${x.prop}" поза підтримуваним діапазоном ${PROP_MIN}–${PROP_MAX}": розрахунок зроблено для ${d}", перевіряйте значення особливо обережно.`);

  const sizeMul = interp([[5, 1], [7, 0.86], [8, 0.81], [10, 0.74], [13, 0.66], [15, 0.62], [18, 0.58], [21, 0.55], [24, 0.52]], d);
  const powerRatio = (x.kv * x.cells) / typicalKvCells(d);
  const weightRatio = x.auw / typicalWeight(d, ducted);
  const vol = statorVolume(x.stator);
  const torqueRatio = vol ? vol / typicalStatorVolume(d) : 1;
  const authority =
    (Math.pow(powerRatio, 0.7) * Math.pow(clamp(torqueRatio, 0.4, 2.5), 0.3)) / Math.pow(clamp(weightRatio, 0.3, 3), 0.8);
  const master = sizeMul * clamp(Math.pow(authority, -0.3), 0.8, 1.25);

  const pitchRatio = x.pitch / d;
  const loadP = clamp(1 - (pitchRatio - 0.8) * 0.12, 0.94, 1.04);
  const bladeP = x.blades === 2 ? 1.04 : x.blades === 4 ? 0.97 : 1;
  const bladeD = x.blades === 2 ? 0.96 : x.blades === 4 ? 1.05 : 1;
  const dRatio = interp([[5, 1], [7, 1.1], [10, 1.15], [13, 1.18], [15, 1.2], [21, 1.25]], d);
  const ductD = ducted ? 1.12 : 1;
  const ductP = ducted ? 1.05 : 1;

  const pMul = master * st.p * bladeP * ductP * loadP;
  const iMul = master * st.i * clamp(Math.pow(weightRatio, 0.15), 0.9, 1.15);
  const dMul = master * dRatio * bladeD * ductD * clamp(Math.pow(weightRatio, 0.1), 0.93, 1.1);
  const ffMul = st.ff * clamp(Math.pow(sizeMul, 0.5), 0.85, 1.15);

  const pid = {} as Record<Axis, AxisPid>;
  for (const ax of AXES) {
    const b = BF_DEFAULTS[ax];
    const D = Math.round(clamp(b.d * dMul, 0, 250));
    pid[ax] = {
      p: Math.round(clamp(b.p * pMul * (ax === "yaw" ? interp([[7, 0.92], [13, 0.88], [21, 0.85]], d) : 1), 5, 250)),
      i: Math.round(clamp(b.i * iMul, 5, 250)),
      d: D,
      dMin: ax === "yaw" ? 0 : Math.round(D * (b.dMin / b.d)),
      f: Math.round(clamp(b.f * ffMul, 0, 500)),
    };
  }

  const motorHzMax = motorHzAtFullThrottle(x.kv, x.cells);
  const motorHzHover = motorHzMax * 0.42;
  const filt = clamp(interp([[5, 1], [7, 0.85], [10, 0.7], [13, 0.6], [15, 0.55], [21, 0.45], [24, 0.42]], d) * (x.rpmFilter ? 1.1 : 0.9), 0.35, 1.4);

  const filters: FilterSettings = {
    gyro_lpf1_dyn_min_hz: round5(250 * filt),
    gyro_lpf1_dyn_max_hz: round5(500 * filt),
    gyro_lpf2_static_hz: round5(500 * filt),
    dterm_lpf1_dyn_min_hz: round5(75 * filt),
    dterm_lpf1_dyn_max_hz: round5(150 * filt),
    dterm_lpf2_static_hz: round5(150 * filt),
    dyn_notch_count: x.rpmFilter ? 1 : 3,
    dyn_notch_q: x.rpmFilter ? 500 : 300,
    dyn_notch_min_hz: clamp(round10(motorHzHover * 0.55), 60, 250),
    dyn_notch_max_hz: clamp(round10(motorHzMax * 1.05), 200, 1000),
  };

  const extras: ExtraSettings = {
    dshot_bidir: x.rpmFilter ? "ON" : "OFF",
    motor_poles: x.motorPoles,
    rpm_filter_harmonics: x.rpmFilter ? 3 : null,
    rpm_filter_min_hz: x.rpmFilter ? clamp(round10(motorHzMax * 0.16), 30, 200) : null,
    dyn_idle_min_rpm: x.rpmFilter ? clamp(Math.round(30 * (5 / d)), 6, 40) : 0,
    tpa_rate: clamp(Math.round(65 + (powerRatio - 1) * 40), 50, 80),
    tpa_breakpoint: powerRatio > 1.15 ? 1250 : powerRatio < 0.9 ? 1450 : 1350,
    thrust_linear: ducted ? 25 : 0,
    anti_gravity_gain: st.antiGravity,
    iterm_relax_cutoff: st.relax,
    feedforward_smooth_factor: st.smooth,
    feedforward_jitter_factor: st.jitter,
    feedforward_boost: st.boost,
  };

  const pct = (v: number) => Math.round(v * 100);
  why.push(`Розмір ${d}" дає базовий множник ${sizeMul.toFixed(2)}: менші пропи мають меншу інерцію і потребують вищих коефіцієнтів, великі навпаки.`);
  why.push(
    `Потужність ${x.kv}KV × ${x.cells}S = ${Math.round(x.kv * x.cells)}, це ${pct(powerRatio)}% від типового для ${d}". ` +
      (powerRatio > 1.05 ? "Запас потужності знижує потрібні P і D." : powerRatio < 0.95 ? "Слабша силова установка потребує трохи вищих коефіцієнтів." : "Потужність типова."),
  );
  why.push(
    `Вага ${x.auw} г, це ${pct(weightRatio)}% від типової. ` +
      (weightRatio > 1.1 ? "Важчий борт отримує більше I та D для утримання положення." : weightRatio < 0.9 ? "Легкий борт швидко реагує, I трохи знижено." : "Вага типова."),
  );
  if (vol) {
    why.push(
      `Статор ${x.stator}: об'єм ${pct(torqueRatio)}% від типового для такого пропа, ` +
        (torqueRatio > 1.1 ? "більший крутний момент дає запас керованості." : torqueRatio < 0.9 ? "момент менший, мотору важче розкручувати проп." : "момент відповідає пропу."),
    );
  }
  why.push(`На пропах ${d}" D відносно P вищий (×${dRatio.toFixed(2)}): велика інерція пропа потребує сильнішого гасіння, а yaw P знижено, бо yaw на великих бортах керується повільно.`);
  if (ducted) why.push("Дакти додають опору й турбулентності, тому D +12%, P +5% і thrust_linear = 25.");
  if (x.blades === 2) why.push("Двохлопатеві пропи мають менше зчеплення з повітрям: P +4%, D −4%.");
  if (x.blades === 4) why.push("Чотирилопатеві пропи мають більше зчеплення: P −3%, D +5%.");
  why.push(`Стиль «${st.name}»: FF ×${st.ff}, iterm_relax_cutoff ${st.relax}, згладжування FF ${st.smooth}.`);
  why.push(
    `Основна частота моторів на повному газі ≈ ${Math.round(motorHzMax)} Гц, на висінні ≈ ${Math.round(motorHzHover)} Гц. ` +
      `За нею виставлено межі динамічного режекторного фільтра${x.rpmFilter ? " і мінімальну частоту RPM-фільтра" : ""}.`,
  );
  if (x.rpmFilter) why.push("RPM-фільтр прибирає основний шум моторів, тому низькочастотні фільтри зсунуто вгору (менша затримка, кращий відгук).");

  if (powerRatio > 1.35) warnings.push(`Дуже висока потужність для ${d}" (${pct(powerRatio)}%). Перевірте нагрів моторів і подумайте про motor_output_limit 85–90.`);
  if (powerRatio < 0.7) warnings.push("Силова установка слабка для такого пропа: борт буде млявий, а висіння на високому газі нагріває мотори.");
  if (weightRatio > 1.4) warnings.push("Борт значно важчий за типовий для цього розміру. Почніть з обережного висіння й перевірте нагрів.");
  if (weightRatio < 0.6) warnings.push("Вага дуже мала для такого пропа. Перевірте, чи введено злітну вагу з акумулятором.");
  if (!x.rpmFilter) warnings.push("На великих бортах дуже радимо bidirectional DShot з RPM-фільтром: шум моторів низькочастотний, і без RPM-фільтра його важко прибрати без великої затримки.");
  if (x.motorPoles < 10 || x.motorPoles > 28) warnings.push("Нетипова кількість полюсів. Порахуйте магніти на дзвоні мотора: це і є кількість полюсів.");
  if (d >= 13) warnings.push(`Для ${d}" евристика менш точна. Перший зліт робіть на прив'язі або на малій висоті, далі тюн по Blackbox.`);
  if (motorHzHover < 60) warnings.push(`Шум моторів на висінні ≈ ${Math.round(motorHzHover)} Гц, нижче межі динамічного режекторного фільтра Betaflight (60 Гц). Покладайтеся на RPM-фільтр.`);
  if (x.cells >= 12) warnings.push("Перевірте, що FC, ESC і BEC розраховані на напругу 12S.");

  const { rates, why: rateWhy } = computeRates(x, powerRatio, weightRatio);
  return { pid, filters, extras, rates, why, rateWhy, warnings, metrics: { master, powerRatio, weightRatio, motorHzMax, motorHzHover } };
}
