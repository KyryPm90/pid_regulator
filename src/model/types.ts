export type Axis = "roll" | "pitch" | "yaw";
export const AXES: readonly Axis[] = ["roll", "pitch", "yaw"] as const;

export type FlyingStyle = "freestyle" | "race" | "cinematic" | "longrange";
export type FrameType = "open" | "ducted";

/** Параметри борта, які вводить користувач. */
export interface BuildParams {
  /** Діаметр пропелера, дюйми */
  prop: number;
  /** Крок пропелера, дюйми */
  pitch: number;
  /** Кількість лопатей (4 означає 4 і більше) */
  blades: 2 | 3 | 4;
  frame: FrameType;
  /** Статор у форматі ШШВВ, напр. "2207" */
  stator: string;
  kv: number;
  cells: number;
  /** Злітна вага з акумулятором, г */
  auw: number;
  style: FlyingStyle;
  motorPoles: number;
  /** Індекс PID-профілю Betaflight, 0..3 */
  profile: number;
  /** Bidirectional DShot + RPM-фільтр */
  rpmFilter: boolean;
}

export interface AxisPid {
  p: number;
  i: number;
  d: number;
  dMin: number;
  f: number;
}

export type PidSet = Record<Axis, AxisPid>;

export interface FilterSettings {
  gyro_lpf1_dyn_min_hz: number;
  gyro_lpf1_dyn_max_hz: number;
  gyro_lpf2_static_hz: number;
  dterm_lpf1_dyn_min_hz: number;
  dterm_lpf1_dyn_max_hz: number;
  dterm_lpf2_static_hz: number;
  dyn_notch_count: number;
  dyn_notch_q: number;
  dyn_notch_min_hz: number;
  dyn_notch_max_hz: number;
}

export interface ExtraSettings {
  dshot_bidir: "ON" | "OFF";
  motor_poles: number;
  rpm_filter_harmonics: number | null;
  rpm_filter_min_hz: number | null;
  dyn_idle_min_rpm: number;
  tpa_rate: number;
  tpa_breakpoint: number;
  thrust_linear: number;
  anti_gravity_gain: number;
  iterm_relax_cutoff: number;
  feedforward_smooth_factor: number;
  feedforward_jitter_factor: number;
  feedforward_boost: number;
}

export interface Tune {
  pid: PidSet;
  filters: FilterSettings;
  extras: ExtraSettings;
}

export interface TuneResult extends Tune {
  /** Пояснення, чому вибрано такі значення */
  why: string[];
  /** Попередження для пілота */
  warnings: string[];
  metrics: {
    master: number;
    /** Потужність відносно типової для розміру (1 = типова) */
    powerRatio: number;
    /** Вага відносно типової для розміру (1 = типова) */
    weightRatio: number;
    /** Основна частота моторів на повному газі, Гц */
    motorHzMax: number;
    /** Орієнтовна основна частота моторів на висінні, Гц */
    motorHzHover: number;
  };
}
