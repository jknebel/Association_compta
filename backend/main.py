import os
import base64
import json
import io
import asyncio
import math
import hashlib
import re
import fitz # PyMuPDF
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
    id: str
    date: str
    description: str
    simplifiedDescription: Optional[str] = None
    amount: float
    fullRawText: Optional[str] = None
    runningBalance: Optional[float] = None
    notes: Optional[str] = None
    accountId: Optional[str] = None
    status: Optional[str] = "PENDING"
    detectedMemberName: Optional[str] = None
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
    amount: Optional[float] = None
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
    
    # Expected balances
    expected_initial_balance: float = 0.0
    expected_final_balance: float = 0.0
    
    # Internal State
    retry_count: int = 0
    recovery_attempts: int = 0
    success_parsing: bool = False
    
    # Results
    extracted_transactions: List[Transaction] = []
    raw_text: str = ""
    page_count: int = 0
    
    # Metadata
    logs: Annotated[List[str], operator.add] = []
    integrity_report: Optional[str] = None
    classification_thinking: str = ""

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

async def classification_consensus_node(state: AgentState):
    """
    Per-transaction Consensus Classifier:
    For each transaction, Agent A (History) and Agent B (Members) run in parallel.
    Python consensus logic picks the best result. 10 transactions processed concurrently.
    """
    print("--- [Agent: CONSENSUS_CLASSIFIER][START] ---")
    all_txns = state.extracted_transactions
    if not all_txns:
        return {"logs": ["Classification : Aucune transaction."]}

    # Build shared context once
    accounts_info = "\n".join([
        f"ID: {a.id} | Nom: {a.label} | Description: {a.description or 'N/A'} | Suivi: {'OUI' if a.isMembership else 'NON'} | Contexte IA: {a.iaContext or 'N/A'}" 
        for a in state.existing_accounts
    ])
    membership_account_ids = {a.id for a in state.existing_accounts if a.isMembership}
    history_context = get_user_history_context(state.user_id)
    global_ctx = state.global_context or ""
    
    flash_llm = get_llm()
    struct_single = flash_llm.with_structured_output(ClassifiedTransactionList)
    
    semaphore = asyncio.Semaphore(10)  # 10 transactions in parallel

    async def process_single_txn(txn):
        async with semaphore:
            txn_data = json.dumps({
                "id": txn.id,
                "date": txn.date,
                "amount": txn.amount,
                "description_complete": txn.description,
                "description_simplifiee": txn.simplifiedDescription
            }, ensure_ascii=False)

            # Agent A: History Expert
            prompt_a = f"""Tu es le Comptable A (Expert Historique). Classe cette transaction.
Utilise 'description_complete' et 'description_simplifiee' pour vérifier ton choix.
{f"CONTEXTE GLOBAL : {global_ctx}" if global_ctx else ""}
HISTORIQUE: {history_context}
PLAN COMPTABLE: {accounts_info}
TRANSACTION: {txn_data}"""

            # Agent B: Member Expert
            prompt_b = f"""Tu es le Comptable B (Expert Membres). Classe cette transaction.
Utilise 'description_simplifiee' pour identifier les noms de personnes.
{f"CONTEXTE GLOBAL : {global_ctx}" if global_ctx else ""}
PLAN COMPTABLE: {accounts_info}
RÈGLES: Si tu détectes un nom de personne dans la communication/description, extrais-le dans detectedMemberName et assigne au compte Suivi: OUI correspondant.
Utilise le 'Contexte IA' de chaque compte pour affiner ton choix.
TRANSACTION: {txn_data}"""
            
            try:
                task_a = struct_single.ainvoke(prompt_a)
                task_b = struct_single.ainvoke(prompt_b)
                res_a, res_b = await asyncio.gather(task_a, task_b)
                
                txn_a = res_a.transactions[0] if res_a.transactions else None
                txn_b = res_b.transactions[0] if res_b.transactions else None
                
                if not txn_a and not txn_b:
                    return ClassifiedTransaction(**txn.model_dump(), accountChoiceReasoning="Aucun agent n'a répondu")
                if not txn_a:
                    return txn_b
                if not txn_b:
                    return txn_a
                
                # Judge LLM: Consensus between A and B
                prompt_j = f"""Tu es le Juge. Deux comptables ont classé cette transaction. Choisis la meilleure proposition.
PLAN COMPTABLE: {accounts_info}
TRANSACTION ORIGINALE: {txn_data}
PROPOSITION A (Historique): accountId={getattr(txn_a, 'accountId', None)}, memberName={getattr(txn_a, 'detectedMemberName', None)}, raison: {txn_a.accountChoiceReasoning}
PROPOSITION B (Membres): accountId={getattr(txn_b, 'accountId', None)}, memberName={getattr(txn_b, 'detectedMemberName', None)}, raison: {txn_b.accountChoiceReasoning}
RÈGLE: Priorité à B si un membre est détecté sur un compte Suivi: OUI. Priorité à A sinon. Explique ton choix."""

                res_j = await struct_single.ainvoke(prompt_j)
                winner = res_j.transactions[0] if res_j.transactions else txn_a
                
                # Ensure the original transaction fields are preserved
                winner.id = txn.id
                winner.date = txn.date
                winner.amount = txn.amount
                winner.description = txn.description
                winner.simplifiedDescription = txn.simplifiedDescription
                winner.fullRawText = txn.fullRawText
                
                return winner
                
            except Exception as e:
                print(f"Error classifying txn {txn.id}: {e}")
                return ClassifiedTransaction(**txn.model_dump(), accountChoiceReasoning=f"Erreur consensus: {str(e)}")

    # Process all transactions, 10 at a time via semaphore
    tasks = [process_single_txn(t) for t in all_txns]
    final_txns = await asyncio.gather(*tasks)
    final_txns = list(final_txns)
    
    # Final cleanup
    for t in final_txns:
        if t.date and "-" in t.date:
            try:
                dt = datetime.strptime(t.date, "%Y-%m-%d")
                t.date = dt.strftime("%d.%m.%y")
            except: pass
            
    final_txns.sort(key=lambda x: str(x.date or "1900-01-01"))
    
    return {
        "extracted_transactions": final_txns,
        "logs": [f"Classification Consensus : {len(final_txns)} transactions (A+B par transaction, 10 en parallèle)."]
    }


async def description_simplifier_node(state: AgentState):
    """
    New Agent: Simplifies transaction descriptions by removing noise (accounts, addresses, etc.)
    while keeping names and communication info.
    """
    print("--- [Agent: SIMPLIFIER][START] ---")
    all_txns = state.extracted_transactions
    if not all_txns: return {"logs": ["Simplification : Aucune transaction."]}

    batch_size = 20
    batches = [all_txns[i : i + batch_size] for i in range(0, len(all_txns), batch_size)]
    
    flash_llm = get_llm()
    
    class SimplifiedTxn(BaseModel):
        id: str
        simplifiedDescription: str

    class SimplifiedList(BaseModel):
        results: List[SimplifiedTxn]

    struct_llm = flash_llm.with_structured_output(SimplifiedList)
    semaphore = asyncio.Semaphore(5)

    async def process_batch(batch, idx):
        async with semaphore:
            prompt = f"""Tu es un expert en simplification de relevés bancaires suisses.

MISSION : Pour chaque transaction, extrais UNIQUEMENT ces 2 informations :
1. **NOM** : Le nom de la personne ou entreprise qui fait le virement (DONNEUR D'ORDRE) ou le destinataire du paiement (BÉNÉFICIAIRE). Juste le nom, rien d'autre.
2. **COMMUNICATION** : Le texte libre après "COMMUNICATIONS:" ou "MOTIF:" s'il existe. C'est souvent un message personnel (ex: "cotisation 2025", "Robin Jenny, cotisation TDGL").

FORMAT DE SORTIE : "Nom - Communication" (ou juste "Nom" si pas de communication).

SUPPRIMER OBLIGATOIREMENT :
- Numéros de compte, IBAN, références (REF, NOTRE REF, BVR)
- Adresses postales (rues, codes postaux, villes)
- Codes techniques (VIRT, CPTE, BANC, TVA, CHE-)
- Dates techniques et montants
- Mots-clés bancaires (DONNEUR D'ORDRE, BÉNÉFICIAIRE, COMMUNICATIONS, etc.)

EXEMPLES :
- "VIRT BANC Cedric Widmer et Evely NOTRE REF.: 692... DONNEUR D'ORDRE: CHE-116... Cedric Widmer et Evelyne Faivre Wid Bleu Avenue..." → "Cedric Widmer et Evelyne Faivre"
- "VIRT CPTE DROUET E. & JENNY C. NOTRE REF.: 260... DONNEUR D'ORDRE: DROUET EMMANUEL ET JENNY... COMMUNICATIONS: Robin Jenny, cotisation TDGL..." → "Drouet Emmanuel et Jenny - Robin Jenny, cotisation TDGL"
- "PAIEMENT COOP PRONTO 1234 MORGES" → "Coop Pronto Morges"

TRANSACTIONS : {json.dumps([{'id': t.id, 'description': t.description} for t in batch], ensure_ascii=False)}"""

            try:
                res = await struct_llm.ainvoke(prompt)
                return res.results
            except Exception as e:
                print(f"Error Simplifier Batch {idx}: {e}")
                return [SimplifiedTxn(id=t.id, simplifiedDescription=t.description) for t in batch]

    tasks = [process_batch(b, i) for i, b in enumerate(batches)]
    results = await asyncio.gather(*tasks)
    flat_results = {r.id: r.simplifiedDescription for batch in results for r in batch}

    for t in all_txns:
        t.simplifiedDescription = flat_results.get(t.id, t.description)

    return {
        "extracted_transactions": all_txns,
        "logs": [f"Simplification : {len(all_txns)} descriptions traitées."]
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
            
            amount = c_val if c_val != 0 else -d_val
            description = " ".join(t["desc"]).replace("\n", " ").strip()
            
            # Stable unique ID based on content
            txn_id = hashlib.md5(f"{date_str}|{description}|{amount}".encode()).hexdigest()
            
            final_txns.append(Transaction(
                id=f"tx_{txn_id}",
                date=date_str,
                description=description,
                amount=amount,
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

# Build Graph
workflow = StateGraph(AgentState)

workflow.add_node("vision", vision_node)
workflow.add_node("balance_scout", balance_scout_node)
workflow.add_node("robust_parsing", robust_parsing_node)

# Simplification Phase
workflow.add_node("simplifier", description_simplifier_node)

# Classification Phase
workflow.add_node("classifier", classification_consensus_node)

# --- Edges Definition ---
workflow.set_entry_point("vision")
workflow.add_edge("vision", "balance_scout")
workflow.add_edge("balance_scout", "robust_parsing")
workflow.add_edge("robust_parsing", "simplifier")
workflow.add_edge("simplifier", "classifier")
workflow.add_edge("classifier", END)

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
        
        output = await compiled_app.ainvoke(initial_state)
        
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
        - Amount: {request.amount or 'N/A'}
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
        
        Accounts: {json.dumps([{"id": a.id, "label": a.label, "code": a.code, "description": a.description, "iaContext": a.iaContext} for a in request.accounts])}
        
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
