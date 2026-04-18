# 📊 AssoCompta AI

[![Statut](https://img.shields.io/badge/Statut-En%20d%C3%A9veloppement-orange)](https://github.com/jknebel/Association_compta)
[![Tech Stack](https://img.shields.io/badge/Stack-React%20%7C%20FastAPI%20%7C%20Gemini-blue)](https://github.com/jknebel/Association_compta)

> **⚠️ Note : Ce projet est actuellement en cours de développement.**  
> L'application est fonctionnelle mais certaines fonctionnalités avancées et optimisations sont encore en phase de test.

## 🚀 Présentation

**AssoCompta AI** est une solution intelligente de gestion comptable conçue spécifiquement pour les associations. Elle automatise la saisie et le rapprochement comptable en s'appuyant sur l'intelligence artificielle (Google Gemini) et une architecture multi-agents (LangGraph).

L'objectif est de transformer des relevés bancaires complexes et des reçus froissés en une comptabilité structurée et conforme au Plan Comptable Associatif, avec un minimum d'effort humain.

## ✨ Fonctionnalités Clés

- **🤖 Extraction Intelligente de Relevés** : Analyse multi-agents des relevés bancaires PDF/images via LangGraph pour une précision maximale.
- **📄 Gestion des Justificatifs** : Analyse automatique des factures et reçus avec extraction de montants et dates.
- **🏷️ Catégorisation Automatique** : Mapping intelligent vers le Plan Comptable basé sur l'historique de l'association.
- **🕵️ Système de Consensus AI** : Utilisation de plusieurs agents (Vision, Worker, Auditor, Judge) pour valider l'intégrité des données extraites.
- **📊 Tableaux de Bord** : Visualisation claire de la santé financière de l'association.
- **☁️ Cloud-Native** : Synchronisation temps réel via Firebase et déploiement flexible (Docker/Cloud Run).

## 🛠️ Architecture Technique

### Frontend
- **Framework** : React 18 avec Vite
- **Langage** : TypeScript
- **Styling** : Tailwind CSS
- **Icônes** : Lucide React
- **Base de données/Auth** : Firebase SDK

### Backend
- **Framework** : FastAPI (Python)
- **AI Orchestration** : LangChain & LangGraph
- **Modèles LLM** : Google Gemini (Flash & Pro)
- **Traitement PDF** : PyMuPDF (fitz)
- **Database Admin** : Firebase Admin SDK

## 📦 Installation et Setup

### Prérequis
- Node.js (v18+)
- Python (3.10+)
- Un projet Firebase configuré
- Une clé API Google Gemini (AI Studio)

### 1. Configuration du Backend
```bash
cd backend
python -m venv venv
source venv/bin/activate # Sur Windows: venv\Scripts\activate
pip install -r requirements.txt
```
Créez un fichier `.env` dans `backend/` :
```env
GOOGLE_API_KEY=votre_cle_gemini
# Firebase credentials (ADC ou serviceAccountKey.json)
```

### 2. Configuration du Frontend
```bash
npm install
```
Créez un fichier `.env.local` à la racine :
```env
VITE_FIREBASE_API_KEY=...
# Autres config Firebase...
```

### 3. Lancement
- **Backend** : `uvicorn main:app --reload` (depuis le dossier `backend`)
- **Frontend** : `npm run dev` (depuis la racine)

## 🐳 Docker
Le projet inclut des Dockerfiles pour le déploiement.
```bash
docker build -t assocompta-backend ./backend
```

---
*Développé avec ❤️ pour simplifier la vie des trésoriers d'associations.*
