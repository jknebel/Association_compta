import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  splitSubmitterIdentity,
  scoreReceiptTransactionMatch,
  findPotentialMatchesForReceipt,
  toggleReceiptReimbursed,
  filterReimbursementReceipts,
  computeReimbursementStats,
  matchTransactionsWithReceipts,
} from '../reimbursementMatching.ts';

describe('WEB-04 — Gestion des Remboursements & Rapprochement Bancaire (Carte vs Remboursement)', () => {
  describe('splitSubmitterIdentity (Nom, Prénom, E-mail)', () => {
    it('sépare correctement le prénom et le nom complet avec e-mail', () => {
      const res = splitSubmitterIdentity('Jean-François Knebel', 'jf.knebel@asso.ch');
      assert.equal(res.firstName, 'Jean-François');
      assert.equal(res.lastName, 'Knebel');
      assert.equal(res.email, 'jf.knebel@asso.ch');
      assert.equal(res.displayFullName, 'Jean-François Knebel');
    });

    it('gère les noms composés à plusieurs mots', () => {
      const res = splitSubmitterIdentity('Marie De La Fontaine', 'marie@asso.ch');
      assert.equal(res.firstName, 'Marie');
      assert.equal(res.lastName, 'De La Fontaine');
    });

    it('gère un prénom seul sans nom de famille', () => {
      const res = splitSubmitterIdentity('Sophie', 'sophie@asso.ch');
      assert.equal(res.firstName, 'Sophie');
      assert.equal(res.lastName, '-');
      assert.equal(res.email, 'sophie@asso.ch');
    });

    it('déduit le prénom et le nom depuis l’adresse e-mail si submittedByName est vide', () => {
      const res = splitSubmitterIdentity('', 'marc.dupont@club.ch');
      assert.equal(res.firstName, 'Marc');
      assert.equal(res.lastName, 'Dupont');
      assert.equal(res.email, 'marc.dupont@club.ch');
    });

    it('retourne des tirets si aucune information n’est fournie', () => {
      const res = splitSubmitterIdentity(null, null);
      assert.equal(res.firstName, '-');
      assert.equal(res.lastName, '-');
      assert.equal(res.email, '-');
      assert.equal(res.displayFullName, 'Membre non renseigné');
    });
  });

  describe('scoreReceiptTransactionMatch — Carte de débit (J / J+1) vs Remboursement (indépendant de la date)', () => {
    it('accorde le score maximal (+20 bonus date) à une dépense par carte le jour même (J) ou le jour suivant (J+1)', () => {
      const cardReceipt = {
        id: 'r-card-1',
        url: 'https://storage/r1.jpg',
        fileName: 'coop.jpg',
        uploadDate: '2026-03-10',
        extractedDate: '2026-03-10',
        extractedAmount: 45.5,
        isAnalyzed: true,
        expenseType: 'DEBIT_CARD',
        merchantName: 'Coop',
      };

      const txnSameDay = {
        id: 't-same',
        date: '2026-03-10',
        description: 'Paiement carte Coop Pronto',
        amount: -45.5,
        status: 'PENDING',
      };
      const txnNextDay = {
        id: 't-next',
        date: '2026-03-11',
        description: 'Debit Card Coop',
        amount: -45.5,
        status: 'PENDING',
      };
      const txnWeekendDelay = {
        id: 't-weekend',
        date: '2026-03-13',
        description: 'Debit Card',
        amount: -45.5,
        status: 'PENDING',
      };
      const txnTooLateForCard = {
        id: 't-late',
        date: '2026-03-28',
        description: 'Coop',
        amount: -45.5,
        status: 'PENDING',
      };

      const sSame = scoreReceiptTransactionMatch(cardReceipt, txnSameDay);
      const sNext = scoreReceiptTransactionMatch(cardReceipt, txnNextDay);
      const sWeekend = scoreReceiptTransactionMatch(cardReceipt, txnWeekendDelay);
      const sLate = scoreReceiptTransactionMatch(cardReceipt, txnTooLateForCard);

      assert.ok(sSame >= 30, `Attendu >= 30 pour J, reçu ${sSame}`);
      assert.ok(sNext >= 30, `Attendu >= 30 pour J+1, reçu ${sNext}`);
      assert.ok(sSame > sWeekend, 'J/J+1 doit avoir un meilleur score que J+3');
      assert.equal(sLate, -1, 'Une carte débitée 18 jours plus tard doit être rejetée (-1)');
    });

    it('ne pénalise PAS l’écart de date pour un remboursement (ex: 35 jours plus tard) et bonifie le nom/prénom du membre', () => {
      const reimbReceipt = {
        id: 'r-reimb-1',
        url: 'https://storage/r2.pdf',
        fileName: 'facture_migros.pdf',
        uploadDate: '2026-02-01',
        extractedDate: '2026-02-01',
        extractedAmount: 128.9,
        isAnalyzed: true,
        expenseType: 'REIMBURSEMENT',
        submittedByName: 'Claire Martin',
        submittedByEmail: 'claire.martin@asso.ch',
        merchantName: 'Migros',
        description: 'Achat boissons tournoi',
      };

      const txnReimbWithMemberName = {
        id: 't-reimb-member',
        date: '2026-03-08', // 35 jours après la date du justificatif !
        description: 'Virement remboursement Claire Martin frais tournoi',
        amount: -128.9,
        status: 'PENDING',
      };

      const txnReimbAmountOnly = {
        id: 't-reimb-anon',
        date: '2026-03-08',
        description: 'Ordre de paiement e-banking',
        amount: -128.9,
        status: 'PENDING',
      };

      const scoreWithMember = scoreReceiptTransactionMatch(reimbReceipt, txnReimbWithMemberName);
      const scoreAmountOnly = scoreReceiptTransactionMatch(reimbReceipt, txnReimbAmountOnly);

      assert.ok(scoreAmountOnly >= 16, `Un remboursement 35j plus tard doit être accepté (>=16), reçu ${scoreAmountOnly}`);
      assert.ok(
        scoreWithMember > scoreAmountOnly + 15,
        `Le remboursement mentionnant Claire Martin doit avoir un fort bonus (${scoreWithMember} vs ${scoreAmountOnly})`
      );

      const matches = findPotentialMatchesForReceipt(reimbReceipt, [
        txnReimbAmountOnly,
        txnReimbWithMemberName,
      ]);
      assert.equal(matches.length, 2);
      assert.equal(matches[0].id, 't-reimb-member');

      // Vérifie spécifiquement le bonus du nom de famille seul (+12)
      const txnLastNameOnly = {
        id: 't-reimb-lastname',
        date: '2026-03-08',
        description: 'Virement bancaire Martin',
        amount: -128.9,
        status: 'PENDING',
      };
      const scoreLastNameOnly = scoreReceiptTransactionMatch(reimbReceipt, txnLastNameOnly);
      assert.equal(scoreLastNameOnly, scoreAmountOnly + 12);
    });

    it('rejette les transactions déjà liées ou de montant positif pour une dépense', () => {
      const receipt = {
        id: 'r-1',
        url: 'u',
        fileName: 'f.jpg',
        uploadDate: '2026-03-01',
        extractedDate: '2026-03-01',
        extractedAmount: 50,
        isAnalyzed: true,
        expenseType: 'REIMBURSEMENT',
      };
      assert.equal(
        scoreReceiptTransactionMatch(receipt, {
          id: 't1',
          date: '2026-03-05',
          description: 'Cotisation',
          amount: 50, // positif (recette)
          status: 'PENDING',
        }),
        -1
      );
      assert.equal(
        scoreReceiptTransactionMatch(receipt, {
          id: 't2',
          date: '2026-03-05',
          description: 'Déjà lié',
          amount: -50,
          receiptUrl: 'https://already.linked',
          status: 'PENDING',
        }),
        -1
      );
    });
  });

  describe('toggleReceiptReimbursed, filterReimbursementReceipts & computeReimbursementStats (Biffer les remboursements)', () => {
    const sampleReceipts = [
      {
        id: 'r1',
        url: 'u1',
        fileName: 'f1.jpg',
        uploadDate: '2026-03-01',
        extractedDate: '2026-03-01',
        extractedAmount: 40.0,
        isAnalyzed: true,
        expenseType: 'REIMBURSEMENT',
        reimbursementStatus: 'PENDING',
        submittedByName: 'Alice Rochat',
        submittedByEmail: 'alice@asso.ch',
        reimbursementIban: 'CH9300762011623852957',
      },
      {
        id: 'r2',
        url: 'u2',
        fileName: 'f2.jpg',
        uploadDate: '2026-03-05',
        extractedDate: '2026-03-05',
        extractedAmount: 60.25,
        isAnalyzed: true,
        expenseType: 'REIMBURSEMENT',
        reimbursementStatus: 'REIMBURSED',
        reimbursedAt: 1772700000000,
        reimbursedByName: 'Trésorier',
        submittedByName: 'Bob Borel',
        submittedByEmail: 'bob@asso.ch',
      },
      {
        id: 'r3',
        url: 'u3',
        fileName: 'f3.jpg',
        uploadDate: '2026-03-06',
        extractedAmount: 25.0,
        isAnalyzed: true,
        expenseType: 'DEBIT_CARD',
      },
    ];

    it('biffe et débiffe un remboursement avec traçabilité', () => {
      const biffed = toggleReceiptReimbursed(
        sampleReceipts[0],
        { uid: 'u-caissier', name: 'Jean Caissier' },
        1773000000000
      );
      assert.equal(biffed.reimbursementStatus, 'REIMBURSED');
      assert.equal(biffed.reimbursedByUid, 'u-caissier');
      assert.equal(biffed.reimbursedByName, 'Jean Caissier');
      assert.equal(biffed.reimbursedAt, 1773000000000);

      const unbiffed = toggleReceiptReimbursed(biffed, { uid: 'u-caissier', name: 'Jean Caissier' });
      assert.equal(unbiffed.reimbursementStatus, 'PENDING');
      assert.equal(unbiffed.reimbursedAt, undefined);
      assert.equal(unbiffed.reimbursedByUid, undefined);
    });

    it('calcule les statistiques de remboursements en ignorant les achats par carte', () => {
      const stats = computeReimbursementStats(sampleReceipts);
      assert.equal(stats.pendingCount, 1);
      assert.equal(stats.pendingTotalChf, 40.0);
      assert.equal(stats.reimbursedCount, 1);
      assert.equal(stats.reimbursedTotalChf, 60.25);
      assert.equal(stats.totalCount, 2);
    });

    it('filtre par statut (PENDING, REIMBURSED, ALL) et par recherche (nom, prénom, email, IBAN)', () => {
      assert.equal(filterReimbursementReceipts(sampleReceipts, 'PENDING').length, 1);
      assert.equal(filterReimbursementReceipts(sampleReceipts, 'REIMBURSED').length, 1);
      assert.equal(filterReimbursementReceipts(sampleReceipts, 'ALL').length, 2);
      assert.equal(filterReimbursementReceipts(sampleReceipts, 'ALL', 'rochat').length, 1);
      assert.equal(filterReimbursementReceipts(sampleReceipts, 'ALL', 'CH930076').length, 1);
    });
  });

  describe('matchTransactionsWithReceipts — Auto-Match de lot', () => {
    it('lie automatiquement un remboursement payé 3 semaines plus tard et une carte débitée à J+1', () => {
      const receipts = [
        {
          id: 'rcpt-card',
          url: 'https://storage/card.jpg',
          fileName: 'migros.jpg',
          uploadDate: '2026-03-01',
          extractedDate: '2026-03-01',
          extractedAmount: 32.4,
          isAnalyzed: true,
          expenseType: 'DEBIT_CARD',
        },
        {
          id: 'rcpt-reimb',
          url: 'https://storage/reimb.pdf',
          fileName: 'note_frais.pdf',
          uploadDate: '2026-03-01',
          extractedDate: '2026-03-01',
          extractedAmount: 85.0,
          isAnalyzed: true,
          expenseType: 'REIMBURSEMENT',
          submittedByName: 'Lucie Favre',
          submittedByEmail: 'lucie@asso.ch',
        },
      ];

      const txns = [
        {
          id: 'txn-card-j1',
          date: '2026-03-02', // J+1
          description: 'Achat Carte Débit Migros',
          amount: -32.4,
          status: 'PENDING',
        },
        {
          id: 'txn-reimb-j21',
          date: '2026-03-22', // J+21
          description: 'Virement remboursement Lucie Favre',
          amount: -85.0,
          status: 'PENDING',
        },
      ];

      const { processedTxns, matchedReceiptIds } = matchTransactionsWithReceipts(txns, receipts);
      assert.deepEqual(matchedReceiptIds, ['rcpt-card', 'rcpt-reimb']);
      assert.equal(processedTxns[0].receiptUrl, 'https://storage/card.jpg');
      assert.equal(processedTxns[1].receiptUrl, 'https://storage/reimb.pdf');
    });
  });
});
