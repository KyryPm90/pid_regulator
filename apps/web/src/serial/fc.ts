import { cliError, parseBetaflightVersion, parseCliScript, parseGetOutput, type CliSetting } from "@pid/core";

/** Мінімальний інтерфейс порту: збігається з Web Serial SerialPort після open(). */
export interface PortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open?(opts: { baudRate: number }): Promise<void>;
  close?(): Promise<void>;
}

export interface SettingDiff extends CliSetting {
  /** Значення на польотнику (null, якщо змінної немає в цій версії прошивки) */
  current: string | null;
}

export class FcError extends Error {}

const PROMPT = /\r?\n# $/;

/**
 * Робота з Betaflight через CLI по послідовному порту.
 * Читання: `get <name>` у потрібному профілі. Запис: усі `set`, потім `save` (польотник перезавантажується).
 * Якщо хоч одна команда повернула помилку, зміни не зберігаються: надсилається `exit`.
 */
export class FlightController {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private buffer = "";
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  version: string | null = null;

  constructor(private port: PortLike, private timeoutMs = 3000) {}

  /** Запитує в браузера порт і підключається. Потрібен Chrome або Edge на комп'ютері. */
  static async request(): Promise<FlightController> {
    const serial = (navigator as Navigator & { serial?: { requestPort(): Promise<PortLike> } }).serial;
    if (!serial) throw new FcError("Цей браузер не підтримує Web Serial. Відкрийте застосунок у Chrome або Edge на комп'ютері.");
    const port = await serial.requestPort();
    await port.open?.({ baudRate: 115200 });
    const fc = new FlightController(port);
    await fc.enterCli();
    return fc;
  }

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  async enterCli(): Promise<void> {
    if (!this.port.readable || !this.port.writable) throw new FcError("Порт не відкрито.");
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    await this.write("#");
    await this.readUntilPrompt();
    const v = await this.command("version");
    this.version = parseBetaflightVersion(v);
    if (!this.version) throw new FcError("Польотник відповів, але це не схоже на Betaflight.");
  }

  /** Виконує одну команду CLI і повертає її вивід (без запрошення `# `). */
  async command(cmd: string): Promise<string> {
    await this.write(`${cmd}\n`);
    return this.readUntilPrompt();
  }

  /** Зчитує з польотника поточні значення для всіх `set` зі скрипта. */
  async readCurrent(cli: string): Promise<SettingDiff[]> {
    const settings = parseCliScript(cli);
    const out: SettingDiff[] = [];
    let ctx = "global";
    for (const s of settings) {
      const want = s.scope === "global" ? "global" : `${s.scope} ${s.index}`;
      if (want !== ctx && s.scope !== "global") {
        await this.command(want);
        ctx = want;
      }
      const res = await this.command(`get ${s.name}`);
      out.push({ ...s, current: parseGetOutput(res, s.name) });
    }
    return out;
  }

  /** Записує скрипт і зберігає. Повертає помилки; якщо вони є, зміни скасовано. */
  async apply(cli: string): Promise<{ saved: boolean; errors: string[] }> {
    const errors: string[] = [];
    for (const raw of cli.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line === "save") continue;
      const res = await this.command(line);
      const err = cliError(res);
      if (err) errors.push(`${line}: ${err}`);
    }
    if (errors.length) {
      await this.write("exit\n");
      await this.release();
      return { saved: false, errors };
    }
    await this.write("save\n");
    await this.release();
    return { saved: true, errors };
  }

  async disconnect(): Promise<void> {
    try {
      await this.write("exit\n");
    } catch {
      /* порт уже закрито */
    }
    await this.release();
  }

  private async release() {
    try {
      await this.reader?.cancel();
    } catch {
      /* ігноруємо */
    }
    this.reader?.releaseLock();
    this.writer?.releaseLock();
    this.reader = null;
    this.writer = null;
    try {
      await this.port.close?.();
    } catch {
      /* польотник міг уже перезавантажитися */
    }
  }

  private async write(text: string) {
    if (!this.writer) throw new FcError("Польотник не підключено.");
    await this.writer.write(this.encoder.encode(text));
  }

  private async readUntilPrompt(): Promise<string> {
    if (!this.reader) throw new FcError("Польотник не підключено.");
    const deadline = Date.now() + this.timeoutMs;
    while (!PROMPT.test(this.buffer)) {
      const left = deadline - Date.now();
      if (left <= 0) throw new FcError("Польотник не відповідає. Перевірте кабель і що порт не зайнятий Betaflight Configurator.");
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<null>((r) => setTimeout(() => r(null), left)),
      ]);
      if (chunk === null) continue;
      if (chunk.done) throw new FcError("З'єднання з польотником розірвано.");
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
    const out = this.buffer.replace(PROMPT, "");
    this.buffer = "";
    return out;
  }
}
