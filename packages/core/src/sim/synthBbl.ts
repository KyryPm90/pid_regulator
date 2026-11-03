/**
 * Кодувальник бінарного логу Blackbox для тестів: з синтетичного польоту робить .bbl
 * у форматі Betaflight (I/P-кадри з тими ж предикторами й кодуваннями, що й прошивка).
 */
import { Enc, Pred } from "../blackbox/bbl";
import { synthLogCsv, type SynthOptions } from "./synthLog";

class Writer {
  bytes: number[] = [];
  byte(b: number) {
    this.bytes.push(b & 0xff);
  }
  text(s: string) {
    for (let i = 0; i < s.length; i++) this.bytes.push(s.charCodeAt(i) & 0xff);
  }
  uvb(u: number) {
    u >>>= 0;
    while (u >= 0x80) {
      this.byte((u & 0x7f) | 0x80);
      u >>>= 7;
    }
    this.byte(u);
  }
  svb(v: number) {
    this.uvb(((v << 1) ^ (v >> 31)) >>> 0);
  }
}

const fits = (v: number, bits: number) => v >= -(2 ** (bits - 1)) && v < 2 ** (bits - 1);

function sized3(w: Writer, vals: number[]) {
  const sizes = vals.map((v) => (fits(v, 8) ? 0 : fits(v, 16) ? 1 : fits(v, 24) ? 2 : 3));
  w.byte(0xc0 | sizes[0]! | (sizes[1]! << 2) | (sizes[2]! << 4));
  vals.forEach((v, i) => {
    for (let k = 0; k <= sizes[i]!; k++) w.byte((v >> (8 * k)) & 0xff);
  });
}

function tag2_3s32(w: Writer, [a, b, c]: number[]) {
  const all = (bits: number) => [a!, b!, c!].every((v) => fits(v, bits));
  if (all(2)) w.byte(((a! & 3) << 4) | ((b! & 3) << 2) | (c! & 3));
  else if (all(4)) {
    w.byte(0x40 | (a! & 0xf));
    w.byte(((b! & 0xf) << 4) | (c! & 0xf));
  } else if (all(6)) {
    w.byte(0x80 | (a! & 0x3f));
    w.byte(b! & 0x3f);
    w.byte(c! & 0x3f);
  } else sized3(w, [a!, b!, c!]);
}

function tag2_3svariable(w: Writer, [a, b, c]: number[]) {
  if ([a!, b!, c!].every((v) => fits(v, 2))) w.byte(((a! & 3) << 4) | ((b! & 3) << 2) | (c! & 3));
  else if (fits(a!, 5) && fits(b!, 5) && fits(c!, 4)) {
    w.byte(0x40 | ((a! & 0x1f) << 1) | ((b! & 0x1f) >> 4));
    w.byte(((b! & 0xf) << 4) | (c! & 0xf));
  } else if (fits(a!, 8) && fits(b!, 7) && fits(c!, 7)) {
    w.byte(0x80 | ((a! & 0xff) >> 2));
    w.byte(((a! & 3) << 6) | ((b! & 0x7f) >> 1));
    w.byte(((b! & 1) << 7) | (c! & 0x7f));
  } else sized3(w, [a!, b!, c!]);
}

function tag8_4s16(w: Writer, vals: number[]) {
  const sel: number[] = vals.map((v) => (v === 0 ? 0 : fits(v, 4) ? 1 : fits(v, 8) ? 2 : 3));
  w.byte(sel.reduce((h, s, i) => h | (s << (i * 2)), 0));
  let nibble = false;
  let buf = 0;
  vals.forEach((v, i) => {
    switch (sel[i]) {
      case 1:
        if (!nibble) buf = (v & 0xf) << 4;
        else w.byte(buf | (v & 0xf));
        nibble = !nibble;
        break;
      case 2:
        if (!nibble) w.byte(v);
        else {
          w.byte(buf | ((v >> 4) & 0xf));
          buf = (v & 0xf) << 4;
        }
        break;
      case 3:
        if (!nibble) {
          w.byte(v >> 8);
          w.byte(v);
        } else {
          w.byte(buf | ((v >> 12) & 0xf));
          w.byte(v >> 4);
          buf = (v & 0xf) << 4;
        }
    }
  });
  if (nibble) w.byte(buf);
}

function writeFields(w: Writer, enc: number[], raw: number[]) {
  let i = 0;
  while (i < enc.length) {
    switch (enc[i]) {
      case Enc.SIGNED_VB:
        w.svb(raw[i++]!);
        break;
      case Enc.UNSIGNED_VB:
        w.uvb(raw[i++]!);
        break;
      case Enc.NEG_14BIT:
        w.uvb(-raw[i++]! & 0x3fff);
        break;
      case Enc.NULL:
        i++;
        break;
      case Enc.TAG8_4S16:
        tag8_4s16(w, raw.slice(i, i + 4));
        i += 4;
        break;
      case Enc.TAG2_3S32:
        tag2_3s32(w, raw.slice(i, i + 3));
        i += 3;
        break;
      case Enc.TAG2_3SVARIABLE:
        tag2_3svariable(w, raw.slice(i, i + 3));
        i += 3;
        break;
      case Enc.TAG8_8SVB: {
        let j = i + 1;
        while (j < i + 8 && j < enc.length && enc[j] === Enc.TAG8_8SVB) j++;
        const group = raw.slice(i, j);
        if (group.length === 1) w.svb(group[0]!);
        else {
          w.byte(group.reduce((h, v, k) => (v !== 0 ? h | (1 << k) : h), 0));
          group.forEach((v) => v !== 0 && w.svb(v));
        }
        i = j;
        break;
      }
    }
  }
}

// Набір полів, схожий на Betaflight 4.4–4.5.
const AX = (p: string, k: number) => Array.from({ length: k }, (_, i) => `${p}[${i}]`);
export const SYNTH_FIELDS = [
  "loopIteration", "time", ...AX("axisP", 3), ...AX("axisI", 3), ...AX("axisD", 2), ...AX("axisF", 3),
  ...AX("rcCommand", 4), ...AX("setpoint", 4), "vbatLatest", ...AX("gyroADC", 3), ...AX("gyroUnfilt", 3), ...AX("debug", 4), ...AX("motor", 4),
];
const rep = <T>(v: T, k: number): T[] => Array(k).fill(v);
const SIGNED = [0, 0, ...rep(1, 11), 1, 1, 1, 0, ...rep(1, 4), 0, ...rep(1, 10), ...rep(0, 4)];
const I_PRED = [0, 0, ...rep(0, 11), 0, 0, 0, Pred.MINTHROTTLE, ...rep(0, 4), Pred.VBATREF, ...rep(0, 10), Pred.MINMOTOR, ...rep(Pred.MOTOR_0, 3)];
const I_ENC = [1, 1, ...rep(0, 11), 0, 0, 0, 1, ...rep(0, 4), Enc.NEG_14BIT, ...rep(0, 10), 1, 0, 0, 0];
const P_PRED = [Pred.INCREMENT, Pred.STRAIGHT_LINE, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, ...rep(1, 4), ...rep(1, 4), 1, ...rep(Pred.AVERAGE_2, 3), ...rep(1, 3), ...rep(1, 4), ...rep(Pred.AVERAGE_2, 4)];
const P_ENC = [Enc.NULL, 0, 0, 0, 0, ...rep(Enc.TAG2_3S32, 3), 0, 0, ...rep(Enc.TAG2_3SVARIABLE, 3), ...rep(Enc.TAG8_4S16, 4), ...rep(Enc.TAG8_4S16, 4), Enc.TAG8_8SVB, 0, 0, 0, ...rep(Enc.TAG8_8SVB, 7), 0, 0, 0, 0];

const MINTHROTTLE = 1070;
const VBATREF = 420;
const MINMOTOR = 48;

/** Рядки значень польоту (цілі) у порядку SYNTH_FIELDS. Кадр пишеться кожні 2 ітерації циклу. */
export function synthFlightRows(o: SynthOptions = {}): number[][] {
  const csv = synthLogCsv(o).split("\n");
  const h = csv.findIndex((l) => l.startsWith("loopIteration"));
  const head = csv[h]!.split(",");
  const at = (name: string) => head.findIndex((c) => c === name || c.startsWith(name + " "));
  const rows: number[][] = [];
  let iErr = [0, 0, 0];
  for (let r = h + 1; r < csv.length; r++) {
    const c = csv[r]!.split(",").map(Number);
    const g = (n: string) => Math.round(c[at(n)]!);
    const sp = [0, 1, 2].map((i) => g(`setpoint[${i}]`));
    const gy = [0, 1, 2].map((i) => g(`gyroADC[${i}]`));
    const err = sp.map((s, i) => s - gy[i]!);
    iErr = iErr.map((v, i) => Math.max(-300, Math.min(300, v + err[i]! * 0.01)));
    const k = r - h - 1;
    rows.push([
      2 * k,
      g("time"),
      ...err.map((e) => Math.round(e * 0.45)),
      ...iErr.map(Math.round),
      ...[0, 1].map((i) => Math.round((gy[i]! - (rows[k - 1]?.[22 + i] ?? 0)) * 2)),
      ...sp.map((s) => Math.round(s * 0.1)),
      ...sp.map((s) => Math.round(s / 2)),
      g("rcCommand[3]"),
      ...sp,
      Math.round((g("rcCommand[3]") - 1000) / 10),
      396 - Math.floor(k / 4000),
      ...gy,
      ...[0, 1, 2].map((i) => g(`gyroUnfilt[${i}]`)),
      ...[0, 1, 2].map((i) => g(`gyroUnfilt[${i}]`) - gy[i]!),
      k % 1000,
      ...[0, 1, 2, 3].map((i) => g(`motor[${i}]`)),
    ].map((v) => v + 0)); // без -0
  }
  return rows;
}

function predict(i: number, pred: number, cur: number[], p1: number[] | null, p2: number[] | null): number {
  switch (pred) {
    case Pred.PREVIOUS:
      return p1 ? p1[i]! : 0;
    case Pred.STRAIGHT_LINE:
      return p1 ? 2 * p1[i]! - p2![i]! : 0;
    case Pred.AVERAGE_2:
      return p1 ? Math.trunc((p1[i]! + p2![i]!) / 2) : 0;
    case Pred.MINTHROTTLE:
      return MINTHROTTLE;
    case Pred.MOTOR_0:
      return cur[SYNTH_FIELDS.indexOf("motor[0]")]!;
    case Pred.INCREMENT:
      return p1 ? p1[i]! + 2 : 0;
    case Pred.VBATREF:
      return VBATREF;
    case Pred.MINMOTOR:
      return MINMOTOR;
    default:
      return 0;
  }
}

function header(w: Writer) {
  const h = (k: string, v: string) => w.text(`H ${k}:${v}\n`);
  w.text("H Product:Blackbox flight data recorder by Nicholas Sherlock\n");
  h("Data version", "2");
  h("I interval", "32");
  h("P interval", "2");
  h("Firmware type", "Cleanflight");
  h("Firmware revision", "Betaflight 4.5.1 (77d01ba3b) STM32F7X2");
  h("Field I name", SYNTH_FIELDS.join(","));
  h("Field I signed", SIGNED.join(","));
  h("Field I predictor", I_PRED.join(","));
  h("Field I encoding", I_ENC.join(","));
  h("Field P predictor", P_PRED.join(","));
  h("Field P encoding", P_ENC.join(","));
  h("Field S name", "flightModeFlags,stateFlags,failsafePhase,rxSignalReceived,rxFlightChannelsValid");
  h("Field S signed", "0,0,0,0,0");
  h("Field S predictor", "0,0,0,0,0");
  h("Field S encoding", "1,1,7,7,7");
  h("minthrottle", String(MINTHROTTLE));
  h("vbatref", String(VBATREF));
  h("motorOutput", `${MINMOTOR},2047`);
  h("looptime", "125");
  // Налаштування, з якими «літав» борт (як їх пише Betaflight)
  h("rollPID", "41,76,33");
  h("pitchPID", "44,80,36");
  h("yawPID", "38,76,0");
  h("d_min", "26,28,0");
  h("ff_weight", "90,95,80");
  h("rates_type", "3");
  h("rc_rates", "18,18,16");
  h("rates", "50,50,40");
  h("rc_expo", "20,20,10");
  h("thr_mid", "38");
  h("thr_expo", "0");
  h("gyro_lpf1_dyn_hz", "180,360");
  h("gyro_lpf2_static_hz", "360");
  h("dterm_lpf1_dyn_hz", "60,110");
  h("dterm_lpf2_static_hz", "110");
  h("dyn_notch_count", "1");
  h("dyn_notch_q", "300");
  h("dyn_notch_min_hz", "60");
  h("dyn_notch_max_hz", "400");
  h("dshot_bidir", "1");
}

export interface SynthBblOptions extends SynthOptions {
  /** Вставити сміттєві байти перед I-кадром із цим номером кадру (перевірка відновлення) */
  garbageBeforeFrame?: number;
  /** Друга, коротша сесія в тому ж файлі (кадрів) */
  secondSessionFrames?: number;
}

function writeSession(w: Writer, rows: number[][], garbageAt?: number) {
  header(w);
  w.byte(69), w.byte(0), w.uvb(0); // E: SYNC_BEEP
  let p1: number[] | null = null;
  let p2: number[] | null = null;
  rows.forEach((row, k) => {
    const intra = row[0]! % 32 === 0;
    if (garbageAt !== undefined && k === garbageAt) [0x01, 0x02, 0xff, 0x50, 0x11].forEach((b) => w.byte(b));
    const pred = intra ? I_PRED : P_PRED;
    const raw = row.map((v, i) => v - predict(i, pred[i]!, row, intra ? null : p1, intra ? null : p2));
    w.byte(intra ? 73 : 80);
    writeFields(w, intra ? I_ENC : P_ENC, raw);
    if (k === 0) {
      w.byte(83); // S-кадр
      writeFields(w, [1, 1, 7, 7, 7], [5, 1, 0, 1, 1]);
    }
    p2 = intra ? row : p1;
    p1 = row;
  });
  w.byte(69), w.byte(255), w.text("End of log\0");
}

/** Синтетичний .bbl. Повертає байти і вихідні рядки для порівняння. */
export function synthBbl(o: SynthBblOptions = {}): { bytes: Uint8Array; rows: number[][] } {
  const rows = synthFlightRows(o);
  // I-кадр має припадати на loopIteration кратний 32: рядок k має ітерацію 2k.
  const w = new Writer();
  const garbage = o.garbageBeforeFrame !== undefined ? Math.ceil(o.garbageBeforeFrame / 16) * 16 : undefined;
  writeSession(w, rows, garbage);
  if (o.secondSessionFrames) writeSession(w, synthFlightRows({ ...o, seconds: o.secondSessionFrames / (o.fs ?? 2000), seed: (o.seed ?? 7) + 1 }));
  return { bytes: Uint8Array.from(w.bytes), rows };
}
