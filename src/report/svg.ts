import { h } from './h.js';

const LABEL_W = 170, BAR_W = 300, ROW_H = 24, BAR_H = 14, PAD = 6, GUTTER = PAD * 2, NOTE_X = LABEL_W + BAR_W + GUTTER, VIEW_W = 640;
const LABEL_MAX = 26, DAY_TAIL = -5, INSET = 2, COL_W = 56, CHART_H = 140, AXIS_H = 20, LEGEND_H = 20;
const SWATCH = 10, SERIES = 4, LEGEND_W = 160;
const MIN_ROWS = 1, MIN_TOP = 1;

/** Cut by code points so a surrogate pair is never split. */
const cut = (s: string, max: number): string => [...s].slice(0, max).join('');
/** Series k is drawn with class `s0`..`s3`; a fifth series would reuse a colour. */
const seriesClass = (k: number): string => `s${k % SERIES}`;
const legendX = (k: number): number => k * LEGEND_W;

/** Horizontal bars. Text is in `<text>` and `<title>`, both escaped; colours come from CSS variables. */
export function hbars(rows: { label: string; value: number; max: number; note?: string }[], aria = 'bar chart'): string {
  const body = rows.map((r, i) => {
    const y = i * ROW_H, w = r.max > 0 ? Math.round((Math.min(r.value, r.max) / r.max) * BAR_W) : 0;
    return `<g><title>${h(r.label)}: ${r.value} of ${r.max}</title>`
      + `<text x="0" y="${y + BAR_H}" class="lbl">${h(cut(r.label, LABEL_MAX))}</text>`
      + `<rect x="${LABEL_W}" y="${y + INSET}" width="${BAR_W}" height="${BAR_H}" class="track"/>`
      + `<rect x="${LABEL_W}" y="${y + INSET}" width="${w}" height="${BAR_H}" class="bar"/>`
      + `<text x="${NOTE_X}" y="${y + BAR_H}" class="lbl">${h(r.note ?? `${r.value}`)}</text></g>`;
  }).join('');
  return `<svg viewBox="0 0 ${VIEW_W} ${Math.max(rows.length, MIN_ROWS) * ROW_H}" role="img" aria-label="${h(aria)}">${body}</svg>`;
}

/** Stacked columns; `parts[k]` is series k. */
export function stackedBars(cols: { label: string; parts: number[] }[], legend: string[], aria = 'stacked bar chart'): string {
  const top = Math.max(MIN_TOP, ...cols.map((c) => c.parts.reduce((a, b) => a + b, 0)));
  const bars = cols.map((c, i) => {
    let y = CHART_H;
    const rects = c.parts.map((p, k) => {
      const hh = Math.round((p / top) * CHART_H);
      y -= hh;
      return `<rect x="${i * COL_W + PAD}" y="${y}" width="${COL_W - GUTTER}" height="${hh}" class="${seriesClass(k)}">`
        + `<title>${h(c.label)} ${h(legend[k] ?? '')}: ${p}</title></rect>`;
    }).join('');
    return `${rects}<text x="${i * COL_W + PAD}" y="${CHART_H + AXIS_H - PAD}" class="lbl">${h(c.label.slice(DAY_TAIL))}</text>`;
  }).join('');
  const ly = CHART_H + AXIS_H + PAD;
  const key = legend.map((l, k) => `<rect x="${legendX(k)}" y="${ly}" width="${SWATCH}" height="${SWATCH}" class="${seriesClass(k)}"/>`
    + `<text x="${legendX(k) + SWATCH + PAD}" y="${ly + SWATCH}" class="lbl">${h(l)}</text>`).join('');
  const width = Math.max(cols.length * COL_W, legendX(SERIES));
  return `<svg class="wide" viewBox="0 0 ${width} ${ly + LEGEND_H}" role="img" aria-label="${h(aria)}">${bars}${key}</svg>`;
}
