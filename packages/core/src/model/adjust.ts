import type { LogAnalysis } from "../blackbox/analyze";
import type { Axis, FilterSettings, Tune } from "./types";
import { clamp, round10, round5 } from "./tuner";

export interface Change {
  group: "PID" | "Фільтри" | "Рейти" | "Динаміка";
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

/** Пороги залишкового шуму після фільтрів (RMS, °/с, 80 Гц і вище). */
export const NOISE_CLEAN = 0.6;
export const NOISE_DIRTY = 2.5;

/**
 * Коригує налаштування за результатами аналізу логу.
 * Змінює PID, фільтри і rate-профіль. Правила консервативні: за один крок значення змінюються не більше ніж на 15%,
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
    if (s.delayMs > 45) findings.push(`${ax}: затримка до 50% відгуку ${s.delayMs.toFixed(0)} мс. Це повільно; перевірте фільтри і feedforward.`);
  }

  const yaw = a.axes.yaw.step;
  if (yaw) {
    if (yaw.peak > 1.2) scalePid("yaw", "p", 0.9, `Перерегулювання по yaw ${yaw.peak.toFixed(2)}`);
    else if (yaw.peak < 0.95) scalePid("yaw", "p", 1.1, `Відгук по yaw ${yaw.peak.toFixed(2)}: недотягує`);
    if (yaw.steady < 0.95) scalePid("yaw", "i", 1.15, `Yaw стабілізується на ${yaw.steady.toFixed(2)}`);
  }

  tuneFilters(tune, a, hfNoise, changes, findings);
  tuneRates(tune, a, changes, findings);
  tuneDynamics(tune, a, changes, findings);

  if (!changes.length) findings.push("Відгук, шум і рейти в межах норми. Змінювати налаштування не потрібно.");
  return { tune, changes, findings };
}

/**
 * Автоналаштування фільтрів за логом:
 * LPF гіроскопа й D-term за залишковим шумом, RPM-фільтр за діапазоном частот моторів і кількістю гармонік,
 * динамічний режекторний фільтр під резонанс рами (або під шум моторів, якщо RPM-фільтра немає).
 */
export function tuneFilters(tune: Tune, a: LogAnalysis, hfNoise: number, changes: Change[], findings: string[]): void {
  const f = tune.filters;
  const e = tune.extras;
  const rpmOn = e.dshot_bidir === "ON";
  const setF = (key: keyof FilterSettings, to: number, reason: string) => {
    const from = f[key];
    if (from === to) return;
    f[key] = to;
    changes.push({ group: "Фільтри", param: key, from, to, reason });
  };
  const setE = (key: "rpm_filter_min_hz" | "rpm_filter_harmonics", to: number, reason: string) => {
    const from = e[key];
    if (from === null || from === to) return;
    e[key] = to;
    changes.push({ group: "Фільтри", param: key, from, to, reason });
  };

  // 1. LPF: плавно, пропорційно до залишкового шуму (ціль ≈ 1.2 °/с), не більше ±15% за ітерацію.
  const k = clamp(Math.sqrt(1.2 / Math.max(hfNoise, 0.05)), 0.85, 1.15);
  const noiseTxt = `залишковий шум ${hfNoise.toFixed(2)} °/с`;
  if (Math.abs(k - 1) >= 0.04) {
    const reason = k > 1 ? `Після фільтрів чисто (${noiseTxt}): менше фільтрації дає меншу затримку` : `Після фільтрів брудно (${noiseTxt}): шум іде в D-term і гріє мотори`;
    setF("gyro_lpf1_dyn_min_hz", round5(clamp(f.gyro_lpf1_dyn_min_hz * k, 60, 600)), reason);
    setF("gyro_lpf1_dyn_max_hz", round5(clamp(f.gyro_lpf1_dyn_max_hz * k, 120, 1000)), reason);
    setF("gyro_lpf2_static_hz", round5(clamp(f.gyro_lpf2_static_hz * k, 120, 1000)), reason);
    setF("dterm_lpf1_dyn_min_hz", round5(clamp(f.dterm_lpf1_dyn_min_hz * k, 30, 200)), reason);
    setF("dterm_lpf1_dyn_max_hz", round5(clamp(f.dterm_lpf1_dyn_max_hz * k, 50, 300)), reason);
    setF("dterm_lpf2_static_hz", round5(clamp(f.dterm_lpf2_static_hz * k, 50, 300)), reason);
  } else {
    findings.push(`Рівень шуму після фільтрів нормальний (${noiseTxt}), LPF не змінюємо.`);
  }

  // 2. Шум моторів.
  if (a.motorHzRange) {
    const { min, max } = a.motorHzRange;
    findings.push(`Шум моторів у польоті від ${min} до ${max} Гц${a.motorHarmonics ? `, помітних гармонік: ${a.motorHarmonics}` : ""}.`);
    if (rpmOn) {
      const target = clamp(round10(min * 0.7), 30, 200);
      if (e.rpm_filter_min_hz !== null && Math.abs(target - e.rpm_filter_min_hz) >= 10) {
        setE("rpm_filter_min_hz", target, `Найнижча частота моторів у польоті ≈ ${min} Гц, RPM-фільтр має працювати трохи нижче`);
      }
      if (a.motorHarmonics !== null) {
        const h = Math.max(2, a.motorHarmonics);
        setE("rpm_filter_harmonics", h, h < 3 ? "Третя гармоніка моторів слабка: менше гармонік дає меншу затримку" : "Помітні три гармоніки моторів");
      }
      if (a.motorNoiseTracksThrottle) findings.push("Якщо пік моторів видно і на графіку після фільтрів, перевірте motor_poles і що bidirectional DShot справді працює.");
    } else {
      setF("dyn_notch_count", 3, "Без RPM-фільтра шум моторів прибирає динамічний режекторний фільтр");
      setF("dyn_notch_min_hz", clamp(round10(min * 0.8), 60, 250), `Нижня межа під шум моторів (${min} Гц)`);
      setF("dyn_notch_max_hz", clamp(round10(max * 1.2), 200, 1000), `Верхня межа під шум моторів (${max} Гц)`);
    }
  }

  // 3. Резонанс рами.
  if (a.frameResonanceHz !== null) {
    const r = a.frameResonanceHz;
    findings.push(`Резонанс рами ≈ ${r} Гц: частота не змінюється з газом. Перевірте затяжку гвинтів, кріплення FC, промені і стан рами.`);
    if (r < 60) {
      findings.push("Резонанс нижче 60 Гц динамічний режекторний фільтр Betaflight не дістає. Його треба прибирати механічно або нижчим gyro LPF.");
    } else {
      if (r * 0.85 < f.dyn_notch_min_hz) setF("dyn_notch_min_hz", clamp(round10(r * 0.85), 60, 250), `Резонанс ${r} Гц нижче межі динамічного режекторного фільтра`);
      if (r * 1.2 > f.dyn_notch_max_hz) setF("dyn_notch_max_hz", clamp(round10(r * 1.3), 200, 1000), `Резонанс ${r} Гц вище межі динамічного режекторного фільтра`);
      if (rpmOn && f.dyn_notch_count < 2) setF("dyn_notch_count", 2, "Окремий режекторний фільтр під резонанс рами");
    }
  }

  // 4. Високочастотні піки поза діапазоном режекторного фільтра.
  const topRaw = Math.max(...(["roll", "pitch"] as const).flatMap((ax) => a.axes[ax].rawPeaks.map((p) => p.hz)), 0);
  if (!rpmOn && topRaw > f.dyn_notch_max_hz && topRaw < (a.sampleRate / 2) * 0.9) {
    setF("dyn_notch_max_hz", clamp(round10(topRaw * 1.1), 200, 1000), `Пік шуму на ${Math.round(topRaw)} Гц вище межі режекторного фільтра`);
  }
}

/** Автоналаштування rate-профілю за логом: газ висіння, використання рейтів, насичення моторів. */
export function tuneRates(tune: Tune, a: LogAnalysis, changes: Change[], findings: string[]): void {
  const r = tune.rates;
  if (a.hoverThrottle !== null) {
    const hover = Math.round(a.hoverThrottle * 100) / 100;
    if (Math.abs(hover - r.thrMid) >= 0.03) {
      changes.push({ group: "Рейти", param: "thr_mid", from: Math.round(r.thrMid * 100), to: Math.round(hover * 100), reason: `Газ висіння за логом ${Math.round(hover * 100)}%: середина кривої газу на висінні робить його плавнішим` });
      r.thrMid = hover;
    }
    if (hover > 0.6) findings.push(`Газ висіння ${Math.round(hover * 100)}%: запасу тяги мало, борт перевантажений для цієї силової установки.`);
  }
  const sat = a.motorSaturation ?? 0;
  if (sat > 0.03) {
    for (const ax of ["roll", "pitch"] as const) {
      const from = r[ax].max;
      const to = clamp(Math.round((from * 0.9) / 10) * 10, 150, 1200);
      if (to !== from) {
        changes.push({ group: "Рейти", param: `${ax}_srate`, from: from / 10, to: to / 10, reason: `Мотори на межі ${(sat * 100).toFixed(1)}% часу: нижчі максимальні рейти залишають запас для стабілізації` });
        r[ax].max = to;
      }
    }
  }
  if (a.setpointP99) {
    const used = Math.max(a.setpointP99.roll / r.roll.max, a.setpointP99.pitch / r.pitch.max);
    if (used > 0.97) findings.push("Ви часто доводите стік до упору: якщо бракує швидкості обертання, підніміть максимальні рейти.");
    else if (used < 0.45) findings.push(`У польоті використано лише ${Math.round(used * 100)}% максимальних рейтів по крену й тангажу. Для плавнішого керування можна знизити max rate або підняти експо.`);
  }
}

/** Пороги для правил динаміки (TPA, anti-gravity, просідання батареї). */
export const TPA_RATIO = 1.6;
export const PUNCH_RATIO = 1.8;
export const SAG_NOTICE = 0.1;

/**
 * Правила, важливі для важких бортів:
 * TPA — коли на високому газі борт коливається помітно сильніше, ніж на середньому;
 * anti-gravity — коли під час різких змін газу борт гірше тримає кут;
 * vbat_sag_compensation — коли батарея помітно просідає під навантаженням.
 */
export function tuneDynamics(tune: Tune, a: LogAnalysis, changes: Change[], findings: string[]): void {
  const e = tune.extras;
  const osc = a.throttleOscillation;
  if (osc && osc.mid > 0 && osc.high / osc.mid > TPA_RATIO && osc.high > 0.8) {
    const ratio = (osc.high / osc.mid).toFixed(1);
    const rate = clamp(e.tpa_rate + 10, 0, 90);
    if (rate !== e.tpa_rate) {
      changes.push({ group: "Динаміка", param: "tpa_rate", from: e.tpa_rate, to: rate, reason: `На високому газі коливання в ${ratio} раза сильніші, ніж на середньому: TPA сильніше прибирає PD на газу` });
      e.tpa_rate = rate;
    }
    if (a.hoverThrottle !== null) {
      // Точка початку TPA трохи вище газу висіння, щоб на висінні PD лишався повним.
      const bp = clamp(round10(1000 + (a.hoverThrottle + 0.08) * 1000), 1200, 1600);
      if (bp !== e.tpa_breakpoint) {
        changes.push({ group: "Динаміка", param: "tpa_breakpoint", from: e.tpa_breakpoint, to: bp, reason: `TPA починає діяти трохи вище газу висіння (${Math.round(a.hoverThrottle * 100)}%)` });
        e.tpa_breakpoint = bp;
      }
    }
  }

  if (a.punchErrorRatio !== null && a.punchErrorRatio > PUNCH_RATIO) {
    const to = clamp(round5(e.anti_gravity_gain * 1.25), 0, 150);
    if (to !== e.anti_gravity_gain) {
      changes.push({ group: "Динаміка", param: "anti_gravity_gain", from: e.anti_gravity_gain, to, reason: `При різкій зміні газу похибка утримання кута в ${a.punchErrorRatio.toFixed(1)} раза більша, ніж у спокої` });
      e.anti_gravity_gain = to;
    }
  }

  if (a.batterySag !== null) {
    const pct = Math.round(a.batterySag * 100);
    if (a.batterySag >= SAG_NOTICE) {
      const to = a.batterySag >= 0.18 ? 100 : 80;
      if (to > e.vbat_sag_compensation) {
        changes.push({ group: "Динаміка", param: "vbat_sag_compensation", from: e.vbat_sag_compensation, to, reason: `На повному газі напруга просідає приблизно на ${pct}%: компенсація зберігає однаковий відгук від повної до розрядженої батареї` });
        e.vbat_sag_compensation = to;
      }
      if (a.batterySag >= 0.2) findings.push(`Просідання батареї ≈${pct}% на повному газі. Для такого борта батарея слабка: перевірте C-рейтинг, стан банок і роз'єм.`);
    }
  }
}
