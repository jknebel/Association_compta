import React, { useState, useEffect, useMemo } from 'react';
import {
  Building2,
  Plus,
  Search,
  CheckCircle2,
  Clock,
  Trash2,
  Download,
  Calendar,
  X,
  Phone,
  Mail,
  CreditCard,
  Banknote,
  Smartphone,
  Check,
  RotateCcw,
  Loader2,
} from 'lucide-react';
import type { Rental, RentalStatus, Transaction } from '../../types';
import { useAuthContext, useOrgContext, useComptaContext } from '../contexts/AppContext';
import {
  subscribeRentals,
  markRentalAsPaidWeb,
  markRentalAsPendingWeb,
  createRentalWeb,
  deleteRentalWeb,
  linkRentalToTransactionWeb,
  unlinkRentalFromTransactionWeb,
} from '../services/rentalService';
import {
  notifyRentalManagerOnVisa,
  checkAndAlertCaissierPendingRentals5Days,
} from '../services/rentalNotificationService';
import * as XLSX from 'xlsx';

interface RentalsViewProps {
  transactions?: Transaction[];
}

export const RentalsView: React.FC<RentalsViewProps> = ({ transactions = [] }) => {
  const { user, userProfile } = useAuthContext();
  const { selectedOrg } = useOrgContext();
  const { selectedCompta } = useComptaContext();

  const [rentals, setRentals] = useState<Rental[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'PENDING' | 'PAID'>('ALL');

  // Modals state
  const [isAddModalOpen, setIsAddModalOpen] = useState<boolean>(false);
  const [payingRental, setPayingRental] = useState<Rental | null>(null);
  const [selectedTxnId, setSelectedTxnId] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<'Virement' | 'TWINT' | 'Cash'>('Virement');
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Form state
  const [newRentalData, setNewRentalData] = useState({
    roomName: 'Grande salle',
    renterName: '',
    renterPhone: '',
    renterEmail: '',
    startDate: new Date().toISOString().split('T')[0],
    endDate: new Date().toISOString().split('T')[0],
    amount: 150,
    notes: '',
  });

  const orgId = selectedOrg?.id || 'TDGL';
  const comptaId = selectedCompta?.id || 'default';
  const currentUserName = userProfile?.displayName || user?.displayName || user?.email || 'Caissier';

  useEffect(() => {
    setLoading(true);
    const unsubscribe = subscribeRentals(
      orgId,
      comptaId,
      (list) => {
        setRentals(list);
        setLoading(false);
        // Vérifier les locations en attente depuis 5 jours et alerter le caissier de groupe
        void checkAndAlertCaissierPendingRentals5Days(
          orgId,
          comptaId,
          list,
          user?.email || 'jean.francois.knebel@gmail.com'
        );
      },
      (err) => {
        console.error('Erreur écoute locations :', err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [orgId, comptaId, user?.email]);

  // Nombre de locations en attente depuis plus de 5 jours
  const overdueRentalsCount = useMemo(() => {
    const now = Date.now();
    const FIVE_DAYS = 5 * 24 * 60 * 60 * 1000;
    return rentals.filter(
      (r) => r.status !== 'PAID' && r.createdAt && now - new Date(r.createdAt).getTime() >= FIVE_DAYS
    ).length;
  }, [rentals]);

  // Statistiques
  const stats = useMemo(() => {
    let pendingAmount = 0;
    let pendingCount = 0;
    let paidAmount = 0;
    let paidCount = 0;

    for (const r of rentals) {
      if (r.status === 'PENDING') {
        pendingAmount += r.amount;
        pendingCount++;
      } else if (r.status === 'PAID') {
        paidAmount += r.amount;
        paidCount++;
      }
    }

    return {
      pendingAmount,
      pendingCount,
      paidAmount,
      paidCount,
      totalAmount: pendingAmount + paidAmount,
      totalCount: rentals.length,
    };
  }, [rentals]);

  // Filtrage
  const filteredRentals = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rentals.filter((r) => {
      if (statusFilter === 'PENDING' && r.status !== 'PENDING') return false;
      if (statusFilter === 'PAID' && r.status !== 'PAID') return false;
      if (!q) return true;
      return (
        r.renterName.toLowerCase().includes(q) ||
        r.roomName.toLowerCase().includes(q) ||
        (r.renterPhone && r.renterPhone.toLowerCase().includes(q)) ||
        (r.renterEmail && r.renterEmail.toLowerCase().includes(q)) ||
        (r.notes && r.notes.toLowerCase().includes(q))
      );
    });
  }, [rentals, statusFilter, searchQuery]);

  const handleCreateRental = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRentalData.renterName.trim()) {
      alert('Veuillez saisir le nom du locataire.');
      return;
    }
    if (newRentalData.amount <= 0) {
      alert('Veuillez saisir un tarif supérieur à 0 CHF.');
      return;
    }

    setSubmitting(true);
    try {
      await createRentalWeb(orgId, comptaId, newRentalData, user, currentUserName);
      setIsAddModalOpen(false);
      setNewRentalData({
        roomName: 'Grande salle',
        renterName: '',
        renterPhone: '',
        renterEmail: '',
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date().toISOString().split('T')[0],
        amount: 150,
        notes: '',
      });
    } catch (err) {
      console.error('Erreur ajout location :', err);
      alert('Erreur lors de l’enregistrement.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmPayment = async () => {
    if (!payingRental) return;
    setSubmitting(true);
    try {
      if (selectedTxnId) {
        await linkRentalToTransactionWeb(orgId, comptaId, payingRental.id, selectedTxnId, user, currentUserName);
      } else {
        await markRentalAsPaidWeb(orgId, comptaId, payingRental.id, paymentMethod, user, currentUserName);
      }

      // Envoi de l'e-mail de confirmation au responsable des locations
      await notifyRentalManagerOnVisa(orgId, comptaId, payingRental, currentUserName);

      setPayingRental(null);
      setSelectedTxnId('');
    } catch (err) {
      console.error('Erreur validation paiement :', err);
      alert('Erreur lors de la validation du paiement.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevertToPending = async (r: Rental) => {
    if (!confirm(`Remettre la location de ${r.renterName} en attente de paiement ?`)) {
      return;
    }
    try {
      await markRentalAsPendingWeb(orgId, comptaId, r.id);
    } catch (err) {
      console.error('Erreur réinitialisation statut :', err);
      alert('Erreur lors de la modification.');
    }
  };

  const handleDeleteRental = async (r: Rental) => {
    if (!confirm(`Supprimer définitivement la location de ${r.renterName} (${r.roomName} - CHF ${r.amount}) ?`)) {
      return;
    }
    try {
      await deleteRentalWeb(orgId, comptaId, r.id);
    } catch (err) {
      console.error('Erreur suppression location :', err);
      alert('Erreur lors de la suppression.');
    }
  };

  const handleExportExcel = () => {
    if (rentals.length === 0) {
      alert('Aucune location à exporter.');
      return;
    }

    const rows = rentals.map((r) => ({
      Statut: r.status === 'PAID' ? 'PAYÉ' : 'EN ATTENTE',
      Locataire: r.renterName,
      Téléphone: r.renterPhone || '',
      Email: r.renterEmail || '',
      Local: r.roomName,
      'Date début': r.startDate,
      'Date fin': r.endDate || r.startDate,
      'Tarif (CHF)': r.amount,
      'Date paiement': r.paidAt ? r.paidAt.split('T')[0] : '',
      'Mode de règlement': r.paidByMethod || '',
      'Validé par': r.paidMarkedByName || '',
      Remarques: r.notes || '',
      'Créé par': r.createdByName || '',
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Locations');
    XLSX.writeFile(wb, `Locations_${selectedCompta?.name || 'TDGL'}_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* En-tête */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <Building2 size={24} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-100">Locations de locaux & Salles</h1>
              <p className="text-xs text-slate-400">
                Suivi des réservations enregistrées sur mobile et encaissements pour{' '}
                <span className="font-semibold text-slate-200">{selectedCompta?.name || 'la comptabilité active'}</span>
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={handleExportExcel}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs text-slate-300 font-medium transition-colors"
          >
            <Download size={15} />
            <span>Export Excel</span>
          </button>

          <button
            type="button"
            onClick={() => setIsAddModalOpen(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-xs text-white font-semibold shadow-lg shadow-indigo-600/25 transition-all"
          >
            <Plus size={16} />
            <span>Nouvelle location</span>
          </button>
        </div>
      </div>

      {/* Alerte locations en attente depuis > 5 jours */}
      {overdueRentalsCount > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4 flex items-center gap-3 text-amber-300">
          <Clock className="shrink-0 text-amber-400" size={20} />
          <div className="text-xs">
            <span className="font-bold">
              {overdueRentalsCount} {overdueRentalsCount > 1 ? 'locations en attente' : 'location en attente'} de visa depuis plus de 5 jours.
            </span>
            <span className="text-amber-200/80 block mt-0.5">
              Un e-mail de rappel automatique a été notifié au caissier de groupe pour pointage avec les encaissements du relevé bancaire.
            </span>
          </div>
        </div>
      )}

      {/* Cartes KPI */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* À encaisser */}
        <div className="bg-slate-900/80 border border-amber-500/20 rounded-2xl p-5 relative overflow-hidden">
          <div className="flex items-center justify-between text-amber-400 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">À encaisser</span>
            <Clock size={18} />
          </div>
          <div className="text-2xl font-black text-amber-300">
            CHF {stats.pendingAmount.toFixed(2)}
          </div>
          <p className="text-xs text-slate-400 mt-1">
            {stats.pendingCount} {stats.pendingCount > 1 ? 'locations en attente de paiement' : 'location en attente de paiement'}
          </p>
        </div>

        {/* Déjà encaissé */}
        <div className="bg-slate-900/80 border border-emerald-500/20 rounded-2xl p-5 relative overflow-hidden">
          <div className="flex items-center justify-between text-emerald-400 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">Déjà encaissé</span>
            <CheckCircle2 size={18} />
          </div>
          <div className="text-2xl font-black text-emerald-300">
            CHF {stats.paidAmount.toFixed(2)}
          </div>
          <p className="text-xs text-slate-400 mt-1">
            {stats.paidCount} {stats.paidCount > 1 ? 'locations réglées' : 'location réglée'}
          </p>
        </div>

        {/* Chiffre d'affaires prévisionnel */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 relative overflow-hidden">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">Total prévisionnel</span>
            <Building2 size={18} />
          </div>
          <div className="text-2xl font-black text-slate-100">
            CHF {stats.totalAmount.toFixed(2)}
          </div>
          <p className="text-xs text-slate-400 mt-1">
            {stats.totalCount} {stats.totalCount > 1 ? 'locations au total' : 'location au total'}
          </p>
        </div>
      </div>

      {/* Barre de recherche et filtres */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-slate-900/60 p-3 rounded-2xl border border-slate-800">
        <div className="relative w-full sm:w-80">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            placeholder="Rechercher par locataire, local, téléphone…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5 w-full sm:w-auto">
          <button
            type="button"
            onClick={() => setStatusFilter('ALL')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              statusFilter === 'ALL'
                ? 'bg-slate-800 text-white font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Toutes ({rentals.length})
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter('PENDING')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              statusFilter === 'PENDING'
                ? 'bg-amber-500/20 text-amber-300 font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            À encaisser ({stats.pendingCount})
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter('PAID')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              statusFilter === 'PAID'
                ? 'bg-emerald-500/20 text-emerald-300 font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Payées ({stats.paidCount})
          </button>
        </div>
      </div>

      {/* Tableau des locations */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
        {loading ? (
          <div className="py-16 flex flex-col items-center justify-center gap-2 text-slate-400">
            <Loader2 size={28} className="animate-spin text-indigo-500" />
            <p className="text-xs">Chargement des locations…</p>
          </div>
        ) : filteredRentals.length === 0 ? (
          <div className="py-16 text-center">
            <Building2 size={40} className="mx-auto text-slate-600 mb-2" />
            <p className="text-sm font-semibold text-slate-300">Aucune location enregistrée</p>
            <p className="text-xs text-slate-500 mt-1">
              Les réservations saisies par le responsable des locations sur l'application mobile apparaîtront ici en temps réel.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/50 text-slate-400 font-semibold uppercase tracking-wider text-[11px]">
                  <th className="py-3 px-4">Statut</th>
                  <th className="py-3 px-4">Dates</th>
                  <th className="py-3 px-4">Locataire</th>
                  <th className="py-3 px-4">Local</th>
                  <th className="py-3 px-4 text-right">Tarif (CHF)</th>
                  <th className="py-3 px-4 text-center">Action Trésorier</th>
                  <th className="py-3 px-4 text-right"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filteredRentals.map((r) => {
                  const isPaid = r.status === 'PAID';

                  return (
                    <tr
                      key={r.id}
                      className={`hover:bg-slate-800/30 transition-colors ${
                        isPaid ? 'bg-emerald-950/10' : ''
                      }`}
                    >
                      {/* Statut */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${
                            isPaid
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                          }`}
                        >
                          {isPaid ? <CheckCircle2 size={13} /> : <Clock size={13} />}
                          <span>{isPaid ? 'Payé' : 'En attente'}</span>
                        </span>
                      </td>

                      {/* Dates */}
                      <td className="py-3.5 px-4 whitespace-nowrap text-slate-300">
                        <div className="flex items-center gap-1.5">
                          <Calendar size={13} className="text-slate-500" />
                          <span>
                            {r.startDate}
                            {r.endDate && r.endDate !== r.startDate ? ` au ${r.endDate}` : ''}
                          </span>
                        </div>
                      </td>

                      {/* Locataire & Contacts */}
                      <td className="py-3.5 px-4">
                        <div className="font-bold text-slate-100">{r.renterName}</div>
                        <div className="flex items-center gap-3 text-slate-400 text-[11px] mt-0.5">
                          {r.renterPhone && (
                            <a
                              href={`tel:${r.renterPhone}`}
                              className="flex items-center gap-1 hover:text-indigo-400 transition-colors"
                            >
                              <Phone size={11} />
                              <span>{r.renterPhone}</span>
                            </a>
                          )}
                          {r.renterEmail && (
                            <a
                              href={`mailto:${r.renterEmail}`}
                              className="flex items-center gap-1 hover:text-indigo-400 transition-colors"
                            >
                              <Mail size={11} />
                              <span>{r.renterEmail}</span>
                            </a>
                          )}
                        </div>
                        {r.notes && (
                          <div className="text-[11px] text-slate-500 italic mt-0.5 line-clamp-1">
                            « {r.notes} »
                          </div>
                        )}
                      </td>

                      {/* Local */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <span className="px-2 py-0.5 rounded-lg bg-slate-800 text-slate-300 border border-slate-700 text-[11px] font-medium">
                          {r.roomName}
                        </span>
                      </td>

                      {/* Tarif */}
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        <span
                          className={`text-sm font-black ${
                            isPaid ? 'text-emerald-400' : 'text-amber-300'
                          }`}
                        >
                          CHF {r.amount.toFixed(2)}
                        </span>
                      </td>

                      {/* Action Trésorier (Validation paiement en 1 clic) */}
                      <td className="py-3.5 px-4 text-center whitespace-nowrap">
                        {isPaid ? (
                          <div className="inline-flex items-center gap-2">
                            <span className="text-[11px] text-emerald-400 bg-emerald-950/40 px-2.5 py-1 rounded-lg border border-emerald-900/50">
                              {r.paidByMethod || 'Payé'}{' '}
                              {r.paidAt ? `(${r.paidAt.split('T')[0]})` : ''}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleRevertToPending(r)}
                              className="p-1 text-slate-500 hover:text-amber-400 transition-colors"
                              title="Remettre en attente de paiement"
                            >
                              <RotateCcw size={13} />
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setPayingRental(r)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white font-semibold text-xs shadow-md shadow-emerald-600/20 transition-all"
                          >
                            <Check size={14} />
                            <span>Pointer comme payé</span>
                          </button>
                        )}
                      </td>

                      {/* Suppression */}
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => handleDeleteRental(r)}
                          className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors"
                          title="Supprimer la location"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal : Ajouter une location depuis le Web */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 w-full max-w-md rounded-2xl p-5 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-4">
              <div className="flex items-center gap-2">
                <span className="p-1.5 rounded-lg bg-indigo-500/20 text-indigo-400">
                  <Building2 size={18} />
                </span>
                <h2 className="text-base font-bold text-slate-100">Ajouter une location</h2>
              </div>
              <button
                type="button"
                onClick={() => setIsAddModalOpen(false)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleCreateRental} className="space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Local / Salle louée
                </label>
                <input
                  type="text"
                  placeholder="Ex : Grande salle, Foyer, Chalet…"
                  value={newRentalData.roomName}
                  onChange={(e) => setNewRentalData({ ...newRentalData, roomName: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Locataire (Nom / Association) *
                </label>
                <input
                  type="text"
                  placeholder="Ex : Famille Dupont"
                  value={newRentalData.renterName}
                  onChange={(e) =>
                    setNewRentalData({ ...newRentalData, renterName: e.target.value })
                  }
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Téléphone
                  </label>
                  <input
                    type="tel"
                    placeholder="079 123 45 67"
                    value={newRentalData.renterPhone}
                    onChange={(e) =>
                      setNewRentalData({ ...newRentalData, renterPhone: e.target.value })
                    }
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    E-mail
                  </label>
                  <input
                    type="email"
                    placeholder="locataire@exemple.ch"
                    value={newRentalData.renterEmail}
                    onChange={(e) =>
                      setNewRentalData({ ...newRentalData, renterEmail: e.target.value })
                    }
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Date de début
                  </label>
                  <input
                    type="date"
                    value={newRentalData.startDate}
                    onChange={(e) =>
                      setNewRentalData({ ...newRentalData, startDate: e.target.value })
                    }
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Tarif (CHF) *
                  </label>
                  <input
                    type="number"
                    step="0.05"
                    min="0"
                    value={newRentalData.amount || ''}
                    onChange={(e) =>
                      setNewRentalData({
                        ...newRentalData,
                        amount: parseFloat(e.target.value) || 0,
                      })
                    }
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500 font-bold"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Remarques
                </label>
                <textarea
                  rows={2}
                  placeholder="Remarques (clés, caution, état des lieux…)"
                  value={newRentalData.notes}
                  onChange={(e) => setNewRentalData({ ...newRentalData, notes: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="pt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="flex-1 py-2 rounded-xl border border-slate-800 text-xs font-medium text-slate-400 hover:text-slate-200"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white shadow-lg shadow-indigo-600/25 flex items-center justify-center gap-1.5"
                >
                  {submitting ? <Loader2 size={15} className="animate-spin" /> : 'Enregistrer'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal : Validation du paiement trésorier */}
      {payingRental && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 w-full max-w-sm rounded-2xl p-5 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
              <div className="flex items-center gap-2">
                <span className="p-1.5 rounded-lg bg-emerald-500/20 text-emerald-400">
                  <CheckCircle2 size={18} />
                </span>
                <h3 className="text-sm font-bold text-slate-100">Pointer l’encaissement</h3>
              </div>
              <button
                type="button"
                onClick={() => setPayingRental(null)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X size={18} />
              </button>
            </div>

            <div className="bg-slate-950/60 rounded-xl p-3 border border-slate-800/80 mb-4 text-center">
              <p className="text-xs text-slate-400 font-medium">{payingRental.renterName}</p>
              <p className="text-xs text-slate-500">{payingRental.roomName}</p>
              <p className="text-2xl font-black text-emerald-400 mt-1">
                CHF {payingRental.amount.toFixed(2)}
              </p>
            </div>

            <p className="text-xs text-slate-300 font-semibold mb-2">Mode de versement constaté :</p>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <button
                type="button"
                onClick={() => setPaymentMethod('Virement')}
                className={`flex flex-col items-center justify-center p-2.5 rounded-xl border text-xs gap-1 transition-all ${
                  paymentMethod === 'Virement'
                    ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300 font-bold'
                    : 'border-slate-800 bg-slate-950/40 text-slate-400 hover:text-slate-200'
                }`}
              >
                <CreditCard size={18} />
                <span>Virement</span>
              </button>

              <button
                type="button"
                onClick={() => setPaymentMethod('TWINT')}
                className={`flex flex-col items-center justify-center p-2.5 rounded-xl border text-xs gap-1 transition-all ${
                  paymentMethod === 'TWINT'
                    ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300 font-bold'
                    : 'border-slate-800 bg-slate-950/40 text-slate-400 hover:text-slate-200'
                }`}
              >
                <Smartphone size={18} />
                <span>TWINT</span>
              </button>

              <button
                type="button"
                onClick={() => setPaymentMethod('Cash')}
                className={`flex flex-col items-center justify-center p-2.5 rounded-xl border text-xs gap-1 transition-all ${
                  paymentMethod === 'Cash'
                    ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300 font-bold'
                    : 'border-slate-800 bg-slate-950/40 text-slate-400 hover:text-slate-200'
                }`}
              >
                <Banknote size={18} />
                <span>Cash</span>
              </button>
            </div>

            {/* Liaison optionnelle avec une transaction bancaire (crédit) */}
            {transactions && transactions.length > 0 && (
              <div className="mb-4">
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Lier au relevé bancaire (crédit) :
                </label>
                <select
                  value={selectedTxnId}
                  onChange={(e) => setSelectedTxnId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">— Non liée (paiement manuel / twint / cash) —</option>
                  {transactions
                    .filter((t) => t.amount > 0)
                    .map((t) => {
                      const isMatch = Math.abs(t.amount - payingRental.amount) < 0.01;
                      return (
                        <option key={t.id} value={t.id}>
                          {isMatch ? '★ MATCH : ' : ''}{t.date} — {t.description?.slice(0, 30)} — +CHF {t.amount.toFixed(2)}
                        </option>
                      );
                    })}
                </select>
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPayingRental(null)}
                className="flex-1 py-2 rounded-xl border border-slate-800 text-xs font-medium text-slate-400 hover:text-slate-200"
              >
                Annuler
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={handleConfirmPayment}
                className="flex-1 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-lg shadow-emerald-600/25 flex items-center justify-center gap-1.5"
              >
                {submitting ? <Loader2 size={15} className="animate-spin" /> : 'Confirmer payé'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
