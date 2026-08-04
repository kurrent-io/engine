const NIBBLE = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];

export function generateUuid(): string {
  let out = '';

  if (crypto?.getRandomValues) {
    // Get 128 bits of randomness.
    const values = new Uint8Array(16);
    crypto.getRandomValues(values);

    // rfc4122 compliance: type 4 uuid
    values[6] = 0x40 | (values[6] & 0x0f);
    values[8] = 0x80 | (values[8] & 0x3f);

    values.forEach((x) => {
      out += NIBBLE[x >>> 4] + NIBBLE[x & 0x0f];
    });
  } else {
    out = new Array(32)
      .fill(null)
      .map(() => NIBBLE[Math.floor(Math.random() * NIBBLE.length)])
      .join('');
  }

  return [
    out.substring(0, 8),
    out.substring(8, 12),
    out.substring(12, 16),
    out.substring(16, 20),
    out.substring(20, 32),
  ].join('-');
}
