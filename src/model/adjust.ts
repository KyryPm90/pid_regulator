import type { LogAnalysis } from "../blackbox/analyze";
import type { Axis, FilterSettings, Tune } from "./types";
import { clamp, round10, round5 } from "./tuner";

export interface Change {
  group: "PID" | "Фільтри";
  param: string;
  from: number;
  to: number;
  reason: string;
}

export interface Adjustment {
  tune: Tune;
  changes: Change[];
  /** Висновки без змін параметрів */
  findings: string[];
}

/** Пороги залишкового шуму після фільтрів (RMS, °/с, 100 Гц і вище). */
export const NOISE_CLEAN = 0.6;
export const NOISE_DIRTY = 2.5;

/**
 * Коригує налаштування за результатами аналізу логу.
 * Правила консервативні: за один крок значення змінюються не більше ніж на 15%,
 * щоб пілот міг перевірити ефект наступним польотом.
 */
export function adjustFromLog(base: Tune, a: LogAnalysis): Adjustment {
  const tune: Tune = structuredClone(base);
  const changes: Change[] = [];
  const findings: string[] = [];

  const hfNoise = Math.max(a.axes.roll.filteredHfRms, a.axes.pitch.filteredHfRms);
  const noisy = hfNoise > NOISE_DIRTY;

  const scalePid = (ax: Axis, term: "p" | "i" | "d" | "f", k: number, reason: string) => {
    const pid = tune.pid[ax];
    const from = pid[term];
    const to = Math.round(clamp(from * k, 0, 250));
    if (to === from) return;
    pid[term] = to;
    changes.push({ group: "PID", param: `${term}_${ax}`, from, to, reason });
    if (term === "d" && ax !== "yaw" && from > 0) {
      const dFrom = pid.dMin;
      pid.dMin = Math.round(pid.dMin * (to / from));
      if (pid.dMin !== dFrom) changes.push({ group: "PID", param: `d_min_${ax}`, from: dFrom, to: pid.dMin, reason: "Пропорційно до D" });
    }
  };

  for (const ax of ["roll", "pitch"] as const) {
    const s = a.axes[ax].step;
    if (!s) continue;
    const pk = s.peak.toFixed(2);
    if (s.peak > 1.25) {
      const dk = noisy ? 1.05 : 1.15;
      scalePid(ax, "d", dk, `Перерегулювання ${pk}: більше D гасить відскок після різкого руху`);
      scalePid(ax, "p", 0.95, `Перерегулювання ${pk}: трохи менше P зменшує відскок`);
    } else if (s.peak > 1.12) {
      scalePid(ax, "d", noisy ? 1.03 : 1.08, `Помірне перерегулювання ${pk}`);
    } else if (s.peak < 0.97) {
      scalePid(ax, "p", 1.1, `Відгук ${pk}: борт не дотягує до заданої швидкості обертання`);
      scalePid(ax, "f", 1.1, `Відгук ${pk}: більший FF прискорює реакцію на стік`);
    }
    if (s.ringing >= 2 && s.peak > 1.05) {
      scalePid(ax, "p", 0.92, `Після піку відгук коливається ${s.ringing} рази: P заважкий`);
    }
    if (s.steady < 0.95) scalePid(ax, "i", 1.12, `Відгук стабілізується на ${s.steady.toFixed(2)}: I не дотягує`);
    else if (s.steady > 1.06) scalePid(ax, "i", 0.9, `Відгук стабілізується на ${s.steady.toFixed(2)}: I перетягує`);
    if (s.delayMs > 30) findings.push(`${ax}: затримка до 50% відгуку ${s.delayMs.toFixed(0)} мс. Це повільно; перевірте фільтри і feedforward.`);
  }

  const yaw = a.axes.yaw.step;
  if (yaw) {
    if (yaw.peak > 1.2) scalePid("yaw", "p", 0.9, `Перерегулювання по yaw ${yaw.peak.toFixed(2)}`);
    else if (yaw.peak < 0.95) scalePid("yaw", "p", 1.1, `Відгук по yaw ${yaw.peak.toFixed(2)}: недотягує`);
    if (yaw.steady < 0.95) scalePid("yaw", "i", 1.15, `Yaw стабілізується на ${yaw.steady.toFixed(2)}`);
  }

  // Фільтри
  const f = tune.filters;
  const setF = (key: keyof FilterSettings, to: number, reason: string) => {
    const from = f[key];
    if (from === to) return;
    f[key] = to;
    changes.push({ group: "Фільтри", param: key, from, to, reason });
  };
  const scaleLpf = (k: number, reason: string) => {
    setF("gyro_lpf1_dyn_min_hz", round5(clamp(f.gyro_lpf1_dyn_min_hz * k, 100, 600)), reason);
    setF("gyro_lpf1_dyn_max_hz", round5(clamp(f.gyro_lpf1_dyn_max_hz * k, 200, 1000)), reason);
    setF("gyro_lpf2_static_hz", round5(clamp(f.gyro_lpf2_static_hz * k, 200, 1000)), reason);
    setF("dterm_lpf1_dyn_min_hz", round5(clamp(f.dterm_lpf1_dyn_min_hz * k, 40, 200)), reason);
    setF("dterm_lpf1_dyn_max_hz", round5(clamp(f.dterm_lpf1_dyn_max_hz * k, 80, 300)), reason);
    setF("dterm_lpf2_static_hz", round5(clamp(f.dterm_lpf2_static_hz * k, 80, 300)), reason);
  };
  const noiseTxt = `залишковий шум ${hfNoise.toFixed(2)} °/с`;
  if (hfNoise < NOISE_CLEAN) scaleLpf(1.15, `Після фільтрів чисто (${noiseTxt}): менше фільтрації дає меншу затримку`);
  else if (noisy) scaleLpf(0.85, `Після фільтрів брудно (${noiseTxt}): шум іде в D-term і гріє мотори`);
  else findings.push(`Рівень шуму після фільтрів нормальний (${noiseTxt}), фільтри LPF не змінюємо.`);

  if (a.frameResonanceHz !== null) {
    const r = a.frameResonanceHz;
    findings.push(`Резонанс рами ≈ ${r} Гц: частота не змінюється з газом. Перевірте затяжку гвинтів, кріплення FC і стан рами.`);
    if (r < f.dyn_notch_min_hz) setF("dyn_notch_min_hz", clamp(round10(r * 0.85), 60, 250), `Резонанс ${r} Гц нижче межі динамічного режекторного фільтра`);
    if (f.dyn_notch_count < 2 && r >= 60) setF("dyn_notch_count", 2, "Окремий режекторний фільтр під резонанс рами");
  }
  const topRaw = Math.max(...(["roll", "pitch"] as const).flatMap((ax) => a.axes[ax].rawPeaks.map((p) => p.hz)), 0);
  if (topRaw > f.dyn_notch_max_hz && topRaw < a.sampleRate / 2 * 0.9) {
    setF("dyn_notch_max_hz", clamp(round10(topRaw * 1.1), 350, 1000), `Пік шуму на ${Math.round(topRaw)} Гц вище межі режекторного фільтра`);
  }
  if (a.motorNoiseTracksThrottle === true) findings.push("Головний пік шуму росте з газом, тобто це шум моторів. Якщо RPM-фільтр увімкнено, а пік видно і після фільтрів, перевірте motor_poles.");

  if (!changes.length) findings.push("Відгук і шум у межах норми. Змінювати налаштування не потрібно.");
  return { tune, changes, findings };
}
