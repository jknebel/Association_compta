"""SEC-04 mutation testing runner for backend/email_security.py and backend/main.py."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List

BACKEND_DIR = Path(__file__).resolve().parents[1]
TEST_FILE = BACKEND_DIR / "tests" / "test_sec04_email.py"

E = "email_security.py"
M = "main.py"

MUTANTS: List[Dict[str, Any]] = [
    # email_security.py mutants
    {"name": "M01 crlf ignored in has_header_injection", "file": E, "find": 'return "\\r" in value or "\\n" in value or "\\x00" in value', "replace": 'return "\\x00" in value'},
    {"name": "M02 null byte ignored in has_header_injection", "file": E, "find": 'or "\\x00" in value', "replace": ""},
    {"name": "M03 email regex permits un-dotted host", "file": E, "find": r"(?:\.[A-Za-z0-9-]+)+$", "replace": r"(?:\.[A-Za-z0-9-]+)*$"},
    {"name": "M04 email min length allows < 3 chars", "file": E, "find": "if len(addr) < 3 or len(addr) > 254:", "replace": "if len(addr) > 254:"},
    {"name": "M05 secret min length check removed", "file": E, "find": "len(secret) < MIN_INTERNAL_SECRET_LEN or ", "replace": ""},
    {"name": "M06 secret comparison always True", "file": E, "find": 'return hmac.compare_digest(provided.encode("utf-8"), secret.encode("utf-8"))', "replace": "return True"},
    {"name": "M07 secret CR/LF guard removed", "file": E, "find": "or has_header_injection(provided)", "replace": ""},
    {"name": "M08 recipient list max bound raised", "file": E, "find": "MAX_RECIPIENTS = 20", "replace": "MAX_RECIPIENTS = 25"},
    {"name": "M09 recipient angle check / CRLF skipped", "file": E, "find": "if not isinstance(raw_addr, str) or has_header_injection(raw_addr):", "replace": "if not isinstance(raw_addr, str):"},
    {"name": "M10 subject CRLF check removed", "file": E, "find": "if not isinstance(subject, str) or has_header_injection(subject):", "replace": "if not isinstance(subject, str):"},
    {"name": "M11 subject max length relaxed", "file": E, "find": "MAX_SUBJECT_LEN = 250", "replace": "MAX_SUBJECT_LEN = 300"},
    {"name": "M12 from_name angle bracket spoofing allowed", "file": E, "find": 'if "<" in from_name or ">" in from_name:', "replace": "if False:"},
    {"name": "M13 reply_to validation skipped", "file": E, "find": "if not is_valid_email_address(candidate):", "replace": "if False:"},
    {"name": "M14 empty body allowed", "file": E, "find": 'if not clean_text.strip() and not (clean_html or "").strip():', "replace": "if False:"},
    {"name": "M15 pending members allowed to send email", "file": E, "find": 'if status != "approved":\n                continue', "replace": "pass"},
    {"name": "M16 uploader added to PRIVILEGED_EMAIL_ROLES", "file": E, "find": '"locations",\n})', "replace": '"locations",\n    "uploader",\n})'},
    {"name": "M17 viewer added to PRIVILEGED_EMAIL_ROLES", "file": E, "find": '"locations",\n})', "replace": '"locations",\n    "viewer",\n})'},
    {"name": "M18 responsable_location removed from PRIVILEGED_EMAIL_ROLES", "file": E, "find": '"responsable_location",\n', "replace": ""},
    {"name": "M19 rate limiter disabled", "file": E, "find": "if len(bucket) >= self.max_requests:", "replace": "if False:"},
    # main.py mutants
    {"name": "M20 endpoint accepts SMTP_PASS as X-Mailer-Secret", "file": M, "find": 'internal_secret = os.getenv("MAILER_INTERNAL_SECRET", "")', "replace": 'internal_secret = os.getenv("SMTP_PASS", "")'},
    {"name": "M21 endpoint skips RBAC check (any token)", "file": M, "find": 'if not (decoded.get("superAdmin") is True or user_can_send_email(uid, email, _SUPER_ADMIN_EMAILS, db)):', "replace": "if False:"},
    {"name": "M22 endpoint disables rate limiter", "file": M, "find": "if not _EMAIL_RATE_LIMITER.allow(actor_key):", "replace": "if False:"},
    {"name": "M23 endpoint ignores ValueError from payload validation", "file": M, "find": '    except ValueError as val_err:\n        raise HTTPException(status_code=400, detail=str(val_err))', "replace": '    except ValueError:\n        sanitized = {"to": list(request.to or []), "subject": request.subject or "", "text": request.text or "", "html": request.html, "from_name": request.from_name or "Asso", "reply_to": request.reply_to}'},
    {"name": "M24 endpoint skips server audit mail logging", "file": M, "find": 'db.collection("mail").add({', "replace": 'if False: db.collection("mail").add({'},
]


def main() -> int:
    originals = {
        E: (BACKEND_DIR / E).read_text(encoding="utf-8").replace("\r\n", "\n"),
        M: (BACKEND_DIR / M).read_text(encoding="utf-8").replace("\r\n", "\n"),
    }

    killed = 0
    survivors: List[str] = []
    invalid: List[str] = []

    print(f"SEC-04 Python Mutation Test: evaluating {len(MUTANTS)} mutants...")
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

        with tempfile.TemporaryDirectory(prefix="sec04-mut-") as tmp:
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
                print(f"SURVIVOR : {mut['name']}")

    valid = killed + len(survivors)
    score = round((killed / valid) * 100) if valid else 0
    print(f"\nSEC-04 Python Mutation Score: {score}% ({killed}/{valid} killed, {len(invalid)} invalid)")
    if survivors:
        print("Survivors:", ", ".join(survivors))
    if invalid:
        print("Invalid:", ", ".join(invalid))
    return 1 if (survivors or invalid) else 0


if __name__ == "__main__":
    raise SystemExit(main())
