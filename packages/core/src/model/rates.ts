import type { AxisRate, BuildParams, FlyingStyle, RateSettings } from "./types";
import { clamp, interp } from "./tuner";

/** Максимальна швидкість обертання для roll/pitch за розміром пропа, °/с (стиль «лонг-рейндж»). */
const MAX_RATE_BY_SIZE: ReadonlyArray<readonly [number, number]> = [[5, 700], [7, 600], [8, 560], [10, 500], [13, 400], [15, 350], [18, 300], [21, 250], [24, 220]];

const STYLE_RATES: Record<FlyingStyle, { max: number; centerFrac: number; expo: number; thrExpo: number }> = {
  race: { max: 1.2, centerFrac: 0.3, expo: 0.2, thrExpo: 0 },
  freestyle: { max: 1.1, centerFrac: 0.25, expo: 0.35, thrExpo: 0.2 },
  longrange: { max: 0.9, centerFrac: 0.22, expo: 0.45, thrExpo: 0.25 },
  cinematic: { max: 0.7, centerFrac: 0.2, expo: 0.55, thrExpo: 0.35 },
  payload: { max: 0.65, centerFrac: 0.2, expo: 0.5, thrExpo: 0.4 },
};

const round10 = (v: number) => Math.round(v / 10) * 10;

/** Оцінка газу висіння (0..1) за потужністю й вагою відносно типових. */
export function estimateHoverThrottle(powerRatio: number, weightRatio: number): number {
  return clamp(0.38 * Math.sqrt(weightRatio) / powerRatio, 0.2, 0.7);
}

/**
 * Стартовий rate-профіль (Betaflight Actual rates) за розміром, стилем і потужністю.
 * Великі пропи мають велику інерцію, тому максимальна швидкість обертання нижча, а експо вище.
 */
export function computeRates(x: BuildParams, powerRatio: number, weightRatio: number): { rates: RateSettings; why: string[] } {
  const st = STYLE_RATES[x.style];
  const base = interp(MAX_RATE_BY_SIZE, x.prop);
  // Слабша силова установка не витягне високі рейти: мотори впираються в межу.
  const authority = clamp(Math.pow(powerRatio / Math.max(weightRatio, 0.3), 0.3), 0.8, 1.15);
  const maxRp = clamp(round10(base * st.max * authority), 150, 1200);
  const rp: AxisRate = { center: clamp(round10(maxRp * st.centerFrac), 30, 250), max: maxRp, expo: st.expo };
  const yawMax = clamp(round10(maxRp * 0.75), 120, 1000);
  const yaw: AxisRate = { center: clamp(round10(yawMax * st.centerFrac * 0.9), 30, 200), max: yawMax, expo: Math.min(0.7, st.expo + 0.05) };
  const hover = estimateHoverThrottle(powerRatio, weightRatio);
  const throttleLimit = powerRatio > 1.3 ? clamp(Math.round((100 * 1.2) / powerRatio), 70, 100) : 100;
  const rates: RateSettings = {
    roll: { ...rp },
    pitch: { ...rp },
    yaw,
    thrMid: Math.round(hover * 100) / 100,
    thrExpo: st.thrExpo,
    throttleLimit,
  };
  const why = [
    `Максимальна швидкість ${maxRp} °/с по крену й тангажу: для ${x.prop}" типово ${round10(base)} °/с, стиль множить на ${st.max}, запас потужності на ${authority.toFixed(2)}.`,
    `Чутливість у центрі ${rp.center} °/с і експо ${rp.expo} дають точне керування малими рухами стіка.`,
    `Газ висіння оцінено в ${Math.round(hover * 100)}%, тому thr_mid = ${rates.thrMid}${st.thrExpo ? ` і thr_expo = ${st.thrExpo} для плавнішого газу біля висіння` : ""}.`,
  ];
  if (throttleLimit < 100) why.push(`Потужність ${Math.round(powerRatio * 100)}% від типової, тому газ обмежено до ${throttleLimit}% для плавнішого керування.`);
  return { rates, why };
}

/** Крива Betaflight Actual rates: швидкість обертання (°/с) для відхилення стіка x ∈ [-1, 1]. */
export function actualRate(r: AxisRate, x: number): number {
  const a = Math.min(1, Math.abs(x));
  const curve = a * a * a * r.expo + a * (1 - r.expo);
  const stickMovement = Math.max(0, r.max - r.center);
  return Math.sign(x) * (a * r.center + stickMovement * curve);
}
