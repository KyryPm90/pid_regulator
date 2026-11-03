/** Простий лінійний графік на canvas з урахуванням теми сторінки. */

export interface Series {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  color: string;
  label: string;
  width?: number;
  dash?: number[];
}

export interface Marker {
  x?: number;
  y?: number;
  label: string;
  color: string;
}

export interface ChartOptions {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  xLabel: string;
  yLabel: string;
  xTicks: number[];
  yTicks: number[];
  markers?: Marker[];
}

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";

export function drawChart(canvas: HTMLCanvasElement, series: Series[], o: ChartOptions): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || 260;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const pad = { l: 46, r: 12, t: 12, b: 34 };
  const W = cssW - pad.l - pad.r;
  const H = cssH - pad.t - pad.b;
  const sx = (x: number) => pad.l + ((x - o.xMin) / (o.xMax - o.xMin)) * W;
  const sy = (y: number) => pad.t + H - ((y - o.yMin) / (o.yMax - o.yMin)) * H;
  const muted = token("--muted");
  const grid = token("--line");
  const font = token("--f-mono") || "monospace";

  ctx.font = `11px ${font}`;
  ctx.lineWidth = 1;
  ctx.strokeStyle = grid;
  ctx.fillStyle = muted;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const x of o.xTicks) {
    ctx.beginPath();
    ctx.moveTo(sx(x) + 0.5, pad.t);
    ctx.lineTo(sx(x) + 0.5, pad.t + H);
    ctx.stroke();
    ctx.fillText(String(x), sx(x), pad.t + H + 4);
  }
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const y of o.yTicks) {
    ctx.beginPath();
    ctx.moveTo(pad.l, sy(y) + 0.5);
    ctx.lineTo(pad.l + W, sy(y) + 0.5);
    ctx.stroke();
    ctx.fillText(String(y), pad.l - 6, sy(y));
  }
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText(o.xLabel, pad.l + W, cssH - 2);
  ctx.save();
  ctx.translate(11, pad.t);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(o.yLabel, 0, 0);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l, pad.t, W, H);
  ctx.clip();
  for (const m of o.markers ?? []) {
    ctx.strokeStyle = m.color;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    if (m.x !== undefined) {
      ctx.moveTo(sx(m.x) + 0.5, pad.t);
      ctx.lineTo(sx(m.x) + 0.5, pad.t + H);
    } else if (m.y !== undefined) {
      ctx.moveTo(pad.l, sy(m.y) + 0.5);
      ctx.lineTo(pad.l + W, sy(m.y) + 0.5);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = m.color;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    if (m.x !== undefined) ctx.fillText(m.label, sx(m.x) + 4, pad.t + 2);
    else if (m.y !== undefined) ctx.fillText(m.label, pad.l + 4, sy(m.y) + 2);
  }
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width ?? 1.6;
    ctx.setLineDash(s.dash ?? []);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < s.y.length; i++) {
      const x = s.x[i]!;
      if (x < o.xMin || x > o.xMax) continue;
      const px = sx(x);
      const py = sy(Math.min(o.yMax * 2, Math.max(o.yMin - (o.yMax - o.yMin), s.y[i]!)));
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.restore();
  ctx.setLineDash([]);
}
