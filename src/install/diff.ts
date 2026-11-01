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
