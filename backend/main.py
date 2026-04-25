import os
import base64
import json
import io
import fitz # PyMuPDF
import json
import operator
from typing import List, Optional, Dict, Any, Annotated
from datetime import datetime

from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Firebase Admin (Server Side)
import firebase_admin
from firebase_admin import credentials, firestore
from google.cloud.firestore_v1.base_query import FieldFilter

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
    iaContext: Optional[str] = None
    initialBalance: float = 0.0
    closingBalance: Optional[float] = None

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

class ClassifiedTransaction(Transaction):
    accountChoiceReasoning: str = Field(description="Raisonnement détaillé pour le choix du compte de cette transaction précise (pourquoi ce compte et pas un autre ?)")

class ClassifiedTransactionList(BaseModel):
    thinking: str = Field(description="Réflexion globale avant de commencer la classification des transactions.")
    transactions: List[ClassifiedTransaction]

class ReceiptExtraction(BaseModel):
    amount: Optional[float] = None
    content: Optional[str] = None
    date: Optional[str] = None
    isRefund: bool = False
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
            .where(filter=FieldFilter("accountId", "!=", None))
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
    raw_pages: List[str] = []
    worker_a_txns: Annotated[List[Transaction], operator.add] = []
    worker_b_txns: Annotated[List[Transaction], operator.add] = []
    itinerant_txns: Annotated[List[Transaction], operator.add] = []
    visual_itinerant_txns: Annotated[List[Transaction], operator.add] = []
    integrity_report: Optional[str] = None
    recovery_attempts: int = 0
    expected_transaction_count: int = 0
    starting_balance: float = 0.0 # Nouveau : extrait par le pré-parser
    logs: Annotated[List[str], operator.add] = []
    extracted_transactions: List[Transaction] = []
    classification_a_txns: Annotated[List[ClassifiedTransaction], operator.add] = []
    classification_a_thinking: str = ""
    classification_b_txns: Annotated[List[ClassifiedTransaction], operator.add] = []
    classification_b_thinking: str = ""
    page_count: int = 0
    global_context: str = ""

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
        raw_pages = []
        for page in doc:
            p_text = page.get_text("text") + "\n"
            raw_text += p_text
            raw_pages.append(p_text)
        doc.close()
        
        # Si le PDF contient du vrai texte (pas juste un scan d'image), on l'utilise direct
        if len(raw_text.strip()) > 500:
            print("--- [Agent: VISION][OUTPUT_START] ---")
            print(f"Extracted Native PyMuPDF Text Length: {len(raw_text)} | Pages: {page_counts}")
            print("--- [Agent: VISION][OUTPUT_END] ---")
            return {
                "raw_text": raw_text,
                "raw_pages": raw_pages,
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

def pre_parser_node(state: AgentState):
    """
    BCV Pre-Parser: Filters raw text using strict anchor order.
    Logic: 
    - Page 1: [SOLDE REPORTE] -> keep -> [SOLDE A REPORTER] (stop)
    - Page X: [REPORT] -> keep -> [SOLDE A REPORTER] (stop)
    - Last:   [REPORT] -> keep -> [SOLDE EN] (stop)
    """
    print("--- [Agent: PRE_PARSER][INPUT_START] ---")
    import re
    date_pattern = re.compile(r'\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})')
    
    starting_bal = 0.0
    
    for page_text in state.raw_pages:
        lines = page_text.split('\n')
        keep = False
        page_content = []
        
        for line in lines:
            upper_line = line.upper().strip()
            
            # 1. STOP Keywords
            if "SOLDE A REPORTER" in upper_line or "SOLDE EN" in upper_line:
                keep = False
                continue
            
            # 2. START Keywords
            if "SOLDE REPORTE" in upper_line:
                keep = True
                # Extraction du montant pour le passer proprement à l'IA sans inclure la ligne
                amounts = re.findall(r"[\d' ]+\.\d{2}", line.replace("'", ""))
                if amounts:
                    try: starting_bal = float(amounts[-1].replace(" ", ""))
                    except: pass
                continue # On ne l'ajoute pas à page_content (Règle : non inclus)
            elif "REPORT" in upper_line:
                keep = True
                continue # On ne l'ajoute pas à page_content (Règle : non inclus)
                
            # 3. Content
            if keep:
                if any(x in upper_line for x in ["DATE", "VALEUR", "LIBELLÉ", "DÉBIT", "CRÉDIT", "SOLDE"]):
                    continue
                page_content.append(line)
                if date_pattern.search(line):
                    total_dates += 1
        
        cleaned_pages.append("\n".join(page_content))
    
    full_cleaned_text = "\n--- NOUVELLE PAGE ---\n".join(cleaned_pages)
    
    return {
        "raw_text": full_cleaned_text,
        "raw_pages": cleaned_pages,
        "expected_transaction_count": total_dates,
        "starting_balance": starting_bal,
        "logs": [f"Pré-Parser : Filtrage BCV (non-inclus). Solde initial détecté : {starting_bal} CHF."]
    }

def worker_a_node(state: AgentState):
    """Worker A: Structured Extraction (Standard Strategy)"""
    print("--- [Agent: WORKER_A][INPUT_START] ---")
    if not state.raw_text:
        return {"logs": ["Erreur: Aucun texte brut pour l'ouvrier A."]}
        
    prompt = f"""
    Tu es l'Ouvrier A. Extrais les transactions.
    CONSIGNE : Le solde avant la première transaction est de {state.starting_balance} CHF.
    
    RELEVÉ NETTOYÉ :
    {state.raw_text}
    
        RÈGLES D'OR (LOGIQUE RELEVÉ BCV) :
    1. STRUCTURE DES PAGES :
       - Page 1 : Les transactions sont ENTRE "SOLDE REPORTE" et "SOLDE A REPORTER" (exclus).
       - Pages suivantes : Les transactions sont ENTRE "REPORT" (en haut) et "SOLDE A REPORTER" (en bas, exclus).
       - Dernière page : Les transactions sont ENTRE "REPORT" et "SOLDE EN..." (exclus).
    2. GESTION DES RAPPELS DE SOLDE (STRICT) :
       - "SOLDE REPORTE" (Page 1) : Utilise-le UNIQUEMENT comme solde de départ pour tes calculs. NE L'INCLUS PAS dans ta liste de transactions JSON.
       - "REPORT" (Haut de page) : À ignorer totalement, ne pas extraire.
       - "SOLDE A REPORTER" / "SOLDE EN..." : Ce sont des bornes d'arrêt. NE PAS extraire.
    3. AUCUN DOUBLON : Ta liste JSON ne doit contenir QUE les mouvements réels (Débit ou Crédit).
    4. POUR CHAQUE LIGNE RÉELLE : Date (YYYY-MM-DD), Libellé (complet), Montant, et SOLDE (runningBalance).
    """
    try:
        flash_llm = get_llm()
        structured_llm = flash_llm.with_structured_output(TransactionList)
        result = structured_llm.invoke(prompt)
        return {"worker_a_txns": result.transactions, "logs": [f"Ouvrier A : {len(result.transactions)} txns trouvées."]}
    except Exception as e:
        return {"logs": [f"Erreur Ouvrier A : {str(e)}"]}

def worker_b_node(state: AgentState):
    """Worker B: Redundant Extraction (Focus on missing & Communications)"""
    print("--- [Agent: WORKER_B][INPUT_START] ---")
    prompt = f"""
    Tu es l'Ouvrier B. Ton rôle est de vérifier minutieusement le relevé.
    Parfois l'ouvrier A oublie des lignes de type 'Frais', 'Commission' ou des petits montants.
    RELEVÉ BRUT :
    {state.raw_text}
    
        RÈGLES BCV :
        - Début : Après "SOLDE REPORTE" (p1) ou "REPORT" (pX).
        - Fin : Avant "SOLDE A REPORTER" ou "SOLDE EN".
        - Ignorer les répétitions "REPORT" en haut de page.
        - Focus sur Date, Montant, Solde, et Libellé complet.
    """
    try:
        flash_llm = get_llm()
        structured_llm = flash_llm.with_structured_output(TransactionList)
        result = structured_llm.invoke(prompt)
        return {"worker_b_txns": result.transactions, "logs": [f"Ouvrier B : {len(result.transactions)} txns trouvées."]}
    except Exception as e:
        return {"logs": [f"Erreur Ouvrier B : {str(e)}"]}

def itinerant_worker_node(state: AgentState):
    """Itinerant Worker: Processes the PDF chunk by chunk (1-2 pages) and accumulates txns."""
    print("--- [Agent: ITINERANT_WORKER][INPUT_START] ---")
    pages = state.raw_pages
    if not pages:
        return {"logs": ["Ouvrier Itinérant : Pas de pages à traiter."]}
    
    all_itinerant_txns = []
    # We process in chunks of 2 pages with 1 page overlap to catch transactions at the border
    batch_size = 2
    step = 1
    
    flash_llm = get_llm()
    structured_llm = flash_llm.with_structured_output(TransactionList)
    
    for i in range(0, len(pages), step):
        chunk = pages[i : i + batch_size]
        if not chunk: break
        
        chunk_text = "\n--- NOUVELLE PAGE ---\n".join(chunk)
        print(f"Itinerant Worker: Processing chunk starting at page {i+1}")
        
        prompt = f"""
        Tu es l'Ouvrier Itinérant. Tu extrais les transactions d'un fragment de relevé bancaire (2 pages).
        TEXTE DU FRAGMENT :
        {chunk_text}
        
        RÈGLES BCV :
        1. STRUCTURE : Transactions entre "SOLDE REPORTE" (p1) ou "REPORT" et "SOLDE A REPORTER" ou "SOLDE EN".
        2. DOUBLONS : NE PAS extraire "REPORT" en haut de page comme une transaction.
        3. SOLDE REPORTE (Page 1) : Extraire comme ANCRE de départ (Montant 0).
        4. RÉEL : Extraire Date, Libellé, Montant, Solde pour chaque mouvement réel.
        5. fullRawText : Copie tout le texte brut lié (vital).
        """
        try:
            result = structured_llm.invoke(prompt)
            all_itinerant_txns.extend(result.transactions)
        except Exception as e:
            print(f"Itinerant Error on chunk {i}: {e}")
            
    # Deduplicate within itinerant worker itself (as there is overlap)
    unique_txns = {}
    for t in all_itinerant_txns:
        desc_start = (t.description or "")[:15]
        bal = t.runningBalance if t.runningBalance is not None else "None"
        key = f"{t.date}_{t.amount}_{bal}_{desc_start}"
        if key not in unique_txns:
            unique_txns[key] = t
            
    final_list = sorted(unique_txns.values(), key=lambda x: str(x.date))
    print(f"--- [Agent: ITINERANT_WORKER][OUTPUT] Found {len(final_list)} unique txns. ---")
    
    return {
        "itinerant_txns": final_list,
        "logs": [f"Ouvrier Itinérant : {len(final_list)} txns extraites par balayage de pages."]
    }

def visual_itinerant_node(state: AgentState):
    """Visual Itinerant Worker: Processes the PDF visually chunk by chunk (1-2 pages)"""
    print("--- [Agent: VISUAL_ITINERANT][INPUT_START] ---")
    
    pdf_bytes = base64.b64decode(state.pdf_base64)
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        return {"logs": [f"Erreur Ouvrier Visuel Itinérant : {str(e)}"]}
        
    page_count = len(doc)
    if page_count == 0:
        return {"logs": ["Ouvrier Visuel Itinérant : Pas de pages à traiter."]}

    all_visual_txns = []
    batch_size = 2
    step = 1
    
    flash_llm = get_llm()
    structured_llm = flash_llm.with_structured_output(TransactionList)
    
    for i in range(0, page_count, step):
        images_content = []
        for j in range(i, min(i + batch_size, page_count)):
            try:
                page = doc.load_page(j)
                pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
                b64_img = base64.b64encode(pix.tobytes("jpeg")).decode("utf-8")
                images_content.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{b64_img}"}
                    }
                )
            except Exception as e:
                print(f"Erreur rendu page {j}: {e}")
        
        if not images_content:
            break
            
        print(f"Visual Itinerant Worker: Processing chunk starting at page {i+1}")
        
        prompt = """
        Tu es l'Ouvrier Visuel Itinérant. Analyser visuellement ces pages de relevé bancaire (jusqu'à 2 pages avec chevauchement).
        ATTENTION À LA POSITION SPATIALE DES MONTANTS :
        - Colonnes de GAUCHE (Débits/Retraits) = montants NÉGATIFS (-).
        - Colonnes de DROITE (Crédits/Dépôts) = montants POSITIFS (+).
        GARANTIR LE BON SIGNE EST TA MISSION PRINCIPALE.
        
        RÈGLES (RELEVÉ BCV) :
        1. Date (YYYY-MM-DD), Montant (SIGNÉ), Libellé, et SOLDE (runningBalance).
        2. BORNES : Ignore tout ce qui précède "SOLDE REPORTE" ou "REPORT". Arrête-toi à "SOLDE A REPORTER" ou "SOLDE EN".
        3. EXCLUSION : Les lignes "SOLDE REPORTE", "REPORT", "SOLDE A REPORTER" ne sont PAS des transactions. NE PAS les inclure dans le JSON.
        """
        
        message_content = [{"type": "text", "text": prompt}] + images_content
        message = HumanMessage(content=message_content)
        
        try:
            result = structured_llm.invoke([message])
            all_visual_txns.extend(result.transactions)
        except Exception as e:
            print(f"Visual Itinerant Error on chunk {i}: {e}")
            
    doc.close()
    
    unique_txns = {}
    for t in all_visual_txns:
        desc_start = (t.description or "")[:15]
        bal = t.runningBalance if t.runningBalance is not None else "None"
        key = f"{t.date}_{t.amount}_{bal}_{desc_start}"
        if key not in unique_txns:
            unique_txns[key] = t
            
    final_list = sorted(unique_txns.values(), key=lambda x: str(x.date or "9999-12-31"))
    print(f"--- [Agent: VISUAL_ITINERANT][OUTPUT] Found {len(final_list)} unique txns. ---")
    
    return {
        "visual_itinerant_txns": final_list,
        "logs": [f"Ouvrier Visuel Itinérant : {len(final_list)} txns extraites par balayage visuel."]
    }

def integrity_auditor_node(state: AgentState):
    """
    Superviseur de Complétude : 
    Vérifie si des montants ou mots-clés (Frais, Commission...) du texte brut
    ont été manqués par les ouvriers.
    """
    print("--- [Agent: INTEGRITY_AUDITOR][INPUT_START] ---")
    
    all_extracted = state.worker_a_txns + state.worker_b_txns + state.itinerant_txns + state.visual_itinerant_txns
    
    # On déduplique grossièrement pour comparer au nombre attendu
    unique_count = len({f"{t.date}_{t.amount}_{t.runningBalance}" for t in all_extracted})
    
    prompt = f"""
    Tu es le Superviseur de Complétude.
    RÈGLE BCV : Le Pré-Parser a détecté {state.expected_transaction_count} dates de transactions dans le document.
    Nous en avons extrait {unique_count} uniques jusqu'à présent.
    
    TEXTE BRUT FILTRÉ :
    ---
    {state.raw_text}
    ---
    
    Ta mission :
    1. Si le nombre extrait ({unique_count}) est inférieur au nombre attendu ({state.expected_transaction_count}), cherche activement ce qui manque.
    2. Si tout semble là et que le compte est bon, réponds EXACTEMENT : "OK_COMPLET".
    3. Sinon, liste les éléments manquants (date, libellé, montant).
    """
    
    flash_llm = get_llm()
    try:
        response = flash_llm.invoke(prompt)
        report = response.content.strip()
        print(f"Integrity Report Preview: {report[:100]}...")
        return {
            "integrity_report": report,
            "logs": [f"Superviseur de Complétude : {'OK' if report == 'OK_COMPLET' else 'Manques détectés'}."]
        }
    except Exception as e:
        print(f"Integrity Auditor Error: {e}")
        return {
             "integrity_report": "OK_COMPLET",
             "logs": [f"Erreur Superviseur : {str(e)}"]
        }

def foreman_consensus_node(state: AgentState):
    """
    Foreman (Le Contre-maître) : 
    1. Compare les résultats des ouvriers.
    2. Utilise le Superviseur (integrity_report) pour lancer une mini-extraction si besoin.
    3. Fusionne les données.
    4. Tranche les divergences (Visuel en Juge de paix pour les signes).
    """
    print("--- [Agent: FOREMAN][INPUT_START] ---")
    extra_txns = []
    
    if state.integrity_report and state.integrity_report != "OK_COMPLET":
        print("Foreman: Attempting targeted extraction based on Integrity Report...")
        prompt = f"""
        Tu es le Contre-maître. Le rapport d'intégrité a signalé des transactions manquantes :
        RAPPORT DU SUPERVISEUR :
        {state.integrity_report}
        
        TEXTE BRUT ORIGINAL :
        {state.raw_text}
        
        Extrais UNIQUEMENT les transactions mentionnées dans le rapport qui manquaient (format JSON avec Date, Montant, Libellé, runningBalance).
        """
        try:
            flash_llm = get_llm()
            structured_llm = flash_llm.with_structured_output(TransactionList)
            result = structured_llm.invoke(prompt)
            extra_txns = result.transactions
            print(f"Foreman recovered {len(extra_txns)} transactions.")
        except Exception as e:
            print(f"Foreman recovery error: {e}")

    a_txns = state.worker_a_txns
    b_txns = state.worker_b_txns
    i_txns = state.itinerant_txns
    v_txns = state.visual_itinerant_txns
    
    # Construction d'un index des signes basé sur l'Ouvrier Visuel (Juge de paix)
    visual_sign_lookup = {}
    for t in v_txns:
        # Clé robuste : date + montant absolu + début libellé
        desc = (t.description or "")[:10].lower()
        key = f"{t.date}_{abs(t.amount)}_{desc}"
        visual_sign_lookup[key] = 1 if t.amount >= 0 else -1

    all_versions = a_txns + b_txns + i_txns + v_txns + extra_txns
    
    # Stratégie de fusion avec clé robuste
    merged_map = {}
    for t in all_versions:
        # Correction de signe par le Visuel (Juge de paix) avant fusion
        desc = (t.description or "")[:10].lower()
        v_key = f"{t.date}_{abs(t.amount)}_{desc}"
        if v_key in visual_sign_lookup:
            t.amount = abs(t.amount) * visual_sign_lookup[v_key]

        desc_start = (t.description or "")[:15]
        bal = t.runningBalance if t.runningBalance is not None else "None"
        key = f"{t.date}_{t.amount}_{bal}_{desc_start}"
        
        if key not in merged_map or len(t.fullRawText or "") > len(merged_map[key].fullRawText or ""):
            merged_map[key] = t
                
    def parse_date(d_str):
        if not d_str: return "9999-12-31"
        import re
        m = re.search(r"(\d{1,2})[\./-](\d{1,2})[\./-](\d{2,4})", str(d_str))
        if m:
            d, month, y = m.groups()
            if len(y) == 2: y = "20" + y
            return f"{y}-{month.zfill(2)}-{d.zfill(2)}"
        return str(d_str)

    # Group by date to handle same-day order better
    merged_list = sorted(merged_map.values(), key=lambda x: parse_date(x.date))
    
    # --- PRÉ-FILTRAGE DES ANCRES POUR LA VÉRIFICATION ---
    SOLDE_KEYWORDS = ["SOLDE REPORTE", "SOLDE REPORTER", "SOLDE AU", "NOUVEAU SOLDE", "TOTAL DES MOUVEMENTS", "REPORT DE SOLDE", "SOLDE INITIAL", "SOLDE EN"]
    
    real_txns = []
    anchors = []
    for t in merged_list:
        desc_upper = (t.description or "").upper()
        if any(kw in desc_upper for kw in SOLDE_KEYWORDS):
            anchors.append(t)
        else:
            real_txns.append(t)
    
    # --- VÉRIFICATION DE LA CHAÎNE MATHÉMATIQUE ---
    # On initialise avec le solde de départ extrait par le pré-parser
    current_balance = state.starting_balance
    last_description = "SOLDE INITIAL"
    
    # On utilise une liste temporaire pour la validation
    verified_txns_internal = []
    
    for t in real_txns:
        if current_balance is not None and t.runningBalance is not None:
            expected_diff = t.amount
            actual_diff = round(t.runningBalance - current_balance, 2)
            
            if abs(actual_diff - expected_diff) > 0.01:
                # Tentative de correction de signe
                if abs(actual_diff + t.amount) < 0.01:
                    print(f"Correction de signe détectée pour {t.description}: {t.amount} -> {actual_diff}")
                    t.amount = actual_diff
                else:
                    gap = round(actual_diff - expected_diff, 2)
                    print(f"RUPTURE DE CHAÎNE détectée avant {t.description}. Prévu: {current_balance + expected_diff}, Réel: {t.runningBalance}, Différence (trou): {gap}")
                    
                    if state.recovery_attempts < 2: 
                        chain_broken_msg = f"RUPTURE CHAINE: Il manque {gap} CHF entre '{last_description}' (Solde: {current_balance}) et '{t.description}' (Solde: {t.runningBalance})."
                        break 
                    else:
                        if ghost_count < MAX_GHOSTS:
                            print(f"Insertion d'une Transaction Fantôme de {gap} CHF.")
                            ghost = Transaction(
                                date=t.date,
                                description=f"ÉCART DE SOLDE DÉTECTÉ ({gap} CHF)",
                                amount=gap,
                                runningBalance=round(current_balance + gap, 2),
                                fullRawText=f"Rupture automatique. Prévu: {current_balance + expected_diff}, Réel: {t.runningBalance}"
                            )
                            verified_txns_internal.append(ghost)
                            current_balance = ghost.runningBalance
                            last_description = ghost.description
                            ghost_count += 1
                        else:
                            print("Trop de ruptures. Arrêt.")
                            break
        
        verified_txns_internal.append(t)
        current_balance = t.runningBalance
        last_description = t.description

    final_verified_txns = verified_txns_internal

    # Si la chaîne est rompue, on retourne immédiatement avec l'alerte
    if chain_broken_msg:
        return {
            "integrity_report": chain_broken_msg,
            "logs": [f"Foreman : {chain_broken_msg}"]
        }

    # --- FILTRAGE SOLDE REPORTE À LA FIN ---
    # Maintenant que la chaîne est vérifiée de bout en bout, on peut jeter les lignes d'ancrage
    before_filter = len(final_verified_txns)
    final_verified_txns = [
        t for t in final_verified_txns 
        if not any(kw in (t.description or "").upper() for kw in SOLDE_KEYWORDS)
    ]
    filtered_count = before_filter - len(final_verified_txns)
    if filtered_count > 0:
        print(f"--- [Agent: FOREMAN] Filtré {filtered_count} lignes SOLDE REPORTE (Ancres) ---")

    log_msgs = [f"Foreman : {len(final_verified_txns)} transactions validées après consensus."]
    if filtered_count > 0:
        log_msgs.append(f"Foreman : {filtered_count} lignes 'SOLDE REPORTE' filtrées (non-transactions).")
    if state.integrity_report != "OK_COMPLET" and extra_txns:
        log_msgs.append(f"Foreman : Récupération effectuée ({len(extra_txns)} récupérées suite au rapport).")
    elif state.integrity_report != "OK_COMPLET":
        log_msgs.append("Foreman : Tentative de récupération échouée malgré le rapport d'intégrité.")

    print(f"--- [Agent: FOREMAN][OUTPUT] {len(final_verified_txns)} txns finales (filtré {filtered_count} soldes reportés) ---")

    return {
        "extracted_transactions": final_verified_txns,
        "logs": log_msgs
    }

def recovery_worker_node(state: AgentState):
    """Recovery Worker: Tries to fix broken chains found by foreman"""
    print("--- [Agent: RECOVERY_WORKER][INPUT_START] ---")
    prompt = f"""
    Tu es l'Agent de Récupération. Une erreur critique a été détectée dans la chaîne mathématique du relevé bancaire.
    ERREUR À RÉSOUDRE :
    {state.integrity_report}
    
    TEXTE BRUT DU RELEVÉ :
    {state.raw_text}
    
    Trouve LA ou LES transactions manquantes qui correspondent exactement à ce trou mathématique.
    Extrais les avec : Date, Montant exact, Libellé, runningBalance.
    """
    try:
        flash_llm = get_llm()
        structured_llm = flash_llm.with_structured_output(TransactionList)
        result = structured_llm.invoke(prompt)
        print(f"Recovery found {len(result.transactions)} transactions.")
        return {
            "worker_a_txns": result.transactions, # On injecte dans le pool existant pour que le foreman refusionne
            "recovery_attempts": state.recovery_attempts + 1,
            "logs": [f"Agent Récupération : Tentative {state.recovery_attempts + 1}, {len(result.transactions)} txns trouvées."]
        }
    except Exception as e:
        print(f"Recovery error: {e}")
        return {
            "recovery_attempts": state.recovery_attempts + 1,
            "logs": [f"Erreur Agent Récupération : {str(e)}"]
        }

def start_classification_node(state: AgentState):
    """Dummy node to fan out to classifiers after foreman loop"""
    return {}

def classifier_a_node(state: AgentState):
    """Classifier A: Accurate categorization based on rules and history."""
    print("--- [Agent: CLASSIFIER_A][INPUT_START] ---")
    history_context = get_user_history_context(state.user_id)
    accounts = state.existing_accounts
    accounts_info = "\n".join([
        f"ID: {a.id} | Code: {a.code} | Nom: {a.label} | Description: {a.description or 'N/A'} | Suivi: {'OUI' if a.isMembership else 'NON'} | Contexte IA: {a.iaContext or 'N/A'}" 
        for a in accounts
    ])
    
    # --- BATCHED CLASSIFICATION ---
    all_txns = state.extracted_transactions
    if not all_txns:
        return {"classification_a_txns": [], "logs": ["Comptable A : Aucune transaction à classer."]}

    batch_size = 50
    all_classified = []
    global_thinking = ""
    
    flash_llm = get_llm()
    structured_llm = flash_llm.with_structured_output(ClassifiedTransactionList)

    for i in range(0, len(all_txns), batch_size):
        batch = all_txns[i : i + batch_size]
        print(f"Classifier A: Processing batch {i//batch_size + 1} ({len(batch)} txns)")
        
        prompt = f"""
        Tu es le Comptable A (Historique). Batch {i//batch_size + 1}.
        
        CONTEXTE :
        {state.global_context or "N/A"}
        MODÈLES :
        {history_context}
        PLAN :
        {accounts_info}
        
        TRANSACTIONS (JSON) :
        {json.dumps([t.model_dump() for t in batch])}
        """
        try:
            result = structured_llm.invoke(prompt)
            all_classified.extend(result.transactions)
            if not global_thinking: global_thinking = result.thinking
        except Exception as e:
            print(f"Batch Classifier A Error: {e}")
            for t in batch:
                all_classified.append(ClassifiedTransaction(**t.model_dump(), accountChoiceReasoning="Erreur lors de la classification IA"))

    classified_count = sum(1 for t in all_classified if t.accountId)
    return {
        "classification_a_txns": all_classified,
        "classification_a_thinking": global_thinking or "Classification terminée.",
        "logs": [f"Comptable A : {classified_count}/{len(all_classified)} classées."]
    }

def classifier_b_node(state: AgentState):
    """Classifier B: Contextual extraction (members, specific keywords)."""
    print("--- [Agent: CLASSIFIER_B][INPUT_START] ---")
    accounts = state.existing_accounts
    accounts_info = "\n".join([
        f"ID: {a.id} | Nom: {a.label} | Description: {a.description or 'N/A'} | Suivi: {'OUI' if a.isMembership else 'NON'} | Contexte IA: {a.iaContext or 'N/A'}" 
        for a in accounts
    ])
    
    # --- BATCHED CLASSIFICATION ---
    all_txns = state.extracted_transactions
    if not all_txns:
        return {"classification_b_txns": [], "logs": ["Comptable B : Aucune transaction à classer."]}

    batch_size = 50
    all_classified = []
    global_thinking = ""
    
    flash_llm = get_llm()
    structured_llm = flash_llm.with_structured_output(ClassifiedTransactionList)

    for i in range(0, len(all_txns), batch_size):
        batch = all_txns[i : i + batch_size]
        print(f"Classifier B: Processing batch {i//batch_size + 1} ({len(batch)} txns)")
        
        prompt = f"""
        Tu es le Comptable B (Détails/Membres). Batch {i//batch_size + 1}.
        
        CONTEXTE :
        {state.global_context or "N/A"}
        PLAN :
        {accounts_info}
        
        RÈGLES :
        - Extraire 'detectedMemberName' pour les comptes de membres (Suivi: OUI).
        
        TRANSACTIONS (JSON) :
        {json.dumps([t.model_dump() for t in batch])}
        """
        try:
            result = structured_llm.invoke(prompt)
            all_classified.extend(result.transactions)
            if not global_thinking: global_thinking = result.thinking
        except Exception as e:
            print(f"Batch Classifier B Error: {e}")
            for t in batch:
                all_classified.append(ClassifiedTransaction(**t.model_dump(), accountChoiceReasoning="Erreur lors de la classification IA"))

    classified_count = sum(1 for t in all_classified if t.accountId)
    return {
        "classification_b_txns": all_classified,
        "classification_b_thinking": global_thinking or "Classification terminée.",
        "logs": [f"Comptable B : {classified_count}/{len(all_classified)} classées."]
    }

def classification_consensus_node(state: AgentState):
    """The Judge: Uses an LLM to harmonize mapping based on Classifier A and B's reasoning."""
    print("--- [Agent: JUDGE][INPUT_START] ---")
    
    accounts = state.existing_accounts
    accounts_info = "\n".join([
        f"ID: {a.id} | Nom: {a.label} | Suivi: {'OUI' if a.isMembership else 'NON'}" 
        for a in accounts
    ])
    
    prompt = f"""
    Tu es le Juge Comptable Suprême. Tu dois consolider le travail de deux comptables (A et B) pour classifier une liste de transactions.
    
    PLAN COMPTABLE :
    {accounts_info}
    
    PENSÉE DU COMPTABLE A (Axé sur l'historique) :
    {state.classification_a_thinking}
    
    PENSÉE DU COMPTABLE B (Axé sur le contexte et les membres) :
    {state.classification_b_thinking}
    
    PROPOSITIONS A (JSON) :
    {json.dumps([t.model_dump() for t in state.classification_a_txns])}
    
    PROPOSITIONS B (JSON) :
    {json.dumps([t.model_dump() for t in state.classification_b_txns])}
    
    RÈGLES DU JUGE :
    1. Pour chaque transaction de base, analyse les propositions de A et B.
    2. Si B a détecté un membre et un compte de suivi (Suivi: OUI), privilégie souvent B pour les cotisations.
    3. Si A a un match historique solide, et B n'a rien de spécial, privilégie A.
    4. Assure-toi que les `accountId` finaux existent dans le plan comptable.
    5. Fournis TA PENSÉE (thinking) justifiant tes choix clés avant de retourner la liste finale.
    6. Respecte le format de date YYYY-MM-DD.
    
    TRANSACTIONS DE BASE À CLASSER (JSON) :
    {json.dumps([t.model_dump() for t in state.extracted_transactions])}
    """
    
    try:
        flash_llm = get_llm()
        structured_llm = flash_llm.with_structured_output(ClassifiedTransactionList)
        result = structured_llm.invoke(prompt)
        
        final_txns = result.transactions
        valid_ids = {a.id for a in state.existing_accounts}
        
        # Format date and validate IDs
        for t in final_txns:
            if t.accountId and t.accountId not in valid_ids:
                t.accountId = None
            if t.date and "-" in t.date:
                try:
                    from datetime import datetime
                    dt = datetime.strptime(t.date, "%Y-%m-%d")
                    t.date = dt.strftime("%d.%m.%y")
                except:
                    pass
                    
        final_txns.sort(key=lambda x: str(x.date or "1900-01-01"))
        
        classified_count = sum(1 for t in final_txns if t.accountId)
        print(f"--- [Agent: JUDGE][OUTPUT] {classified_count}/{len(final_txns)} transactions avec compte ---")
        print(f"  THINKING: {result.thinking[:200]}...")
        for t in final_txns[:5]:
            print(f"  JUDGE: '{t.description[:40]}' -> accountId={t.accountId} | reasoning={t.accountChoiceReasoning[:50]}...")
        
        return {
            "extracted_transactions": final_txns,
            "logs": [f"Le Juge : {classified_count}/{len(final_txns)} classées après réflexion."]
        }
    except Exception as e:
        print(f"Judge LLM Error: {e}")
        import traceback
        traceback.print_exc()
        
        # Fallback to the original base transactions if the LLM fails
        return {
            "extracted_transactions": state.extracted_transactions,
            "logs": [f"Erreur du Juge LLM : {str(e)}"]
        }

# Build Graph
workflow = StateGraph(AgentState)
workflow.add_node("vision", vision_node)
workflow.add_node("pre_parser", pre_parser_node)
workflow.add_node("worker_a", worker_a_node)
workflow.add_node("worker_b", worker_b_node)
workflow.add_node("itinerant", itinerant_worker_node)
workflow.add_node("visual_itinerant", visual_itinerant_node)
workflow.add_node("integrity_auditor", integrity_auditor_node)
workflow.add_node("foreman", foreman_consensus_node)
workflow.add_node("recovery_worker", recovery_worker_node)
workflow.add_node("start_classification", start_classification_node)
workflow.add_node("classifier_a", classifier_a_node)
workflow.add_node("classifier_b", classifier_b_node)
workflow.add_node("judge", classification_consensus_node)

# Circuit : Vision -> Pre-Parser -> Workers (Parallel) -> Auditor -> Foreman -> (Recovery) -> Classifiers -> Judge
workflow.set_entry_point("vision")
workflow.add_edge("vision", "pre_parser")

# Fan-out vers les ouvriers
workflow.add_edge("pre_parser", "worker_a")
workflow.add_edge("pre_parser", "worker_b")
workflow.add_edge("pre_parser", "itinerant")
workflow.add_edge("pre_parser", "visual_itinerant")

# Fan-in vers l'auditeur
workflow.add_edge("worker_a", "integrity_auditor")
workflow.add_edge("worker_b", "integrity_auditor")
workflow.add_edge("itinerant", "integrity_auditor")
workflow.add_edge("visual_itinerant", "integrity_auditor")

workflow.add_edge("integrity_auditor", "foreman")

def check_chain(state: AgentState):
    if state.integrity_report and state.integrity_report.startswith("RUPTURE"):
        return "broken"
    return "ok"

workflow.add_conditional_edges("foreman", check_chain, {
    "broken": "recovery_worker",
    "ok": "start_classification"
})
workflow.add_edge("recovery_worker", "foreman")

workflow.add_edge("start_classification", "classifier_a")
workflow.add_edge("start_classification", "classifier_b")
workflow.add_edge("classifier_a", "judge")
workflow.add_edge("classifier_b", "judge")
workflow.add_edge("judge", END)

compiled_app = workflow.compile()

# --- ENDPOINTS ---

@app.get("/health")
def health_check():
    return {"status": "ok", "service": "AssoCompta Backend"}

@app.post("/process-bank-statement")
async def process_statement(
    file: UploadFile = File(...),
    accounts: str = Form(...),
    userId: str = Form(...),
    context: Optional[str] = Form("")
):
    try:
        print(f"Processing file: {file.filename} for user: {userId}")
        print(f"Global Context length: {len(context) if context else 0}")
        if context:
            print(f"Global Context preview: {context[:200]}...")
        content = await file.read()
        b64_pdf = base64.b64encode(content).decode("utf-8")
        
        # Safe Account Parsing
        try:
            raw_accounts = json.loads(accounts)
            accounts_list = [Account(**a) for a in raw_accounts]
            # Log accounts with iaContext for debugging
            accounts_with_context = [a for a in accounts_list if a.iaContext]
            print(f"Accounts received: {len(accounts_list)} total, {len(accounts_with_context)} with iaContext")
            for a in accounts_with_context:
                print(f"  Account '{a.label}' (ID: {a.id}) iaContext: {a.iaContext[:80]}...")
        except Exception as e:
            print(f"Account parsing error: {e}")
            raise HTTPException(status_code=400, detail="Invalid accounts JSON format")
        
        initial_state = AgentState(
            user_id=userId,
            pdf_base64=b64_pdf,
            existing_accounts=accounts_list,
            global_context=context or ""
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
        4. isRefund (booléen) : true si c'est explicitement un "Avoir" ou "Remboursement" ou "Refund", false sinon.
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
            
            # 3. Sécurité sur les Signes : On cherche des débits (-) par défaut, sauf si isRefund
            if getattr(extraction, "isRefund", False):
                print(f"Reçu de type Remboursement/Avoir détecté. Recherche de Crédit (montant > 0) pour {target_amount}")
                filtered_txns = [t for t in unlinked_txns if t.amount is not None and t.amount > 0]
            else:
                print(f"Reçu standard détecté. Recherche de Débit (montant < 0) pour {target_amount}")
                filtered_txns = [t for t in unlinked_txns if t.amount is not None and t.amount < 0]
            
            # 2. Matching Multi-Critères avec Pondération
            candidates = []
            
            for t in filtered_txns:
                t_amount = abs(t.amount)
                
                # Montant exact (marge de 0.05)
                if abs(t_amount - target_amount) <= 0.05:
                    score = 1 # Score + (Montant exact uniquement)
                    reasons = ["Score + (Montant exact)"]
                    
                    # Score +++ : Date exacte
                    if extraction.date and t.date == extraction.date:
                        score += 2 # Score +++
                        reasons.append("Score +++ (Date exacte)")
                        
                    # Score ++ : Nom du marchand présent dans fullRawText
                    if extraction.content:
                        # 1. Utilisation du fullRawText : on combine description, notes et fullRawText
                        search_space = (str(t.description or "") + " " + str(t.notes or "") + " " + str(t.fullRawText or "")).lower()
                        ext_content = extraction.content.lower().strip()
                        significant_words = [w for w in ext_content.split() if len(w) >= 4]
                        
                        match_found = False
                        if len(ext_content) > 3 and ext_content in search_space:
                            match_found = True
                        elif significant_words:
                            for word in significant_words:
                                if word in search_space:
                                    match_found = True
                                    break
                                    
                        if match_found:
                            score += 1 # Score ++
                            reasons.append("Score ++ (Marchand dans fullRawText)")
                    
                    # Calcul de la différence de date pour le départage
                    date_diff = 9999
                    if extraction.date and t.date:
                        try:
                            from datetime import datetime
                            d1 = datetime.strptime(extraction.date, "%Y-%m-%d")
                            d2 = datetime.strptime(t.date, "%Y-%m-%d")
                            date_diff = abs((d1 - d2).days)
                        except:
                            pass
                            
                    candidates.append({
                        "id": t.id,
                        "score": score,
                        "date_diff": date_diff,
                        "reasons": reasons
                    })
            
            if candidates:
                # Tri : Score décroissant, puis différence de jours croissante (proximité de date)
                candidates.sort(key=lambda x: (-x["score"], x["date_diff"]))
                best_match = candidates[0]
                matched_id = best_match["id"]
                print(f"Match trouvé : {matched_id} | Score : {best_match['score']} | Diff jours : {best_match['date_diff']}")
                print(f"Critères de match : {', '.join(best_match['reasons'])}")
            else:
                # 4. Gestion des Transactions "Orphelines" : Pas de correspondance stricte trouvée.
                # Priority Fallback: check in remarks/notes/description if amount is mentioned as text.
                print("Aucun candidat avec montant exact. Recherche par texte (orphelines/montants groupés)...")
                candidates_remarks = []
                for t in unlinked_txns:
                    text_to_search = (str(t.description or "") + " " + str(t.notes or "") + " " + str(t.fullRawText or "")).lower()
                    if str(target_amount) in text_to_search or str(int(target_amount)) in text_to_search:
                        candidates_remarks.append(t)
                
                if len(candidates_remarks) == 1:
                    matched_id = candidates_remarks[0].id
                    print(f"Match de fallback par texte brut pour {matched_id}")
                elif len(candidates_remarks) > 1:
                    for c in candidates_remarks:
                        if extraction.date and c.date == extraction.date:
                            matched_id = c.id
                            print(f"Match de fallback par texte brut + date pour {matched_id}")
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
        
        Accounts: {json.dumps([{"id": a.id, "label": a.label, "code": a.code, "description": a.description, "iaContext": a.iaContext} for a in accounts])}
        
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
