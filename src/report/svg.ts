import { h } from './h.js';

const LABEL_W = 170, BAR_W = 300, ROW_H = 24, BAR_H = 14, PAD = 6, NOTE_X = LABEL_W + BAR_W + PAD * 2, VIEW_W = 640;
const LABEL_MAX = 26, DAY_TAIL = -5, INSET = 2, COL_W = 56, CHART_H = 140, AXIS_H = 20, LEGEND_H = 20, SWATCH = 10, SERIES = 4;

/** Horizontal bars. Text is in `<text>` and `<title>`, both escaped; colours come from CSS variables. */
export function hbars(rows: { label: string; value: number; max: number; note?: string }[]): string {
  const body = rows.map((r, i) => {
    const y = i * ROW_H, w = r.max > 0 ? Math.round((Math.min(r.value, r.max) / r.max) * BAR_W) : 0;
    return `<g><title>${h(r.label)}: ${r.value} of ${r.max}</title>`
      + `<text x="0" y="${y + BAR_H}" class="lbl">${h(r.label.slice(0, LABEL_MAX))}</text>`
      + `<rect x="${LABEL_W}" y="${y + INSET}" width="${BAR_W}" height="${BAR_H}" class="track"/>`
      + `<rect x="${LABEL_W}" y="${y + INSET}" width="${w}" height="${BAR_H}" class="bar"/>`
      + `<text x="${NOTE_X}" y="${y + BAR_H}" class="lbl">${h(r.note ?? `${r.value}`)}</text></g>`;
  }).join('');
  return `<svg viewBox="0 0 ${VIEW_W} ${Math.max(rows.length, 1) * ROW_H}" role="img" aria-label="bar chart">${body}</svg>`;
}

/** Stacked columns; `parts[k]` is series k (class `s0`..`s3`). */
export function stackedBars(cols: { label: string; parts: number[] }[], legend: string[]): string {
  const top = Math.max(1, ...cols.map((c) => c.parts.reduce((a, b) => a + b, 0)));
  const bars = cols.map((c, i) => {
    let y = CHART_H;
    const rects = c.parts.map((p, k) => {
      const hh = Math.round((p / top) * CHART_H);
      y -= hh;
      return `<rect x="${i * COL_W + PAD}" y="${y}" width="${COL_W - PAD * 2}" height="${hh}" class="s${k % SERIES}"><title>${h(c.label)} ${h(legend[k] ?? '')}: ${p}</title></rect>`;
    }).join('');
    return `${rects}<text x="${i * COL_W + PAD}" y="${CHART_H + AXIS_H - PAD}" class="lbl">${h(c.label.slice(DAY_TAIL))}</text>`;
  }).join('');
  const key = legend.map((l, k) => `<rect x="${k * BAR_W / SERIES}" y="${CHART_H + AXIS_H + PAD}" width="${SWATCH}" height="${SWATCH}" class="s${k % SERIES}"/><text x="${k * BAR_W / SERIES + SWATCH + PAD}" y="${CHART_H + AXIS_H + SWATCH + PAD}" class="lbl">${h(l)}</text>`).join('');
  return `<svg viewBox="0 0 ${Math.max(cols.length * COL_W, VIEW_W)} ${CHART_H + AXIS_H + LEGEND_H + PAD}" role="img" aria-label="stacked bar chart">${bars}${key}</svg>`;
}
