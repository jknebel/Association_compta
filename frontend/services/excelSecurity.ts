/**
 * SEC-12 Web: Bounded Excel file validation, safe SheetJS parsing options,
 * and spreadsheet formula-injection neutralization.
 */

export const MAX_EXCEL_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_EXCEL_ROWS = 10000;
export const ALLOWED_EXCEL_EXTENSIONS = ['.xlsx', '.xls'] as const;

export const SAFE_XLSX_READ_OPTIONS = {
  sheetRows: MAX_EXCEL_ROWS + 1,
  cellFormula: false,
  cellHTML: false,
} as const;

export interface ExcelFileValidationResult {
  valid: boolean;
  error?: string;
}

export function validateExcelUploadFile(
  file: { name?: string | null; size?: number | null } | null | undefined
): ExcelFileValidationResult {
  if (!file || typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size <= 0) {
    return { valid: false, error: 'Fichier Excel invalide ou vide.' };
  }
  if (file.size > MAX_EXCEL_FILE_BYTES) {
    return {
      valid: false,
      error: `Fichier Excel trop volumineux (max ${Math.round(MAX_EXCEL_FILE_BYTES / (1024 * 1024))} Mo).`,
    };
  }
  const cleanName = typeof file.name === 'string' ? file.name.trim().toLowerCase() : '';
  const hasAllowedExt = ALLOWED_EXCEL_EXTENSIONS.some((ext) => cleanName.endsWith(ext));
  if (!hasAllowedExt) {
    return { valid: false, error: 'Format de fichier invalide (.xlsx ou .xls requis).' };
  }
  return { valid: true };
}

export function enforceExcelRowLimit(rows: readonly unknown[]): void {
  if (!Array.isArray(rows)) {
    throw new Error('Contenu Excel invalide.');
  }
  if (rows.length > MAX_EXCEL_ROWS) {
    throw new Error(`Nombre de lignes Excel maximal dépassé (${MAX_EXCEL_ROWS} max).`);
  }
}

export function sanitizeExcelTextCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  const text = String(value);
  if (text.length === 0) return '';
  const startsWithFormulaTrigger = /^[=+\-@\t\r]/.test(text);
  const isPlainNegativeNumber = /^-\d+(\.\d+)?$/.test(text.trim());
  if (startsWithFormulaTrigger && !isPlainNegativeNumber) {
    return `'${text}`;
  }
  return text;
}
