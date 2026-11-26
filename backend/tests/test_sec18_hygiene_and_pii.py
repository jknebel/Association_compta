"""SEC-18 positive, negative, and boundary tests for backend super-admin config & PII log hygiene."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

_DEFAULT_BACKEND_DIR = str(Path(__file__).resolve().parents[1])
_BACKEND_DIR = os.environ.get("SEC04_BACKEND_DIR") or _DEFAULT_BACKEND_DIR
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import main  # noqa: E402
from test_sec04_email import FakeFirestore  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_sec18_state():
    main._AI_RATE_LIMITER.reset()
    main._EMAIL_RATE_LIMITER.reset()
    main._ROLE_CACHE.clear()
    yield
    main._AI_RATE_LIMITER.reset()
    main._EMAIL_RATE_LIMITER.reset()
    main._ROLE_CACHE.clear()


def test_sec18_load_super_admin_emails_positive_and_env_override():
    # Env var overrides default fallback cleanly
    custom = main._load_super_admin_emails("  Tresorier@Asso.ch ; Admin@Asso.ch ")
    assert custom == {"tresorier@asso.ch", "admin@asso.ch"}

    # Fallback defaults apply when unset/empty
    fallback = main._load_super_admin_emails("")
    assert "jean-francois@knebel.ch" in fallback
    assert "jean.francois.knebel@gmail.com" in fallback
    assert "quokka@tdgl.ch" in fallback


def test_sec18_load_super_admin_emails_negative_and_boundary():
    # Passing "NONE" disables all fallback emails
    assert main._load_super_admin_emails("NONE") == set()
    # Non-email garbage ignored while valid email kept
    assert main._load_super_admin_emails("not-an-email, ; , x@y.ch ") == {"x@y.ch"}


def test_sec18_verify_firebase_token_honors_superadmin_claim_even_with_empty_db(monkeypatch):
    monkeypatch.setattr(main, "db", None)
    monkeypatch.setattr(main.firebase_admin, "_apps", {"default": object()})
    monkeypatch.setattr(
        main.firebase_auth,
        "verify_id_token",
        lambda _tok: {"uid": "claim-admin", "email": "ordinary@asso.ch", "superAdmin": True},
    )
    client = TestClient(main.app)
    resp = client.post(
        "/suggest-category",
        headers={"Authorization": "Bearer valid-claim-token"},
        json={"description": "Achat", "accounts": []},
    )
    # Must NOT fail with 403 due to empty Firestore; claim superAdmin===True authenticates cleanly
    assert resp.status_code != 401
    assert resp.status_code != 403


def test_sec18_verify_firebase_token_rejects_non_bool_superadmin_claim(monkeypatch):
    monkeypatch.setattr(main, "db", FakeFirestore())
    monkeypatch.setattr(main.firebase_admin, "_apps", {"default": object()})
    monkeypatch.setattr(
        main.firebase_auth,
        "verify_id_token",
        lambda _tok: {"uid": "regular-user", "email": "regular@asso.ch", "superAdmin": "true"},
    )
    client = TestClient(main.app)
    resp = client.post(
        "/suggest-category",
        headers={"Authorization": "Bearer non-bool-claim"},
        json={"description": "Achat", "accounts": []},
    )
    assert resp.status_code == 403


def test_sec18_backend_main_contains_no_pii_debug_prints():
    src = (Path(_BACKEND_DIR) / "main.py").read_text(encoding="utf-8")
    forbidden_snippets = [
        "[SAMPLE] id=",
        "[SIMPLIFIER SAMPLE]",
        "[ENDPOINT SAMPLE]",
        "Global Context preview:",
        "iaContext:",
        "extraction.model_dump()",
        "result.model_dump()",
        "FullRawText:",
        "Description: {request.description}",
        "labels.reasoning",
        "file.filename",
        "montant > 0) pour {target_amount}",
        "montant < 0) pour {target_amount}",
        "(lu: '{raw_str}')",
    ]
    for snippet in forbidden_snippets:
        assert snippet not in src, f"Forbidden PII print snippet remained in main.py: {snippet}"
