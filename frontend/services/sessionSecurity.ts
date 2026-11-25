/**
 * SEC-10 Web: localStorage key isolation, logout purge, and production local/demo mode guardrails.
 */

export const WEB_MIGRATION_FLAG_KEY = 'asso_compta_v1_migrated';

export const WEB_SENSITIVE_STORAGE_KEYS: readonly string[] = [
  'asso_compta_accounts_v5',
  'asso_compta_transactions_v5',
  'asso_compta_receipts_v5',
  'asso_compta_ai_context_v5',
];

export const PROD_FIREBASE_MISSING_WEB_ERROR =
  'Configuration Firebase manquante en production. Contactez un administrateur.';

export function canUseWebLocalMode(
  isConfigured: boolean,
  isGuest: boolean,
  isProd: boolean
): boolean {
  if (isProd) return false;
  return Boolean(isGuest || !isConfigured);
}

export function scopedWebStorageKey(baseKey: string, uid?: string | null): string {
  const cleanUid = typeof uid === 'string' ? uid.trim() : '';
  return cleanUid ? `${baseKey}_${cleanUid}` : baseKey;
}

function isSensitiveKey(key: string): boolean {
  if (key === WEB_MIGRATION_FLAG_KEY) return false;
  return WEB_SENSITIVE_STORAGE_KEYS.some(
    (prefix) => key === prefix || key.startsWith(`${prefix}_`)
  );
}

export function purgeWebSensitiveStorage(
  storage?: Storage | null,
  knownUids: readonly string[] = []
): number {
  const s =
    storage !== undefined
      ? storage
      : typeof localStorage !== 'undefined'
      ? localStorage
      : null;
  if (!s) return 0;

  const keysToRemove = new Set<string>(WEB_SENSITIVE_STORAGE_KEYS);
  for (const uid of knownUids) {
    const cleanUid = typeof uid === 'string' ? uid.trim() : '';
    if (!cleanUid) continue;
    for (const prefix of WEB_SENSITIVE_STORAGE_KEYS) {
      keysToRemove.add(`${prefix}_${cleanUid}`);
    }
  }

  try {
    if (typeof s.length === 'number' && typeof s.key === 'function') {
      for (let i = 0; i < s.length; i += 1) {
        const k = s.key(i);
        if (typeof k === 'string' && isSensitiveKey(k)) {
          keysToRemove.add(k);
        }
      }
    }
  } catch {
    // Ignore enumeration failures in restricted environments
  }

  let removedCount = 0;
  for (const key of keysToRemove) {
    try {
      const existed = s.getItem(key) !== null;
      s.removeItem(key);
      if (existed) removedCount += 1;
    } catch {
      // Ignore individual key deletion errors
    }
  }
  return removedCount;
}
