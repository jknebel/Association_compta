
import React from 'react';
import { LayoutDashboard, Upload, BookOpen, Users, MessageSquareText, Settings, Cloud, CloudOff, LogOut, User as UserIcon, Receipt, Github } from 'lucide-react';
import { useDataService } from '../services/dataService';
import { logout } from '../services/authService';
import { User } from 'firebase/auth';

interface LayoutProps {
  children: React.ReactNode;
  activeTab: string;
  onTabChange: (tab: string) => void;
  user?: User | null;
}

export const Layout: React.FC<LayoutProps> = ({ children, activeTab, onTabChange, user }) => {
  const { isConfigured } = useDataService(user || null);
  
  const navItems = [
    { id: 'dashboard', label: 'Tableau de bord', icon: LayoutDashboard },
    { id: 'upload', label: 'Import & Traitement', icon: Upload },
    { id: 'receipts', label: 'Pièces Comptables', icon: Receipt },
    { id: 'ledger', label: 'Journal / Transactions', icon: BookOpen },
    { id: 'members', label: 'Membres / Payeurs', icon: Users },
    { id: 'expert', label: 'Expert Comptable', icon: MessageSquareText },
    { id: 'settings', label: 'Plan Comptable', icon: Settings },
    // Removed Python Tab
    { id: 'deploy', label: 'GitHub & CI/CD', icon: Github },
  ];

  const handleLogout = async () => {
    try {
        await logout();
    } catch (e) {
        console.error("Logout failed", e);
    }
  };

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100">
      {/* Sidebar */}
      <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col shadow-lg z-10">
        <div className="p-6 border-b border-slate-800">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <span className="text-blue-500">Asso</span>Compta AI
          </h1>
          <p className="text-xs text-slate-400 mt-1">Comptabilité d'Association</p>
        </div>
        
        <nav className="flex-1 py-6 px-3 space-y-2">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors duration-200 ${
                activeTab === item.id 
                  ? 'bg-blue-600 text-white shadow-md' 
                  : 'text-slate-400 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <item.icon size={20} />
              <span className="font-medium">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="border-t border-slate-800">
            {/* User Profile */}
            {user && (
                <div className="p-4 border-b border-slate-800">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold">
                            {user.email ? user.email[0].toUpperCase() : 'U'}
                        </div>
                        <div className="overflow-hidden">
                            <p className="text-xs font-medium text-slate-200 truncate">{user.email}</p>
                            <button 
                                onClick={handleLogout}
                                className="text-[10px] text-rose-400 hover:text-rose-300 flex items-center gap-1 mt-1 transition-colors"
                            >
                                <LogOut size={10} />
                                Déconnexion
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Status */}
            <div className="p-4">
                <div className="flex items-center justify-center gap-2 text-xs mb-3 bg-slate-950 py-2 rounded-md border border-slate-800">
                    {isConfigured ? (
                        <>
                            <Cloud size={14} className="text-emerald-500" />
                            <span className="text-emerald-500 font-medium">En ligne</span>
                        </>
                    ) : (
                        <>
                            <CloudOff size={14} className="text-orange-500" />
                            <span className="text-orange-500 font-medium">Mode Local</span>
                        </>
                    )}
                </div>
                <div className="text-xs text-slate-500 text-center">
                    Propulsé par Gemini 3 Pro
                </div>
            </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto bg-slate-900 relative text-slate-100">
        {children}
      </main>
    </div>
  );
};
