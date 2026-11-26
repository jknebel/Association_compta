"""SEC-18 Python mutation testing runner for backend/main.py config & PII hygiene."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List

BACKEND_DIR = Path(__file__).resolve().parents[1]
TEST_FILE = BACKEND_DIR / "tests" / "test_sec18_hygiene_and_pii.py"

E = "email_security.py"
R = "request_security.py"
P = "prompt_and_error_security.py"
M = "main.py"

MUTANTS: List[Dict[str, Any]] = [
    {"name": "L01 _load_super_admin_emails ignores raw_env override", "file": M, "find": '    if isinstance(val, str) and val.strip():', "replace": '    if False and isinstance(val, str) and val.strip():'},
    {"name": "L02 _load_super_admin_emails omits @ filter on split items", "file": M, "find": 'if "@" in item.strip()', "replace": "if item.strip()"},
    {"name": "L03 verify_firebase_token ignores superAdmin==True claim", "file": M, "find": '    if decoded.get("superAdmin") is True:\n        return decoded', "replace": '    if False and decoded.get("superAdmin") is True:\n        return decoded'},
    {"name": "L04 verify_firebase_token accepts truthy string superAdmin", "file": M, "find": '    if decoded.get("superAdmin") is True:', "replace": '    if bool(decoded.get("superAdmin")):'},
    {"name": "L05 /suggest-category reintroduces request.description PII print", "file": M, "find": 'print(f"Description length: {len(request.description or \'\')}")', "replace": 'print(f"Description: {request.description}")'},
    {"name": "L06 /suggest-category reintroduces request.fullRawText PII print", "file": M, "find": 'print(f"FullRawText length: {len(request.fullRawText) if request.fullRawText else 0}")', "replace": 'print(f"FullRawText: {request.fullRawText}")'},
    {"name": "L07 /suggest-category reintroduces result.model_dump() print", "file": M, "find": 'print(f"Suggested accountId present: {result.accountId is not None}, memberName present: {result.memberName is not None}")', "replace": 'print(f"Result: {result.model_dump()}")'},
    {"name": "L08 /analyze-receipt reintroduces extraction.model_dump() print", "file": M, "find": 'print(f"Receipt extracted (has_amount={extraction.amount is not None}, is_refund={getattr(extraction, \'isRefund\', False)})")', "replace": 'print(f"Extracted from receipt: {extraction.model_dump()}")'},
    {"name": "L09 /process-bank-statement reintroduces file.filename PII print", "file": M, "find": 'print(f"Processing bank statement upload (context_len={len(context) if context else 0})")', "replace": 'print(f"Processing file: {file.filename} for user: {effective_user_id}")'},
    {"name": "L10 ancrage IA reintroduces labels.reasoning print", "file": M, "find": 'print("    [ANCRAGE IA] Labels anchored")', "replace": 'print(f"    [ANCRAGE IA] {labels.reasoning}")'},
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

    print(f"SEC-18 Python Mutation Test: evaluating {len(MUTANTS)} mutants...")
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

        with tempfile.TemporaryDirectory(prefix="sec18-mut-") as tmp:
            tmp_path = Path(tmp)
            for fname, content in originals.items():
                (tmp_path / fname).write_text(mutated if fname == mut["file"] else content, encoding="utf8")

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
        f"\nSEC-18 Python Mutation Score: {killed}/{len(MUTANTS)} killed "
        f"({(killed / len(MUTANTS) * 100.0):.1f}%), {len(invalid)} invalid, {len(survivors)} survived."
    )
    if invalid:
        print("Invalid mutants:", invalid)
    if survivors:
        print("Survived mutants:", survivors)
    return 1 if (invalid or survivors) else 0


if __name__ == "__main__":
    raise SystemExit(main())
