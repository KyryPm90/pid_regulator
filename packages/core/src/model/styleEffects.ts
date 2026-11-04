import { computeTune } from "./tuner";
import type { BuildParams } from "./types";

export interface StyleEffect {
  label: string;
  /** Значення в базовому стилі («агресивний») */
  base: number;
  value: number;
  unit: string;
}

/** Базовий стиль, від якого рахуються відмінності. */
export const BASE_STYLE = "freestyle" as const;

/**
 * Що саме змінює вибраний стиль порівняно з базовим («агресивний») для цього борта.
 * Порівнює повні тюни, тож враховує і PID, і рейти, і додаткові параметри.
 */
export function styleEffects(x: BuildParams): StyleEffect[] {
  if (x.style === BASE_STYLE) return [];
  const t = computeTune(x);
  const b = computeTune({ ...x, style: BASE_STYLE });
  const rows: StyleEffect[] = [
    { label: "P (крен)", base: b.pid.roll.p, value: t.pid.roll.p, unit: "" },
    { label: "I (крен)", base: b.pid.roll.i, value: t.pid.roll.i, unit: "" },
    { label: "Feedforward (крен)", base: b.pid.roll.f, value: t.pid.roll.f, unit: "" },
    { label: "Макс. швидкість обертання", base: b.rates.roll.max, value: t.rates.roll.max, unit: "°/с" },
    { label: "Експо стіків", base: b.rates.roll.expo, value: t.rates.roll.expo, unit: "" },
    { label: "Експо газу", base: b.rates.thrExpo, value: t.rates.thrExpo, unit: "" },
    { label: "Anti-gravity", base: b.extras.anti_gravity_gain, value: t.extras.anti_gravity_gain, unit: "" },
    { label: "Згладжування FF", base: b.extras.feedforward_smooth_factor, value: t.extras.feedforward_smooth_factor, unit: "" },
    { label: "I-term relax", base: b.extras.iterm_relax_cutoff, value: t.extras.iterm_relax_cutoff, unit: "" },
  ];
  return rows.filter((r) => r.base !== r.value);
}
