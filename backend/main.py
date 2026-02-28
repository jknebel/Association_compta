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

class Transaction(BaseModel):
    date: str
    description: str
    amount: float
    accountId: Optional[str] = None
    detectedMemberName: Optional[str] = None
    status: str = "PENDING"
    receiptUrl: Optional[str] = None

class TransactionList(BaseModel):
    transactions: List[Transaction]

class ReceiptExtraction(BaseModel):
    amount: Optional[float] = None
    content: Optional[str] = None
    date: Optional[str] = None

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
    extracted_transactions: List[Transaction] = []
    logs: List[str] = []

def ingest_node(state: AgentState):
    """OCR Extraction"""
    print("--- NODE: INGESTION ---")
    prompt = """
    Analyse ce document bancaire. Extrais toutes les transactions.
    Date format: YYYY-MM-DD.
    Montant: Positif pour crédit, Négatif pour débit.
    Description: Garde le texte complet.
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
        # Use with_structured_output for robust JSON parsing
        structured_llm = flash_llm.with_structured_output(TransactionList)
        result = structured_llm.invoke([message])
        
        return {
            "extracted_transactions": result.transactions,
            "logs": [f"Extraction terminée: {len(result.transactions)} lignes trouvées."]
        }
    except Exception as e:
        print(f"Ingestion Error: {e}")
        return {
            "extracted_transactions": [],
            "logs": [f"Erreur d'extraction: {str(e)}"]
        }

def classification_node(state: AgentState):
    """
    Classification with LEARNING (RAG-lite).
    """
    print("--- NODE: CLASSIFICATION INTELLIGENTE ---")
    transactions = state.extracted_transactions
    accounts = state.existing_accounts
    user_id = state.user_id
    
    if not transactions:
        return {}

    # 1. Retrieve User Memory
    history_context = get_user_history_context(user_id)
    
    # 2. Prepare Account Context
    # Map ID -> Label to help AI
    accounts_info = "\n".join([f"ID: {a.id} | Code: {a.code} | Nom: {a.label}" for a in accounts])
    
    # 3. Advanced Prompt with History
    prompt = f"""
    Tu es un expert comptable intelligent. Ta tâche est d'assigner le bon 'accountId' aux nouvelles transactions.

    ### 1. PLAN COMPTABLE ACTUEL
    {accounts_info}

    ### 2. HISTORIQUE & APPRENTISSAGE (TRÈS IMPORTANT)
    Voici comment cet utilisateur a classé ses transactions précédentes. 
    Utilise ces exemples pour comprendre sa logique.
    
    RÈGLES D'APPRENTISSAGE :
    - Cherche des patterns dans les descriptions (ex: références 'xxxcv', noms de fournisseurs).
    - Regarde les montants récurrents (ex: 100.00 tout rond souvent = Loyer ou Parking).
    - Si tu vois "M. Bolomet" classé en "Parking" dans le passé, et que tu vois "Mme Bolomet" avec le même montant/référence aujourd'hui, classe-le aussi en "Parking".
    - Si la référence (ex: 'xxxcv') correspond à un compte passé, c'est prioritaire sur le nom.

    DONNÉES HISTORIQUES :
    ---------------------
    {history_context}
    ---------------------

    ### 3. NOUVELLES TRANSACTIONS À CLASSER
    {json.dumps([t.model_dump() for t in transactions], default=str)}

    Retourne la liste des transactions avec le champ 'accountId' rempli (ou null si incertain).
    """
    
    try:
        flash_llm = get_llm()
        structured_llm = flash_llm.with_structured_output(TransactionList)
        result = structured_llm.invoke(prompt)
        
        return {
            "extracted_transactions": result.transactions,
            "logs": ["Classification intelligente terminée avec historique."]
        }
    except Exception as e:
        print(f"Classification Error: {e}")
        return {
            "logs": [f"Erreur de classification: {str(e)}"]
        }

# Build Graph
workflow = StateGraph(AgentState)
workflow.add_node("ingest", ingest_node)
workflow.add_node("classify", classification_node)

workflow.set_entry_point("ingest")
workflow.add_edge("ingest", "classify")
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