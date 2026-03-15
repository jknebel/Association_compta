import os
import base64
import json
import io
import fitz # PyMuPDF
import json
from typing import List, Optional, Dict, Any
from datetime import datetime

from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Firebase Admin (Server Side)
import firebase_admin
from firebase_admin import credentials, firestore

# LangChain / LangGraph
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import SystemMessage, HumanMessage
from langgraph.graph import StateGraph, END
from dotenv import load_dotenv

# --- CONFIGURATION ---
load_dotenv()

# 1. Initialize Firebase Admin
# In production (Cloud Run/Heroku), use env vars or service account JSON.
# Locally, we might not have credentials, so we handle it gracefully.
try:
    if not firebase_admin._apps:
        # Option A: Local file
        # cred = credentials.Certificate("serviceAccountKey.json")
        
        # Option B: ADC (Application Default Credentials) - Best for Cloud Run
        cred = credentials.ApplicationDefault()
        firebase_admin.initialize_app(cred)
        
    db = firestore.client()
    print("✅ Firebase initialized successfully.")
except Exception as e:
    print(f"⚠️ Firebase initialization failed or skipped: {e}")
    print("   Running in 'No History' mode (Stateless).")
    db = None

app = FastAPI(title="AssoCompta AI Backend")

# Allow CORS for local dev and potential production domains
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:8080", "*"], # Adjust "*" for strict prod security later
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- DATA MODELS ---

class Account(BaseModel):
    id: str
    code: str
    label: str
    type: str
    parentId: Optional[str] = None
    description: Optional[str] = None
    isMembership: bool = False

class Transaction(BaseModel):
    id: Optional[str] = None
    date: str
    description: str
    amount: float
    runningBalance: Optional[float] = None
    accountId: Optional[str] = None
    detectedMemberName: Optional[str] = None
    status: str = "PENDING"
    notes: Optional[str] = None
    fullRawText: Optional[str] = None
    receiptUrl: Optional[str] = None
    receiptFileName: Optional[str] = None

class TransactionList(BaseModel):
    transactions: List[Transaction]

class ReceiptExtraction(BaseModel):
    amount: Optional[float] = None
    content: Optional[str] = None
    date: Optional[str] = None
class AnalyzeReceiptRequest(BaseModel):
    base64Data: str
    mimeType: str

class AnalyzeReceiptResponse(BaseModel):
    date: Optional[str] = None
    amount: Optional[float] = None

class ChatMessage(BaseModel):
    role: str
    text: str

class ChatContext(BaseModel):
    transactions: List[Transaction]
    accounts: List[Account]

class ChatRequest(BaseModel):
    history: List[ChatMessage]
    context: ChatContext
    newMessage: str
    
class ChatResponse(BaseModel):
    response: str

class SuggestCategoryRequest(BaseModel):
    description: str
    accounts: List[Account]
    fullRawText: Optional[str] = None
    receiptFileName: Optional[str] = None

class SuggestCategoryResponse(BaseModel):
    accountId: Optional[str] = None
    memberName: Optional[str] = None

# --- LLM HELPERS ---
def get_llm():
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        print("⚠️ GOOGLE_API_KEY missing. LLM calls will fail.")
    return ChatGoogleGenerativeAI(model="gemini-2.0-flash", temperature=0)

# --- UTILITY FUNCTIONS ---

def get_user_history_context(user_id: str, limit: int = 200) -> str:
    """
    Retrieves the last VALIDATED transactions from the user to serve as examples.
    This is where the AI 'memory' lives.
    Fail-safe: returns empty string if DB is not connected.
    """
    if not db:
        return "Pas d'historique disponible (Mode Offline/Sans BDD)."

    try:
        # Search for transactions with an assigned accountId (validated by human or confident AI)
        docs = (
            db.collection("users").document(user_id).collection("transactions")
            .where("accountId", "!=", None)
            .order_by("accountId") # Required by Firestore for != clauses
            .order_by("date", direction=firestore.Query.DESCENDING)
            .limit(limit)
            .stream()
        )
        
        history_lines = []
        for doc in docs:
            data = doc.to_dict()
            # Format a compact example line
            # Ex: "Libellé: Virement Bolomet | Montant: 100.0 | CompteID: 12345"
            line = f"Libellé: '{data.get('description', '')}' | Montant: {data.get('amount')} -> CompteID: {data.get('accountId')}"
            history_lines.append(line)
            
        if not history_lines:
            return "Aucun historique disponible."
            
        return "\n".join(history_lines)
    except Exception as e:
        print(f"Error reading history: {e}")
        return "Erreur lors de la récupération de l'historique."

# --- LANGGRAPH LOGIC ---

class AgentState(BaseModel):
    user_id: str
    pdf_base64: str
    existing_accounts: List[Account]
    raw_text: str = ""
    extracted_transactions: List[Transaction] = []
    page_count: int = 0
    logs: List[str] = []

def vision_node(state: AgentState):
    """Vision Extraction: Image/PDF -> Raw Text"""
    print("--- [Agent: VISION][INPUT_START] ---")
    print(f"UserId: {state.user_id}")
    print(f"PDF Base64 Length: {len(state.pdf_base64)}")
    print("--- [Agent: VISION][INPUT_END] ---")
    
    # 1. Tenter une extraction native intelligente avec PyMuPDF
    try:
        pdf_bytes = base64.b64decode(state.pdf_base64)
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        page_counts = len(doc)
        raw_text = ""
        for page in doc:
            raw_text += page.get_text("text") + "\n"
        doc.close()
        
        # Si le PDF contient du vrai texte (pas juste un scan d'image), on l'utilise direct
        if len(raw_text.strip()) > 500:
            print("--- [Agent: VISION][OUTPUT_START] ---")
            print(f"Extracted Native PyMuPDF Text Length: {len(raw_text)} | Pages: {page_counts}")
            print("--- [Agent: VISION][OUTPUT_END] ---")
            return {
                "raw_text": raw_text,
                "page_count": page_counts,
                "logs": [f"Extraction native réussie ({len(raw_text)} caractères, {page_counts} pages)."]
            }
        else:
            print("PDF semble être un scan court, fallback vers l'IA Vision...")
    except Exception as e:
        print(f"PyMuPDF Error, fallback to Vision: {e}")

    # Fallback si PDF non-texte ou erreur : on tente de compter les pages si possible
    try:
        pdf_bytes = base64.b64decode(state.pdf_base64)
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        page_counts = len(doc)
        doc.close()
    except:
        page_counts = 1 # Par défaut 1 si on arrive pas à lire le PDF du tout

    prompt = """
    Voici un document bancaire. Ton SEUL et UNIQUE but est d'extraire tout le texte visible.
    Pour l'intégralité du document, copie absolument TOUT le texte (dates, toutes les lignes de descriptions, montants, donneurs d'ordre, communications, adresses, etc.).
    Garde l'ordre de lecture. Ne tente pas de formater (pas de JSON) ou de résumer. Sois une machine de transcription parfaite. Ne saute aucune ligne !
    """
    
    message = HumanMessage(
        content=[
            {"type": "text", "text": prompt},
            {
                "type": "image_url", 
                "image_url": {"url": f"data:application/pdf;base64,{state.pdf_base64}"}
            }
        ]
    )
    
    try:
        flash_llm = get_llm()
        result = flash_llm.invoke([message])
        
        print("--- [Agent: VISION][OUTPUT_START] ---")
        print(f"Extracted Raw Text Length: {len(result.content)}")
        print(f"Raw Text Preview: {result.content[:200]}...")
        print("--- [Agent: VISION][OUTPUT_END] ---")

        return {
            "raw_text": result.content,
            "logs": ["Extraction visuelle du texte brut terminée."]
        }
    except Exception as e:
        print(f"Vision Error: {e}")
        return {
            "raw_text": "",
            "logs": [f"Erreur de vision: {str(e)}"]
        }

def parsing_node(state: AgentState):
    """Text -> Structured JSON"""
    print("--- [Agent: PARSING][INPUT_START] ---")
    print(f"Raw Text Preview: {state.raw_text[:500]}...")
    print("--- [Agent: PARSING][INPUT_END] ---")
    
    if not state.raw_text:
        return {"logs": ["Erreur: Aucun texte brut fourni au parseur."]}
        
    prompt = f"""
    Voici le texte brut exhaustivement extrait d'un document bancaire :
    
    ---------------------
    {state.raw_text}
    ---------------------
    
    Tu dois retrouver et extraire toutes les transactions sous forme structurée en respectant ces règles STRICTES :
    1.  **Date** : Convertis les dates au format YYYY-MM-DD. ATTENTION: Le texte d'origine utilise le format Européen (Jour.Mois.Année ou DD.MM.YY). Ne confonds pas le mois et le jour.
        IGNORES et EXCLUS totalement les lignes de type "REPORT", "SOLDE REPORTE", "SOLDE A REPORTER". Ce ne sont pas des transactions. N'invente jamais de date pour elles.
    2.  **Montant** : Positif pour crédit, Négatif pour débit.
        CRITIQUE: Le montant ne doit JAMAIS être 0.00 sauf si c'est explicitement écrit '0.00'. Ne mets JAMAIS 0 par défaut.
    3.  **runningBalance** : NOUVEAU et VITAL. Sur chaque ligne de transaction (ou juste à côté), il y a le "solde", c'est-à-dire le solde du compte après l'opération (tu le vois progresser au fur et à mesure). Extraie cette valeur (en float). Si tu ne la trouves vraiment pas, laisse null.
    4.  **Description** : Un libellé 'small' très court et propre pour l'affichage (ex: 'Parking', 'Cotisation Dupont', 'Virement Andrea Lozzi').
    5.  **Transactions sur plusieurs pages** : ATTENTION, une transaction peut commencer en bas d'une page (avec sa date et son début) et continuer sur la page suivante (ex: "COMMUNICATIONS", "BENEFICIAIRE"). Tu dois fusionner intelligemment ces blocs pour reconstituer UNE SEULE transaction complète. Ignore le texte parasite de changement de page (logos, numéro de page, "SOLDE A REPORTER", "REPORT") situé au milieu de la transaction.
    6.  **fullRawText** : OBLIGATOIRE ET VITAL. Recopie ici de manière exhaustive TOUT le bloc de texte brut associé à cette transaction. Si la transaction est coupée sur deux pages, regroupe tout le texte brut pertinent dans ce seul champ. Ne tronque rien !
    """
    
    try:
        flash_llm = get_llm()
        structured_llm = flash_llm.with_structured_output(TransactionList)
        result = structured_llm.invoke(prompt)
        
        print("--- [Agent: PARSING][OUTPUT_START] ---")
        print(f"Extracted {len(result.transactions)} transactions.")
        for i, t in enumerate(result.transactions[:3]):
             print(f"Txn {i}: {t.date} | {t.description} | {t.amount} | Raw: {t.fullRawText}")
        print("--- [Agent: PARSING][OUTPUT_END] ---")

        return {
            "extracted_transactions": result.transactions,
            "logs": [f"Parsing texte terminé: {len(result.transactions)} transactions structurées."]
        }
    except Exception as e:
        print(f"Parsing Error: {e}")
        return {
            "extracted_transactions": [],
            "logs": [f"Erreur de parsing: {str(e)}"]
        }

def amount_verification_node(state: AgentState):
    """
    Double vérification mathématique des montants via le solde courant (runningBalance).
    Détecte les transactions manquantes, erreurs de signe, et montant == 0.
    """
    print("--- [Agent: AMOUNT_VERIFICATION][INPUT_START] ---")
    transactions = state.extracted_transactions
    zero_txns = [t for t in transactions if t.amount == 0.0]
    
    anomaly_txns = []
    direction = 1
    if len(transactions) >= 2:
        for i in range(1, len(transactions)):
            prev = transactions[i-1]
            curr = transactions[i]
            if prev.runningBalance is not None and curr.runningBalance is not None:
                diff = round(curr.runningBalance - prev.runningBalance, 2)
                if diff == round(curr.amount, 2):
                    direction = 1
                elif diff == round(-curr.amount, 2):
                    direction = -1
                break

    for i in range(1, len(transactions)):
        curr = transactions[i]
        prev = transactions[i-1]
        
        if curr.runningBalance is not None and prev.runningBalance is not None:
            expected_diff = round(curr.amount, 2) if direction == 1 else round(-curr.amount, 2)
            actual_diff = round(curr.runningBalance - prev.runningBalance, 2)
            
            if abs(actual_diff - expected_diff) > 0.02:
                if curr.amount != 0.0:
                    anomaly_txns.append({
                        "txn": curr,
                        "prev_bal": prev.runningBalance,
                        "curr_bal": curr.runningBalance,
                        "diff": actual_diff,
                        "amount": curr.amount
                    })

    print(f"Total Txns: {len(transactions)} | Suspicious (0.0): {len(zero_txns)} | Anomalies Mathématiques: {len(anomaly_txns)}")
    
    # Estimation du nombre de transactions (4 à 6 par page)
    min_expected = state.page_count * 4
    max_expected = state.page_count * 6
    estimation_msg = ""
    if len(transactions) < min_expected:
        estimation_msg = f"⚠️ ALERTE : Nombre de transactions faible ({len(transactions)}) pour {state.page_count} pages (estimation attendue : {min_expected}-{max_expected})."
        print(estimation_msg)
    
    print("--- [Agent: AMOUNT_VERIFICATION][INPUT_END] ---")
    
    if not zero_txns and not anomaly_txns:
        final_logs = [f"Vérification mathématique : OK ({len(transactions)} transactions, balance parfaite)."]
        if estimation_msg:
            final_logs.append(estimation_msg)
        return {
            "logs": final_logs
        }
    
    suspect_lines = []
    for t in zero_txns:
         suspect_lines.append(f"- Date: {t.date}, Desc: '{t.description}' (montant 0.00)")
         
    for an in anomaly_txns:
         t = an["txn"]
         suspect_lines.append(f"- Date: {t.date}, Desc: '{t.description}', Montant extrait: {an['amount']} | Solde précédent: {an['prev_bal']}, Solde affiché: {an['curr_bal']}. Écart attendu: {an['amount']}, Écart réel constaté: {an['diff']}. (Erreur de signe ou oubli avant cette ligne ?)")
         
    suspect_descriptions = "\n".join(suspect_lines)
    
    prompt = f"""
    ALERTE: Lors de l'extraction, des anomalies mathématiques ont été détectées en vérifiant les "soldes courants" (running balance).
    
    Lignes problématiques :
    {suspect_descriptions}
    
    Relis attentivement le document bancaire ci-joint et retrouve la VRAIE transaction (ou vérifie son signe +/-) pour corriger ces erreurs. 
    1) Si une transaction a été totalement oubliée par l'agent précédent (ce qui fausse le solde), extrais la transaction manquante complète et inclue-la.
    2) Si le signe du montant est erroné (ex: Débit au lieu de Crédit), corrige-le (Positif = crédit/recette, Négatif = débit/dépense).
    
    Retourne UNIQUEMENT les transactions corrigées ou oubliées, avec leur montant parfaitement ajusté, et le runningBalance correspondant.
    """
    
    message = HumanMessage(
        content=[
            {"type": "text", "text": prompt},
            {
                "type": "image_url",
                "image_url": {"url": f"data:application/pdf;base64,{state.pdf_base64}"}
            }
        ]
    )
    
    try:
        flash_llm = get_llm()
        structured_llm = flash_llm.with_structured_output(TransactionList)
        result = structured_llm.invoke([message])
        
        correction_map = {}
        for corrected_txn in result.transactions:
            key = (corrected_txn.date, corrected_txn.description.strip().lower()[:20])
            correction_map[key] = corrected_txn
            
        updated_transactions = []
        corrections_applied = 0
        still_zero = 0
        
        for t in transactions:
            key = (t.date, t.description.strip().lower()[:20])
            if key in correction_map and correction_map[key].amount != 0.0:
                t.amount = correction_map[key].amount
                t.runningBalance = correction_map[key].runningBalance
                corrections_applied += 1
                del correction_map[key]
            else:
                if t.amount == 0.0:
                    still_zero += 1
            updated_transactions.append(t)
            
        added_missing = 0
        for rem_key, rem_txn in correction_map.items():
            if rem_txn.amount != 0.0:
                updated_transactions.append(rem_txn)
                added_missing += 1
        
        # Sort to ensure any missing txns inserted at the end are placed in chronologic order
        updated_transactions.sort(key=lambda x: str(x.date))
        
        print("--- [Agent: AMOUNT_VERIFICATION][OUTPUT_START] ---")
        print(f"Corrections Applied: {corrections_applied} | Added Missing: {added_missing} | Still Zero: {still_zero}")
        print("--- [Agent: AMOUNT_VERIFICATION][OUTPUT_END] ---")

        log_msg = f"Vérification montants: {corrections_applied} corrigé(s), {added_missing} rattrapé(s)"
        if still_zero > 0:
            log_msg += f" ({still_zero} toujours à 0)"
        
        final_logs = [log_msg]
        if estimation_msg:
            final_logs.append(estimation_msg)

        return {
            "extracted_transactions": updated_transactions,
            "logs": final_logs
        }
    except Exception as e:
        print(f"Amount Verification Error: {e}")
        return {
            "logs": [f"Erreur vérification montants: {str(e)} — Montants originaux conservés."]
        }

def classification_node(state: AgentState):
    """
    Classification with LEARNING (RAG-lite).
    """
    print("--- [Agent: CLASSIFICATION][INPUT_START] ---")
    transactions = state.extracted_transactions
    accounts = state.existing_accounts
    user_id = state.user_id
    print(f"To Classify: {len(transactions)} | Accounts available: {len(accounts)} | UserId: {user_id}")
    if transactions:
        print(f"First Transaction to classify (full JSON): {json.dumps(transactions[0].model_dump(), default=str)}")
    print("--- [Agent: CLASSIFICATION][INPUT_END] ---")
    
    if not transactions:
        return {}

    # 1. Retrieve User Memory
    history_context = get_user_history_context(user_id)
    print(f"History Context Length: {len(history_context)} chars")
    
    # 2. Prepare Account Context
    # Map ID -> Label to help AI
    accounts_info = "\n".join([f"ID: {a.id} | Code: {a.code} | Nom: {a.label} | Type: {a.type}" for a in accounts])
    
    # 3. Advanced Prompt with History
    prompt = f"""
    Tu es un expert comptable intelligent. Ta tâche est d'assigner le bon 'accountId' aux nouvelles transactions.

    ### 1. PLAN COMPTABLE ACTUEL
    {accounts_info}

    !!! TRÈS IMPORTANT !!!
    Pour le champ 'accountId', tu DOIS utiliser UNIQUEMENT la valeur 'ID' (souvent un UUID ou une chaîne complexe) fournie dans la liste ci-dessus.
    NE renvoie PAS le 'Code' (ex: 701000) ni le 'Nom'.
    Si tu penses que c'est le compte "Cotisations" (Code 701000), tu dois chercher son ID correspondant dans la liste et renvoyer cet ID.

    ### 2. RÈGLES COMPTABLES (SIGNES ET CLASSES) - CRITIQUE
    Tu dois impérativement respecter la logique comptable suivante :

    1.  **MONTANTS NÉGATIFS (Dépenses / Débits)** :
        -   Ils correspondent généralement à des **CHARGES** (Comptes de type CHARGE).
        -   Exemple : -20.00 CHF pour "Parking" doit aller dans un compte de type CHARGE.
        -   IL EST INTERDIT de classer un montant négatif dans un compte de type PRODUIT, sauf s'il s'agit d'un remboursement client (rare).

    2.  **MONTANTS POSITIFS (Recettes / Crédits)** :
        -   Ils correspondent généralement à des **PRODUITS** (Comptes de type PRODUIT).
        -   Exemple : +50.00 CHF pour "Cotisation" doit aller dans un compte de type PRODUIT.

    3.  **COMPTES MIXTES** :
        -   Les comptes de type MIXTE (ex: "Noël", "Activité") peuvent recevoir des montants positifs ET négatifs.
        -   Par exemple, un compte "Noël" MIXTE peut avoir des dépenses (-200€ achat cadeaux) et des recettes (+50€ buvette).
        -   Pour les comptes MIXTE, la règle Charge/Produit ne s'applique PAS.

    4.  **VIREMENTS INTERNES** :
        -   Les mouvements de fonds (classe 58) peuvent être positifs ou négatifs.

    **VERIFICATION :** Avant d'assigner un compte, vérifie :
    - Si le compte est MIXTE → accepte les deux signes.
    - Si le compte est CHARGE → le montant doit être négatif.
    - Si le compte est PRODUIT → le montant doit être positif.

    ### 3. HISTORIQUE & APPRENTISSAGE (TRÈS IMPORTANT)
    Voici comment cet utilisateur a classé ses transactions précédentes. 
    Utilise ces exemples pour comprendre sa logique.
    
    RÈGLES D'APPRENTISSAGE :
    - Cherche des patterns dans les descriptions (ex: références 'xxxcv', noms de fournisseurs).
    - Regarde les montants récurrents (ex: 100.00 tout rond souvent = Loyer ou Parking).
    - Si tu vois "M. Bolomet" classé en "Parking" dans le passé, et que tu vois "Mme Bolomet" avec le même montant/référence aujourd'hui, classe-le aussi en "Parking".
    - Si la référence (ex: 'xxxcv') correspond à un compte passé, c'est prioritaire sur le nom.

    ### 4. NOUVELLES TRANSACTIONS À CLASSER
    ATTENTION : Les deux champs LES PLUS IMPORTANTS pour prendre ta décision sont 'amount' (pour le signe et l'ordre de grandeur) et 'fullRawText' (qui contient la transaction originale non-tronquée).
    
    - Base-toi prioritairement sur 'fullRawText' et 'amount' plutôt que sur 'description' (qui a pu être raccourcie par l'Agent précédent).
    - TRÈS IMPORTANT: Dans 'fullRawText', si tu vois le mot-clé "COMMUNICATIONS:", ce qui suit est l'information la plus cruciale de la transaction (ex: le vrai motif du paiement). Utilise-le en priorité absolue pour trouver le bon 'accountId'.
    - La section "BENEFICIAIRE:" indique souvent notre propre compte/association et est donc peu pertinente pour déterminer la catégorie d'une dépense/recette. Ne te laisse pas distraire par elle.
    - En revanche, la section "DONNEUR D'ORDRE:" indique la personne source (ex: la personne ayant viré l'argent). Extrais ce nom et mets-le dans 'detectedMemberName'. SAUF SI tu trouves un autre nom de personne explicitement mentionné dans "COMMUNICATIONS:" (ex: "Cotisation 25 Louise B" ou "Monsieur X paie pour Madame B"). Dans ce cas, c'est ce nom dans "COMMUNICATIONS:" (Louise B, Madame B) qui prime et qui DOIT devenir le seul 'detectedMemberName'.
    - Si tu vois une date de période pertinente (ex: "Loyer Janvier"), note-le également.
    - Regarde aussi 'receiptFileName' qui contient le nom original du justificatif sans extension (ex: "Bouffe Etapes Ikicize"). Ce nom contient TRÈS SOUVENT des indices vitaux sur la catégorie.

    DONNÉES HISTORIQUES :
    ---------------------
    {history_context}
    ---------------------

    ### 5. NOUVELLES TRANSACTIONS À CLASSER
    {json.dumps([t.model_dump() for t in transactions], default=str)}

    !!! CONSEIL POUR LE DÉMARRAGE !!!
    Si tu n'as pas beaucoup d'historique, utilise ton bon sens d'expert comptable. 
    - Pour les dépenses courantes sans catégorie spécifique (ex: train, parking), utilise le compte le plus générique (ex: 'Activité' ou 'Gestion').
    - N'aie pas peur de proposer un compte : il vaut mieux une suggestion pertinente qu'un champ vide.
    - Propose le compte le plus probable plutôt que de laisser 'accountId' à null, sauf si c'est vraiment impossible à déterminer.

    Retourne la liste des transactions avec le champ 'accountId' rempli ET 'detectedMemberName' extrait si possible.
    """
    
    print("--- [Agent: CLASSIFICATION][PROMPT_START] ---")
    print(prompt)
    print("--- [Agent: CLASSIFICATION][PROMPT_END] ---")

    try:
        flash_llm = get_llm()
        structured_llm = flash_llm.with_structured_output(TransactionList)
        result = structured_llm.invoke(prompt)
        
        print("--- [Agent: CLASSIFICATION][RAW_OUTPUT_START] ---")
        for i, t in enumerate(result.transactions): # Log ALL to be sure
            print(f"Raw Txn {i}: {t.description} -> accountId suggested: '{t.accountId}'")
        print("--- [Agent: CLASSIFICATION][RAW_OUTPUT_END] ---")

        # Post-processing: Validate, Correct Account IDs, and Preserve Original Data
        validated_transactions = []
        account_map = {str(a.id): a for a in accounts}
        code_map = {str(a.code): a for a in accounts} 
        label_map = {str(a.label).lower().strip(): a for a in accounts} # New Robust Fallback
        
        # Build a map of the original transactions to preserve fields the AI might drop
        original_txns_map = {t.description: t for t in transactions}

        for txn in result.transactions:
            # Re-inject missing critical data from the original transaction
            # because the AI output structure often omits them.
            orig_t = original_txns_map.get(txn.description)
            if orig_t:
                txn.fullRawText = orig_t.fullRawText
                txn.receiptFileName = orig_t.receiptFileName
                txn.receiptUrl = orig_t.receiptUrl
                txn.notes = orig_t.notes

            if txn.accountId:
                # Clean up the ID returned by AI
                tid = str(txn.accountId).strip()
                
                # 1. Check if ID is valid
                if tid in account_map:
                    txn.accountId = tid
                # 2. Fallback: Check if AI returned a Code instead
                elif tid in code_map:
                    print(f"Fallback matched Code: {tid} -> {code_map[tid].id}")
                    txn.accountId = code_map[tid].id
                # 3. Fallback: Check if AI returned a Label instead
                elif tid.lower() in label_map:
                    print(f"Fallback matched Label: {tid} -> {label_map[tid.lower()].id}")
                    txn.accountId = label_map[tid.lower()].id
                else:
                    # Invalid ID, reset
                    print(f"Warning: AI suggested invalid accountId/Code/Label: '{tid}'")
                    txn.accountId = None
            validated_transactions.append(txn)

        print("--- [Agent: CLASSIFICATION][OUTPUT_START] ---")
        for i, t in enumerate(validated_transactions):
             print(f"Txn {i}: {t.description} -> AccountID: {t.accountId} | Member: {t.detectedMemberName}")
             # Affichage complet du Pydantic model pour debug
             if "CFF" in (t.description or "").upper(): # Filtre optionnel pour ne pas polluer les logs si tu veux, ou affiche tout :
                 print(f"FULL TXN OUTPUT (JSON): {t.model_dump_json(indent=2)}")
        print("--- [Agent: CLASSIFICATION][OUTPUT_END] ---")

        return {
            "extracted_transactions": validated_transactions,
            "logs": ["Classification intelligente terminée avec historique et validation."]
        }
    except Exception as e:
        print(f"Classification Error: {e}")
        return {
            "logs": [f"Erreur de classification: {str(e)}"]
        }

# Build Graph
workflow = StateGraph(AgentState)
workflow.add_node("vision", vision_node)
workflow.add_node("parse", parsing_node)
workflow.add_node("verify_amounts", amount_verification_node)
workflow.add_node("classify", classification_node)

workflow.set_entry_point("vision")
workflow.add_edge("vision", "parse")
workflow.add_edge("parse", "verify_amounts")
workflow.add_edge("verify_amounts", "classify")
workflow.add_edge("classify", END)

compiled_app = workflow.compile()

# --- ENDPOINTS ---

@app.get("/health")
def health_check():
    return {"status": "ok", "service": "AssoCompta Backend"}

@app.post("/process-bank-statement")
async def process_statement(
    file: UploadFile = File(...),
    accounts: str = Form(...),
    userId: str = Form(...) 
):
    try:
        print(f"Processing file: {file.filename} for user: {userId}")
        content = await file.read()
        b64_pdf = base64.b64encode(content).decode("utf-8")
        
        # Safe Account Parsing
        try:
            raw_accounts = json.loads(accounts)
            accounts_list = [Account(**a) for a in raw_accounts]
        except Exception as e:
            print(f"Account parsing error: {e}")
            raise HTTPException(status_code=400, detail="Invalid accounts JSON format")
        
        initial_state = AgentState(
            user_id=userId,
            pdf_base64=b64_pdf,
            existing_accounts=accounts_list
        )
        
        output = compiled_app.invoke(initial_state)
        
        return {
            "transactions": output["extracted_transactions"],
            "logs": output["logs"]
        }
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/process-receipt")
async def process_receipt(
    file: UploadFile = File(...),
    transactions: str = Form(...) 
):
    try:
        print(f"Processing receipt: {file.filename} ({file.content_type})")
        content = await file.read()
        
        # If it's a PDF, we convert the first page to an image for Gemini Vision
        if file.content_type == "application/pdf":
            try:
                pdf_doc = fitz.open(stream=content, filetype="pdf")
                first_page = pdf_doc.load_page(0)
                pix = first_page.get_pixmap(matrix=fitz.Matrix(2, 2)) # 2x zoom for better text readability
                content = pix.tobytes("jpeg")
                mime_type = "image/jpeg"
                pdf_doc.close()
            except Exception as e:
                print(f"PDF conversion error: {e}")
                raise HTTPException(status_code=400, detail="Could not read PDF file")
        else:
            mime_type = file.content_type

        b64_file = base64.b64encode(content).decode("utf-8")
        
        try:
            raw_txns = json.loads(transactions)
            txns_list = [Transaction(**t) for t in raw_txns]
        except Exception as e:
            print(f"Transactions parsing error: {e}")
            raise HTTPException(status_code=400, detail="Invalid transactions JSON format")
            
        flash_llm = get_llm()
        structured_llm = flash_llm.with_structured_output(ReceiptExtraction)
        
        prompt = """
        Analyse cette pièce comptable (reçu/facture).
        Extrais à minima et dans cet ordre d'importance :
        1. Le montant TOTAL (amount) en float.
        2. Le contenu/marchand/description (content).
        3. La date (date) au format YYYY-MM-DD.
        """
        
        message = HumanMessage(
            content=[
                {"type": "text", "text": prompt},
                {
                    "type": "image_url", 
                    "image_url": {"url": f"data:{mime_type};base64,{b64_file}"}
                }
            ]
        )
        
        extraction = structured_llm.invoke([message])
        print(f"Extracted from receipt: {extraction.model_dump()}")
        
        matched_id = None
        
        if extraction.amount is not None:
            target_amount = abs(extraction.amount)
            unlinked_txns = [t for t in txns_list if not t.receiptUrl]
            
            # Priority 2: Match against charges (amount < 0) with exactly the same amount
            candidates_amount = [t for t in unlinked_txns if t.amount < 0 and abs(abs(t.amount) - target_amount) < 0.05]
            
            if len(candidates_amount) == 1:
                matched_id = candidates_amount[0].id
            elif len(candidates_amount) > 1:
                # Priority 5: If 2 similar amounts, resolve using date and content
                for c in candidates_amount:
                    if extraction.date and c.date == extraction.date:
                        matched_id = c.id
                        break
                    if extraction.content and c.description and (c.description.lower() in extraction.content.lower() or extraction.content.lower() in c.description.lower()):
                        matched_id = c.id
                        break
            
            # Priority 3: If no charge with same amount, check in remarks/notes/description
            if not matched_id:
                candidates_remarks = []
                for t in unlinked_txns:
                    text_to_search = (str(t.description or "") + " " + str(t.notes or "")).lower()
                    # Look for string representation of the amount
                    if str(target_amount) in text_to_search or str(int(target_amount)) in text_to_search:
                        candidates_remarks.append(t)
                
                if len(candidates_remarks) == 1:
                    matched_id = candidates_remarks[0].id
                elif len(candidates_remarks) > 1:
                    for c in candidates_remarks:
                        if extraction.date and c.date == extraction.date:
                            matched_id = c.id
                            break
                            
            # Priority 4: if still nothing, try date + content match
            if not matched_id and extraction.date and extraction.content:
                for t in unlinked_txns:
                    if t.date == extraction.date and t.description and (t.description.lower() in extraction.content.lower() or extraction.content.lower() in t.description.lower()):
                        matched_id = t.id
                        break
                        
        print(f"Matched transaction: {matched_id}")
        
        return {
            "extracted": extraction.model_dump(),
            "matchedTransactionId": matched_id
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/analyze-receipt")
async def analyze_receipt(request: AnalyzeReceiptRequest):
    try:
        flash_llm = get_llm()
        structured_llm = flash_llm.with_structured_output(AnalyzeReceiptResponse)
        
        prompt = """
        Analyze this receipt/invoice.
        Extract:
        1. The date of the transaction (Format YYYY-MM-DD).
        2. The TOTAL amount (Float).
        
        If you cannot find one of them, return null for that field.
        """
        
        message = HumanMessage(
            content=[
                {"type": "text", "text": prompt},
                {
                    "type": "image_url", 
                    "image_url": {"url": f"data:{request.mimeType};base64,{request.base64Data}"}
                }
            ]
        )
        
        result = structured_llm.invoke([message])
        return result
    except Exception as e:
        print(f"Receipt Analysis Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/chat")
async def chat_agent(request: ChatRequest):
    try:
        # Prepare Context
        txns_summary = f"{len(request.context.transactions)} transactions"
        accounts_summary = f"{len(request.context.accounts)} accounts"
        
        income = sum(t.amount for t in request.context.transactions if t.amount > 0)
        expenses = sum(t.amount for t in request.context.transactions if t.amount < 0)
        
        system_prompt = f"""
        You are an intelligent accounting assistant for an association.
        You have access to the current financial data:
        {accounts_summary} and {txns_summary}.
        
        Total Income: {income:.2f}
        Total Expenses: {expenses:.2f}
        
        Answer questions about the finances, help categorize items, or explain accounting principles.
        If asked to perform an action (like "create an account"), guide the user on how to do it in the UI.
        """
        
        messages = [SystemMessage(content=system_prompt)]
        
        # Add History
        for msg in request.history:
             if msg.role == 'user':
                 messages.append(HumanMessage(content=msg.text))
             else:
                 messages.append(HumanMessage(content=msg.text)) # LangChain usually uses AIMessage, but HumanMessage works for simple history if role is clear? 
                 # Actually better to use AIMessage for model
                 
        # Add new message
        messages.append(HumanMessage(content=request.newMessage))
        
        # Use Pro model if available, or Flash
        llm = ChatGoogleGenerativeAI(model="gemini-2.0-flash", temperature=0.7)
        response = llm.invoke(messages)
        
        return ChatResponse(response=response.content)
    except Exception as e:
        print(f"Chat Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/suggest-category")
async def suggest_category(request: SuggestCategoryRequest):
    try:
        print("--- [Agent: SUGGEST_CATEGORY][INPUT_START] ---")
        print(f"Description: {request.description}")
        print(f"FullRawText: {request.fullRawText[:100] if request.fullRawText else 'N/A'}...")
        print(f"Accounts Count: {len(request.accounts)}")
        print("--- [Agent: SUGGEST_CATEGORY][INPUT_END] ---")

        # 1. Build Account Map for easy parent lookup
        account_map = {a.id: a for a in request.accounts}

        # 2. Helper to get full path
        def get_account_path(account):
            path = [account.label]
            current = account
            # Walk up the tree (max 3 levels to avoid infinite loops if cycle)
            for _ in range(3):
                if hasattr(current, 'parentId') and current.parentId and current.parentId in account_map:
                    parent = account_map[current.parentId]
                    path.insert(0, parent.label)
                    current = parent
                else:
                    break
            return " > ".join(path)

        # 3. Prepare Context with Path and Description
        accounts_context = []
        for a in request.accounts:
            # Safe attribute access + optional description
            desc = getattr(a, 'description', '')
            full_path = get_account_path(a)
            
            context_entry = {
                "id": a.id, 
                "label": a.label,
                "path": full_path,
                "description": desc,
                "isMembership": getattr(a, 'isMembership', False)
            }
            accounts_context.append(context_entry)
        
        prompt = f"""
        Analyze the transaction:
        - Description (short): "{request.description}"
        - Amount: {request.amount}
        - Full Raw Text: "{request.fullRawText or 'N/A'}"
        - Receipt File Name: "{request.receiptFileName or 'N/A'}"
        
        ATTENTION : Les deux champs LES PLUS IMPORTANTS pour ta décision sont 'amount' (signe et valeur) et 'fullRawText' (texte original complet).
        La 'Description' courte n'est qu'un résumé qui peut être trompeur.
        
        Task 1: Select the best matching Account ID from the list below.
        CRITICAL INSTRUCTIONS FOR MATCHING:
        - Use the 'path' field to understand the account hierarchy.
        - The Receipt File Name often contains the vendor or category context (e.g., "Bouffe Etapes").
        - If 'fullRawText' contains a specific name or purpose, use it!
        
        Task 2: Extract 'memberName' if available in 'fullRawText' or 'description'.
        
        Accounts: {json.dumps(accounts_context)}
        
        Return a strict JSON object: {{ "accountId": "ID_OR_NULL", "memberName": "EXTRACTED_NAME_OR_NULL" }}
        """
        
        flash_llm = get_llm()
        structured_llm = flash_llm.with_structured_output(SuggestCategoryResponse)
        result = structured_llm.invoke(prompt)
        
        print("--- [Agent: SUGGEST_CATEGORY][OUTPUT_START] ---")
        print(f"Result: {result.model_dump()}")
        print("--- [Agent: SUGGEST_CATEGORY][OUTPUT_END] ---")

        return result
    except Exception as e:
        print(f"Suggest Category Error: {e}")
        # Return empty/null result instead of crashing
        return SuggestCategoryResponse(accountId=None, memberName=None)

# --- AUDIT ENDPOINT ---

class AuditRequest(BaseModel):
    transactions: List[Transaction]
    accounts: List[Account]

@app.post("/audit")
async def audit_ledger_endpoint(request: AuditRequest):
    try:
        # Pre-calc totals
        income = sum(t.amount for t in request.transactions if t.amount > 0)
        expenses = sum(t.amount for t in request.transactions if t.amount < 0)
        balance = income + expenses
        
        # Format data for AI
        txns_text = "\n".join([f"{t.date} | {t.description} | {t.amount} | ID: {t.accountId}" for t in request.transactions])
        accounts_text = "\n".join([f"ID: {a.id} | {a.code} - {a.label} ({a.type})" for a in request.accounts])
        
        prompt = f"""
        Tu es un Expert Comptable IA certifié. Ta mission est d'auditer la comptabilité de cette association pour la clôture.
        
        DONNÉES FINANCIÈRES :
        ---------------------
        Comptes :
        {accounts_text}
        
        Transactions (Toutes validées) :
        {txns_text}
        
        RÉSUMÉ :
        Total Recettes : {income:.2f}
        Total Dépenses : {expenses:.2f}
        Résultat Net : {balance:.2f}
        
        TA MISSION (Réponds en FORMAT MARKDOWN) :
        1.  **Synthèse Financière** : Rédige un paragraphe professionnel résumant la situation (bénéficiaire ou déficitaire) et les grandes masses.
        2.  **Audit des Anomalies** : Analyse les transactions ligne par ligne. Si tu vois :
            - Des gros montants (> 200) sans description claire.
            - Des dépenses qui semblent bizarres pour une association.
            - Des incohérences de compte (ex: 'Loyer' classé en 'Recettes').
            Lyste-les dans une section "⚠️ Points de Vigilance". Sinon, dis "R.A.S - Comptabilité cohérente".
        3.  **Certification** : Termine par une phrase solennelle : "Je, soussigné l'Assistant IA, certifie la cohérence arithmétique de ces écritures au [Date du Jour]."
        
        Le ton doit être formel, précis et rassurant. Fais une mise en page propre avec des titres.
        """
        
        flash_llm = get_llm() # Using Flash for speed, or Pro for better reasoning if needed. Flash is usually fine for this volume.
        response = flash_llm.invoke(prompt)
        
        return {"report": response.content}
    
    except Exception as e:
        print(f"Audit Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
