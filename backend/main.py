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
from pydantic import BaseModel

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
    integrity_report: str = "OK_COMPLET"
    extracted_transactions: List[Transaction] = []
    classification_a_txns: Annotated[List[Transaction], operator.add] = []
    classification_b_txns: Annotated[List[Transaction], operator.add] = []
    page_count: int = 0
    global_context: str = ""
    logs: Annotated[List[str], operator.add] = []

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

def worker_a_node(state: AgentState):
    """Worker A: Structured Extraction (Standard Strategy)"""
    print("--- [Agent: WORKER_A][INPUT_START] ---")
    if not state.raw_text:
        return {"logs": ["Erreur: Aucun texte brut pour l'ouvrier A."]}
        
    prompt = f"""
    Tu es l'Ouvrier A. Ton rôle est d'extraire TOUTES les transactions du document bancaire suivant.
    RELEVÉ BRUT :
    {state.raw_text}
    
    RÈGLES STRICTES :
    1. Repère les colonnes DÉBIT (-), CRÉDIT (+), et SOLDE (runningBalance).
    2. Pour chaque ligne : Date (YYYY-MM-DD), Libellé (court), Montant, et SOLDE après opération.
    3. Reconstitue les blocs coupés entre deux pages : si tu vois le mot "REPORT" en haut d'une page, c'est la suite de la transaction précédente.
    4. fullRawText : Copie tout le texte brut lié à la transaction (obligatoire).
    5. IGNORER les lignes de résumé comme "SOLDE REPORTER", "NOUVEAU SOLDE", ou "TOTAL DES MOUVEMENTS". Ce ne sont PAS des transactions.
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
    
    RÈGLES identiques à A (Date, Montant, Débit/Crédit, SOLDE/runningBalance), mais sois EXTRÊMEMENT attentif aux petits caractères et aux dates répétées.
    Note : Si le mot "REPORT" apparaît en majuscules en haut d'une page, il indique que l'information suivante appartient à la transaction de la page précédente. 
    IGNORER les lignes "SOLDE REPORTER", "NOUVEAU SOLDE".
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
        
        RÈGLES :
        1. Extrais TOUTES les transactions de ce fragment.
        2. Date (YYYY-MM-DD), Montant, Libellé, et SOLDE (runningBalance).
        3. fullRawText : Copie tout le texte brut lié (vital).
        4. GESTION DU "REPORT" : Si "REPORT" est en haut du texte, lie les données à la transaction parente si possible.
        5. FILTRAGE : Ignore les lignes de type "SOLDE REPORTER" ou "SOLDE AU ...".
        """
        try:
            result = structured_llm.invoke(prompt)
            all_itinerant_txns.extend(result.transactions)
        except Exception as e:
            print(f"Itinerant Error on chunk {i}: {e}")
            
    # Deduplicate within itinerant worker itself (as there is overlap)
    unique_txns = {}
    for t in all_itinerant_txns:
        # Use runningBalance as anchor if available
        key = f"{t.runningBalance}" if t.runningBalance else f"{t.date}_{t.amount}_{t.description[:15]}"
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
        
        RÈGLES :
        1. Date (YYYY-MM-DD), Montant (AVEC LE BON SIGNE), Libellé court, et SOLDE (runningBalance) si visible.
        2. fullRawText : Copie le texte lié tel que tu le vois.
        3. REPORT : Lie les informations coupées entre pages si nécessaire. Ignore les lignes "SOLDE REPORTER".
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
        key = f"{t.runningBalance}" if t.runningBalance else f"{t.date}_{t.amount}_{t.description[:15]}"
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
    
    prompt = f"""
    Tu es le Superviseur de Complétude.
    Voici le TEXTE BRUT original du document bancaire :
    ---
    {state.raw_text}
    ---
    
    Voici TOUTES les transactions qui ont été extraites jusqu'à présent (format JSON) :
    ---
    {json.dumps([t.model_dump() for t in all_extracted], ensure_ascii=False)}
    ---
    
    Ta mission :
    Vérifie si des transactions évidentes dans le texte brut manquent dans la liste extraite.
    Fais particulièrement attention aux "Frais", "Commission", "Agios", "Cotisation", ou petits montants.
    
    Si RIEN ne manque et que tout semble extrait correctement, réponds EXACTEMENT : "OK_COMPLET" sans aucun autre texte.
    Sinon, liste clairement les éléments manquants (date, libellé approximatif, montant) pour qu'ils soient récupérés par le contre-maître.
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
    
    # Stratégie de fusion par solde
    merged_map = {}
    for t in all_versions:
        # Correction de signe par le Visuel (Juge de paix) avant fusion
        desc = (t.description or "")[:10].lower()
        v_key = f"{t.date}_{abs(t.amount)}_{desc}"
        if v_key in visual_sign_lookup:
            t.amount = abs(t.amount) * visual_sign_lookup[v_key]

        if t.runningBalance is not None:
            key = f"{t.runningBalance}"
            if key not in merged_map or len(t.fullRawText or "") > len(merged_map[key].fullRawText or ""):
                merged_map[key] = t
        else:
            key = f"{t.date}_{t.amount}_{t.description[:10]}"
            if key not in merged_map:
                merged_map[key] = t
                
    merged_list = sorted(merged_map.values(), key=lambda x: str(x.date or "9999-12-31"))
    
    final_verified_txns = []
    for i in range(len(merged_list)):
        t = merged_list[i]
        if i > 0:
            prev = merged_list[i-1]
            if prev.runningBalance is not None and t.runningBalance is not None:
                actual_diff = round(t.runningBalance - prev.runningBalance, 2)
                if abs(actual_diff - t.amount) > 0.01:
                    print(f"Correction de signe mathématique ou montant pour {t.description}: {t.amount} -> {actual_diff}")
                    t.amount = actual_diff
        final_verified_txns.append(t)

    # --- FILTRAGE SOLDE REPORTE ---
    # Ces lignes ne sont PAS des transactions réelles, ce sont des soldes reportés.
    SOLDE_KEYWORDS = ["SOLDE REPORTE", "SOLDE REPORTER", "SOLDE AU", "NOUVEAU SOLDE", "TOTAL DES MOUVEMENTS", "REPORT DE SOLDE"]
    before_filter = len(final_verified_txns)
    final_verified_txns = [
        t for t in final_verified_txns 
        if not any(kw in (t.description or "").upper() for kw in SOLDE_KEYWORDS)
    ]
    filtered_count = before_filter - len(final_verified_txns)
    if filtered_count > 0:
        print(f"--- [Agent: FOREMAN] Filtré {filtered_count} lignes SOLDE REPORTE ---")

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

def classifier_a_node(state: AgentState):
    """Classifier A: Accurate categorization based on rules and history."""
    print("--- [Agent: CLASSIFIER_A][INPUT_START] ---")
    history_context = get_user_history_context(state.user_id)
    accounts = state.existing_accounts
    accounts_info = "\n".join([
        f"ID: {a.id} | Code: {a.code} | Nom: {a.label} | Description: {a.description or 'N/A'} | Suivi: {'OUI' if a.isMembership else 'NON'} | Contexte IA: {a.iaContext or 'N/A'}" 
        for a in accounts
    ])
    
    prompt = f"""
    Tu es le Comptable A. Ta spécialité est le rapprochement par HISTORIQUE.
    
    CONTEXTE GLOBAL DE L'ASSOCIATION :
    {state.global_context or "Aucun contexte particulier."}
    
    MODÈLES PASSÉS :
    {history_context}
    
    PLAN COMPTABLE :
    {accounts_info}
    
    RÈGLES :
    1. Si un libellé ressemble à l'historique, utilise le même 'accountId'.
    2. Respecte les signes : un montant négatif est une CHARGE, positif est un PRODUIT (sauf comptes MIXTE).
    
    TRANSACTIONS À CLASSER (JSON) :
    {json.dumps([t.model_dump() for t in state.extracted_transactions])}
    """
    try:
        flash_llm = get_llm()
        structured_llm = flash_llm.with_structured_output(TransactionList)
        result = structured_llm.invoke(prompt)
        
        # --- DETAILED OUTPUT LOGGING ---
        classified_count = sum(1 for t in result.transactions if t.accountId)
        print(f"--- [Agent: CLASSIFIER_A][OUTPUT] {len(result.transactions)} txns retournées, {classified_count} avec accountId ---")
        for t in result.transactions[:5]:
            print(f"  CLASSIFIER_A: '{t.description[:40]}' -> accountId={t.accountId} | member={t.detectedMemberName}")
        if len(result.transactions) > 5:
            print(f"  ... et {len(result.transactions) - 5} autres")
        
        return {"classification_a_txns": result.transactions, "logs": [f"Comptable A : {classified_count}/{len(result.transactions)} classées par historique."]}
    except Exception as e:
        print(f"Classifier A Error: {e}")
        import traceback
        traceback.print_exc()
        return {"classification_a_txns": [], "logs": [f"Erreur Comptable A : {str(e)}"]}

def classifier_b_node(state: AgentState):
    """Classifier B: Contextual extraction (members, specific keywords)."""
    print("--- [Agent: CLASSIFIER_B][INPUT_START] ---")
    accounts = state.existing_accounts
    accounts_info = "\n".join([
        f"ID: {a.id} | Nom: {a.label} | Description: {a.description or 'N/A'} | Suivi: {'OUI' if a.isMembership else 'NON'} | Contexte IA: {a.iaContext or 'N/A'}" 
        for a in accounts
    ])
    
    prompt = f"""
    Tu es le Comptable B. Ta spécialité est l'analyse des DÉTAILS (fullRawText).
    
    CONTEXTE GLOBAL DE L'ASSOCIATION :
    {state.global_context or "Aucun contexte particulier."}
    
    PLAN COMPTABLE :
    {accounts_info}
    
    RÈGLES DE CLASSIFICATION :
    1. Si un compte est marqué 'Suivi: OUI', il s'agit d'un compte de membres (cotisations). 
       Pour ces transactions, tu DOIS extraire le nom du membre dans 'detectedMemberName'.
       Priorité pour trouver le nom : 
       a) Dans le texte de communication ou la description.
       b) Si rien n'est trouvé, cherche le nom de la personne ayant fait le virement (ex: "Virement de Jean Dupont").
    2. Si 'fullRawText' contient des mots comme "COTISATION", "ADHESION", ou "MEMBRE", utilise en priorité le compte marqué 'Suivi: OUI'.
    3. Pour les autres transactions, utilise le nom (label) et la description du compte pour trouver la meilleure correspondance.
    4. Signes : Un montant négatif (-) est une CHARGE, un montant positif (+) est un PRODUIT.
    
    TRANSACTIONS À CLASSER (JSON) :
    {json.dumps([t.model_dump() for t in state.extracted_transactions])}
    """
    try:
        flash_llm = get_llm()
        structured_llm = flash_llm.with_structured_output(TransactionList)
        result = structured_llm.invoke(prompt)
        
        # --- DETAILED OUTPUT LOGGING ---
        classified_count = sum(1 for t in result.transactions if t.accountId)
        member_count = sum(1 for t in result.transactions if t.detectedMemberName)
        print(f"--- [Agent: CLASSIFIER_B][OUTPUT] {len(result.transactions)} txns retournées, {classified_count} avec accountId, {member_count} avec memberName ---")
        for t in result.transactions[:5]:
            print(f"  CLASSIFIER_B: '{t.description[:40]}' -> accountId={t.accountId} | member={t.detectedMemberName}")
        if len(result.transactions) > 5:
            print(f"  ... et {len(result.transactions) - 5} autres")
        
        return {"classification_b_txns": result.transactions, "logs": [f"Comptable B : {classified_count}/{len(result.transactions)} classées contextuellement, {member_count} membres détectés."]}
    except Exception as e:
        print(f"Classifier B Error: {e}")
        import traceback
        traceback.print_exc()
        return {"classification_b_txns": [], "logs": [f"Erreur Comptable B : {str(e)}"]}

def classification_consensus_node(state: AgentState):
    """The Judge: Harmonizes mapping and ensures no transaction is left empty if a clear match exists."""
    print("--- [Agent: JUDGE][INPUT_START] ---")
    a_results = state.classification_a_txns
    b_results = state.classification_b_txns
    
    print(f"  JUDGE: Received {len(a_results)} from Classifier A, {len(b_results)} from Classifier B")
    print(f"  JUDGE: Extracted transactions to process: {len(state.extracted_transactions)}")
    
    final_txns = []
    valid_ids = {a.id for a in state.existing_accounts}
    
    for i in range(len(state.extracted_transactions)):
        orig = state.extracted_transactions[i]
        ta = a_results[i] if i < len(a_results) else None
        tb = b_results[i] if i < len(b_results) else None
        
        txn = orig.model_copy()
        source = "none"
        
        # Priority logic
        if ta and ta.accountId:
            txn.accountId = ta.accountId
            source = "A"
        if tb:
            if tb.accountId and not txn.accountId:
                txn.accountId = tb.accountId
                source = "B"
            elif tb.accountId and txn.accountId:
                source = "A (B aussi)"
            if tb.detectedMemberName:
                txn.detectedMemberName = tb.detectedMemberName
        
        # Priority Fallback: If a member name is detected but no account is assigned,
        # assign the first available membership account.
        if txn.detectedMemberName and not txn.accountId:
            membership_acc = next((a for a in state.existing_accounts if a.isMembership), None)
            if membership_acc:
                txn.accountId = membership_acc.id
                source = "fallback-member"

        # Final safety check: validate accountId exists
        if txn.accountId and txn.accountId not in valid_ids:
            print(f"  JUDGE WARNING: accountId '{txn.accountId}' invalide pour '{txn.description[:30]}', reset à None")
            txn.accountId = None
            source = "INVALID->None"

        print(f"  JUDGE: [{source}] '{txn.description[:35]}' -> accountId={txn.accountId} | member={txn.detectedMemberName}")
        final_txns.append(txn)
        
    # Final Sorting (Oldest to Newest) and Formatting (DD.MM.YY)
    # 1. Sort by ISO Date first
    final_txns.sort(key=lambda x: str(x.date or "1900-01-01"))
    
    # 2. Reformat date strings for the user
    for t in final_txns:
        if t.date and "-" in t.date: # If ISO YYYY-MM-DD
            try:
                from datetime import datetime
                dt = datetime.strptime(t.date, "%Y-%m-%d")
                t.date = dt.strftime("%d.%m.%y")
            except:
                pass

    classified_count = sum(1 for t in final_txns if t.accountId)
    print(f"--- [Agent: JUDGE][OUTPUT] {classified_count}/{len(final_txns)} transactions avec un compte assigné ---")

    return {
        "extracted_transactions": final_txns,
        "logs": [f"Le Juge : {classified_count}/{len(final_txns)} classées. Format date JJ.MM.AA validé."]
    }

# Build Graph
workflow = StateGraph(AgentState)
workflow.add_node("vision", vision_node)
workflow.add_node("worker_a", worker_a_node)
workflow.add_node("worker_b", worker_b_node)
workflow.add_node("itinerant", itinerant_worker_node)
workflow.add_node("visual_itinerant", visual_itinerant_node)
workflow.add_node("integrity_auditor", integrity_auditor_node)
workflow.add_node("foreman", foreman_consensus_node)
workflow.add_node("classifier_a", classifier_a_node)
workflow.add_node("classifier_b", classifier_b_node)
workflow.add_node("judge", classification_consensus_node)

workflow.set_entry_point("vision")
workflow.add_edge("vision", "worker_a")
workflow.add_edge("vision", "worker_b")
workflow.add_edge("vision", "itinerant")
workflow.add_edge("vision", "visual_itinerant")

workflow.add_edge("worker_a", "integrity_auditor")
workflow.add_edge("worker_b", "integrity_auditor")
workflow.add_edge("itinerant", "integrity_auditor")
workflow.add_edge("visual_itinerant", "integrity_auditor")

workflow.add_edge("integrity_auditor", "foreman")

workflow.add_edge("foreman", "classifier_a")
workflow.add_edge("foreman", "classifier_b")
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
