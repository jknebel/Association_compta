"""Python mutation testing runner for immediate INVOICE_PAYMENT email notifications."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List

BACKEND_DIR = Path(__file__).resolve().parents[1]
TEST_FILE = BACKEND_DIR / "tests" / "test_sec19_invoice_notification.py"

E = "email_security.py"
R = "request_security.py"
P = "prompt_and_error_security.py"
M = "main.py"

MUTANTS: List[Dict[str, Any]] = [
    {"name": "N01 is_safe_firestore_segment allows path traversal ..", "file": E, "find": 'if not stripped or stripped in (".", "..") or ".." in stripped or "/" in stripped or "\\\\" in stripped:', "replace": "if not stripped:"},
    {"name": "N02 build_invoice_payment_email skips html.escape on compta_name", "file": E, "find": "{_html.escape(safe_compta)}", "replace": "{safe_compta}"},
    {"name": "N03 build_invoice_payment_email skips html.escape on submitter_name", "file": E, "find": "{_html.escape(submitter_name)}", "replace": "{submitter_name}"},
    {"name": "N04 resolve_compta_caissier_emails_from_db skips approved status check", "file": E, "find": 'if (m_data.get("status") or "approved").strip().lower() != "approved":', "replace": "if False:"},
    {"name": "N05 /api/notify-invoice-payment skips expenseType==INVOICE_PAYMENT guard", "file": M, "find": 'if receipt_data.get("expenseType") != "INVOICE_PAYMENT":', "replace": "if False:"},
    {"name": "N06 /api/notify-invoice-payment skips ownership/privilege check", "file": M, "find": "if not (is_owner or is_privileged):", "replace": "if False:"},
    {"name": "N07 /api/notify-invoice-payment skips idempotency guard", "file": M, "find": 'if receipt_data.get("invoiceNotificationSentAt"):', "replace": "if False:"},
    {"name": "N08 /api/notify-invoice-payment skips safe segment validation", "file": M, "find": "is_safe_firestore_segment(org_id)", "replace": "True"},
]


def main() -> int:
    originals = {
        E: (BACKEND_DIR / E).read_text(encoding="utf-8").replace("\r\n", "\n"),
        R: (BACKEND_DIR / R).read_text(encoding="utf-8").replace("\r\n", "\n"),
        P: (BACKEND_DIR / P).read_text(encoding="utf-8").replace("\r\n", "\n"),
        M: (BACKEND_DIR / M).read_text(encoding="utf-8").replace("\r\n", "\n"),
    }

    killed = 0
    survivors: List[str] = []
    invalid: List[str] = []

    print(f"INVOICE_PAYMENT Python Mutation Test: evaluating {len(MUTANTS)} mutants...")
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

        with tempfile.TemporaryDirectory(prefix="inv-mut-") as tmp:
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
        f"\nINVOICE_PAYMENT Python Mutation Score: {killed}/{len(MUTANTS)} killed "
        f"({(killed / len(MUTANTS) * 100.0):.1f}%), {len(invalid)} invalid, {len(survivors)} survived."
    )
    if invalid:
        print("Invalid mutants:", invalid)
    if survivors:
        print("Survived mutants:", survivors)
    return 1 if (invalid or survivors) else 0


if __name__ == "__main__":
    raise SystemExit(main())
