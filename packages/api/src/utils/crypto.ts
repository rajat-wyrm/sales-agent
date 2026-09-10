import bcrypt from 'bcryptjs';
import crypto from 'crypto';

export async function hashPassword(password: string): Promise<string> {
  const saltRounds = 12;
  return bcrypt.hash(password, saltRounds);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET;
if (!ENCRYPTION_SECRET) {
  throw new Error(
    'ENCRYPTION_SECRET environment variable must be set to a strong random value. ' +
    'Generate one with: openssl rand -hex 32',
  );
}

const ENCRYPTION_KEY = crypto.scryptSync(ENCRYPTION_SECRET, 'salt', 32);

export function encryptText(text: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptText(encrypted: string): string {
  const data = Buffer.from(encrypted, 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encryptedText = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString('utf8');
}

export function encryptApiKeys(keys: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(keys)) {
    if (value) {
      result[key] = encryptText(value);
    }
  }
  return result;
}

export function decryptApiKeys(keys: Record<string, string>): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(keys)) {
    if (value) {
      result[key] = decryptText(value);
    }
  }
  return result;
}
