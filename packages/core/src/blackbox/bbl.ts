import { buildFlightLog, type FlightLog } from "./csv";

/**
 * Розбір бінарних логів Betaflight Blackbox (.bbl / .bfl / .txt з SD-карти чи флешу FC).
 *
 * Формат: текстовий заголовок із рядків `H ключ:значення`, далі потік кадрів.
 * Кадри I (повні) і P (дельта від попередніх) містять основні поля; S, G, H, E
 * розбираються лише щоб не збитися з потоку. Один файл може містити кілька сесій
 * (кожен арм пише новий заголовок).
 */

export class BblParseError extends Error {}

const MARKER = "H Product:Blackbox flight data recorder by Nicholas Sherlock";

/** Кодування полів. */
export const Enc = {
  SIGNED_VB: 0,
  UNSIGNED_VB: 1,
  NEG_14BIT: 3,
  TAG8_8SVB: 6,
  TAG2_3S32: 7,
  TAG8_4S16: 8,
  NULL: 9,
  TAG2_3SVARIABLE: 10,
} as const;

/** Предиктори полів. */
export const Pred = {
  ZERO: 0,
  PREVIOUS: 1,
  STRAIGHT_LINE: 2,
  AVERAGE_2: 3,
  MINTHROTTLE: 4,
  MOTOR_0: 5,
  INCREMENT: 6,
  HOME_COORD: 7,
  P1500: 8,
  VBATREF: 9,
  LAST_MAIN_FRAME_TIME: 10,
  MINMOTOR: 11,
} as const;

const EVENT = { SYNC_BEEP: 0, INFLIGHT_ADJUSTMENT: 13, LOGGING_RESUME: 14, DISARM: 15, FLIGHT_MODE: 30, LOG_END: 255 } as const;

interface FrameDef {
  names: string[];
  signed: boolean[];
  predictor: number[];
  encoding: number[];
}

export interface BblSession {
  headers: Record<string, string>;
  /** Імена полів основних кадрів (I/P) */
  fields: string[];
  /** Значення основних кадрів, по рядку на кадр */
  frames: Float64Array[];
  /** Скільки кадрів відкинуто як пошкоджені */
  corrupt: number;
}

class Reader {
  pos: number;
  constructor(
    readonly buf: Uint8Array,
    start: number,
    readonly end: number,
  ) {
    this.pos = start;
  }
  eof(): boolean {
    return this.pos >= this.end;
  }
  byte(): number {
    if (this.pos >= this.end) throw new RangeError("eof");
    return this.buf[this.pos++]!;
  }
  peek(): number {
    return this.pos < this.end ? this.buf[this.pos]! : -1;
  }
  unsignedVB(): number {
    let result = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.byte();
      result += (b & 0x7f) * 2 ** (7 * i);
      if (b < 0x80) return result >>> 0;
    }
    throw new RangeError("vb overflow");
  }
  signedVB(): number {
    const u = this.unsignedVB();
    return (u >>> 1) ^ -(u & 1);
  }
}

const sx = (v: number, bits: number): number => (v << (32 - bits)) >> (32 - bits);

function readTag2_3S32(r: Reader, out: number[]): void {
  const lead = r.byte();
  switch (lead >> 6) {
    case 0:
      out[0] = sx((lead >> 4) & 3, 2);
      out[1] = sx((lead >> 2) & 3, 2);
      out[2] = sx(lead & 3, 2);
      return;
    case 1: {
      out[0] = sx(lead & 0x0f, 4);
      const b = r.byte();
      out[1] = sx(b >> 4, 4);
      out[2] = sx(b & 0x0f, 4);
      return;
    }
    case 2:
      out[0] = sx(lead & 0x3f, 6);
      out[1] = sx(r.byte() & 0x3f, 6);
      out[2] = sx(r.byte() & 0x3f, 6);
      return;
    default:
      readSized3(r, lead, out);
  }
}

/** Три значення, розмір кожного (8/16/24/32 біти) у двох бітах lead. Little-endian. */
function readSized3(r: Reader, lead: number, out: number[]): void {
  for (let i = 0; i < 3; i++) {
    const size = (lead >> (i * 2)) & 3;
    let v = 0;
    for (let k = 0; k <= size; k++) v |= r.byte() << (8 * k);
    out[i] = size === 3 ? v | 0 : sx(v, 8 * (size + 1));
  }
}

function readTag2_3SVariable(r: Reader, out: number[]): void {
  const lead = r.byte();
  switch (lead >> 6) {
    case 0:
      out[0] = sx((lead >> 4) & 3, 2);
      out[1] = sx((lead >> 2) & 3, 2);
      out[2] = sx(lead & 3, 2);
      return;
    case 1: {
      const b1 = r.byte();
      out[0] = sx((lead & 0x3e) >> 1, 5);
      out[1] = sx(((lead & 0x01) << 4) | (b1 >> 4), 5);
      out[2] = sx(b1 & 0x0f, 4);
      return;
    }
    case 2: {
      const b1 = r.byte();
      const b2 = r.byte();
      out[0] = sx(((lead & 0x3f) << 2) | (b1 >> 6), 8);
      out[1] = sx(((b1 & 0x3f) << 1) | (b2 >> 7), 7);
      out[2] = sx(b2 & 0x7f, 7);
      return;
    }
    default:
      readSized3(r, lead, out);
  }
}

/** Чотири значення: 0, 4, 8 або 16 біт; півбайти пакуються щільно, 16 біт big-endian. */
function readTag8_4S16(r: Reader, out: number[]): void {
  const header = r.byte();
  let nibble = false;
  let buffer = 0;
  for (let i = 0; i < 4; i++) {
    switch ((header >> (i * 2)) & 3) {
      case 0:
        out[i] = 0;
        break;
      case 1:
        if (!nibble) {
          buffer = r.byte();
          out[i] = sx(buffer >> 4, 4);
          nibble = true;
        } else {
          out[i] = sx(buffer & 0x0f, 4);
          nibble = false;
        }
        break;
      case 2:
        if (!nibble) out[i] = sx(r.byte(), 8);
        else {
          const hi = (buffer & 0x0f) << 4;
          buffer = r.byte();
          out[i] = sx(hi | (buffer >> 4), 8);
        }
        break;
      default:
        if (!nibble) {
          const a = r.byte();
          const b = r.byte();
          out[i] = sx((a << 8) | b, 16);
        } else {
          const a = r.byte();
          const b = r.byte();
          out[i] = sx(((buffer & 0x0f) << 12) | (a << 4) | (b >> 4), 16);
          buffer = b;
        }
    }
  }
}

function readTag8_8SVB(r: Reader, out: number[], count: number): void {
  if (count === 1) {
    out[0] = r.signedVB();
    return;
  }
  let header = r.byte();
  for (let i = 0; i < 8; i++, header >>= 1) out[i] = header & 1 ? r.signedVB() : 0;
}

/** Читає сирі (ще без предикторів) значення всіх полів кадру. */
function readRaw(r: Reader, def: FrameDef, out: Float64Array): void {
  const enc = def.encoding;
  const n = enc.length;
  const tmp: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
  let i = 0;
  while (i < n) {
    switch (enc[i]) {
      case Enc.SIGNED_VB:
        out[i++] = r.signedVB();
        break;
      case Enc.UNSIGNED_VB:
        out[i++] = r.unsignedVB();
        break;
      case Enc.NEG_14BIT:
        out[i++] = -sx(r.unsignedVB(), 14);
        break;
      case Enc.NULL:
        out[i++] = 0;
        break;
      case Enc.TAG8_4S16:
        readTag8_4S16(r, tmp);
        for (let j = 0; j < 4 && i < n; j++) out[i++] = tmp[j]!;
        break;
      case Enc.TAG2_3S32:
        readTag2_3S32(r, tmp);
        for (let j = 0; j < 3 && i < n; j++) out[i++] = tmp[j]!;
        break;
      case Enc.TAG2_3SVARIABLE:
        readTag2_3SVariable(r, tmp);
        for (let j = 0; j < 3 && i < n; j++) out[i++] = tmp[j]!;
        break;
      case Enc.TAG8_8SVB: {
        let j = i + 1;
        while (j < i + 8 && j < n && enc[j] === Enc.TAG8_8SVB) j++;
        const count = j - i;
        readTag8_8SVB(r, tmp, count);
        for (let k = 0; k < count; k++) out[i++] = tmp[k]!;
        break;
      }
      default:
        throw new BblParseError(`Невідоме кодування поля: ${enc[i]}`);
    }
  }
}

function parseDef(h: Record<string, string>, t: string, names?: string[], signed?: boolean[]): FrameDef | null {
  const list = (k: string) => (h[k] ?? "").split(",").filter((s) => s !== "");
  const nm = names ?? list(`Field ${t} name`);
  if (!nm.length) return null;
  const pred = list(`Field ${t} predictor`).map(Number);
  const enc = list(`Field ${t} encoding`).map(Number);
  if (pred.length !== nm.length || enc.length !== nm.length) return null;
  const sg = signed ?? list(`Field ${t} signed`).map((s) => s === "1");
  return { names: nm, signed: nm.map((_, i) => sg[i] ?? false), predictor: pred, encoding: enc };
}

const isFrameByte = (b: number) => b === 73 /*I*/ || b === 80 /*P*/ || b === 83 /*S*/ || b === 71 /*G*/ || b === 72 /*H*/ || b === 69; /*E*/

/** Знаходить початки сесій у файлі. */
function findSessions(buf: Uint8Array): number[] {
  const m = new TextEncoder().encode(MARKER);
  const starts: number[] = [];
  outer: for (let i = 0; i + m.length <= buf.length; i++) {
    for (let k = 0; k < m.length; k++) if (buf[i + k] !== m[k]) continue outer;
    starts.push(i);
    i += m.length - 1;
  }
  return starts;
}

function parseSession(buf: Uint8Array, start: number, end: number): BblSession {
  const r = new Reader(buf, start, end);
  const headers: Record<string, string> = {};
  const dec = new TextDecoder("latin1");
  while (r.peek() === 72 /*H*/ && r.pos + 1 < end && buf[r.pos + 1] === 32) {
    let e = r.pos;
    while (e < end && buf[e] !== 10) e++;
    const line = dec.decode(buf.subarray(r.pos + 2, e));
    const c = line.indexOf(":");
    if (c > 0) headers[line.slice(0, c)] = line.slice(c + 1);
    r.pos = e + 1;
  }
  const dataVersion = Number(headers["Data version"] ?? 2);
  if (dataVersion !== 2) throw new BblParseError(`Непідтримувана версія даних Blackbox: ${dataVersion}. Оновіть Betaflight або експортуйте CSV.`);

  const I = parseDef(headers, "I");
  if (!I) throw new BblParseError("У заголовку логу немає опису полів (Field I).");
  const P = parseDef(headers, "P", I.names, I.signed);
  const S = parseDef(headers, "S");
  const G = parseDef(headers, "G");
  const Hdef = parseDef(headers, "H");

  const n = I.names.length;
  const idx = (name: string) => I.names.indexOf(name);
  const motor0 = idx("motor[0]");
  const timeIdx = idx("time");
  const iterIdx = idx("loopIteration");
  const minthrottle = Number(headers["minthrottle"] ?? 1150);
  const vbatref = Number(headers["vbatref"] ?? 4095);
  const minmotor = Number((headers["motorOutput"] ?? "0").split(",")[0]);
  const iInterval = Math.max(1, Number(headers["I interval"] ?? 1));
  const pIntHdr = headers["P interval"] ?? "1";
  let pNum = 1;
  let pDen = 1;
  if (pIntHdr.includes("/")) [pNum, pDen] = pIntHdr.split("/").map(Number) as [number, number];
  else pDen = Math.max(1, Number(pIntHdr));
  const shouldHave = (i: number) => ((i % iInterval) + pNum - 1) % pDen < pNum;

  const frames: Float64Array[] = [];
  let prev: Float64Array | null = null;
  let prev2: Float64Array | null = null;
  let lastTime = -1;
  let corrupt = 0;
  const raw = new Float64Array(Math.max(n, S?.names.length ?? 0, G?.names.length ?? 0, Hdef?.names.length ?? 0));

  const apply = (def: FrameDef, cur: Float64Array, p1: Float64Array | null, p2: Float64Array | null, skipped: number) => {
    for (let i = 0; i < def.names.length; i++) {
      let v = raw[i]!;
      switch (def.predictor[i]) {
        case Pred.ZERO:
          break;
        case Pred.PREVIOUS:
          if (p1) v += p1[i]!;
          break;
        case Pred.STRAIGHT_LINE:
          if (p1) v += 2 * p1[i]! - p2![i]!;
          break;
        case Pred.AVERAGE_2:
          if (p1) v += Math.trunc((p1[i]! + p2![i]!) / 2);
          break;
        case Pred.MINTHROTTLE:
          v += minthrottle;
          break;
        case Pred.MOTOR_0:
          v += cur[motor0]!;
          break;
        case Pred.INCREMENT:
          if (p1) v += p1[i]! + 1 + skipped;
          break;
        case Pred.P1500:
          v += 1500;
          break;
        case Pred.VBATREF:
          v += vbatref;
          break;
        case Pred.MINMOTOR:
          v += minmotor;
          break;
        case Pred.HOME_COORD:
        case Pred.LAST_MAIN_FRAME_TIME:
          break; // для GPS-кадрів значення не потрібні
        default:
          throw new BblParseError(`Невідомий предиктор: ${def.predictor[i]}`);
      }
      // Беззнакові поля Betaflight зберігає як uint32; знакові — як int32.
      cur[i] = def.signed[i] ? v | 0 : v >>> 0;
    }
  };

  const skippedBefore = (iter: number): number => {
    let s = 0;
    for (let i = iter + 1; !shouldHave(i) && s < 1 << 16; i++) s++;
    return s;
  };

  const readEvent = (): boolean => {
    const type = r.byte();
    switch (type) {
      case EVENT.SYNC_BEEP:
        r.unsignedVB();
        return true;
      case EVENT.INFLIGHT_ADJUSTMENT: {
        const fn = r.byte();
        if (fn > 127) {
          r.byte(), r.byte(), r.byte(), r.byte();
        } else r.signedVB();
        return true;
      }
      case EVENT.LOGGING_RESUME:
        r.unsignedVB();
        r.unsignedVB();
        prev = prev2 = null; // далі обов'язково I-кадр
        return true;
      case EVENT.DISARM:
        r.unsignedVB();
        return true;
      case EVENT.FLIGHT_MODE:
        r.unsignedVB();
        r.unsignedVB();
        return true;
      case EVENT.LOG_END:
        r.pos = end;
        return true;
      default:
        throw new BblParseError("unknown event");
    }
  };

  while (!r.eof()) {
    const frameStart = r.pos;
    const type = r.byte();
    try {
      let accepted: Float64Array | null = null;
      let isIntra = false;
      switch (type) {
        case 73: /*I*/ {
          readRaw(r, I, raw);
          const cur = new Float64Array(n);
          apply(I, cur, null, null, 0);
          accepted = cur;
          isIntra = true;
          break;
        }
        case 80: /*P*/ {
          if (!P || !prev) {
            // без попереднього I-кадру P не розкодувати: пропускаємо до наступного маркера
            readRaw(r, P ?? I, raw);
            break;
          }
          readRaw(r, P, raw);
          const cur = new Float64Array(n);
          const skipped = iterIdx >= 0 ? skippedBefore(prev[iterIdx]!) : 0;
          apply(P, cur, prev, prev2 ?? prev, skipped);
          accepted = cur;
          break;
        }
        case 83: /*S*/
          if (!S) throw new BblParseError("S");
          readRaw(r, S, raw);
          break;
        case 71: /*G*/
          if (!G) throw new BblParseError("G");
          readRaw(r, G, raw);
          break;
        case 72: /*H*/
          if (!Hdef) throw new BblParseError("H");
          readRaw(r, Hdef, raw);
          break;
        case 69: /*E*/
          readEvent();
          break;
        default:
          throw new BblParseError("bad frame type");
      }
      // Після кадру має починатися наступний кадр або кінець даних; інакше кадр пошкоджений.
      if (!r.eof() && !isFrameByte(r.peek())) throw new BblParseError("desync");
      if (accepted) {
        const t = timeIdx >= 0 ? accepted[timeIdx]! : frames.length;
        const sane = lastTime < 0 || (t > lastTime && t - lastTime < 10_000_000);
        if (!sane && !isIntra) throw new BblParseError("time jump");
        if (sane || isIntra) {
          frames.push(accepted);
          lastTime = t;
          prev2 = isIntra ? accepted : prev;
          prev = accepted;
        }
      }
    } catch (e) {
      if (!(e instanceof BblParseError) && !(e instanceof RangeError)) throw e;
      if (r.eof() && e instanceof RangeError) break; // обрізаний кінець файлу
      corrupt++;
      prev = prev2 = null;
      r.pos = frameStart + 1;
      while (!r.eof() && r.peek() !== 73) r.pos++; // чекаємо наступного I-кадру
    }
  }
  return { headers, fields: I.names, frames, corrupt };
}

/** Чи схожий файл на бінарний лог Blackbox. */
export function isBlackboxBinary(buf: Uint8Array): boolean {
  return findSessions(buf.subarray(0, Math.min(buf.length, 4096))).length > 0;
}

/** Розбирає всі сесії з файлу. */
export function parseBblSessions(buf: Uint8Array): BblSession[] {
  const starts = findSessions(buf);
  if (!starts.length) throw new BblParseError("Це не лог Betaflight Blackbox: не знайдено заголовок.");
  return starts.map((s, k) => parseSession(buf, s, starts[k + 1] ?? buf.length));
}

/**
 * Розбирає бінарний лог і повертає найдовшу сесію як FlightLog.
 * `sessionIndex` вибирає конкретну сесію (з 0).
 */
export function parseBlackboxBinary(buf: Uint8Array, sessionIndex?: number): FlightLog & { sessions: number; corrupt: number } {
  const sessions = parseBblSessions(buf);
  let k = sessionIndex ?? 0;
  if (sessionIndex === undefined) for (let i = 1; i < sessions.length; i++) if (sessions[i]!.frames.length > sessions[k]!.frames.length) k = i;
  const s = sessions[k];
  if (!s) throw new BblParseError(`У файлі немає сесії №${(sessionIndex ?? 0) + 1}.`);
  const n = s.frames.length;
  const column = (name: string): Float64Array | null => {
    const c = s.fields.indexOf(name);
    if (c < 0) return null;
    const out = new Float64Array(n);
    for (let r = 0; r < n; r++) out[r] = s.frames[r]![c]!;
    return out;
  };
  const meta = { ...s.headers };
  return { ...buildFlightLog(column, n, 1e-6, meta), sessions: sessions.length, corrupt: s.corrupt };
}
