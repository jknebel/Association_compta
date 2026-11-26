/**
 * SEC-17 Web: CSPRNG token/ID generation via Web Crypto API and signup password policy.
 */

export const MIN_SIGNUP_PASSWORD_LENGTH = 12;
export const MIN_LOGIN_PASSWORD_LENGTH = 6;

export function generateSecureHexToken(byteLength: number = 16): string {
  const safeBytes =
    typeof byteLength === 'number' && Number.isFinite(byteLength) && byteLength >= 1
      ? Math.min(64, Math.floor(byteLength))
      : 16;
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error('Web Crypto CSPRNG indisponible.');
  }
  const buf = new Uint8Array(safeBytes);
  cryptoObj.getRandomValues(buf);
  let hex = '';
  for (let i = 0; i < buf.length; i += 1) {
    hex += buf[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function generateSecureInviteCode(byteLength: number = 16): string {
  return generateSecureHexToken(byteLength);
}

export function generateSecureShortToken(byteLength: number = 6): string {
  return generateSecureHexToken(byteLength);
}

export function generateSecureEntityId(prefix: string): string {
  const cleanPrefix = typeof prefix === 'string' && prefix.trim() ? prefix.trim() : 'id';
  return `${cleanPrefix}-${Date.now()}-${generateSecureShortToken(6)}`;
}

export function validateSignupPasswordPolicy(
  password: string,
  isSignUp: boolean
): { valid: boolean; error?: string } {
  const pwd = typeof password === 'string' ? password : '';
  if (isSignUp) {
    if (pwd.length < MIN_SIGNUP_PASSWORD_LENGTH) {
      return {
        valid: false,
        error: `Le mot de passe doit contenir au moins ${MIN_SIGNUP_PASSWORD_LENGTH} caractères lors de l'inscription.`,
      };
    }
    return { valid: true };
  }
  if (pwd.length < MIN_LOGIN_PASSWORD_LENGTH) {
    return {
      valid: false,
      error: `Le mot de passe doit contenir au moins ${MIN_LOGIN_PASSWORD_LENGTH} caractères.`,
    };
  }
  return { valid: true };
}
