"""SEC-08 mutation testing runner for backend/request_security.py and backend/main.py."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List

BACKEND_DIR = Path(__file__).resolve().parents[1]
TEST_FILE = BACKEND_DIR / "tests" / "test_sec08_backend.py"

E = "email_security.py"
R = "request_security.py"
P = "prompt_and_error_security.py"
M = "main.py"

MUTANTS: List[Dict[str, Any]] = [
    # request_security.py mutants
    {"name": "R01 statement max size raised above 10 MiB", "file": R, "find": "MAX_STATEMENT_BYTES = 10 * 1024 * 1024", "replace": "MAX_STATEMENT_BYTES = 20 * 1024 * 1024"},
    {"name": "R02 receipt max size raised above 5 MiB", "file": R, "find": "MAX_RECEIPT_BYTES = 5 * 1024 * 1024", "replace": "MAX_RECEIPT_BYTES = 10 * 1024 * 1024"},
    {"name": "R03 receipt base64 char limit raised", "file": R, "find": "MAX_RECEIPT_BASE64_CHARS = 7_000_000", "replace": "MAX_RECEIPT_BASE64_CHARS = 14_000_000"},
    {"name": "R04 max PDF pages raised above 50", "file": R, "find": "MAX_PDF_PAGES = 50", "replace": "MAX_PDF_PAGES = 100"},
    {"name": "R05 bounded upload chunk check disabled", "file": R, "find": "if len(buf) + len(chunk) > max_bytes:", "replace": "if False:"},
    {"name": "R06 MIME allowlist check skipped", "file": R, "find": "if norm not in allowed_mimes:", "replace": "if False:"},
    {"name": "R07 PDF %PDF- signature check skipped", "file": R, "find": 'if not raw_bytes.lstrip().startswith(b"%PDF-"):', "replace": "if False:"},
    {"name": "R08 PDF page count limit check skipped", "file": R, "find": "if page_count > max_pages:", "replace": "if False:"},
    {"name": "R09 pre-decode base64 char cap skipped", "file": R, "find": "if len(clean) > max_chars:", "replace": "if False:"},
    {"name": "R10 post-decode base64 byte cap skipped", "file": R, "find": "if len(decoded) > max_decoded_bytes:", "replace": "if False:"},
    {"name": "R11 role cache ignores expired TTL", "file": R, "find": "if expires_at <= current:", "replace": "if False:"},
    {"name": "R12 role cache disables LRU eviction above max_entries", "file": R, "find": "while len(self._entries) > self.max_entries:", "replace": "while False:"},
    # main.py mutants
    {"name": "R13 AI rate limiter disabled inside dependency", "file": M, "find": "if not _AI_RATE_LIMITER.allow(actor_key):", "replace": "if False:"},
    {"name": "R14 /process-bank-statement restores client userId IDOR", "file": M, "find": 'effective_user_id = (decoded_token.get("uid") or "").strip()', "replace": 'effective_user_id = userId or (decoded_token.get("uid") or "").strip()'},
    {"name": "R15 _user_has_any_role skips caching negative False lookups", "file": M, "find": "_ROLE_CACHE.store(cache_key, has_role, now)", "replace": "if has_role:\n            _ROLE_CACHE.store(cache_key, has_role, now)"},
    {"name": "R16 _user_has_any_role caches failed Firestore lookups", "file": M, "find": "if not lookup_failed:", "replace": "if True:"},
    {"name": "R17 /process-bank-statement drops AI rate limiter", "file": M, "find": "decoded_token: dict = Depends(verify_and_rate_limit_ai_user),", "replace": "decoded_token: dict = Depends(verify_firebase_token),"},
    {"name": "R18 /process-receipt drops AI rate limiter", "file": M, "find": '@app.post("/process-receipt", dependencies=[Depends(verify_and_rate_limit_ai_user)])', "replace": '@app.post("/process-receipt", dependencies=[Depends(verify_firebase_token)])'},
    {"name": "R19 /analyze-receipt drops AI rate limiter", "file": M, "find": '@app.post("/analyze-receipt", dependencies=[Depends(verify_and_rate_limit_ai_user)])', "replace": '@app.post("/analyze-receipt", dependencies=[Depends(verify_firebase_token)])'},
    {"name": "R20 /chat drops AI rate limiter", "file": M, "find": '@app.post("/chat", dependencies=[Depends(verify_and_rate_limit_ai_user)])', "replace": '@app.post("/chat", dependencies=[Depends(verify_firebase_token)])'},
    {"name": "R21 /suggest-category drops AI rate limiter", "file": M, "find": '@app.post("/suggest-category", dependencies=[Depends(verify_and_rate_limit_ai_user)])', "replace": '@app.post("/suggest-category", dependencies=[Depends(verify_firebase_token)])'},
    {"name": "R22 /audit drops AI rate limiter", "file": M, "find": '@app.post("/audit", dependencies=[Depends(verify_and_rate_limit_ai_user)])', "replace": '@app.post("/audit", dependencies=[Depends(verify_firebase_token)])'},
    {"name": "R23 /process-bank-statement maps PayloadTooLargeError to 500 instead of 413", "file": M, "find": "    except PayloadTooLargeError as size_err:\n        raise HTTPException(status_code=413, detail=str(size_err))\n    except InvalidUploadMediaError as media_err:\n        raise HTTPException(status_code=400, detail=str(media_err))\n    except HTTPException:\n        raise\n    except Exception as e:\n        raise HTTPException(status_code=500, detail=build_safe_500_detail(e, \"process-bank-statement\"))\n\n@app.post(\"/process-receipt\"", "replace": "    except PayloadTooLargeError as size_err:\n        raise HTTPException(status_code=500, detail=str(size_err))\n    except InvalidUploadMediaError as media_err:\n        raise HTTPException(status_code=400, detail=str(media_err))\n    except HTTPException:\n        raise\n    except Exception as e:\n        raise HTTPException(status_code=500, detail=build_safe_500_detail(e, \"process-bank-statement\"))\n\n@app.post(\"/process-receipt\""},
]


def main() -> int:
    originals = {
        E: (BACKEND_DIR / E).read_text(encoding="utf-8").replace("\r\n", "\n"),
        R: (BACKEND_DIR / R).read_text(encoding="utf-8").replace("\r\n", "\n"),
        P: (BACKEND_DIR / P).read_text(encoding="utf-8").replace("\r\n", "\n"),
        M: (BACKEND_DIR / M).read_text(encoding="utf-8").replace("\r\n", "\n"),
    }

    if "--dry-check" in sys.argv:
        missing = [mut["name"] for mut in MUTANTS if mut["find"] not in originals[mut["file"]] or originals[mut["file"]].replace(mut["find"], mut["replace"], 1) == originals[mut["file"]]]
        print(f"Dry-check: {len(MUTANTS)} mutants, invalid={len(missing)}")
        for m in missing:
            print(f"INVALID: {m}")
        return 1 if missing else 0

    killed = 0
    survivors: List[str] = []
    invalid: List[str] = []

    print(f"SEC-08 Python Mutation Test: evaluating {len(MUTANTS)} mutants...")
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

        with tempfile.TemporaryDirectory(prefix="sec08-mut-") as tmp:
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
        f"\nSEC-08 Python Mutation Score: {killed}/{len(MUTANTS)} killed "
        f"({(killed / len(MUTANTS) * 100.0):.1f}%), {len(invalid)} invalid, {len(survivors)} survived."
    )
    if invalid:
        print("Invalid mutants:", invalid)
    if survivors:
        print("Surviving mutants:", survivors)
    return 0 if (killed == len(MUTANTS) and not invalid and not survivors) else 1


if __name__ == "__main__":
    raise SystemExit(main())
