/** Мінімальна радикс-2 FFT на типізованих масивах, без залежностей. */

export const nextPow2 = (n: number): number => 1 << Math.ceil(Math.log2(Math.max(1, n)));
export const prevPow2 = (n: number): number => 1 << Math.floor(Math.log2(Math.max(1, n)));

/** FFT на місці. `inverse` дає обернене перетворення з нормалізацією 1/N. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) throw new Error("FFT: довжина має бути степенем двійки");
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]!; re[i] = re[j]!; re[j] = t;
      t = im[i]!; im[i] = im[j]!; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cRe = 1;
      let cIm = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xRe = re[b]! * cRe - im[b]! * cIm;
        const xIm = re[b]! * cIm + im[b]! * cRe;
        re[b] = re[a]! - xRe;
        im[b] = im[a]! - xIm;
        re[a] = re[a]! + xRe;
        im[a] = im[a]! + xIm;
        const nRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] = re[i]! / n;
      im[i] = im[i]! / n;
    }
  }
}

export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}
