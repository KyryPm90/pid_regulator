import type { BuildParams, Tune } from "./types";
import { AXES } from "./types";
import { STYLES } from "./tuner";

/**
 * Формує CLI-скрипт для Betaflight 4.4–4.5.
 * Глобальні змінні (мотори, фільтри гіроскопа) йдуть до `profile N`,
 * змінні PID-профілю (PID, D-term фільтри, FF, TPA) після, rate-профіль окремо в кінці.
 */
export function buildCli(x: BuildParams, t: Tune, note?: string): string {
  const L: string[] = [];
  const set = (k: string, v: string | number) => L.push(`set ${k} = ${v}`);
  L.push("# FPV PID Тюнер");
  L.push(
    `# Борт: ${x.prop}" ${x.blades === 4 ? "4+" : x.blades}-лоп., ${x.frame === "ducted" ? "дакти, " : ""}` +
      `${x.stator} ${x.kv}KV, ${x.cells}S, ${x.auw} г, ${STYLES[x.style].name}`,
  );
  if (note) L.push(`# ${note}`);
  L.push("# Betaflight 4.4–4.5. Спершу зробіть diff all як резервну копію.");
  L.push("");
  L.push("# мотори і RPM-фільтр");
  set("dshot_bidir", t.extras.dshot_bidir);
  set("motor_poles", t.extras.motor_poles);
  if (t.extras.rpm_filter_harmonics !== null) set("rpm_filter_harmonics", t.extras.rpm_filter_harmonics);
  if (t.extras.rpm_filter_min_hz !== null) set("rpm_filter_min_hz", t.extras.rpm_filter_min_hz);
  L.push("");
  L.push("# фільтри гіроскопа");
  set("simplified_gyro_filter", "OFF");
  const f = t.filters;
  set("gyro_lpf1_dyn_min_hz", f.gyro_lpf1_dyn_min_hz);
  set("gyro_lpf1_dyn_max_hz", f.gyro_lpf1_dyn_max_hz);
  set("gyro_lpf2_static_hz", f.gyro_lpf2_static_hz);
  set("dyn_notch_count", f.dyn_notch_count);
  set("dyn_notch_q", f.dyn_notch_q);
  set("dyn_notch_min_hz", f.dyn_notch_min_hz);
  set("dyn_notch_max_hz", f.dyn_notch_max_hz);
  L.push("");
  L.push(`# PID профіль ${x.profile + 1}`);
  L.push(`profile ${x.profile}`);
  set("simplified_pids_mode", "OFF");
  set("simplified_dterm_filter", "OFF");
  set("dterm_lpf1_dyn_min_hz", f.dterm_lpf1_dyn_min_hz);
  set("dterm_lpf1_dyn_max_hz", f.dterm_lpf1_dyn_max_hz);
  set("dterm_lpf2_static_hz", f.dterm_lpf2_static_hz);
  for (const ax of AXES) {
    const p = t.pid[ax];
    set(`p_${ax}`, p.p);
    set(`i_${ax}`, p.i);
    set(`d_${ax}`, p.d);
    set(`f_${ax}`, p.f);
  }
  set("d_min_roll", t.pid.roll.dMin);
  set("d_min_pitch", t.pid.pitch.dMin);
  const e = t.extras;
  set("anti_gravity_gain", e.anti_gravity_gain);
  set("iterm_relax_cutoff", e.iterm_relax_cutoff);
  set("feedforward_smooth_factor", e.feedforward_smooth_factor);
  set("feedforward_jitter_factor", e.feedforward_jitter_factor);
  set("feedforward_boost", e.feedforward_boost);
  set("tpa_rate", e.tpa_rate);
  set("tpa_breakpoint", e.tpa_breakpoint);
  set("thrust_linear", e.thrust_linear);
  set("dyn_idle_min_rpm", e.dyn_idle_min_rpm);
  L.push("");
  L.push(`# rate-профіль ${x.rateProfile + 1} (Actual rates)`);
  L.push(`rateprofile ${x.rateProfile}`);
  const r = t.rates;
  set("rates_type", "ACTUAL");
  for (const ax of AXES) {
    set(`${ax}_rc_rate`, Math.round(r[ax].center / 10));
    set(`${ax}_srate`, Math.round(r[ax].max / 10));
    set(`${ax}_expo`, Math.round(r[ax].expo * 100));
  }
  set("thr_mid", Math.round(r.thrMid * 100));
  set("thr_expo", Math.round(r.thrExpo * 100));
  set("throttle_limit_type", r.throttleLimit < 100 ? "SCALE" : "OFF");
  set("throttle_limit_percent", r.throttleLimit);
  L.push("");
  L.push("save");
  return L.join("\n");
}
