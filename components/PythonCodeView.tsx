
import React, { useState, useEffect, useRef } from 'react';
import { Copy, Terminal, Play, Code, SquareTerminal, Loader2, Download, CloudCog } from 'lucide-react';
import { Account } from '../types';

interface PythonCodeViewProps {
  accounts?: Account[];
}

type LogLine = {
    timestamp: string;
    message: string;
    type: 'info' | 'success' | 'warning' | 'error' | 'system';
};

export const PythonCodeView: React.FC<PythonCodeViewProps> = ({ accounts = [] }) => {
  const [activeTab, setActiveTab] = useState<'CODE' | 'TERMINAL'>('TERMINAL');
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of terminal
  useEffect(() => {
    if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, activeTab]);
  
  // Format accounts for Python injection
  const formattedAccounts = accounts.map(a => 
    `            Account(
                code="${a.code}", 
                label="${a.label}", 
                description="${a.description}", 
                type="${a.type}", 
                is_membership=${a.isMembership ? 'True' : 'False'},
                parent_id=${a.parentId ? `"${a.parentId}"` : 'None'},
                icon=${a.icon ? `"${a.icon}"` : 'None'}
            )`
  ).join(',\n');

  const pythonCode = `import os
from typing import TypedDict, List, Optional, Annotated
import operator
import pandas as pd
from pydantic import BaseModel, Field
from langgraph.graph import StateGraph, END
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import SystemMessage, HumanMessage

# --- CONFIGURATION ---
os.environ["GOOGLE_API_KEY"] = "YOUR_API_KEY_HERE"

# Initialize Models
# We use Gemini 2.5 Flash for fast extraction tasks
flash_model = ChatGoogleGenerativeAI(model="gemini-2.5-flash", temperature=0)
# We use Gemini 3 Pro for complex reasoning and auditing
pro_model = ChatGoogleGenerativeAI(model="gemini-3-pro-preview", temperature=0.2)

# --- DATA MODELS ---

class Account(BaseModel):
    code: str
    label: str
    description: str
    type: str
    is_membership: bool

class Transaction(BaseModel):
    date: str
    description: str
    amount: float
    account_code: Optional[str] = None
    review_status: str = "PENDING"

class AssociationState(TypedDict):
    """The state of our graph passed between agents."""
    pdf_content: str
    existing_accounts: List[Account]
    transactions: List[Transaction]
    logs: Annotated[List[str], operator.add]

# --- AGENTS / NODES ---

def ingestion_agent(state: AssociationState):
    """Reads PDF text and extracts raw transactions."""
    print("--- 1. INGESTION AGENT ---")
    # ... extraction logic ...
    return {"transactions": extracted_txns}

def classification_agent(state: AssociationState):
    """Assigns accounts to transactions using RAG."""
    print("--- 2. CLASSIFICATION AGENT ---")
    # ... classification logic ...
    return {"transactions": updated_transactions}

def expert_auditor_agent(state: AssociationState):
    """Gemini 3 Pro reviews the ledger."""
    print("--- 3. EXPERT AUDITOR AGENT ---")
    # ... audit logic ...
    return {"logs": ["Audit Report Generated"]}

def excel_writer_agent(state: AssociationState):
    """Outputs the final state to Excel."""
    print("--- 4. EXCEL WRITER AGENT ---")
    # ... pandas logic ...
    return {"logs": ["File saved."]}

# --- GRAPH DEFINITION ---

workflow = StateGraph(AssociationState)
workflow.add_node("ingest", ingestion_agent)
workflow.add_node("classify", classification_agent)
workflow.add_node("audit", expert_auditor_agent)
workflow.add_node("write", excel_writer_agent)

workflow.set_entry_point("ingest")
workflow.add_edge("ingest", "classify")
workflow.add_edge("classify", "audit")
workflow.add_edge("audit", "write")
workflow.add_edge("write", END)

app = workflow.compile()`;

  const handleDownload = () => {
    const element = document.createElement("a");
    const file = new Blob([pythonCode], {type: 'text/x-python'});
    element.href = URL.createObjectURL(file);
    element.download = "agent_workflow.py";
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  // --- SIMULATION LOGIC ---
  const addLog = (msg: string, type: LogLine['type'] = 'info') => {
      setLogs(prev => [...prev, { timestamp: new Date().toLocaleTimeString(), message: msg, type }]);
  };

  const runSimulation = async () => {
      if (isRunning) return;
      setIsRunning(true);
      setLogs([]);
      
      const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

      addLog("user@assocompta:~/backend$ python agent_workflow.py", 'system');
      await delay(800);
      addLog("Initializing LangGraph Workflow...", 'info');
      await delay(1000);
      addLog(`Loaded ${accounts.length} accounts from configuration.`, 'info');
      
      // STEP 1: INGESTION
      await delay(1200);
      addLog("--- NODE: INGESTION AGENT (Gemini 2.5 Flash) ---", 'system');
      await delay(500);
      addLog("Reading PDF content...", 'info');
      await delay(800);
      addLog("Extracting financial entities...", 'info');
      await delay(800);
      addLog("Found 12 raw transactions.", 'success');

      // STEP 2: CLASSIFICATION
      await delay(1200);
      addLog("--- NODE: CLASSIFICATION AGENT (Vector Match) ---", 'system');
      await delay(600);
      addLog(`Processing 'Virement Cotisation J.Dupont'...`, 'info');
      addLog(`Matched to Account [7000] (Cotisations Membres) - Confidence 98%`, 'success');
      await delay(400);
      addLog(`Processing 'Facture Hostinger'...`, 'info');
      addLog(`Matched to Account [6510] (Frais Web) - Confidence 95%`, 'success');
      await delay(600);
      addLog("Classified 12/12 transactions.", 'success');

      // STEP 3: AUDIT
      await delay(1500);
      addLog("--- NODE: EXPERT AUDITOR (Gemini 3 Pro) ---", 'system');
      addLog("Reasoning Budget: 8192 tokens allocated.", 'warning');
      await delay(2000);
      addLog("Analyzing consistency...", 'info');
      await delay(1000);
      addLog("Warning: Transaction #4 (Resto) might be 'Frais de Mission' instead of 'Réception'.", 'warning');
      addLog("Audit complete. Score: 92/100", 'success');

      // STEP 4: WRITE
      await delay(1000);
      addLog("--- NODE: EXCEL WRITER ---", 'system');
      await delay(500);
      addLog("Generating .xlsx file...", 'info');
      await delay(500);
      addLog("Saved output to ./exports/comptabilite_2024.xlsx", 'success');
      
      await delay(200);
      addLog("Process finished with exit code 0", 'system');
      setIsRunning(false);
  };

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto h-full flex flex-col">
      <div className="mb-6 bg-slate-900 p-6 rounded-xl border border-slate-800 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
            <h2 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <Terminal className="text-blue-500" />
            Backend Python & Agents
            </h2>
            <p className="text-slate-400 mt-2 text-sm">
            Code source des agents LangGraph. Pour la mise en production, déployez ce script sur <b>Google Cloud Run</b>.
            </p>
        </div>
        <button 
            onClick={handleDownload}
            className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 transition-colors text-sm font-medium"
        >
            <Download size={16} />
            Télécharger agent_workflow.py
        </button>
      </div>

      <div className="flex-1 bg-slate-950 rounded-xl shadow-lg overflow-hidden flex flex-col border border-slate-800">
        {/* TAB HEADER */}
        <div className="bg-slate-900 border-b border-slate-800 flex items-center px-4">
            <button 
                onClick={() => setActiveTab('TERMINAL')}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${activeTab === 'TERMINAL' ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
            >
                <SquareTerminal size={16} />
                Terminal Simulé
            </button>
            <button 
                onClick={() => setActiveTab('CODE')}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${activeTab === 'CODE' ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
            >
                <Code size={16} />
                Code Source (LangGraph)
            </button>
            
            <div className="ml-auto flex items-center gap-2">
                {activeTab === 'TERMINAL' && (
                    <button 
                        onClick={runSimulation}
                        disabled={isRunning}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider transition-all ${
                            isRunning 
                            ? 'bg-slate-800 text-slate-500 cursor-not-allowed' 
                            : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/20'
                        }`}
                    >
                        {isRunning ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                        {isRunning ? 'Exécution...' : 'Lancer Simulation'}
                    </button>
                )}
                 {activeTab === 'CODE' && (
                     <button 
                        onClick={() => navigator.clipboard.writeText(pythonCode)}
                        className="flex items-center gap-2 text-xs text-slate-400 hover:text-white transition-colors px-3"
                    >
                        <Copy size={14} />
                        Copier
                    </button>
                 )}
            </div>
        </div>
        
        {/* CONTENT */}
        <div className="flex-1 overflow-hidden relative bg-[#0d1117]">
            {activeTab === 'CODE' ? (
                <div className="absolute inset-0 overflow-auto p-4">
                    <pre className="text-sm font-mono text-slate-300 leading-relaxed">
                        <code>{pythonCode}</code>
                    </pre>
                </div>
            ) : (
                <div className="absolute inset-0 flex flex-col font-mono text-sm p-4" onClick={() => document.getElementById('fake-input')?.focus()}>
                    <div className="flex-1 overflow-y-auto space-y-2 pb-4 scrollbar-thin scrollbar-thumb-slate-700" ref={scrollRef}>
                        <div className="text-slate-500 mb-4">
                            AssoCompta AI Environment [Version 1.0.2]<br/>
                            (c) 2024 Association OS. All rights reserved.<br/>
                            Type 'help' for instructions.
                        </div>

                        {logs.map((log, idx) => (
                            <div key={idx} className="flex gap-3 animate-in fade-in slide-in-from-left-2 duration-300">
                                <span className="text-slate-600 shrink-0 text-xs mt-0.5">[{log.timestamp}]</span>
                                <span className={`break-all ${
                                    log.type === 'system' ? 'text-blue-400 font-bold' :
                                    log.type === 'success' ? 'text-emerald-400' :
                                    log.type === 'warning' ? 'text-amber-400' :
                                    log.type === 'error' ? 'text-rose-400' :
                                    'text-slate-300'
                                }`}>
                                    {log.type === 'system' && log.message.includes('$') ? (
                                        <span className="flex gap-2">
                                            <span className="text-emerald-500">➜</span>
                                            <span className="text-white">{log.message.replace('user@assocompta:~/backend$ ', '')}</span>
                                        </span>
                                    ) : (
                                        log.message
                                    )}
                                </span>
                            </div>
                        ))}

                        {isRunning && (
                             <div className="flex gap-2 items-center text-slate-500 mt-2">
                                 <span className="w-2 h-4 bg-slate-500 animate-pulse"></span>
                             </div>
                        )}
                        
                        {!isRunning && logs.length > 0 && (
                            <div className="text-emerald-500 flex gap-2 mt-4">
                                ➜ <span className="text-white animate-pulse">_</span>
                            </div>
                        )}
                        
                        {!isRunning && logs.length === 0 && (
                            <div className="flex flex-col items-center justify-center h-64 text-slate-600 gap-4">
                                <SquareTerminal size={48} className="opacity-20" />
                                <p>Le terminal est prêt.</p>
                                <div className="flex gap-4 mt-2">
                                    <button onClick={runSimulation} className="text-emerald-500 hover:underline flex items-center gap-1">
                                        <Play size={14} /> Lancer la Simulation
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
      </div>
    </div>
  );
};
