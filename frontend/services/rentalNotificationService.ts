import { collection, addDoc, doc, getDoc, getDocs, setDoc, updateDoc, getFirestore } from 'firebase/firestore';
import { app } from './dataService';
import type { Rental, Receipt } from '../../types';

const getDb = () => {
  if (app) {
    return getFirestore(app);
  }
  return null;
};

export interface NotificationLog {
  id?: string;
  type: 'RENTAL_REMINDER_5_DAYS' | 'RENTAL_VISA_CONFIRMED';
  recipientEmail: string;
  recipientName?: string;
  rentalId: string;
  renterName: string;
  roomName: string;
  amount: number;
  subject: string;
  sentAt: string;
  status: 'QUEUED' | 'SENT' | 'LOGGED';
}

/**
 * Envoie un email au responsable de location dès que le caissier a visé / marqué payé sa location.
 */
export const notifyRentalManagerOnVisa = async (
  orgId: string,
  comptaId: string,
  rental: Rental,
  caissierName: string = 'Le caissier'
): Promise<boolean> => {
  const db = getDb();
  const recipientEmail = rental.createdByEmail;

  if (!recipientEmail || !recipientEmail.includes('@')) {
    console.warn(`Pas d'adresse e-mail connue pour le créateur de la location ${rental.id} (${rental.createdByName})`);
    return false;
  }

  const subject = `[AssoCompta TDGL] Location visée & confirmée : ${rental.renterName} (${rental.roomName})`;
  const textBody = `Bonjour ${rental.createdByName || 'Responsable des locations'},\n\nLa location pour « ${rental.renterName} » (${rental.roomName} - CHF ${rental.amount.toFixed(2)}) du ${rental.startDate} a bien été visée et enregistrée comme payée par ${caissierName}.\n\nLe statut a été mis à jour dans votre application mobile.\n\nCordialement,\nL'équipe AssoCompta TDGL`;

  const htmlBody = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; rounded: 12px; background: #ffffff;">
      <h2 style="color: #059669; margin-top: 0;">✓ Location visée et confirmée</h2>
      <p>Bonjour <strong>${rental.createdByName || 'Responsable des locations'}</strong>,</p>
      <p>La location suivante a bien été <strong>pointée et visée par la trésorerie</strong> :</p>
      <div style="background: #f8fafc; border-left: 4px solid #10b981; padding: 12px 16px; margin: 16px 0;">
        <p style="margin: 4px 0;"><strong>Locataire :</strong> ${rental.renterName}</p>
        <p style="margin: 4px 0;"><strong>Local / Salle :</strong> ${rental.roomName}</p>
        <p style="margin: 4px 0;"><strong>Date(s) :</strong> ${rental.startDate} ${rental.endDate && rental.endDate !== rental.startDate ? 'au ' + rental.endDate : ''}</p>
        <p style="margin: 4px 0;"><strong>Montant :</strong> <span style="color: #059669; font-weight: bold; font-size: 16px;">CHF ${rental.amount.toFixed(2)}</span></p>
        <p style="margin: 4px 0;"><strong>Visé par :</strong> ${caissierName}</p>
      </div>
      <p style="color: #475569; font-size: 13px;">Le statut a été automatiquement actualisé en vert sur votre application mobile.</p>
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
      <p style="color: #94a3b8; font-size: 11px;">Message automatique envoyé par AssoCompta Morges (TDGL).</p>
    </div>
  `;

  if (db) {
    try {
      // 1. File d'attente d'envoi d'e-mails (Firebase Trigger Email)
      await addDoc(collection(db, 'mail'), {
        to: [recipientEmail],
        message: {
          subject,
          text: textBody,
          html: htmlBody,
        },
        createdAt: new Date().toISOString(),
      });

      // 2. Journaliser la notification
      await addDoc(collection(db, 'organizations', orgId, 'comptabilites', comptaId, 'notifications'), {
        type: 'RENTAL_VISA_CONFIRMED',
        recipientEmail,
        recipientName: rental.createdByName,
        rentalId: rental.id,
        renterName: rental.renterName,
        roomName: rental.roomName,
        amount: rental.amount,
        subject,
        sentAt: new Date().toISOString(),
      });

      // 3. Mettre à jour le rental avec la date de notification
      await updateDoc(doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'rentals', rental.id), {
        visaNotifiedAt: new Date().toISOString(),
      });

      return true;
    } catch (err) {
      console.warn('Erreur envoi notification email visa :', err);
    }
  }

  return false;
};

/**
 * Vérifie toutes les locations non visées / en attente créées depuis plus de 5 jours
 * et envoie une alerte e-mail au caissier de groupe.
 */
export const checkAndAlertCaissierPendingRentals5Days = async (
  orgId: string,
  comptaId: string,
  rentals: Rental[],
  caissierEmail: string = 'jean.francois.knebel@gmail.com'
): Promise<number> => {
  const db = getDb();
  if (!db || !rentals || rentals.length === 0) return 0;

  const now = Date.now();
  const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
  let notifiedCount = 0;

  for (const r of rentals) {
    // Condition : Location pas encore payée/visée
    if (r.status === 'PAID') continue;

    // Déterminer la date de référence (date de création ou date de saisie)
    const creationTime = r.createdAt ? new Date(r.createdAt).getTime() : 0;
    if (!creationTime || isNaN(creationTime)) continue;

    const ageMs = now - creationTime;

    // Si plus de 5 jours et aucun rappel déjà envoyé
    if (ageMs >= FIVE_DAYS_MS && !r.reminder5DaysSentAt) {
      const subject = `[Rappel Caissier] Location à viser depuis 5 jours : ${r.renterName} (${r.roomName} - CHF ${r.amount.toFixed(2)})`;
      const textBody = `Bonjour,\n\nLa location pour « ${r.renterName} » (${r.roomName} - CHF ${r.amount.toFixed(2)}) a été saisie il y a plus de 5 jours et n'a pas encore été visée / pointée sur le relevé de compte bancaire.\n\nMerci de la vérifier dans votre application AssoCompta dès réception du virement sur le compte bancaire.\n\nCordialement,\nAssoCompta TDGL`;

      const htmlBody = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #fed7aa; rounded: 12px; background: #fffaf5;">
          <h2 style="color: #ea580c; margin-top: 0;">⏳ Rappel : Location à viser (5 jours écoulés)</h2>
          <p>Bonjour,</p>
          <p>La réservation suivante a été saisie il y a plus de 5 jours et est toujours <strong>en attente de visa / règlement bancaire</strong> :</p>
          <div style="background: #ffffff; border: 1px solid #fed7aa; border-left: 4px solid #f97316; padding: 12px 16px; margin: 16px 0; border-radius: 8px;">
            <p style="margin: 4px 0;"><strong>Locataire :</strong> ${r.renterName}</p>
            <p style="margin: 4px 0;"><strong>Local :</strong> ${r.roomName}</p>
            <p style="margin: 4px 0;"><strong>Date début :</strong> ${r.startDate}</p>
            <p style="margin: 4px 0;"><strong>Montant attendu :</strong> <span style="color: #ea580c; font-weight: bold; font-size: 16px;">CHF ${r.amount.toFixed(2)}</span></p>
            <p style="margin: 4px 0;"><strong>Saisie le :</strong> ${r.createdAt.split('T')[0]} par ${r.createdByName || 'Responsable'}</p>
          </div>
          <p style="color: #475569; font-size: 13px;">Vous pouvez la viser directement dans votre journal ou dans l'onglet « Locations » dès constatation du virement sur le compte groupe.</p>
        </div>
      `;

      try {
        // Envoi dans la file d'attente d'e-mails
        await addDoc(collection(db, 'mail'), {
          to: [caissierEmail],
          message: {
            subject,
            text: textBody,
            html: htmlBody,
          },
          createdAt: new Date().toISOString(),
        });

        // Journaliser la notification
        await addDoc(collection(db, 'organizations', orgId, 'comptabilites', comptaId, 'notifications'), {
          type: 'RENTAL_REMINDER_5_DAYS',
          recipientEmail: caissierEmail,
          rentalId: r.id,
          renterName: r.renterName,
          roomName: r.roomName,
          amount: r.amount,
          subject,
          sentAt: new Date().toISOString(),
        });

        // Marquer la location comme ayant reçu le rappel des 5 jours pour ne pas la notifier en boucle
        await updateDoc(doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'rentals', r.id), {
          reminder5DaysSentAt: new Date().toISOString(),
        });

        notifiedCount++;
      } catch (err) {
        console.warn('Erreur envoi rappel caissier 5 jours :', err);
      }
    }
  }

  return notifiedCount;
};

/**
 * Calcule la clé de semaine ISO courante (ex: "2026-W46") pour éviter d'envoyer
 * plusieurs fois la synthèse du vendredi 12h00 dans la même semaine.
 */
export const getIsoWeekKey = (date: Date = new Date()): string => {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
};

/**
 * Vérifie si l'heure courante a atteint ou dépassé le vendredi 12h00 de la semaine en cours.
 * (Vendredi >= 12h00, Samedi ou Dimanche de la même semaine).
 */
export const isPastFriday12hForCurrentWeek = (now: Date = new Date()): boolean => {
  const day = now.getDay(); // 0 = Dimanche, 1 = Lundi, ..., 5 = Vendredi, 6 = Samedi
  const hours = now.getHours();
  if (day === 5 && hours >= 12) return true;
  if (day === 6 || day === 0) return true;
  return false;
};

/**
 * Récupère les adresses e-mail des caissiers affectés à la comptabilité (ou à défaut l'e-mail du caissier/admin).
 */
export const resolveComptaCaissierEmails = async (
  orgId: string,
  comptaId: string,
  fallbackEmail: string = 'jean.francois.knebel@gmail.com'
): Promise<string[]> => {
  const db = getDb();
  const emails = new Set<string>();

  if (db && orgId) {
    try {
      const membersSnap = await getDocs(collection(db, 'organizations', orgId, 'members'));
      for (const mDoc of membersSnap.docs) {
        const data = mDoc.data() as Record<string, unknown>;
        if (data.status === 'rejected') continue;
        const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
        if (!email || !email.includes('@')) continue;

        const comptaAccess = (data.comptaAccess && typeof data.comptaAccess === 'object')
          ? (data.comptaAccess as Record<string, string>)
          : {};
        const roleOnCompta = (comptaAccess[comptaId] || '').toLowerCase();
        const orgRole = typeof data.role === 'string' ? data.role.toLowerCase() : '';

        if (roleOnCompta === 'caissier' || roleOnCompta === 'comptable' || orgRole === 'caissier') {
          emails.add(email);
        }
      }
    } catch (e) {
      console.warn('Impossible de résoudre les caissiers de la comptabilité :', e);
    }
  }

  if (emails.size === 0 && fallbackEmail && fallbackEmail.includes('@')) {
    emails.add(fallbackEmail.trim().toLowerCase());
  }

  return Array.from(emails);
};

/**
 * Envoie un e-mail de synthèse des remboursements en attente au(x) caissier(s) de la comptabilité.
 */
export const sendReimbursementSynthesisEmail = async (
  orgId: string,
  comptaId: string,
  comptaName: string,
  receipts: Receipt[],
  explicitRecipients?: string[],
  isManualTrigger: boolean = false
): Promise<{ sent: boolean; recipients: string[]; count: number; totalAmount: number }> => {
  const db = getDb();
  const pending = (receipts || []).filter(
    (r) => r.expenseType === 'REIMBURSEMENT' && r.reimbursementStatus !== 'REIMBURSED'
  );

  const totalAmount = pending.reduce((sum, r) => sum + Number(r.extractedAmount || 0), 0);

  if (!db || pending.length === 0) {
    return { sent: false, recipients: [], count: pending.length, totalAmount };
  }

  const recipients =
    explicitRecipients && explicitRecipients.length > 0
      ? explicitRecipients
      : await resolveComptaCaissierEmails(orgId, comptaId);

  if (recipients.length === 0) {
    return { sent: false, recipients: [], count: pending.length, totalAmount };
  }

  const subject = `[AssoCompta — ${comptaName}] Synthèse du vendredi : ${pending.length} remboursement${pending.length > 1 ? 's' : ''} en attente (CHF ${totalAmount.toFixed(2)})`;

  const linesText = pending
    .map((r, idx) => {
      const member = r.submittedByName || r.submittedByEmail || 'Membre';
      const email = r.submittedByEmail ? ` (${r.submittedByEmail})` : '';
      const motif = r.merchantName || r.description || r.fileName || 'Justificatif';
      const dateStr = r.extractedDate || (r.uploadDate ? r.uploadDate.split('T')[0] : '—');
      const iban = r.reimbursementIban || 'IBAN non renseigné';
      const amt = Number(r.extractedAmount || 0).toFixed(2);
      return `${idx + 1}. ${member}${email} — CHF ${amt}\n   Date : ${dateStr} | Motif : ${motif}\n   IBAN : ${iban}`;
    })
    .join('\n\n');

  const textBody = `Bonjour,\n\nVoici la synthèse hebdomadaire du vendredi (12h00) des demandes de remboursement en attente pour la comptabilité « ${comptaName} » afin de pouvoir les traiter dans les meilleurs délais :\n\nNombre de demandes : ${pending.length}\nMontant total à rembourser : CHF ${totalAmount.toFixed(2)}\n\n--------------------------------------------------\n${linesText}\n--------------------------------------------------\n\nVous pouvez consulter les pièces justificatives, copier les IBAN en 1 clic et biffer les remboursements effectués directement sur :\nhttps://compta-ai-v2.web.app\n\nCordialement,\nAssoCompta TDGL`;

  const rowsHtml = pending
    .map((r) => {
      const member = r.submittedByName || 'Membre';
      const email = r.submittedByEmail || '';
      const motif = r.merchantName || r.description || r.fileName || 'Justificatif';
      const dateStr = r.extractedDate || (r.uploadDate ? r.uploadDate.split('T')[0] : '—');
      const iban = r.reimbursementIban || '—';
      const amt = Number(r.extractedAmount || 0).toFixed(2);
      return `
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 10px 8px; font-size: 13px; color: #334155;">${dateStr}</td>
          <td style="padding: 10px 8px; font-size: 13px; color: #0f172a;">
            <strong>${member}</strong>
            ${email ? `<br/><span style="font-size: 11px; color: #64748b;">${email}</span>` : ''}
          </td>
          <td style="padding: 10px 8px; font-size: 13px; color: #334155;">${motif}</td>
          <td style="padding: 10px 8px; font-size: 12px; font-family: monospace; color: #0f172a;">${iban}</td>
          <td style="padding: 10px 8px; font-size: 13px; font-weight: bold; color: #d97706; text-align: right; white-space: nowrap;">CHF ${amt}</td>
        </tr>
      `;
    })
    .join('');

  const htmlBody = `
    <div style="font-family: sans-serif; max-width: 680px; margin: 0 auto; padding: 24px; border: 1px solid #fde68a; border-radius: 12px; background: #ffffff;">
      <div style="border-bottom: 2px solid #f59e0b; padding-bottom: 12px; margin-bottom: 16px;">
        <h2 style="color: #b45309; margin: 0; font-size: 18px;">💶 Synthèse des remboursements en attente — ${comptaName}</h2>
        <p style="color: #64748b; font-size: 12px; margin: 4px 0 0 0;">Récapitulatif hebdomadaire du vendredi 12h00 pour exécution rapide des virements</p>
      </div>

      <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 14px 16px; margin-bottom: 20px;">
        <p style="margin: 0; font-size: 14px; color: #92400e;">
          <strong>${pending.length} demande${pending.length > 1 ? 's' : ''} à rembourser</strong> pour un total de
          <strong style="font-size: 17px; color: #b45309;"> CHF ${totalAmount.toFixed(2)}</strong>
        </p>
      </div>

      <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
        <thead>
          <tr style="background: #f8fafc; border-bottom: 2px solid #cbd5e1; text-align: left;">
            <th style="padding: 8px; font-size: 11px; text-transform: uppercase; color: #475569;">Date</th>
            <th style="padding: 8px; font-size: 11px; text-transform: uppercase; color: #475569;">Membre</th>
            <th style="padding: 8px; font-size: 11px; text-transform: uppercase; color: #475569;">Motif / Commerce</th>
            <th style="padding: 8px; font-size: 11px; text-transform: uppercase; color: #475569;">IBAN</th>
            <th style="padding: 8px; font-size: 11px; text-transform: uppercase; color: #475569; text-align: right;">Montant</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>

      <div style="text-align: center; margin: 24px 0 12px 0;">
        <a href="https://compta-ai-v2.web.app" style="display: inline-block; background: #d97706; color: #ffffff; text-decoration: none; font-weight: bold; font-size: 13px; padding: 10px 20px; border-radius: 8px;">
          Ouvrir AssoCompta et pointer les remboursements
        </a>
      </div>

      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
      <p style="color: #94a3b8; font-size: 11px; margin: 0;">
        ${isManualTrigger ? 'Synthèse déclenchée depuis l’onglet Remboursements.' : 'Synthèse automatique hebdomadaire (vendredi 12h00) — AssoCompta TDGL.'}
      </p>
    </div>
  `;

  await addDoc(collection(db, 'mail'), {
    to: recipients,
    message: {
      subject,
      text: textBody,
      html: htmlBody,
    },
    createdAt: new Date().toISOString(),
  });

  const weekKey = getIsoWeekKey(new Date());
  await setDoc(
    doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'settings', 'reimbursementDigest'),
    {
      lastSentWeekKey: weekKey,
      lastSentAt: new Date().toISOString(),
      lastPendingCount: pending.length,
      lastTotalAmount: totalAmount,
      recipients,
    },
    { merge: true }
  );

  await addDoc(collection(db, 'organizations', orgId, 'comptabilites', comptaId, 'notifications'), {
    type: 'FRIDAY_REIMBURSEMENT_SYNTHESIS',
    recipients,
    pendingCount: pending.length,
    totalAmount,
    weekKey,
    subject,
    sentAt: new Date().toISOString(),
  });

  return { sent: true, recipients, count: pending.length, totalAmount };
};

/**
 * Vérifie automatiquement si nous sommes vendredi >= 12h00 (ou week-end) et si la synthèse
 * de la semaine en cours n'a pas encore été envoyée au caissier pour cette comptabilité.
 */
export const checkAndSendFriday12hReimbursementDigest = async (
  orgId: string,
  comptaId: string,
  comptaName: string,
  receipts: Receipt[],
  fallbackEmail: string = 'jean.francois.knebel@gmail.com'
): Promise<boolean> => {
  const db = getDb();
  if (!db || !orgId || !comptaId) return false;

  const pending = (receipts || []).filter(
    (r) => r.expenseType === 'REIMBURSEMENT' && r.reimbursementStatus !== 'REIMBURSED'
  );
  if (pending.length === 0) return false;

  const now = new Date();
  if (!isPastFriday12hForCurrentWeek(now)) {
    return false;
  }

  const currentWeekKey = getIsoWeekKey(now);
  try {
    const digestRef = doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'settings', 'reimbursementDigest');
    const snap = await getDoc(digestRef);
    if (snap.exists()) {
      const data = snap.data() as { lastSentWeekKey?: string };
      if (data.lastSentWeekKey === currentWeekKey) {
        return false; // Déjà envoyé pour ce vendredi
      }
    }

    const recipients = await resolveComptaCaissierEmails(orgId, comptaId, fallbackEmail);
    const res = await sendReimbursementSynthesisEmail(orgId, comptaId, comptaName, receipts, recipients, false);
    return res.sent;
  } catch (err) {
    console.warn('Erreur lors de la vérification de la synthèse remboursements du vendredi 12h :', err);
    return false;
  }
};

/**
 * Envoie un e-mail de confirmation au membre qui attend son remboursement
 * dès que le caissier coche / marque le remboursement comme effectué ("REIMBURSED").
 */
export const notifyMemberOnReimbursementDone = async (
  orgId: string,
  comptaId: string,
  comptaName: string,
  receipt: Receipt,
  caissierName: string = 'Le caissier'
): Promise<boolean> => {
  const db = getDb();
  let recipientEmail = (receipt.submittedByEmail || '').trim().toLowerCase();
  let memberName = (receipt.submittedByName || '').trim();

  // Fallback : si l'email du déposant n'était pas renseigné sur le reçu mais qu'on a son UID
  if ((!recipientEmail || !recipientEmail.includes('@')) && db && receipt.submittedByUid) {
    try {
      const userSnap = await getDoc(doc(db, 'users', receipt.submittedByUid));
      if (userSnap.exists()) {
        const uData = userSnap.data() as { email?: string; displayName?: string };
        if (uData.email && uData.email.includes('@')) {
          recipientEmail = uData.email.trim().toLowerCase();
        }
        if (!memberName && uData.displayName) {
          memberName = uData.displayName.trim();
        }
      }
    } catch {
      // ignorer
    }
  }

  if (!recipientEmail || !recipientEmail.includes('@')) {
    console.warn(`Pas d'adresse e-mail trouvée pour notifier le remboursement du justificatif ${receipt.id}`);
    return false;
  }

  const amount = Number(receipt.extractedAmount || 0);
  const motif = receipt.merchantName || receipt.description || receipt.fileName || 'Votre justificatif';
  const dateStr = receipt.extractedDate || (receipt.uploadDate ? receipt.uploadDate.split('T')[0] : '—');
  const ibanStr = receipt.reimbursementIban || 'votre compte bancaire enregistré';

  const subject = `[AssoCompta — ${comptaName}] Votre remboursement a été effectué (CHF ${amount.toFixed(2)})`;

  const textBody = `Bonjour ${memberName || 'Membre'},\n\nBonne nouvelle ! Le caissier (${caissierName}) vient d'indiquer que votre demande de remboursement a été effectuée :\n\n• Comptabilité : ${comptaName}\n• Motif / Commerce : ${motif}\n• Date du justificatif : ${dateStr}\n• Montant remboursé : CHF ${amount.toFixed(2)}\n• IBAN crédité : ${ibanStr}\n\nVous pouvez vérifier la bonne réception du virement sur votre compte bancaire ainsi que le statut « ✅ Remboursé » dans l'onglet « Mes envois » de votre application mobile :\nhttps://justificatifs-tdgl.web.app\n\nCordialement,\nL'équipe AssoCompta TDGL`;

  const htmlBody = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #a7f3d0; border-radius: 12px; background: #ffffff;">
      <h2 style="color: #059669; margin-top: 0;">✅ Votre remboursement a été effectué</h2>
      <p>Bonjour <strong>${memberName || 'Membre'}</strong>,</p>
      <p>Le caissier (<strong>${caissierName}</strong>) vient de valider et d'exécuter votre demande de remboursement :</p>
      <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-left: 4px solid #10b981; padding: 14px 16px; margin: 16px 0; border-radius: 8px;">
        <p style="margin: 4px 0;"><strong>Comptabilité :</strong> ${comptaName}</p>
        <p style="margin: 4px 0;"><strong>Commerce / Motif :</strong> ${motif}</p>
        <p style="margin: 4px 0;"><strong>Date du justificatif :</strong> ${dateStr}</p>
        <p style="margin: 4px 0;"><strong>IBAN :</strong> <span style="font-family: monospace;">${ibanStr}</span></p>
        <p style="margin: 6px 0 0 0;"><strong>Montant remboursé :</strong> <span style="color: #059669; font-weight: bold; font-size: 17px;">CHF ${amount.toFixed(2)}</span></p>
      </div>
      <p style="color: #334155; font-size: 13px;">
        Vous pouvez vérifier la réception du virement sur votre compte bancaire. Le statut de votre justificatif est également passé à <strong>« ✅ Remboursé »</strong> dans votre application mobile (<a href="https://justificatifs-tdgl.web.app" style="color: #059669;">justificatifs-tdgl.web.app</a>).
      </p>
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
      <p style="color: #94a3b8; font-size: 11px; margin: 0;">Notification automatique envoyée par AssoCompta TDGL.</p>
    </div>
  `;

  if (db) {
    try {
      await addDoc(collection(db, 'mail'), {
        to: [recipientEmail],
        message: {
          subject,
          text: textBody,
          html: htmlBody,
        },
        createdAt: new Date().toISOString(),
      });

      await addDoc(collection(db, 'organizations', orgId, 'comptabilites', comptaId, 'notifications'), {
        type: 'REIMBURSEMENT_DONE_MEMBER_NOTIFIED',
        recipientEmail,
        recipientName: memberName,
        receiptId: receipt.id,
        amount,
        subject,
        sentAt: new Date().toISOString(),
      });

      return true;
    } catch (err) {
      console.warn('Erreur lors de l’envoi de l’e-mail de confirmation de remboursement :', err);
    }
  }

  return false;
};
