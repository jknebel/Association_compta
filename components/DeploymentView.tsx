
import React, { useState } from 'react';
import { Download, FileCode, Github, Copy, Check, FolderOpen, Key, Globe, Zap, ShieldCheck } from 'lucide-react';

export const DeploymentView: React.FC = () => {
  const [copied, setCopied] = useState<string | null>(null);

  const handleCopy = (key: string, content: string) => {
    navigator.clipboard.writeText(content);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const downloadFile = (filename: string, content: string) => {
    const element = document.createElement("a");
    const file = new Blob([content], {type: 'text/yaml'});
    element.href = URL.createObjectURL(file);
    element.download = filename;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  // 1. WORKFLOW FRONTEND (FIREBASE)
  const frontendWorkflow = `name: Deploy Frontend (Firebase)

on:
  push:
    branches: [ "main" ]

jobs:
  build_and_deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - name: Install Dependencies
        run: npm ci

      - name: Build
        run: npm run build
        # INJECTION DES CLÉS VIA GITHUB SECRETS
        env:
          VITE_API_KEY: \${{ secrets.VITE_API_KEY }}
          VITE_FIREBASE_API_KEY: \${{ secrets.VITE_FIREBASE_API_KEY }}
          VITE_FIREBASE_AUTH_DOMAIN: \${{ secrets.VITE_FIREBASE_AUTH_DOMAIN }}
          VITE_FIREBASE_PROJECT_ID: \${{ secrets.VITE_FIREBASE_PROJECT_ID }}
          VITE_FIREBASE_STORAGE_BUCKET: \${{ secrets.VITE_FIREBASE_STORAGE_BUCKET }}
          VITE_FIREBASE_MESSAGING_SENDER_ID: \${{ secrets.VITE_FIREBASE_MESSAGING_SENDER_ID }}
          VITE_FIREBASE_APP_ID: \${{ secrets.VITE_FIREBASE_APP_ID }}

      - name: Deploy to Firebase Hosting
        uses: FirebaseExtended/action-hosting-deploy@v0
        with:
          repoToken: '\${{ secrets.GITHUB_TOKEN }}'
          firebaseServiceAccount: '\${{ secrets.FIREBASE_SERVICE_ACCOUNT_COMPTA_AI }}'
          channelId: live
          projectId: compta-ai
`;

  const structureTree = `mon-projet/
├── .github/
│   └── workflows/
│       └── deploy-frontend.yml  <-- Fichier à copier
├── src/                         <-- Code React
├── package.json
└── firebase.json`;

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-8 pb-20">
      <header>
        <h2 className="text-3xl font-bold text-slate-100 flex items-center gap-3">
          <Github className="text-white" size={32} />
          GitHub Actions & CI/CD
        </h2>
        <p className="text-slate-400 mt-2 text-lg">
          Déployez votre application automatiquement sur <b>Firebase Hosting</b>.
          Les clés API sont désormais gérées de manière sécurisée via les <b>GitHub Secrets</b>.
        </p>
      </header>

      <div className="bg-emerald-900/10 border border-emerald-900/30 p-4 rounded-xl flex items-start gap-3">
            <ShieldCheck className="text-emerald-400 shrink-0 mt-1" size={24} />
            <div className="text-sm text-emerald-200">
                <strong className="block mb-1 text-base">Sécurité Renforcée</strong>
                Le code source ne contient plus aucune clé API en dur.
                Lors du déploiement, GitHub Actions injectera les clés dans l'application via le processus de build (Vite).
            </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        
        {/* COLONNE GAUCHE : WORKFLOW */}
        <div className="space-y-6">
             <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
                <div className="bg-slate-950 px-4 py-3 border-b border-slate-800 flex justify-between items-center">
                    <div className="flex items-center gap-2">
                        <FileCode className="text-orange-500" size={18} />
                        <span className="font-mono text-sm text-slate-200">.github/workflows/deploy.yml</span>
                    </div>
                    <div className="flex gap-2">
                         <button onClick={() => downloadFile('deploy-frontend.yml', frontendWorkflow)} className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-white" title="Télécharger">
                             <Download size={16} />
                         </button>
                         <button onClick={() => handleCopy('front', frontendWorkflow)} className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-white" title="Copier">
                             {copied === 'front' ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
                         </button>
                    </div>
                </div>
                <div className="p-4 overflow-x-auto bg-[#0d1117]">
                    <pre className="text-xs font-mono text-slate-300 leading-relaxed">
                        {frontendWorkflow}
                    </pre>
                </div>
            </div>
        </div>

        {/* COLONNE DROITE : SECRETS */}
        <div className="space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
                <h3 className="font-bold text-slate-100 flex items-center gap-2 mb-4">
                    <Key className="text-emerald-500" size={20} />
                    Secrets à ajouter dans GitHub
                </h3>
                <p className="text-sm text-slate-400 mb-4">
                    Allez dans <em>Settings {'>'} Secrets and variables {'>'} Actions</em> et ajoutez les clés suivantes :
                </p>
                <div className="space-y-3 text-xs font-mono">
                    <div className="flex justify-between items-center bg-slate-950 p-2 rounded border border-slate-800">
                        <span className="text-yellow-400">VITE_API_KEY</span>
                        <span className="text-slate-500">Clé Google Gemini AI</span>
                    </div>
                    
                    <div className="p-2 rounded border border-slate-800 bg-slate-950/50 space-y-2">
                        <div className="text-slate-500 font-sans text-[10px] mb-1 uppercase tracking-wider">Configuration Firebase</div>
                        <div className="flex justify-between"><span className="text-blue-300">VITE_FIREBASE_API_KEY</span></div>
                        <div className="flex justify-between"><span className="text-blue-300">VITE_FIREBASE_AUTH_DOMAIN</span></div>
                        <div className="flex justify-between"><span className="text-blue-300">VITE_FIREBASE_PROJECT_ID</span></div>
                        <div className="flex justify-between"><span className="text-blue-300">VITE_FIREBASE_STORAGE_BUCKET</span></div>
                        <div className="flex justify-between"><span className="text-blue-300">VITE_FIREBASE_MESSAGING_SENDER_ID</span></div>
                        <div className="flex justify-between"><span className="text-blue-300">VITE_FIREBASE_APP_ID</span></div>
                    </div>

                    <div className="flex justify-between items-center bg-slate-950 p-2 rounded border border-slate-800">
                        <span className="text-purple-400">FIREBASE_SERVICE_ACCOUNT...</span>
                        <span className="text-slate-500">JSON de service pour le déploiement</span>
                    </div>
                </div>
            </div>
        </div>
      </div>
    </div>
  );
};
