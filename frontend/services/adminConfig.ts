/**
 * Configuration des comptes super-administrateurs et d'exemption de vérification e-mail (SEC-18).
 * Module autonome sans dépendance relative runtime pour compatibilité Node ESM & Vite.
 */

export const DEFAULT_SUPER_ADMIN_EMAILS: readonly string[] = [
  'jean.francois.knebel@gmail.com',
  'jean-francois@knebel.ch',
];

export const DEFAULT_EXEMPT_VERIFICATION_EMAILS: readonly string[] = [
  'jean.francois.knebel@gmail.com',
  'jean-francois@knebel.ch',
  'quokka@tdgl.ch',
];

export const parseConfiguredEmails = (
  rawEnv?: string | null,
  fallback: readonly string[] = DEFAULT_SUPER_ADMIN_EMAILS
): string[] => {
  if (typeof rawEnv === 'string' && rawEnv.trim().length > 0) {
    return Array.from(
      new Set(
        rawEnv
          .split(/[,;]/)
          .map((item) => item.trim().toLowerCase())
          .filter((item) => item.includes('@'))
      )
    );
  }
  return [...fallback];
};

export const resolveSuperAdminAccess = (params: {
  claims?: Record<string, unknown> | null;
  email?: string | null;
  rawSuperAdminEmailsEnv?: string | null;
}): boolean => {
  if (params?.claims?.superAdmin === true) {
    return true;
  }
  const normEmail = typeof params?.email === 'string' ? params.email.trim().toLowerCase() : '';
  if (!normEmail) {
    return false;
  }
  const configured = parseConfiguredEmails(params?.rawSuperAdminEmailsEnv, DEFAULT_SUPER_ADMIN_EMAILS);
  return configured.includes(normEmail);
};

export const isEmailExemptFromVerification = (
  email?: string | null,
  rawExemptEmailsEnv?: string | null
): boolean => {
  const normEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normEmail) {
    return false;
  }
  const configured = parseConfiguredEmails(rawExemptEmailsEnv, DEFAULT_EXEMPT_VERIFICATION_EMAILS);
  return configured.includes(normEmail);
};
