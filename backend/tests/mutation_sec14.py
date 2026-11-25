"""SEC-14 mutation testing runner for backend/prompt_and_error_security.py and backend/main.py."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List

BACKEND_DIR = Path(__file__).resolve().parents[1]
TEST_FILE = BACKEND_DIR / "tests" / "test_sec14_ai_and_errors.py"

E = "email_security.py"
R = "request_security.py"
P = "prompt_and_error_security.py"
M = "main.py"

MUTANTS: List[Dict[str, Any]] = [
    {"name": "P01 wrap_untrusted_data skips escaping closing tag", "file": P, "find": 'escaped = _UNTRUSTED_TAG_PATTERN.sub(r"&lt;\\1", raw)', "replace": "escaped = raw"},
    {"name": "P02 wrap_untrusted_data disables max_chars truncation", "file": P, "find": "if max_chars > 0 and len(raw) > max_chars:", "replace": "if False:"},
    {"name": "P03 sanitize_chat_history maps assistant role to HumanMessage", "file": P, "find": "sanitized.append(AIMessage(content=bounded))", "replace": "sanitized.append(HumanMessage(content=bounded))"},
    {"name": "P04 sanitize_chat_history accepts client system role", "file": P, "find": 'if role == "user":', "replace": 'if role in ("user", "system"):'},
    {"name": "P05 build_safe_500_detail leaks exception text", "file": P, "find": 'return f"Erreur interne lors du traitement. Référence : {ref}"', "replace": 'return f"Erreur interne ({exc}). Référence : {ref}"'},
    {"name": "P06 /chat omits PROMPT_INJECTION_SYSTEM_GUARD", "file": M, "find": 'system_prompt = f"""{PROMPT_INJECTION_SYSTEM_GUARD}\n\n        You are an intelligent accounting assistant', "replace": 'system_prompt = f"""\n        You are an intelligent accounting assistant'},
    {"name": "P07 /chat skips sanitize_chat_history", "file": M, "find": "messages.extend(sanitize_chat_history(request.history))", "replace": "pass"},
    {"name": "P08 /suggest-category bypasses wrap_untrusted_data on description", "file": M, "find": 'wrapped_desc = wrap_untrusted_data("description", request.description, max_chars=2000)', "replace": "wrapped_desc = request.description"},
    {"name": "P09 /audit bypasses wrap_untrusted_data on transactions", "file": M, "find": 'wrapped_audit_txns = wrap_untrusted_data("audit_transactions", txns_text, max_chars=50000)', "replace": "wrapped_audit_txns = txns_text"},
    {"name": "P10 /process-bank-statement leaks 500 str(e)", "file": M, "find": 'detail=build_safe_500_detail(e, "process-bank-statement")', "replace": "detail=str(e)"},
    {"name": "P11 /audit leaks 500 str(e)", "file": M, "find": 'detail=build_safe_500_detail(e, "audit")', "replace": "detail=str(e)"},
    {"name": "P12 /api/send-email leaks SMTP exception in 500 detail", "file": M, "find": 'detail=build_safe_500_detail(e, "send-email")', "replace": 'detail=f"SMTP send failed: {e}"'},
]


def main() -> int:
    originals = {
        E: (BACKEND_DIR / E).read_text(encoding="utf-8").replace("\r\n", "\n"),
        R: (BACKEND_DIR / R).read_text(encoding="utf-8").replace("\r\n", "\n"),
        P: (BACKEND_DIR / P).read_text(encoding="utf-8").replace("\r\n", "\n"),
        M: (BACKEND_DIR / M).read_text(encoding="utf-8").replace("\r\n", "\n"),
    }

    if "--dry-check" in sys.argv:
        missing = [
            mut["name"]
            for mut in MUTANTS
            if mut["find"] not in originals[mut["file"]]
            or originals[mut["file"]].replace(mut["find"], mut["replace"], 1) == originals[mut["file"]]
        ]
        print(f"Dry-check: {len(MUTANTS)} mutants, invalid={len(missing)}")
        for m in missing:
            print(f"INVALID: {m}")
        return 1 if missing else 0

    killed = 0
    survivors: List[str] = []
    invalid: List[str] = []

    print(f"SEC-14 Python Mutation Test: evaluating {len(MUTANTS)} mutants...")
    for mut in MUTANTS:
        src = originals[mut["file"]]
        find = mut["find"]
        if find not in src:
            invalid.append(f"{mut['name']} (target not found)")
            print(f"INVALID  : {mut['name']}")
            continue

        mutated = src.replace(find, mut["replace"], 1)
        if mutated == src:
            invalid.append(f"{mut['name']} (no-op mutation)")
            print(f"NO-OP    : {mut['name']}")
            continue

        with tempfile.TemporaryDirectory(prefix="sec14-mut-") as tmp:
            tmp_path = Path(tmp)
            for fname, content in originals.items():
                (tmp_path / fname).write_text(mutated if fname == mut["file"] else content, encoding="utf-8")

            env = {**os.environ, "SEC04_BACKEND_DIR": str(tmp_path)}
            res = subprocess.run(
                [sys.executable, "-m", "pytest", "-q", str(TEST_FILE)],
                cwd=str(BACKEND_DIR.parent),
                env=env,
                capture_output=True,
                text=True,
                timeout=60,
            )
            if res.returncode != 0:
                killed += 1
                print(f"KILLED   : {mut['name']}")
            else:
                survivors.append(mut["name"])
                print(f"SURVIVED : {mut['name']}")

    print(
        f"\nSEC-14 Python Mutation Score: {killed}/{len(MUTANTS)} killed "
        f"({(killed / len(MUTANTS) * 100.0):.1f}%), {len(invalid)} invalid, {len(survivors)} survived."
    )
    if invalid:
        print("Invalid mutants:", invalid)
    if survivors:
        print("Surviving mutants:", survivors)
    return 0 if (killed == len(MUTANTS) and not invalid and not survivors) else 1


if __name__ == "__main__":
    raise SystemExit(main())
