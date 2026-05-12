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
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

function toBase64Url(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const BASE64URL_TOKEN_PATTERN = BASE64URL_ALPHABET;
