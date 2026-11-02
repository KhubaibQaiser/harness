type Op = { t: ' ' | '-' | '+'; s: string };

const lines = (s: string): string[] => {
  const l = s.split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
};

// Prefix/suffix are trimmed first; the LCS table only covers the middle. ponytail: a middle over 4M cells is shown as one replace.
function middle(a: string[], b: string[]): Op[] {
  if (a.length * b.length > 4_000_000) return [...a.map((s) => ({ t: '-' as const, s })), ...b.map((s) => ({ t: '+' as const, s }))];
  const w = b.length + 1;
  const L = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) ops.push({ t: ' ', s: a[i++] }), j++;
    else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) ops.push({ t: '-', s: a[i++] });
    else ops.push({ t: '+', s: b[j++] });
  }
  while (i < a.length) ops.push({ t: '-', s: a[i++] });
  while (j < b.length) ops.push({ t: '+', s: b[j++] });
  return ops;
}

/** Unified line diff (a/ and b/ headers, `ctx` lines of context). Returns '' when the line content is the same. */
export function unifiedDiff(before: string, after: string, name: string, ctx = 3): string {
  const A = lines(before), B = lines(after);
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let q = 0;
  while (q < A.length - p && q < B.length - p && A[A.length - 1 - q] === B[B.length - 1 - q]) q++;
  const ops: Op[] = [
    ...A.slice(0, p).map((s) => ({ t: ' ' as const, s })),
    ...middle(A.slice(p, A.length - q), B.slice(p, B.length - q)),
    ...A.slice(A.length - q).map((s) => ({ t: ' ' as const, s })),
  ];
  const changed = ops.flatMap((o, i) => (o.t === ' ' ? [] : [i]));
  if (!changed.length) return '';

  const out = [`--- a/${name}`, `+++ b/${name}`];
  for (let k = 0; k < changed.length; ) {
    let e = k;
    while (e + 1 < changed.length && changed[e + 1] - changed[e] <= 2 * ctx + 1) e++;
    const from = Math.max(0, changed[k] - ctx), to = Math.min(ops.length, changed[e] + ctx + 1);
    const seg = ops.slice(from, to);
    const aBefore = ops.slice(0, from).filter((o) => o.t !== '+').length;
    const bBefore = ops.slice(0, from).filter((o) => o.t !== '-').length;
    const aN = seg.filter((o) => o.t !== '+').length, bN = seg.filter((o) => o.t !== '-').length;
    out.push(`@@ -${aN ? aBefore + 1 : aBefore},${aN} +${bN ? bBefore + 1 : bBefore},${bN} @@`, ...seg.map((o) => o.t + o.s));
    k = e + 1;
  }
  return out.join('\n') + '\n';
}

export type Hunk = { from: string; to: string };

/**
 * The line hunks that turn `b` back into `a`, each with `ctx` lines of context: `from` is the text in `b`, `to` the
 * text in `a`. Both are whole lines (a hunk that does not end the file ends in "\n"), so they match at a line start.
 */
export function lineHunks(a: string, b: string, ctx = 1): Hunk[] {
  const A = a.split('\n'), B = b.split('\n');
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let q = 0;
  while (q < A.length - p && q < B.length - p && A[A.length - 1 - q] === B[B.length - 1 - q]) q++;
  const ops: Op[] = [
    ...A.slice(0, p).map((s) => ({ t: ' ' as const, s })),
    ...middle(A.slice(p, A.length - q), B.slice(p, B.length - q)),
    ...A.slice(A.length - q).map((s) => ({ t: ' ' as const, s })),
  ];
  const changed = ops.flatMap((o, i) => (o.t === ' ' ? [] : [i]));
  const out: Hunk[] = [];
  for (let k = 0; k < changed.length; ) {
    let e = k;
    while (e + 1 < changed.length && changed[e + 1] - changed[e] <= 2 * ctx + 1) e++;
    const from = Math.max(0, changed[k] - ctx), to = Math.min(ops.length, changed[e] + ctx + 1);
    const seg = ops.slice(from, to);
    const end = to < ops.length ? '\n' : '';
    out.push({ from: seg.filter((o) => o.t !== '-').map((o) => o.s).join('\n') + end, to: seg.filter((o) => o.t !== '+').map((o) => o.s).join('\n') + end });
    k = e + 1;
  }
  return out;
}

/** Applies hunks backwards (last one first): each `from`, at a line start (the last such match), becomes `to`. Null when one is missing. */
// Matched in LF form, like removeBlocks: a teammate's core.autocrlf checkout has CRLF; the result keeps the text's EOL.
export function revertHunks(text: string, hunks: Hunk[]): string | null {
  const lf = (t: string) => t.replace(/\r\n/g, '\n');
  let out = lf(text);
  for (const h of [...hunks].reverse()) {
    const from = lf(h.from);
    let i = out.lastIndexOf(from);
    while (i > 0 && out[i - 1] !== '\n') i = out.lastIndexOf(from, i - 1);
    if (i < 0) return null;
    out = out.slice(0, i) + lf(h.to) + out.slice(i + from.length);
  }
  return text.includes('\r\n') ? out.replace(/\n/g, '\r\n') : out;
}
