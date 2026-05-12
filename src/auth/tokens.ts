const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]+$/;

export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export function hashToken(plaintext: string): Uint8Array {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(plaintext);
  return new Uint8Array(hasher.digest());
}

export function verifyToken(plaintext: string, storedHash: Uint8Array): boolean {
  const candidate = hashToken(plaintext);
  return constantTimeEqual(candidate, storedHash);
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  // Walk the LONGER buffer so length-mismatch comparisons take the same time as
  // equal-length ones. This makes the utility safe to reuse with variable-length
  // inputs in the future — current callers (SHA-256 digests) always pass 32-byte
  // buffers, so the difference is academic for production but matters if the
  // function ever feeds an attacker-influenced length.
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const av = i < a.length ? a[i]! : 0;
    const bv = i < b.length ? b[i]! : 0;
    diff |= av ^ bv;
  }
  return diff === 0;
}

function toBase64Url(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const BASE64URL_TOKEN_PATTERN = BASE64URL_ALPHABET;
