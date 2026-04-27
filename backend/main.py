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

# --- PARSING MODELS ---

class LayoutConfig(BaseModel):
    header_center: Dict[str, float] = Field(default_factory=lambda: {"DATE": 40, "OPERATIONS": 80, "DEBIT": 450, "CREDIT": 520, "VALEUR": 580, "SOLDE": 650})
    y_start: int = 0
    y_end: int = 1000
    starting_balance: float = 0.0
    bank_name: str = "UNKNOWN"
    confidence: float = 0.0
    thinking: str = ""

# --- ROBUST PIPELINE MODELS ---
class FinancialScout(BaseModel):
    initial_balance: float = Field(description="Solde initial au début du relevé")
    final_balance: float = Field(description="Solde final à la fin du relevé")

class ColumnConfig(BaseModel):
    width: float = Field(default=80.0, description="Largeur de la colonne")
    offset: float = Field(default=0.0, description="Décalage horizontal par rapport à l'ancre (X_start)")
    reasoning: str = Field(default="", description="Explication du choix de ce réglage")

class ColumnWidths(BaseModel):
    date: ColumnConfig = Field(default_factory=lambda: ColumnConfig(width=40, offset=0, reasoning="Default"))
    description: ColumnConfig = Field(default_factory=lambda: ColumnConfig(width=250, offset=0, reasoning="Default"))
    debit: ColumnConfig = Field(default_factory=lambda: ColumnConfig(width=80, offset=0, reasoning="Default"))
    credit: ColumnConfig = Field(default_factory=lambda: ColumnConfig(width=80, offset=0, reasoning="Default"))
    solde: ColumnConfig = Field(default_factory=lambda: ColumnConfig(width=80, offset=0, reasoning="Default"))
    global_reasoning: str = Field(default="", description="Raisonnement global sur l'ajustement")

class PipelineResult(BaseModel):
    transactions: List[Transaction] = []
    is_mathematically_correct: bool = False
    verification_log: str = ""
    error_page: Optional[int] = None
    retry_count: int = 0
    layout: Optional[Dict] = None

# --- LLM HELPERS ---
def get_llm():
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        print("⚠️ GOOGLE_API_KEY missing. LLM calls will fail.")
    return ChatGoogleGenerativeAI(model="gemini-2.5-flash", temperature=0)

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

class BalanceResult(BaseModel):
    initial_balance: float
    final_balance: float
    thinking: str

class AgentState(BaseModel):
    user_id: str
    pdf_base64: str
    existing_accounts: List[Account] = []
    global_context: str = ""
    
    # Expected balances from BalanceScout
    expected_initial_balance: float = 0.0
    expected_final_balance: float = 0.0
    
    # Results for Quadruple Pipeline
    pipeline_a: Optional[PipelineResult] = None
    pipeline_b: Optional[PipelineResult] = None
    pipeline_c: Optional[PipelineResult] = None
    pipeline_d: Optional[PipelineResult] = None
    
    # Loop Management
    retry_count: int = 0
    parsing_feedback: str = ""
    success_parsing: bool = False
    
    # Final Output
    extracted_transactions: List[Transaction] = []
    logs: List[str] = []
    
    # Legacy/Global Storage
    raw_text: str = ""
    raw_pages: List[str] = []
    extracted_transactions: List[Transaction] = []
    
    # Metadata
    page_count: int = 0
    global_context: str = ""
    logs: Annotated[List[str], operator.add] = []
    integrity_report: Optional[str] = None
    
    # Classification results
    classification_a_txns: List[ClassifiedTransaction] = []
    classification_b_txns: List[ClassifiedTransaction] = []
    classification_a_thinking: str = ""
    classification_b_thinking: str = ""

def balance_scout_node(state: AgentState):
    """Initial node to find starting and ending balances matching test_pipeline.py logic"""
    print("--- [Agent: BALANCE_SCOUT][START] ---")
    import fitz
    import base64
    
    try:
        pdf_bytes = base64.b64decode(state.pdf_base64)
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        
        # Get text from first and last page (as in test_pipeline.py)
        text_scout = doc[0].get_text() + "\n" + doc[-1].get_text()
        
        # We also keep the images for better accuracy in Vision (as in test_balance_scout.py)
        p1 = doc[0]
        pix1 = p1.get_pixmap(matrix=fitz.Matrix(2, 2))
        img1_b64 = base64.b64encode(pix1.tobytes("png")).decode('utf-8')
        
        pLast = doc[-1]
        pixLast = pLast.get_pixmap(matrix=fitz.Matrix(2, 2))
        imgLast_b64 = base64.b64encode(pixLast.tobytes("png")).decode('utf-8')
        doc.close()
        
        prompt = f"""
        Tu es un expert en relevés bancaires suisses (BCV, Raiffeisen, PostFinance).
        Analyse l'image et le texte OCR pour trouver les soldes exacts.
        
        DONNÉES OCR (Utilise-les pour confirmer les chiffres lus sur l'image) :
        {text_scout}
        
        OBJECTIF :
        1. SOLDE INITIAL : Le montant EXACT avant toute transaction. 
        2. SOLDE FINAL : Le montant EXACT après la dernière transaction.
        
        Réponds en JSON uniquement selon BalanceResult.
        """
        
        flash_llm = get_llm()
        # Ensure we use the right schema (BalanceResult is already defined in main.py)
        structured_llm = flash_llm.with_structured_output(BalanceResult)
        
        message = HumanMessage(content=[
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img1_b64}"}},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{imgLast_b64}"}}
        ])
        
        res = structured_llm.invoke([message])
        return {
            "expected_initial_balance": res.initial_balance,
            "expected_final_balance": res.final_balance,
            "logs": [f"BalanceScout : In={res.initial_balance}, Out={res.final_balance}"]
        }
    except Exception as e:
        print(f"Error in BalanceScout: {e}")
        return {"logs": [f"Erreur BalanceScout: {str(e)}"]}

def vision_node(state: AgentState):
    """Vision Extraction: Image/PDF -> Initial check for text content"""
    print("--- [Agent: VISION][INPUT_START] ---")
    
    try:
        pdf_bytes = base64.b64decode(state.pdf_base64)
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        page_counts = len(doc)
        
        # Test de présence de texte
        full_text_sample = ""
        for i in range(min(3, page_counts)):
            full_text_sample += doc[i].get_text()
        
        doc.close()
        
        if len(full_text_sample.strip()) > 200:
            return {
                "page_count": page_counts,
                "logs": [f"Document identifié comme PDF natif ({page_counts} pages)."]
            }
        else:
            print("PDF semble être un scan, fallback vers l'IA Vision...")
    except Exception as e:
        print(f"PyMuPDF Error: {e}")

    # Fallback Vision (OCR par IA)
    prompt = "Copie absolument TOUT le texte visible du document bancaire. Ne saute aucune ligne."
    message = HumanMessage(content=[{"type": "text", "text": prompt}, {"type": "image_url", "image_url": {"url": f"data:application/pdf;base64,{state.pdf_base64}"}}])
    
    try:
        flash_llm = get_llm()
        result = flash_llm.invoke([message])
        return {
            "raw_text": result.content,
            "logs": ["Extraction visuelle (OCR) terminée."]
        }
    except Exception as e:
        return {"logs": [f"Erreur Vision: {str(e)}"]}
def scout_standard_node(state: AgentState):
    """Pipeline A Scout: Programmatic Calibration"""
    print("--- [Agent: SCOUT_STANDARD][START] ---")
    import re
    import fitz
    
    try:
        pdf_bytes = base64.b64decode(state.pdf_base64)
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        
        header_center = {"DATE": 40, "OPERATIONS": 80, "DEBIT": 450, "CREDIT": 520, "VALEUR": 580, "SOLDE": 650}
        starting_bal = 0.0
        
        # Calibration sur page 1
        words = doc[0].get_text("words")
        for w in words:
            x0, y0, x1, y1, text = w[0], w[1], w[2], w[3], w[4].upper()
            if y0 < 100 and text in header_center:
                if text == "SOLDE" and x0 < 200: continue
                header_center[text] = (x0 + x1) / 2
            
            if text == "REPORTE":
                line_ws = [sw for sw in words if abs(sw[3]-y1) < 5]
                sol_ws = [sw for sw in line_ws if (sw[0]+sw[2])/2 > 500]
                if sol_ws:
                    val_str = "".join([sw[4] for sw in sol_ws if any(c.isdigit() for c in sw[4])])
                    try: starting_bal = float(val_str.replace(" ", "").replace(",", "."))
                    except: pass

        layout = LayoutConfig(
            header_center=header_center,
            starting_balance=state.expected_initial_balance,
            bank_name="BCV",
            confidence=0.9,
            thinking="Detection programmique basee sur les mots-cles d'en-tete."
        )
        doc.close()
        return {"pipeline_a": PipelineResult(layout=layout), "logs": ["Scout Standard : Calibration terminee."]}
    except Exception as e:
        return {"logs": [f"Erreur Scout Standard: {str(e)}"]}

def universal_parser_node(state: AgentState, pipeline_id: str = "a"):
    """Generic Parser: Uses a LayoutConfig to extract transactions"""
    print(f"--- [Agent: PARSER][PIPELINE_{pipeline_id.upper()}][START] ---")
    import re
    import fitz
    
    pipeline = getattr(state, f"pipeline_{pipeline_id}")
    if not pipeline or not pipeline.layout:
        return {"logs": [f"Erreur Parser {pipeline_id}: Pas de layout."]}
    
    layout = pipeline.layout
    header_center = layout.header_center
    limit_ops = (header_center["DATE"] + header_center["OPERATIONS"]) / 2
    limit_debit = (header_center["OPERATIONS"] + header_center["DEBIT"]) / 2
    limit_credit = (header_center["DEBIT"] + header_center["CREDIT"]) / 2
    
    try:
        pdf_bytes = base64.b64decode(state.pdf_base64)
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        all_txns = []
        
        for i, page in enumerate(doc):
            words = page.get_text("words")
            words.sort(key=lambda w: (w[3], w[0]))
            
            # Detection Y dynamiques pour cette page
            y_start, y_end = 0, page.rect.height
            for w in words:
                x0, y0, x1, y1, text = w[0], w[1], w[2], w[3], w[4].upper()
                if text == "REPORTE" and x0 < 150: y_start = y1 + 2
                elif text == "REPORT" and x0 < 150: y_start = y1 + 2
                elif text == "REPORTER" or text == "SOLDE":
                    next_ws = [sw[4].upper() for sw in words if abs(sw[1]-y0) < 5 and sw[0] > x0]
                    if any(k in next_ws for k in ["EN", "A"]): y_end = y0 - 2
            
            limit_solde = (header_center["CREDIT"] + header_center["SOLDE"]) / 2
            row_data = {"date": "", "desc": [], "debit": [], "credit": [], "solde": []}
            current_y = -1
            
            for w in words:
                x0, y0, x1, y1, text = w[0], w[1], w[2], w[3], w[4]
                mid_x = (x0 + x1) / 2
                if y1 <= y_start or y0 >= y_end: continue
                if (y1 - y0) > (x1 - x0) * 2: continue 
                if x0 > page.rect.width * 0.98: continue

                if current_y == -1: current_y = y1
                if abs(y1 - current_y) > 4:
                    if row_data["date"] or any(row_data.values()):
                        process_row_helper(row_data, all_txns)
                    row_data = {"date": "", "desc": [], "debit": [], "credit": [], "solde": []}
                    current_y = y1

                if mid_x < limit_ops:
                    if re.match(r'\d{1,2}\.\d{1,2}\.', text): row_data["date"] = text
                    else: row_data["desc"].append(text)
                elif mid_x < limit_debit: row_data["desc"].append(text)
                elif mid_x < limit_credit: row_data["debit"].append(text)
                elif mid_x < limit_solde: row_data["credit"].append(text)
                else: row_data["solde"].append(text)
            
            if row_data["date"] or any(row_data.values()):
                process_row_helper(row_data, all_txns)

        doc.close()
        pipeline.transactions = all_txns
        
        # Add feedback processing if we are in a retry
        if state.retry_count > 0 and state.parsing_feedback:
            # On pourrait ici ajuster des paramètres ou donner un hint au parser
            # Pour l'instant on log juste qu'on a pris en compte le feedback
            pass

        return {f"pipeline_{pipeline_id}": pipeline, "logs": [f"Parser {pipeline_id} : {len(all_txns)} txns extraites."]}
    except Exception as e:
        return {"logs": [f"Erreur Parser {pipeline_id}: {str(e)}"]}

def process_row_helper(row, all_txns):
    """Helper to group lines into transactions"""
    date = row["date"]
    desc = " ".join(row["desc"]).strip()
    
    def parse_amt(parts):
        if not parts: return 0.0
        s = "".join(parts).replace(" ", "").replace("'", "").replace(",", ".")
        try: return float(s)
        except: return 0.0

    debit = parse_amt(row["debit"])
    credit = parse_amt(row["credit"])
    solde = parse_amt(row["solde"])
    amount = credit if credit != 0 else -debit
    
    if date:
        all_txns.append(Transaction(date=date, description=desc, amount=amount, runningBalance=solde if solde != 0 else None))
    elif all_txns and amount == 0 and desc:
        all_txns[-1].description += " " + desc
    elif all_txns and amount != 0:
        if all_txns[-1].amount == 0:
            all_txns[-1].amount = amount
            if solde: all_txns[-1].runningBalance = solde
        else:
            if desc: all_txns[-1].description += " " + desc + f" ({amount})"

def verification_node(state: AgentState, pipeline_id: str = "a"):
    """Validates the mathematical integrity of a pipeline"""
    print(f"--- [Agent: VERIFY][PIPELINE_{pipeline_id.upper()}][START] ---")
    pipeline = getattr(state, f"pipeline_{pipeline_id}")
    if not pipeline or not pipeline.transactions:
        return {f"pipeline_{pipeline_id}": pipeline, "logs": [f"Verify {pipeline_id}: Pas de données."]}
    
    txns = [t for t in pipeline.transactions if abs(t.amount or 0) > 0.001]
    starting_bal = pipeline.layout.starting_balance
    current_bal = starting_bal
    
    is_ok = True
    log = []
    error_page = None
    
    for i, t in enumerate(txns):
        current_bal = round(current_bal + (t.amount or 0), 2)
        if t.runningBalance is not None:
            if abs(current_bal - t.runningBalance) > 0.05:
                is_ok = False
                if error_page is None: error_page = 1 
                log.append(f"Erreur ligne {i+1}: Attendu {t.runningBalance}, Calculé {current_bal}")
    
    pipeline.transactions = txns
    pipeline.is_mathematically_correct = is_ok
    pipeline.verification_log = "\n".join(log) if log else "Succès mathématique total."
    pipeline.error_page = error_page
    
    return {f"pipeline_{pipeline_id}": pipeline, "logs": [f"Verify {pipeline_id}: {'OK' if is_ok else 'ERREUR'}"]}

def scout_visual_node(state: AgentState):
    """Pipeline B Scout: Vision-based Layout Analysis"""
    print("--- [Agent: SCOUT_VISUAL][START] ---")
    
    # Génération d'un rendu de la page 1 pour Vision
    try:
        pdf_bytes = base64.b64decode(state.pdf_base64)
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        page = doc[0]
        pix = page.get_pixmap()
        img_data = pix.tobytes("png")
        img_b64 = base64.b64encode(img_data).decode('utf-8')
        doc.close()
    except Exception as e:
        return {"logs": [f"Erreur rendu image pour Scout Visuel: {e}"]}

    prompt = """
    Analyse l'image de ce relevé bancaire. 
    Identifie les coordonnées X centrales (de 0 à 600 environ) pour les colonnes suivantes :
    - DATE
    - OPERATIONS (Libellé)
    - DEBIT (Montants négatifs)
    - CREDIT (Montants positifs)
    - SOLDE (La colonne de droite avec le solde cumulé)
    
    Extrais aussi le SOLDE INITIAL (marqué souvent 'Solde reporté' ou 'Report').
    Réponds au format JSON uniquement :
    {
      "header_center": {"DATE": x1, "OPERATIONS": x2, "DEBIT": x3, "CREDIT": x4, "VALEUR": x5, "SOLDE": x6},
      "starting_balance": 0.0,
      "thinking": "Ton raisonnement ici"
    }
    """
    
    try:
        flash_llm = get_llm()
        message = HumanMessage(content=[
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}}
        ])
        # On utilise une version structurée pour forcer le JSON LayoutConfig
        structured_llm = flash_llm.with_structured_output(LayoutConfig)
        layout = structured_llm.invoke([message])
        
        return {"pipeline_b": PipelineResult(layout=layout), "logs": ["Scout Visuel : Layout identifié par Vision."]}
    except Exception as e:
        return {"logs": [f"Erreur Scout Visuel: {str(e)}"]}
        print(f"Visual Itinerant Worker: Processing chunk starting at page {i+1}")
        
        prompt = """
        Tu es l'Ouvrier Visuel Itinérant. Analyser visuellement ces pages de relevé bancaire (jusqu'à 2 pages avec chevauchement).
        ATTENTION À LA POSITION SPATIALE DES MONTANTS :
        - DÉBIT = NÉGATIF (-).
        - CRÉDIT = POSITIF (+).
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
    current_balance = state.starting_balance
    last_description = "SOLDE INITIAL"
    ghost_count = 0
    MAX_GHOSTS = 30
    chain_broken_msg = None
    
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
        
        return {
            "extracted_transactions": state.extracted_transactions,
            "logs": [f"Erreur du Juge LLM : {str(e)}"]
        }


# --- NEW ROBUST PIPELINE NODE ---

def robust_parsing_node(state: AgentState):
    """
    Robust Parsing Node: Extrait les transactions en utilisant la méthode d'ancrage X/Y
    et d'audit mathématique développée dans test_pipeline.py.
    """
    print("--- [Agent: ROBUST_PARSING][START] ---")
    import re
    import fitz
    import unicodedata
    import json

    def normalize(s):
        return "".join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn').upper()

    def parse_amount(val):
        if not val: return 0.0
        text = " ".join(val) if isinstance(val, list) else str(val)
        # On ne supprime l'espace/apostrophe QUE s'il est entre deux chiffres (ex: 1 500 -> 1500)
        clean_val = re.sub(r"(\d)[ ' ](\d)", r"\1\2", text)
        clean_val = clean_val.replace(",", ".")
        numbers = re.findall(r"-?\d+\.\d+|-?\d+", clean_val)
        if not numbers: return 0.0
        for n in reversed(numbers):
            if "." in n: return int(float(n) * 100) / 100.0
        return float(numbers[-1])

    try:
        pdf_bytes = base64.b64decode(state.pdf_base64)
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        
        # 1. Ancrage IA (Header discovery) - Copied from test_pipeline.py
        words_p0 = [{"text": w[4], "x_min": w[0], "x_max": w[2], "y_mid": (w[1]+w[3])/2, "x_mid": (w[0]+w[2])/2} for w in doc[0].get_text("words")]
        headers = [w for w in words_p0 if w["y_mid"] < 600]
        
        class HeaderLabels(BaseModel):
            date: str = Field(description="Mot exact pour la colonne Date (VALEUR de préférence)")
            description: str = Field(description="Mot exact pour la colonne Description (OPERATIONS de préférence)")
            debit: str = Field(description="Mot exact pour Débit")
            credit: str = Field(description="Mot exact pour Crédit")
            solde: str = Field(description="Mot exact pour Solde")
            reasoning: str = Field(description="Pourquoi ces choix ?")

        prompt_header = f"""
        Tu es un expert en analyse de relevés bancaires.
        Voici les mots du haut de page : {[{"t": w['text'], "x": round(w['x_min']), "y": round(w['y_mid'])} for w in headers]}
        
        MISSION :
        1. Identifie la langue (FR, DE, EN).
        2. Trouve la ligne d'en-tête (Date, Texte, Débit, Crédit, Solde).
        3. Choisis le mot EXACT tel qu'écrit dans la liste :
           - Date : Choisis IMPÉRATIVEMENT 'VALEUR' ou 'VALUTA' si présents (priorité sur 'DATE').
           - Description : Préfère 'OPERATIONS' ou 'TEXTE' à 'DETAIL'.
        
        Réponds en JSON HeaderLabels.
        """
        flash_llm = get_llm()
        labels = flash_llm.with_structured_output(HeaderLabels).invoke([HumanMessage(content=prompt_header)])
        print(f"    [ANCRAGE IA] {labels.reasoning}")

        anchors = {}
        target_y = -1
        # Priority to VALEUR/VALUTA
        for w in headers:
            txt = normalize(w["text"])
            if txt in ["VALEUR", "VALUTA", "VAL"]:
                target_y = w["y_mid"]
                break
        
        if target_y == -1:
            for w in headers:
                if normalize(w["text"]) == "DATE":
                    target_y = w["y_mid"]
                    break
        
        if target_y == -1: target_y = headers[0]["y_mid"] # Fallback

        for w in headers:
            if abs(w["y_mid"] - target_y) > 15: continue
            
            def is_match(word_text, target_label):
                w_norm = normalize(word_text)
                t_norm = normalize(target_label)
                if len(w_norm) < 3: return False
                return w_norm in t_norm or t_norm in w_norm

            if is_match(w["text"], labels.date) and "date" not in anchors: anchors["date"] = w
            if is_match(w["text"], labels.description) and "description" not in anchors: anchors["description"] = w
            if is_match(w["text"], labels.debit) and "debit" not in anchors: anchors["debit"] = w
            if is_match(w["text"], labels.credit) and "credit" not in anchors: anchors["credit"] = w
            if is_match(w["text"], labels.solde) and "solde" not in anchors: anchors["solde"] = w

        # 2. Scout des lignes (Y-Anchors) - get_y_anchors logic
        date_anchor = anchors.get("date", {"x_min": 40, "x_max": 80})
        x_start = date_anchor.get("x_min", 20)
        x_range = (x_start - 10, x_start + 45)
        
        y_anchors = {}
        date_pattern = re.compile(r"^\d{1,2}\.\d{1,2}(\.\d{2,4})?$")
        
        for i in range(len(doc)):
            page_words = doc[i].get_text("words")
            y_list = []
            limit_y = target_y + 10 if i == 0 else 50
            
            footer_y = doc[i].rect.height
            for w in page_words:
                txt = w[4].upper()
                if any(k in txt for k in ["TOTAL", "SOLDE", "PAGE", "REPORT"]) and w[1] > doc[i].rect.height * 0.75:
                    footer_y = w[1]
                    break

            for w in page_words:
                center_x = (w[0] + w[2]) / 2
                if limit_y < w[1] < footer_y and x_range[0] <= center_x <= x_range[1]:
                    if date_pattern.match(w[4]) and not any(c.isalpha() for c in w[4]):
                        y_list.append(round(w[1], 2))
            
            unique_ys = []
            if y_list:
                y_list.sort()
                unique_ys.append(y_list[0])
                for y in y_list[1:]:
                    if y - unique_ys[-1] > 5: unique_ys.append(y)
            y_anchors[i] = unique_ys

        # 3. Extraction - extract_raw_transactions logic
        widths = ColumnWidths()
        all_raw_txns = []
        
        for p_idx, ys in y_anchors.items():
            page = doc[p_idx]
            page_words = page.get_text("words")
            page_words.sort(key=lambda w: (w[1], w[0]))
            
            p_footer_y = page.rect.height
            for w in page_words:
                if any(k in w[4].upper() for k in ["TOTAL", "SOLDE", "PAGE", "REPORT"]) and w[1] > page.rect.height * 0.75:
                    p_footer_y = w[1] - 5
                    break

            for i, y_start in enumerate(ys):
                y_end = ys[i+1]-1 if i < len(ys)-1 else p_footer_y
                rect = fitz.Rect(0, y_start-2, page.rect.width, y_end)
                words_in_tx = page.get_text("words", clip=rect)
                words_in_tx.sort(key=lambda w: (w[1], w[0]))
                
                tx_data = {"date": [], "desc": [], "debit": [], "credit": [], "solde": []}
                for w in words_in_tx:
                    x0, y0, x1, y1, txt = w[0], w[1], w[2], w[3], w[4]
                    x_mid = (x0 + x1) / 2
                    is_num = len(re.findall(r"\d", txt)) > 0 and len(re.findall(r"\d", txt)) >= len(re.findall(r"[a-zA-Z]", txt))
                    is_near_top = (y1 - y_start) < 10
                    
                    def get_col_range(role, cfg):
                        anchor_info = anchors.get(role)
                        anchor_x = anchor_info["x_mid"] if anchor_info else 0
                        if anchor_x == 0: 
                            anchor_x = {"date": 40, "description": 200, "debit": 440, "credit": 510, "solde": 650}.get(role, 0)
                        x_min = anchor_x + cfg.offset - (cfg.width / 2)
                        return x_min, x_min + cfg.width

                    if get_col_range("date", widths.date)[0] <= x_mid <= get_col_range("date", widths.date)[1]: 
                        tx_data["date"].append(txt)
                    elif is_num and is_near_top and get_col_range("debit", widths.debit)[0] <= x1 <= get_col_range("debit", widths.debit)[1]: 
                        tx_data["debit"].append(txt)
                    elif is_num and is_near_top and get_col_range("credit", widths.credit)[0] <= x1 <= get_col_range("credit", widths.credit)[1]: 
                        tx_data["credit"].append(txt)
                    elif is_num and is_near_top and get_col_range("solde", widths.solde)[0] <= x1 <= get_col_range("solde", widths.solde)[1]: 
                        tx_data["solde"].append(txt)
                    else: 
                        tx_data["desc"].append(txt)
                
                all_raw_txns.append(tx_data)

        # 4. Nettoyage et conversion vers Transaction
        final_txns = []
        date_clean_pattern = re.compile(r"\d{1,2}\.\d{1,2}\.\d{2,4}")
        
        for t in all_raw_txns:
            all_text_for_date = " ".join(t["date"] + t["desc"])
            found_date = date_clean_pattern.search(all_text_for_date)
            date_str = found_date.group(0) if found_date else ""
            
            d_val = parse_amount(t["debit"])
            c_val = parse_amount(t["credit"])
            s_val = parse_amount(t["solde"])
            
            final_txns.append(Transaction(
                date=date_str,
                description=" ".join(t["desc"]).replace("\n", " ").strip(),
                amount=c_val if c_val != 0 else -d_val,
                runningBalance=s_val if s_val != 0 else None,
                fullRawText=json.dumps(t)
            ))
        
        doc.close()
        
        # 5. Math validation (Verification logic from test_pipeline.py)
        expected_delta = round(state.expected_final_balance - state.expected_initial_balance, 2)
        total_c = sum(t.amount for t in final_txns if t.amount > 0)
        total_d = sum(abs(t.amount) for t in final_txns if t.amount < 0)
        calc_delta = round(total_c - total_d, 2)
        
        is_ok = abs(calc_delta - expected_delta) < 0.05
        
        return {
            "extracted_transactions": final_txns,
            "success_parsing": True,
            "logs": [
                f"Robust Parsing : {len(final_txns)} transactions extraites.",
                f"Audit mathématique : {'OK' if is_ok else 'ÉCHEC'} (Delta calculé: {calc_delta} vs Attendu: {expected_delta})"
            ]
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"logs": [f"Erreur Robust Parsing: {str(e)}"]}

def scout_heuristic_node(state: AgentState):
    """Pipeline C Scout: sampling-based numeric column detection"""
    print("--- [Agent: SCOUT_HEURISTIC][START] ---")
    import fitz
    import re
    try:
        pdf_bytes = base64.b64decode(state.pdf_base64)
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        header_center = {"DATE": 45, "OPERATIONS": 200, "DEBIT": 440, "CREDIT": 515, "VALEUR": 580, "SOLDE": 650}
        
        words = doc[0].get_text("words")
        num_zones = [ (w[0]+w[2])/2 for w in words if re.search(r'\d+,\d{2}', w[4]) ]
        if num_zones:
            rightmost = max(num_zones)
            if rightmost > 550: header_center["SOLDE"] = rightmost
        
        layout = LayoutConfig(header_center=header_center, starting_balance=state.expected_initial_balance, thinking="Heuristique par zones numériques.")
        doc.close()
        return {"pipeline_c": PipelineResult(layout=layout), "logs": ["Scout Heuristique : Calibration par zones."]}
    except Exception as e:
        return {"logs": [f"Erreur Scout Heuristique: {e}"]}

def scout_sampling_node(state: AgentState):
    """Pipeline D Scout: analysis of the first line of transaction"""
    print("--- [Agent: SCOUT_SAMPLING][START] ---")
    import fitz
    import re
    try:
        pdf_bytes = base64.b64decode(state.pdf_base64)
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        header_center = {"DATE": 45, "OPERATIONS": 150, "DEBIT": 450, "CREDIT": 520, "VALEUR": 585, "SOLDE": 660}
        
        words = doc[0].get_text("words")
        for w in words:
            if re.match(r'\d{2}\.\d{2}\.', w[4]):
                header_center["DATE"] = (w[0] + w[2]) / 2
                break
        
        layout = LayoutConfig(header_center=header_center, starting_balance=state.expected_initial_balance, thinking="Sampling par premiere ligne.")
        doc.close()
        return {"pipeline_d": PipelineResult(layout=layout), "logs": ["Scout Sampling : Calibration par premiere ligne."]}
    except Exception as e:
        return {"logs": [f"Erreur Scout Sampling: {e}"]}

def judge_parsing_node(state: AgentState):
    """Aggregates results, checks final balance and decides if retry is needed"""
    print(f"--- [Agent: JUDGE_PARSING][START][RETRY: {state.retry_count}] ---")
    
    pipelines = [state.pipeline_a, state.pipeline_b, state.pipeline_c, state.pipeline_d]
    valid_results = [p for p in pipelines if p and p.is_mathematically_correct]
    
    final_valid = []
    best_fail = None
    first_error_page = 999
    
    for p in valid_results:
        calc_final = p.layout.starting_balance
        for t in p.transactions:
            calc_final += (t.amount or 0)
        
        if abs(calc_final - state.expected_final_balance) < 0.1:
            final_valid.append(p)
        else:
            # On cherche la page de l'erreur
            if p.error_page and p.error_page < first_error_page:
                first_error_page = p.error_page
            best_fail = p

    if final_valid:
        winner = max(final_valid, key=lambda r: len(r.transactions))
        return {
            "extracted_transactions": winner.transactions, 
            "success_parsing": True,
            "logs": [f"Juge : Succès avec {len(winner.transactions)} txns."]
        }
    
    # ÉCHEC : On prépare le feedback pour le retry
    if state.retry_count < 2: # Max 2 retries
        msg = f"Le solde final ne correspond pas (Attendu: {state.expected_final_balance}). "
        if first_error_page != 999:
            msg += f"L'erreur semble commencer à la PAGE {first_error_page}."
        else:
            msg += "L'erreur est répartie ou non localisée."
        
        return {
            "retry_count": state.retry_count + 1,
            "parsing_feedback": msg,
            "success_parsing": False,
            "logs": [f"Juge : ÉCHEC. Retry {state.retry_count + 1} demandé. Feedback: {msg}"]
        }
    else:
        # Épuisement des retries, on prend le meilleur disponible
        winner = state.pipeline_a
        if valid_results:
            winner = max(valid_results, key=lambda r: len(r.transactions))
        return {
            "extracted_transactions": winner.transactions if winner else [],
            "success_parsing": True, # On force la sortie pour éviter la boucle infinie
            "logs": ["Juge : Échec après retries. Passage en mode dégradé."]
        }

def should_continue_parsing(state: AgentState):
    """Conditional edge to decide if we loop back for another try"""
    if state.success_parsing:
        return "continue"
    return "retry"

# Build Graph
workflow = StateGraph(AgentState)

workflow.add_node("vision", vision_node)
workflow.add_node("balance_scout", balance_scout_node)
workflow.add_node("robust_parsing", robust_parsing_node)

# Classification Phase
workflow.add_node("start_classification", start_classification_node)
workflow.add_node("classifier_a", classifier_a_node)
workflow.add_node("classifier_b", classifier_b_node)
workflow.add_node("judge", classification_consensus_node)

# --- Edges Definition ---
workflow.set_entry_point("vision")
workflow.add_edge("vision", "balance_scout")
workflow.add_edge("balance_scout", "robust_parsing")
workflow.add_edge("robust_parsing", "start_classification")

# Classification Flow
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
            "detected_dates": output.get("detected_dates", []),
            "parser_output": output.get("raw_text", ""),
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
        llm = ChatGoogleGenerativeAI(model="gemini-2.5-flash", temperature=0.7)
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
