/**
 * Formatte une date en format court DD.MM.YY (ex: 19.12.25).
 * Supporte le format ISO (YYYY-MM-DD), les formats existants, ou les objets Date.
 */
export const formatDate = (dateString: string | null | undefined): string => {
  if (!dateString) return '-';
  
  // Si c'est déjà au format DD.MM.YY ou DD.MM.YYYY
  if (/^\d{2}\.\d{2}\.\d{2,4}$/.test(dateString)) {
    // Si c'est YYYY (4 chiffres), on tronque à YY pour uniformiser
    const parts = dateString.split('.');
    if (parts[2] && parts[2].length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2].slice(-2)}`;
    }
    return dateString;
  }

  // Gérer le format ISO YYYY-MM-DD
  const isoMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const [_, year, month, day] = isoMatch;
    return `${day}.${month}.${year.slice(-2)}`;
  }

  // Repli : tenter de parser avec l'objet Date natif
  try {
    const d = new Date(dateString);
    if (!isNaN(d.getTime())) {
      const day = String(d.getDate()).padStart(2, '0');
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const year = String(d.getFullYear()).slice(-2);
      return `${day}.${month}.${year}`;
    }
  } catch (e) {
    // Échec du parsing
  }

  return dateString;
};

/**
 * Convertit une date (ISO ou DD.MM.YY) en timestamp numérique pour le tri.
 */
export const dateToTimestamp = (dateString: string | null | undefined): number => {
  if (!dateString) return 0;

  // Si format ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(dateString)) {
    return new Date(dateString).getTime();
  }

  // Si format DD.MM.YY ou DD.MM.YYYY
  const parts = dateString.split('.');
  if (parts.length === 3) {
    let [day, month, year] = parts;
    if (year.length === 2) {
      // Deviner le siècle (seuil 50)
      const yr = parseInt(year);
      year = yr > 50 ? `19${year}` : `20${year}`;
    }
    return new Date(`${year}-${month}-${day}`).getTime();
  }

  const d = new Date(dateString);
  return isNaN(d.getTime()) ? 0 : d.getTime();
};
