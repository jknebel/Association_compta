
import React, { useState, useEffect, useRef } from 'react';
import { Account, AccountType } from '../../types';
import {
  Plus, Trash2, Save, Upload, Download, Folder, FolderOpen,
  ChevronDown, AlertTriangle, Briefcase, Users, ArrowRight, X, Terminal, CheckCircle, Lock
} from 'lucide-react';
import * as LucideIcons from 'lucide-react';

interface SettingsViewProps {
  accounts: Account[];
  onUpdateAccounts: (accounts: Account[]) => Promise<void> | void;
  globalContext?: string;
  onSaveContext?: (text: string) => Promise<void> | void;
}

// Dynamic Icon Loading Helper
const getIconComponent = (iconName: string | undefined) => {
  if (!iconName) return Folder;
  // @ts-ignore
  const Icon = LucideIcons[iconName];
  return Icon || Folder;
};

// Common icons for the selector
const COMMON_ICONS = [
  'Folder', 'Landmark', 'Wallet', 'CreditCard', 'Receipt', 'Users',
  'ShoppingCart', 'Music', 'Coffee', 'Train', 'Home', 'Gift',
  'Briefcase', 'Wrench', 'Zap', 'Phone', 'Package', 'Plane',
  'GraduationCap', 'Heart', 'Award', 'Globe', 'Anchor', 'Car',
  'Camera', 'Smartphone', 'Sun', 'Moon', 'Star'
];

export const SettingsView: React.FC<SettingsViewProps> = ({ 
  accounts, 
  onUpdateAccounts,
  globalContext,
  onSaveContext
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tempAccount, setTempAccount] = useState<Account | null>(null);
  const [showIconSelector, setShowIconSelector] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [showAiModal, setShowAiModal] = useState(false);
  const [tempAiContext, setTempAiContext] = useState(globalContext || "");
  const [contextAccount, setContextAccount] = useState<Account | null>(null);
  const [tempAccountContext, setTempAccountContext] = useState("");

  // Sync temp context when global props changes
  useEffect(() => {
    setTempAiContext(globalContext || "");
  }, [globalContext]);

  // IMPORT STATE
  const [pendingImport, setPendingImport] = useState<Account[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // LOGS STATE
  const [importLogs, setImportLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);

  const addLog = (msg: string) => {
    console.log(msg);
    setImportLogs(prev => [...prev, `${new Date().toLocaleTimeString()} > ${msg}`]);
    setShowLogs(true);
  };

  // --- SAFE SORTING LOGIC ---
  // Helper: determine account depth level
  const getAccountLevel = (a: Account): number => {
    if (!a.parentId || a.parentId === 'null' || a.parentId === 'undefined' || String(a.parentId).trim() === '') return 1;
    const parent = accounts.find(p => p.id === a.parentId);
    if (!parent) return 1;
    if (!parent.parentId || parent.parentId === 'null' || parent.parentId === 'undefined' || String(parent.parentId).trim() === '') return 2;
    return 3;
  };

  const sortedAccounts = React.useMemo(() => {
    try {
      if (!accounts || accounts.length === 0) return [];

      const safeAccounts = [...accounts];

      // Robust check for "empty" parentId
      const isRoot = (a: Account) => {
        if (!a.parentId) return true;
        const p = String(a.parentId).trim().toLowerCase();
        return p === "" || p === "null" || p === "undefined";
      };

      const roots = safeAccounts.filter(a => isRoot(a));
      const nonRoots = safeAccounts.filter(a => !isRoot(a));

      let result: Account[] = [];
      const processedIds = new Set<string>();

      roots.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

      roots.forEach(root => {
        result.push(root);
        processedIds.add(root.id);

        // Level 2: direct children of this root
        const level2 = nonRoots.filter(c => c.parentId === root.id);
        level2.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

        level2.forEach(child => {
          result.push(child);
          processedIds.add(child.id);

          // Level 3: children of this level 2 (auto-generated sub-accounts)
          const level3 = nonRoots.filter(c => c.parentId === child.id);
          level3.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
          level3.forEach(grandchild => {
            result.push(grandchild);
            processedIds.add(grandchild.id);
          });
        });
      });

      // Add Orphans
      const remaining = safeAccounts.filter(a => !processedIds.has(a.id));
      if (remaining.length > 0) {
        remaining.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
        result.push(...remaining);
      }

      return result;
    } catch (e) {
      console.error("Sorting error, displaying raw list:", e);
      return [...accounts].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    }
  }, [accounts]);

  useEffect(() => {
    if (deleteConfirmId) {
      const timer = setTimeout(() => setDeleteConfirmId(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [deleteConfirmId]);

  const handleEdit = (account: Account) => {
    setEditingId(account.id);
    setTempAccount({ ...account });
    setDeleteConfirmId(null);
    setShowIconSelector(null);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setTempAccount(null);
    setShowIconSelector(null);
  };

  const handleSave = () => {
    if (tempAccount) {
      if (!tempAccount.code.trim()) {
        alert("Le Numéro de Compte (Code) est obligatoire !");
        return;
      }
      let updatedAccounts = accounts.map(a => a.id === tempAccount.id ? tempAccount : a);

      // --- AUTO-CREATION / DELETION of level 3 sub-accounts for MIXTE ---
      const originalAccount = accounts.find(a => a.id === tempAccount.id);
      const level = getAccountLevel(tempAccount);

      // If a level 2 account is now MIXTE and wasn't before (or is new)
      if (level === 2 && tempAccount.type === AccountType.MIXED) {
        const existingAutoChildren = updatedAccounts.filter(
          a => a.parentId === tempAccount.id && a.autoGenerated
        );
        if (existingAutoChildren.length === 0) {
          // Create the two sub-accounts
          const produitId = `${tempAccount.id}-auto-produit`;
          const chargeId = `${tempAccount.id}-auto-charge`;
          const produitAccount: Account = {
            id: produitId,
            code: `${tempAccount.code}.1`,
            label: `${tempAccount.label} - Participation`,
            description: `Produit auto-généré pour ${tempAccount.label}`,
            type: AccountType.INCOME,
            isMembership: true,
            parentId: tempAccount.id,
            icon: 'ArrowRight',
            autoGenerated: true
          };
          const chargeAccount: Account = {
            id: chargeId,
            code: `${tempAccount.code}.2`,
            label: `${tempAccount.label} - Charges`,
            description: `Charge auto-générée pour ${tempAccount.label}`,
            type: AccountType.EXPENSE,
            isMembership: false,
            parentId: tempAccount.id,
            icon: 'ArrowRight',
            autoGenerated: true
          };
          updatedAccounts = [...updatedAccounts, produitAccount, chargeAccount];
        }
      }

      // If a level 2 account was MIXTE and is changed to something else, remove auto-generated children
      if (level === 2 && originalAccount && originalAccount.type === AccountType.MIXED && tempAccount.type !== AccountType.MIXED) {
        updatedAccounts = updatedAccounts.filter(
          a => !(a.parentId === tempAccount.id && a.autoGenerated)
        );
      }

      onUpdateAccounts(updatedAccounts);
      setEditingId(null);
      setTempAccount(null);
      setShowIconSelector(null);
    }
  };

  const handleDeleteClick = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (deleteConfirmId === id) {
      const children = accounts.filter(a => a.parentId === id);
      let updatedAccounts;
      if (children.length > 0) {
        updatedAccounts = accounts
          .filter(a => a.id !== id)
          .map(a => (a.parentId === id ? { ...a, parentId: undefined } : a));
      } else {
        updatedAccounts = accounts.filter(a => a.id !== id);
      }
      onUpdateAccounts(updatedAccounts);
      setDeleteConfirmId(null);
    } else {
      setDeleteConfirmId(id);
    }
  };

  const handleAdd = () => {
    let nextCode = "600";
    if (accounts.length > 0) {
      const codes = accounts.map(a => parseInt(a.code)).filter(n => !isNaN(n));
      if (codes.length > 0) nextCode = (Math.max(...codes) + 1).toString();
    }

    const newId = Date.now().toString();
    const newAccount: Account = {
      id: newId,
      code: nextCode,
      label: 'Nouveau Compte',
      description: '',
      type: AccountType.EXPENSE,
      isMembership: false,
      icon: 'Folder'
    };
    onUpdateAccounts([...accounts, newAccount]);
    setEditingId(newId);
    setTempAccount(newAccount);
  };

  const handleOpenAccountContext = (account: Account) => {
    setContextAccount(account);
    setTempAccountContext(account.iaContext || "");
  };

  const handleSaveAccountContext = () => {
    if (contextAccount) {
      const updatedAccounts = accounts.map(a => 
        a.id === contextAccount.id ? { ...a, iaContext: tempAccountContext } : a
      );
      onUpdateAccounts(updatedAccounts);
      setContextAccount(null);
    }
  };

  const handleChange = (field: keyof Account, value: any) => {
    if (tempAccount) {
      setTempAccount({ ...tempAccount, [field]: value });
    }
  };

  // --- IMPORT / EXPORT ---

  const handleExportConfig = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(accounts, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", `plan_comptable.json`);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  const handleImportClick = () => {
    if (fileInputRef.current) fileInputRef.current.value = "";
    fileInputRef.current?.click();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setImportLogs([]);
    setShowLogs(true);
    addLog(`Début Import : ${file.name} (${file.size} bytes)`);

    const reader = new FileReader();
    reader.onerror = () => addLog("ERREUR CRITIQUE: Impossible de lire le fichier (FileReader error).");

    reader.onload = (e) => {
      try {
        const result = e.target?.result as string;
        if (!result) throw new Error("Fichier vide ou illisible.");
        addLog(`Contenu lu (${result.length} caractères). Tentative de parsing JSON...`);

        let rawParsed;
        try {
          rawParsed = JSON.parse(result);
          addLog("JSON Parse: SUCCÈS.");
        } catch (jsonErr: any) {
          addLog(`ERREUR JSON Parse: ${jsonErr.message}`);
          throw new Error("Le fichier n'est pas un JSON valide.");
        }

        // INTELLIGENT STRUCTURE DETECTION
        let listToProcess: any[] = [];
        let detectionSource = "Inconnue";

        if (Array.isArray(rawParsed)) {
          listToProcess = rawParsed;
          detectionSource = "Tableau direct (Root Array)";
        } else if (rawParsed && typeof rawParsed === 'object') {
          if (Array.isArray(rawParsed.accounts)) { listToProcess = rawParsed.accounts; detectionSource = "Propriété 'accounts'"; }
          else if (Array.isArray(rawParsed.data)) { listToProcess = rawParsed.data; detectionSource = "Propriété 'data'"; }
          else if (Array.isArray(rawParsed.items)) { listToProcess = rawParsed.items; detectionSource = "Propriété 'items'"; }
          else {
            const values = Object.values(rawParsed);
            if (values.length > 0 && typeof values[0] === 'object') {
              listToProcess = values;
              detectionSource = "Valeurs de l'objet (Object.values)";
            }
          }
        }

        addLog(`Structure détectée: ${detectionSource}`);
        addLog(`Nombre d'éléments trouvés: ${listToProcess.length}`);

        if (!Array.isArray(listToProcess) || listToProcess.length === 0) {
          throw new Error("Aucune liste valide trouvée. Vérifiez que le JSON contient un tableau.");
        }

        // UNIQUE ID TRACKING
        const existingIds = new Set<string>();

        // Parsing Loop
        const validAccounts: Account[] = [];
        let errors = 0;

        listToProcess.forEach((a: any, index: number) => {
          try {
            // Determine ID
            let safeId = a.id ? String(a.id).trim() : `imported-${index}`;
            if (existingIds.has(safeId)) {
              safeId = `${safeId}-${Math.random().toString(36).substr(2, 5)}`;
            }
            existingIds.add(safeId);

            // Parent ID Cleanup
            let pId: string | undefined = undefined;
            if (a.parentId !== null && a.parentId !== undefined) {
              const s = String(a.parentId).trim();
              if (s !== "" && s !== "null" && s !== "undefined") {
                pId = s;
              }
            }
            if (pId === safeId) pId = undefined; // Avoid loop

            // Determine Type
            let type: AccountType = AccountType.EXPENSE;
            const rawType = String(a.type || "").toUpperCase();
            if (rawType.includes("PRODUIT") || rawType.includes("INCOME") || rawType.includes("RECETTE")) type = AccountType.INCOME;
            else if (rawType.includes("CHARGE") || rawType.includes("EXPENSE") || rawType.includes("DEPENSE")) type = AccountType.EXPENSE;
            else if (rawType.includes("MIXTE") || rawType.includes("MIXED")) type = AccountType.MIXED;

            const newAcc: Account = {
              id: safeId,
              code: String(a.code || `???-${index}`),
              label: String(a.label || "Compte sans nom"),
              description: String(a.description || ""),
              type: type,
              isMembership: !!a.isMembership,
              parentId: pId,
              icon: a.icon || "Folder"
            };
            validAccounts.push(newAcc);
          } catch (innerErr) {
            errors++;
          }
        });

        addLog(`Comptes validés: ${validAccounts.length}`);
        if (errors > 0) addLog(`Éléments ignorés (erreurs): ${errors}`);

        if (validAccounts.length === 0) {
          throw new Error("Aucun compte valide n'a pu être extrait du tableau.");
        }

        // REPLACEMENT OF WINDOW.CONFIRM WITH STATE
        // Old flaky logic: if (window.confirm(...)) ...
        setPendingImport(validAccounts);
        addLog(`Succès: ${validAccounts.length} comptes identifiés. En attente de validation UI...`);

      } catch (err: any) {
        console.error(err);
        addLog(`❌ ERREUR FATALE: ${err.message}`);
        alert(`❌ Erreur d'importation : ${err.message}`);
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    };
    reader.readAsText(file);
  };

  // Allow selecting root accounts and level 2 non-MIXTE accounts as potential parents
  // But exclude MIXTE level 2 (since they auto-generate children) and exclude self
  const potentialParents = accounts.filter(a => {
    if (a.id === tempAccount?.id) return false;
    if (a.autoGenerated) return false;
    const aLevel = getAccountLevel(a);
    if (aLevel === 1) return true; // Root accounts are always valid parents
    return false; // Don't allow nesting under level 2+ for manual accounts
  });
  potentialParents.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  const getTypeBadgeStyle = (type: string) => {
    switch (type) {
      case AccountType.INCOME: return 'bg-emerald-950 text-emerald-400 border-emerald-800';
      case AccountType.EXPENSE: return 'bg-rose-950 text-rose-400 border-rose-800';
      case AccountType.MIXED: return 'bg-purple-950 text-purple-400 border-purple-800';
      default: return 'bg-slate-800 text-slate-400';
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto relative">
      <header className="mb-8 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-100">Plan Comptable</h2>
          <p className="text-slate-400 mt-2">
            Gérez vos comptes et catégories.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleImportClick} className="flex items-center gap-2 px-3 py-2 bg-blue-900/30 text-blue-300 rounded border border-blue-900/50 hover:bg-blue-900/50 hover:text-white transition-colors text-sm font-medium">
            <Upload size={16} /> Importer JSON
          </button>
          <input type="file" ref={fileInputRef} className="hidden" accept=".json" onChange={handleFileChange} />
          <button onClick={handleExportConfig} className="flex items-center gap-2 px-3 py-2 bg-slate-800 text-slate-300 rounded border border-slate-700 hover:bg-slate-700 hover:text-white transition-colors text-sm font-medium">
            <Download size={16} /> Exporter JSON
          </button>
          <button 
            onClick={() => setShowAiModal(true)} 
            className="flex items-center gap-2 px-3 py-2 bg-indigo-900/30 text-indigo-300 rounded border border-indigo-500/30 hover:bg-indigo-900/50 hover:text-white transition-all text-sm font-bold shadow-lg shadow-indigo-950/20 ml-2"
          >
            <LucideIcons.Sparkles size={16} /> Informations IA
          </button>
        </div>
      </header>

      {/* DEBUG LOG SECTION */}
      {showLogs && (
        <div className="mb-8 bg-black rounded-lg border border-slate-700 p-4 font-mono text-xs overflow-hidden">
          <div className="flex justify-between items-center mb-2 border-b border-slate-800 pb-2">
            <span className="text-green-500 flex items-center gap-2"><Terminal size={14} /> Logs d'importation</span>
            <button onClick={() => setShowLogs(false)} className="text-slate-500 hover:text-white"><X size={14} /></button>
          </div>
          <div className="h-32 overflow-y-auto space-y-1 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
            {importLogs.map((log, i) => (
              <div key={i} className={`${log.includes('ERREUR') ? 'text-red-400 font-bold' : 'text-slate-400'}`}>
                {log}
              </div>
            ))}
            {importLogs.length === 0 && <span className="text-slate-600">En attente de fichier...</span>}
          </div>
        </div>
      )}

      {/* IMPORT CONFIRMATION MODAL */}
      {pendingImport && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 max-w-md w-full shadow-2xl animate-in fade-in zoom-in duration-200">
            <div className="flex justify-between items-start mb-4">
              <h3 className="text-xl font-bold text-white flex items-center gap-2">
                <Upload className="text-blue-500" />
                Confirmer l'Importation
              </h3>
              <button onClick={() => setPendingImport(null)} className="text-slate-500 hover:text-white"><X size={20} /></button>
            </div>

            <p className="text-slate-300 mb-2">
              <strong className="text-white">{pendingImport.length}</strong> comptes ont été identifiés avec succès.
            </p>
            <div className="bg-red-900/20 border border-red-900/50 rounded-lg p-3 flex items-start gap-3 mb-4">
              <AlertTriangle className="text-red-400 shrink-0 mt-0.5" size={16} />
              <p className="text-xs text-red-300 leading-relaxed">
                Attention : Cette action va <strong>REMPLACER</strong> l'intégralité de votre plan comptable actuel. Les transactions existantes pourraient perdre leur liaison si les IDs de comptes changent.
              </p>
            </div>

            <div className="max-h-32 overflow-y-auto bg-slate-950 rounded border border-slate-800 p-2 mb-6 text-xs font-mono text-slate-400 scrollbar-thin">
              {pendingImport.slice(0, 50).map(a => (
                <div key={a.id} className="truncate">{a.code} - {a.label}</div>
              ))}
              {pendingImport.length > 50 && <div className="italic text-slate-500">... et {pendingImport.length - 50} autres</div>}
            </div>

            <div className="flex gap-3 justify-end pt-2 border-t border-slate-800">
              <button
                onClick={() => {
                  setPendingImport(null);
                  addLog("Annulé par l'utilisateur (UI).");
                }}
                className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors text-sm font-medium"
              >
                Annuler
              </button>
              <button
                onClick={async () => {
                  addLog("Utilisateur a confirmé (UI). Application en cours...");
                  try {
                    await onUpdateAccounts(pendingImport);
                    setPendingImport(null);
                    addLog("SUCCÈS : Mise à jour terminée.");
                    alert("Le plan comptable a été mis à jour avec succès !");
                  } catch (e: any) {
                    console.error(e);
                    addLog(`ERREUR CRITIQUE lors de la sauvegarde : ${e.message}`);
                    alert(`Erreur lors de la sauvegarde : ${e.message}`);
                  }
                }}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-500 font-medium transition-colors text-sm flex items-center gap-2"
              >
                <CheckCircle size={16} />
                Confirmer le Remplacement
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI CONTEXT MODAL */}
      {showAiModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
          <div className="bg-slate-900 border border-indigo-500/30 rounded-2xl p-8 max-w-2xl w-full shadow-2xl animate-in fade-in zoom-in duration-300">
            <div className="flex justify-between items-start mb-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-600 rounded-lg">
                    <LucideIcons.Sparkles className="text-white" size={20} />
                </div>
                <div>
                    <h3 className="text-xl font-bold text-white">Mémoire et Instructions IA</h3>
                    <p className="text-slate-400 text-sm">Aidez l'IA à classer vos transactions avec vos propres règles.</p>
                </div>
              </div>
              <button 
                onClick={() => {
                   setShowAiModal(false);
                   setTempAiContext(globalContext || "");
                }} 
                className="text-slate-500 hover:text-white transition-colors p-1"
              >
                <X size={24} />
              </button>
            </div>

            <div className="space-y-4 mb-6">
                <p className="text-sm text-slate-300 leading-relaxed">
                    Copiez ici toute information utile : liste des membres, noms des fournisseurs récurrents, ou règles spécifiques (ex: "Le paiement 'Netflix' va toujours dans le compte 6500").
                </p>
                <textarea 
                    value={tempAiContext}
                    onChange={(e) => setTempAiContext(e.target.value)}
                    placeholder="Ex: Liste des membres : Jean Dupont, Marie Curie... 
Loyer mensuel : Agence Immo Suisse..."
                    className="w-full h-64 bg-slate-950 border border-slate-700 rounded-xl p-4 text-slate-200 text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none resize-none scrollbar-thin scrollbar-thumb-indigo-900"
                />
            </div>

            <div className="flex gap-3 justify-end pt-4 border-t border-slate-800">
              <button
                onClick={() => {
                  setShowAiModal(false);
                  setTempAiContext(globalContext || "");
                }}
                className="px-6 py-2 rounded-xl bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors text-sm font-medium"
              >
                Annuler
              </button>
              <button
                onClick={async () => {
                  if (onSaveContext) {
                    await onSaveContext(tempAiContext);
                  }
                  setShowAiModal(false);
                }}
                className="px-6 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 font-bold shadow-lg shadow-indigo-900/40 transition-all text-sm flex items-center gap-2"
              >
                <Save size={18} />
                Enregistrer pour l'IA
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-slate-900 rounded-xl shadow-lg border border-slate-800 overflow-visible">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-950 border-b border-slate-800 uppercase text-xs tracking-wider sticky top-0 z-10">
            <tr>
              <th className="px-6 py-4 font-bold text-slate-400 w-16">Icone</th>
              <th className="px-6 py-4 font-bold text-slate-400 w-32">Code</th>
              <th className="px-6 py-4 font-bold text-slate-400">Libellé</th>
              <th className="px-6 py-4 font-bold text-slate-400 w-72">Type</th>
              <th className="px-6 py-4 font-bold text-slate-400 w-32 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {accounts.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-12 text-center text-slate-500 flex flex-col items-center gap-3">
                  <AlertTriangle size={32} />
                  <p>Aucun compte affiché.</p>
                  <p className="text-xs">Importez un fichier JSON valide ou créez un compte.</p>
                </td>
              </tr>
            ) : (
              sortedAccounts.map((account) => {
                const isEditing = editingId === account.id;
                const data = isEditing && tempAccount ? tempAccount : account;
                // Determine depth level
                const level = getAccountLevel(data);
                const isRoot = level === 1;
                const IconComponent = getIconComponent(data.icon);

                const rowClass = isEditing
                  ? 'bg-blue-900/10 border-l-2 border-blue-500'
                  : isRoot
                    ? 'bg-slate-800/50 hover:bg-slate-800'
                    : level === 3
                      ? 'bg-slate-950/80 hover:bg-slate-900/80'
                      : 'bg-slate-950 hover:bg-slate-900';

                return (
                  <tr key={account.id} className={`transition-colors ${rowClass}`}>
                    {/* ICON */}
                    <td className="px-6 py-4 align-top">
                      {isEditing ? (
                        <div className="relative">
                          <button
                            onClick={() => setShowIconSelector(showIconSelector === account.id ? null : account.id)}
                            className="w-10 h-10 flex items-center justify-center bg-slate-950 border border-blue-500 rounded text-white"
                          >
                            <IconComponent size={20} />
                          </button>
                          {showIconSelector === account.id && (
                            <div className="absolute top-12 left-0 z-50 bg-slate-900 border border-slate-700 rounded shadow-xl p-2 w-64 grid grid-cols-5 gap-1">
                              {COMMON_ICONS.map(name => {
                                const Ico = getIconComponent(name);
                                return (
                                  <button key={name} onClick={() => { handleChange('icon', name); setShowIconSelector(null); }} className="p-2 hover:bg-blue-600 rounded text-slate-400 hover:text-white flex justify-center">
                                    <Ico size={18} />
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className={`w-10 h-10 rounded flex items-center justify-center border shadow-sm ${isRoot ? 'bg-slate-700/50 border-slate-600 text-blue-400' : level === 3 ? 'bg-slate-900 border-slate-800 text-purple-500' : 'bg-slate-900 border-slate-800 text-slate-600'
                          }`}>
                          <IconComponent size={20} />
                        </div>
                      )}
                    </td>

                    {/* CODE */}
                    <td className="px-6 py-4 align-top">
                      {isEditing ? (
                        <input
                          type="text" value={data.code} onChange={(e) => handleChange('code', e.target.value)}
                          className="w-full bg-slate-950 text-white border border-blue-500 rounded px-2 py-1 font-mono font-bold"
                        />
                      ) : (
                        <span className={`font-mono font-bold ${isRoot ? 'text-white' : 'text-slate-500'}`}>{data.code}</span>
                      )}
                    </td>

                    {/* LABEL */}
                    <td className="px-6 py-4 align-top">
                      {isEditing ? (
                        <div className="space-y-2">
                          <input type="text" value={data.label} onChange={(e) => handleChange('label', e.target.value)} className="w-full bg-slate-950 text-white border border-blue-500 rounded px-2 py-1" placeholder="Nom" />
                          <input type="text" value={data.description} onChange={(e) => handleChange('description', e.target.value)} className="w-full bg-slate-950 text-slate-300 border border-slate-700 rounded px-2 py-1 text-xs" placeholder="Description" />
                          <select value={data.parentId || ''} onChange={(e) => handleChange('parentId', e.target.value || undefined)} className="w-full bg-slate-950 text-white border border-slate-700 rounded px-2 py-1 text-xs">
                            <option value="">(Compte Principal)</option>
                            {potentialParents.map(p => <option key={p.id} value={p.id}>{p.code} - {p.label}</option>)}
                          </select>
                        </div>
                      ) : (
                        <div className="flex flex-col">
                          {isRoot ? (
                            <div className="font-bold text-slate-100">{data.label}</div>
                          ) : level === 3 ? (
                            <div className="flex items-center gap-2 pl-8 border-l-2 border-purple-900/50">
                              <span className="text-slate-400 text-xs">{data.label}</span>
                              {data.autoGenerated && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-950 text-purple-400 border border-purple-800">
                                  <Lock size={8} /> Auto
                                </span>
                              )}
                            </div>
                          ) : (
                            <div className="flex items-center gap-2 pl-4 border-l-2 border-slate-800">
                              <span className="text-slate-300">{data.label}</span>
                            </div>
                          )}
                          <div className={`text-xs text-slate-500 mt-1 ${level === 3 ? 'pl-8' : ''}`}>{data.description}</div>
                        </div>
                      )}
                    </td>

                    {/* TYPE */}
                    <td className="px-6 py-4 align-top">
                      {isEditing && !data.autoGenerated ? (
                        <div className="space-y-2">
                          <select value={data.type} onChange={(e) => handleChange('type', e.target.value)} className="w-full bg-slate-950 text-white border border-slate-700 rounded px-2 py-1 text-xs">
                            <option value="PRODUIT">Produit</option>
                            <option value="CHARGE">Charge</option>
                            {level <= 2 && <option value="MIXTE">Mixte</option>}
                          </select>
                          {!data.autoGenerated && (
                            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                              <input type="checkbox" checked={data.isMembership} onChange={(e) => handleChange('isMembership', e.target.checked)} className="rounded bg-slate-950 border-slate-700" />
                              Suivi Payeurs
                            </label>
                          )}
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <div className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border ${getTypeBadgeStyle(data.type)}`}>
                            {data.type}
                          </div>
                          {data.isMembership && <div className="text-purple-400 text-[10px] flex items-center gap-1"><Users size={10} /> Suivi</div>}
                        </div>
                      )}
                    </td>

                    {/* ACTIONS */}
                    <td className="px-6 py-4 align-top text-right">
                      {isEditing ? (
                        <div className="flex flex-col gap-1">
                          <button onClick={handleSave} className="bg-blue-600 text-white px-2 py-1 rounded text-xs">Sauver</button>
                          <button onClick={handleCancelEdit} className="bg-slate-800 text-slate-300 px-2 py-1 rounded text-xs">Annuler</button>
                        </div>
                      ) : (
                        <div className="flex justify-end gap-1">
                          {!data.autoGenerated && (
                            <button 
                              onClick={() => handleOpenAccountContext(account)} 
                              className={`p-1.5 rounded transition-colors ${account.iaContext ? 'text-indigo-400 bg-indigo-900/20' : 'text-slate-500 hover:text-indigo-400 hover:bg-slate-800'}`}
                              title="Instructions IA spécifiques pour ce compte"
                            >
                              <LucideIcons.Sparkles size={16} />
                            </button>
                          )}
                          {!data.autoGenerated && (
                            <button onClick={() => handleEdit(account)} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded" disabled={!!deleteConfirmId}>
                              <Briefcase size={16} />
                            </button>
                          )}
                          {!data.autoGenerated && (
                            <button onClick={(e) => handleDeleteClick(account.id, e)} className={`p-1.5 rounded ${deleteConfirmId === account.id ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-red-400 hover:bg-slate-800'}`}>
                              <Trash2 size={16} />
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              }))}
          </tbody>
        </table>
        <div className="p-4 bg-slate-900 border-t border-slate-800 flex justify-center">
          <button onClick={handleAdd} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-full text-sm font-medium transition-colors">
            <Plus size={16} /> Ajouter Compte
          </button>
        </div>
      </div>

      {/* INDIVIDUAL ACCOUNT CONTEXT MODAL */}
      {contextAccount && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[60] p-4 backdrop-blur-sm">
          <div className="bg-slate-900 border border-indigo-500/30 rounded-2xl p-8 max-w-xl w-full shadow-2xl animate-in fade-in zoom-in duration-200">
            <div className="flex justify-between items-start mb-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-600 rounded-lg">
                    <LucideIcons.Sparkles className="text-white" size={20} />
                </div>
                <div>
                    <h3 className="text-xl font-bold text-white">Instructions IA : {contextAccount.label}</h3>
                    <p className="text-slate-400 text-sm">Définissez des règles de détection spécifiques pour ce compte ({contextAccount.code}).</p>
                </div>
              </div>
              <button 
                onClick={() => setContextAccount(null)} 
                className="text-slate-500 hover:text-white transition-colors p-1"
              >
                <X size={24} />
              </button>
            </div>

            <div className="space-y-4 mb-6">
                <p className="text-sm text-slate-300 leading-relaxed italic">
                    Ex: "Si la transaction contient 'Apple Store', c'est toujours ce compte", ou "Ignorer si le montant est supérieur à 1000".
                </p>
                <textarea 
                    autoFocus
                    value={tempAccountContext}
                    onChange={(e) => setTempAccountContext(e.target.value)}
                    placeholder="Règles, mots-clés, exceptions..."
                    className="w-full h-48 bg-slate-950 border border-slate-700 rounded-xl p-4 text-slate-200 text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none resize-none"
                />
            </div>

            <div className="flex gap-3 justify-end pt-4 border-t border-slate-800">
              <button
                onClick={() => setContextAccount(null)}
                className="px-6 py-2 rounded-xl bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors text-sm font-medium"
              >
                Annuler
              </button>
              <button
                onClick={handleSaveAccountContext}
                className="px-6 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 font-bold shadow-lg shadow-indigo-900/40 transition-all text-sm flex items-center gap-2"
              >
                <Save size={18} />
                Enregistrer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
