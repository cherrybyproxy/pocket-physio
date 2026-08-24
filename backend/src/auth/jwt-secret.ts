// jwt secret resolution: environment -> file -> ephemeral random (with warning).
// never hardcodes a literal secret. follows the multi-tiered fallback pattern.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

let cachedSecret: string | null = null;

export function getJwtSecret(): string {
  if (cachedSecret) return cachedSecret;

  // tier 1: environment variable
  if (process.env['JWT_SECRET']) {
    cachedSecret = process.env['JWT_SECRET'];
    return cachedSecret;
  }

  // tier 2: local file (for dev environments)
  const secretPath = path.resolve(process.cwd(), 'jwt_secret.txt');
  if (fs.existsSync(secretPath)) {
    cachedSecret = fs.readFileSync(secretPath, 'utf-8').trim();
    if (cachedSecret.length > 0) return cachedSecret;
  }

  // tier 3: generate ephemeral secret (single-instance only)
  console.warn(
    'WARNING: generating ephemeral jwt secret. tokens will not survive restarts ' +
    'and are not valid across multiple instances. set JWT_SECRET in your environment.'
  );
  cachedSecret = crypto.randomBytes(32).toString('hex');
  return cachedSecret;
}
