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
    logs: List[str] = []

def vision_node(state: AgentState):
    """Vision Extraction: Image -> Raw Text"""
    print("--- [Agent: VISION][INPUT_START] ---")
    print(f"UserId: {state.user_id}")
    print(f"PDF Base64 Length: {len(state.pdf_base64)}")
    print("--- [Agent: VISION][INPUT_END] ---")
    
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
    
    Tu dois retrouver et extraire toutes les transactions sous forme structurée en respectant ces règles STICTES :
    1.  **Date** : Convertis les dates au format YYYY-MM-DD. ATTENTION: Le texte d'origine utilise le format Européen (Jour.Mois.Année ou DD.MM.YY). Ne confonds pas le mois et le jour.
    2.  **Montant** : Positif pour crédit, Négatif pour débit.
        CRITIQUE: Le montant ne doit JAMAIS être 0.00 sauf si c'est explicitement écrit '0.00'. Ne mets JAMAIS 0 par défaut.
    3.  **Description** : Un libellé 'small' très court et propre pour l'affichage (ex: 'Parking', 'Cotisation Dupont', 'Virement Andrea Lozzi').
    4.  **fullRawText** : OBLIGATOIRE ET VITAL. Recopie ici de manière exhaustive TOUT le bloc de texte brut (ci-dessus) qui est associé à cette transaction. Cela inclut toutes les lignes subsidiaires (communications, donneur d'ordre, notre ref, etc.). Ne tronque rien !
    """
    
    try:
        flash_llm = get_llm()
        structured_llm = flash_llm.with_structured_output(TransactionList)
        result = structured_llm.invoke(prompt)
        
        print("--- [Agent: PARSING][OUTPUT_START] ---")
        print(f"Extracted {len(result.transactions)} transactions.")
        for i, t in enumerate(result.transactions[:3]):
             print(f"Txn {i}: {t.date} | {t.description} | {t.amount} | Raw: {t.fullRawText[:50]}...")
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
    Double vérification des montants.
    Détecte les transactions avec montant == 0 et tente une ré-extraction.
    """
    print("--- [Agent: AMOUNT_VERIFICATION][INPUT_START] ---")
    transactions = state.extracted_transactions
    zero_txns = [t for t in transactions if t.amount == 0.0]
    print(f"Total Txns: {len(transactions)} | Suspicious (0.00): {len(zero_txns)}")
    print("--- [Agent: AMOUNT_VERIFICATION][INPUT_END] ---")
    
    if not zero_txns:
        return {
            "logs": [f"Vérification montants: OK ({len(transactions)} transactions, aucun montant à 0)."]
        }
    
    # Build a targeted prompt for re-extraction
    suspect_descriptions = "\n".join([
        f"- Date: {t.date}, Description: '{t.description}' (montant actuel: 0.00)"
        for t in zero_txns
    ])
    
    prompt = f"""
    ATTENTION: Lors de l'extraction précédente, les transactions suivantes ont été extraites avec un montant de 0.00,
    ce qui est très probablement une erreur.
    
    Transactions suspectes :
    {suspect_descriptions}
    
    Relis attentivement le document bancaire ci-joint et retrouve le VRAI montant pour chacune de ces transactions.
    Le montant doit être positif pour un crédit et négatif pour un débit.
    
    Retourne UNIQUEMENT ces transactions avec le montant corrigé.
    Si tu ne peux vraiment pas trouver le montant, laisse 0.0 mais c'est un dernier recours.
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
        
        # Build correction map: description -> corrected amount
        correction_map = {}
        for corrected_txn in result.transactions:
            if corrected_txn.amount != 0.0:
                correction_map[corrected_txn.description.strip().lower()] = corrected_txn.amount
        
        # Apply corrections
        corrections_applied = 0
        still_zero = 0
        updated_transactions = []
        for t in transactions:
            if t.amount == 0.0:
                key = t.description.strip().lower()
                if key in correction_map:
                    old_amount = t.amount
                    t.amount = correction_map[key]
                    corrections_applied += 1
                else:
                    still_zero += 1
            updated_transactions.append(t)
        
        print("--- [Agent: AMOUNT_VERIFICATION][OUTPUT_START] ---")
        print(f"Corrections Applied: {corrections_applied} | Still Zero: {still_zero}")
        print("--- [Agent: AMOUNT_VERIFICATION][OUTPUT_END] ---")

        log_msg = f"Vérification montants: {corrections_applied} corrigé(s)"
        if still_zero > 0:
            log_msg += f", {still_zero} toujours à 0 (vérification manuelle recommandée)"
        
        return {
            "extracted_transactions": updated_transactions,
            "logs": [log_msg]
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
    print("--- [Agent: CLASSIFICATION][INPUT_END] ---")
    
    if not transactions:
        return {}

    # 1. Retrieve User Memory
    history_context = get_user_history_context(user_id)
    
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
    Regarde bien le champ 'fullRawText' pour chaque transaction :
    - Il contient souvent le "Vrai" bénéficiaire dans les remarques (ex: "COTISATION POUR PIERRE").
    - Extrais ce nom et mets-le dans 'detectedMemberName'.
    - Si tu vois une date de période (ex: "Loyer Janvier"), note-le en priorité.
    - Le champ 'description' peut être raccourci par l'utilisateur, fie-toi à 'fullRawText' qui est la donnée brute.
    - Regarde aussi 'receiptFileName' qui contient le nom original du justificatif sans extension. Ce nom contient TRÈS SOUVENT des indices vitaux sur la catégorie (ex: "Bouffe Etapes Ikicize").

    DONNÉES HISTORIQUES :
    ---------------------
    {history_context}
    ---------------------

    ### 5. NOUVELLES TRANSACTIONS À CLASSER
    {json.dumps([t.model_dump() for t in transactions], default=str)}

    Retourne la liste des transactions avec le champ 'accountId' rempli ET 'detectedMemberName' extrait si possible.
    """
    
    print("--- [Agent: CLASSIFICATION][PROMPT_START] ---")
    print(prompt)
    print("--- [Agent: CLASSIFICATION][PROMPT_END] ---")

    try:
        flash_llm = get_llm()
        structured_llm = flash_llm.with_structured_output(TransactionList)
        result = structured_llm.invoke(prompt)
        
        # Post-processing: Validate and Correct Account IDs
        validated_transactions = []
        account_map = {a.id: a for a in accounts}
        code_map = {a.code: a for a in accounts} # Fallback map

        for txn in result.transactions:
            if txn.accountId:
                # 1. Check if ID is valid
                if txn.accountId in account_map:
                    # All good
                    pass
                # 2. Fallback: Check if AI returned a Code instead
                elif txn.accountId in code_map:
                    txn.accountId = code_map[txn.accountId].id
                else:
                    # Invalid ID, reset
                    txn.accountId = None
            validated_transactions.append(txn)

        print("--- [Agent: CLASSIFICATION][OUTPUT_START] ---")
        for i, t in enumerate(validated_transactions[:3]):
             print(f"Txn {i}: {t.description} -> AccountID: {t.accountId} | Member: {t.detectedMemberName}")
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
        Analyze the transaction description: "{request.description}"
        Full Raw Text (if available): "{request.fullRawText or 'N/A'}"
        Receipt File Name (if available): "{request.receiptFileName or 'N/A'}"
        
        Task 1: Select the best matching Account ID from the list below.
        CRITICAL INSTRUCTIONS FOR MATCHING:
        - Use the 'path' field to understand the account hierarchy (Parent > Child).
        - Use the 'description' field (if present) to understand the intended use of the account.
        - Pay attention to specific keywords in the 'description' or 'path' that match the transaction.
        - The Receipt File Name often contains the vendor or category context (e.g., "Bouffe Etapes" -> generic food/meals).
        
        Task 2: If the chosen account has 'isMembership': true, OR if the description/raw text clearly contains a person's name (Payer), extract that name.
        
        SPECIAL RULE: If the description contains "VIRT CPTE" (which means Account Transfer), the text following it is likely the Payer's Name. Extract it as 'memberName', especially if the account is a Product class (Class 7).
        
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
