/** Розбір CLI-скрипта Betaflight на контексти (глобальні, PID-профіль, rate-профіль). */

export type CliScope = "global" | "profile" | "rateprofile";

export interface CliSetting {
  scope: CliScope;
  /** Індекс профілю для scope = profile | rateprofile */
  index: number;
  name: string;
  value: string;
}

/** Повертає всі `set` з урахуванням того, в якому профілі вони стоять. Коментарі й `save` ігноруються. */
export function parseCliScript(cli: string): CliSetting[] {
  let scope: CliScope = "global";
  let index = 0;
  const out: CliSetting[] = [];
  for (const raw of cli.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let m = /^(profile|rateprofile)\s+(\d+)$/.exec(line);
    if (m) {
      scope = m[1] as CliScope;
      index = Number(m[2]);
      continue;
    }
    m = /^set\s+(\w+)\s*=\s*(.+)$/.exec(line);
    if (m) out.push({ scope, index, name: m[1]!, value: m[2]!.trim() });
  }
  return out;
}

/** Розбирає відповідь Betaflight на `get <name>`: "p_roll = 45". */
export function parseGetOutput(output: string, name: string): string | null {
  const re = new RegExp(`^${name}\\s*=\\s*(.+?)\\s*$`, "m");
  const m = re.exec(output);
  return m ? m[1]! : null;
}

/** Чи містить відповідь CLI ознаку помилки. */
export function cliError(output: string): string | null {
  const m = /(###ERROR[^\n]*|Invalid (?:name|value)[^\n]*|ERROR[^\n]*)/i.exec(output);
  return m ? m[1]!.trim() : null;
}

/** Версія з відповіді на `version`, напр. "4.5.1". */
export function parseBetaflightVersion(output: string): string | null {
  const m = /Betaflight\s*\/\s*\S+\s*\(\w+\)\s*(\d+\.\d+\.\d+)/.exec(output) ?? /Betaflight[^\n]*?(\d+\.\d+\.\d+)/.exec(output);
  return m ? m[1]! : null;
}
