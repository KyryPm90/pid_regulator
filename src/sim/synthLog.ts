/**
 * Генератор синтетичного Blackbox-логу у форматі CSV.
 * Модель: замкнений контур кожної осі як ланка другого порядку із затримкою,
 * плюс шум моторів (частота залежить від газу), резонанс рами і білий шум.
 * Використовується для демо в інтерфейсі і в тестах.
 */
export interface SynthOptions {
  fs?: number;
  seconds?: number;
  seed?: number;
  /** Демпфування осей roll/pitch/yaw (менше = більше перерегулювання) */
  zeta?: [number, number, number];
  /** Власна частота замкненого контуру, рад/с */
  wn?: number;
  /** Чиста затримка, мс */
  delayMs?: number;
  /** Частота резонансу рами, Гц (0 = без резонансу) */
  frameHz?: number;
  /** Амплітуда шуму моторів, °/с */
  motorNoise?: number;
  /** Основна частота моторів на нульовому газі і її приріст до повного газу, Гц */
  motorHzIdle?: number;
  motorHzSpan?: number;
  /** Частота PT2-фільтра гіроскопа, Гц */
  gyroLpfHz?: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function synthLogCsv(o: SynthOptions = {}): string {
  const fs = o.fs ?? 2000;
  const seconds = o.seconds ?? 30;
  const rnd = mulberry32(o.seed ?? 7);
  const zeta = o.zeta ?? [0.42, 0.5, 0.8];
  const wn = o.wn ?? 95;
  const delay = Math.round(((o.delayMs ?? 4) / 1000) * fs);
  const frameHz = o.frameHz ?? 165;
  const motorAmp = o.motorNoise ?? 12;
  const n = Math.round(fs * seconds);
  const dt = 1 / fs;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

  // Газ: плавне випадкове блукання 0.25..0.85
  const throttle = new Float64Array(n);
  let thTarget = 0.45, th = 0.45;
  for (let i = 0; i < n; i++) {
    if (i % Math.round(fs * 1.5) === 0) thTarget = 0.25 + rnd() * 0.6;
    th += (thTarget - th) * (dt / 0.3);
    throttle[i] = th;
  }

  const ampMax = [550, 550, 250];
  const sp: Float64Array[] = [];
  const gyroClean: Float64Array[] = [];
  for (let ax = 0; ax < 3; ax++) {
    const s = new Float64Array(n);
    let target = 0, cur = 0, next = 0;
    for (let i = 0; i < n; i++) {
      if (i >= next) {
        // Чергуємо різкі маневри і спокійні ділянки
        target = rnd() < 0.35 ? 0 : (rnd() * 2 - 1) * ampMax[ax]!;
        next = i + Math.round(fs * (0.15 + rnd() * 0.6));
      }
      cur += (target - cur) * (dt / 0.015);
      s[i] = cur;
    }
    sp.push(s);
    // Замкнений контур: y'' = wn²(u(t−τ) − y) − 2ζwn·y'
    const y = new Float64Array(n);
    let pos = 0, vel = 0;
    const sub = 4;
    const h = dt / sub;
    for (let i = 0; i < n; i++) {
      const u = i >= delay ? s[i - delay]! : 0;
      for (let k = 0; k < sub; k++) {
        const acc = wn * wn * (u - pos) - 2 * zeta[ax]! * wn * vel;
        vel += acc * h;
        pos += vel * h;
      }
      y[i] = pos;
    }
    gyroClean.push(y);
  }

  // Шуми
  const unfilt: Float64Array[] = [];
  const filtered: Float64Array[] = [];
  const axisNoiseGain = [1, 0.9, 0.5];
  let phase = 0;
  const motorPhase = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const fMotor = (o.motorHzIdle ?? 110) + (o.motorHzSpan ?? 480) * throttle[i]!;
    phase += 2 * Math.PI * fMotor * dt;
    motorPhase[i] = phase;
  }
  const alpha = 1 - Math.exp(-2 * Math.PI * (o.gyroLpfHz ?? 110) * dt);
  for (let ax = 0; ax < 3; ax++) {
    const u = new Float64Array(n);
    const f = new Float64Array(n);
    let s1 = 0, s2 = 0;
    const ph0 = rnd() * 6.28;
    for (let i = 0; i < n; i++) {
      const g = axisNoiseGain[ax]!;
      const motor = motorAmp * g * (0.5 + throttle[i]!) * (Math.sin(motorPhase[i]! + ph0) + 0.4 * Math.sin(2 * motorPhase[i]! + ph0));
      const frame = frameHz > 0 && ax < 2 ? 4 * Math.sin(2 * Math.PI * frameHz * i * dt + ph0) * (0.6 + 0.4 * Math.sin(i * dt * 0.7)) : 0;
      const white = 1.5 * gauss();
      const raw = gyroClean[ax]![i]! + motor + frame + white;
      u[i] = raw;
      // Імітуємо RPM-фільтр (послаблює шум моторів) + PT2 фільтр
      const pre = gyroClean[ax]![i]! + 0.25 * motor + frame + white;
      s1 += (pre - s1) * alpha;
      s2 += (s1 - s2) * alpha;
      f[i] = s2;
    }
    unfilt.push(u);
    filtered.push(f);
  }

  const out: string[] = [];
  out.push('"Product","Blackbox flight data recorder by Nicholas Sherlock"');
  out.push('"Firmware revision","Synthetic FPV PID Tuner demo"');
  out.push(
    "loopIteration,time (us),rcCommand[3],setpoint[0],setpoint[1],setpoint[2],gyroADC[0],gyroADC[1],gyroADC[2],gyroUnfilt[0],gyroUnfilt[1],gyroUnfilt[2],motor[0],motor[1],motor[2],motor[3]",
  );
  const f1 = (v: number) => v.toFixed(1);
  for (let i = 0; i < n; i++) {
    const thr = throttle[i]!;
    const base = 160 + thr * 1800;
    const r = filtered[0]![i]! * 0.3, p = filtered[1]![i]! * 0.3, yw = filtered[2]![i]! * 0.2;
    const m = [base - r + p - yw, base - r - p + yw, base + r + p + yw, base + r - p - yw].map((v) => Math.round(Math.min(2047, Math.max(48, v))));
    out.push(
      [
        i,
        Math.round(i * dt * 1e6),
        Math.round(1000 + thr * 1000),
        f1(sp[0]![i]!), f1(sp[1]![i]!), f1(sp[2]![i]!),
        f1(filtered[0]![i]!), f1(filtered[1]![i]!), f1(filtered[2]![i]!),
        f1(unfilt[0]![i]!), f1(unfilt[1]![i]!), f1(unfilt[2]![i]!),
        ...m,
      ].join(","),
    );
  }
  return out.join("\n");
}
