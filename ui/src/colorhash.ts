export function colorHash(s: string): string {
  let x = 0;
  for (const c of s) {
    x = ((x * 33) ^ (c.codePointAt(0) as number)) >>> 0;
  }
  // golden ratio conjugate spreads hue evenly even for sequential inputs
  const hue = ((x * 0.618033988749895) % 1) * 360;
  return `hsl(${hue | 0}, 70%, 55%)`;
}
