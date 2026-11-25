"""SEC-05 positive, negative, and boundary tests enforcing email_verified == True."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

_DEFAULT_BACKEND_DIR = str(Path(__file__).resolve().parents[1])
_BACKEND_DIR = os.environ.get("SEC04_BACKEND_DIR") or _DEFAULT_BACKEND_DIR
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import email_security  # noqa: E402
import main  # noqa: E402
from test_sec04_email import FakeFirestore, _FakeSnapshot  # noqa: E402


def test_verified_token_email_strict_boolean():
    assert email_security.verified_token_email({"email": "  Alice@TDGL.ch ", "email_verified": True}) == "alice@tdgl.ch"
    assert email_security.verified_token_email({"email": "alice@tdgl.ch", "email_verified": False}) == ""
    assert email_security.verified_token_email({"email": "alice@tdgl.ch"}) == ""
    assert email_security.verified_token_email({"email": "alice@tdgl.ch", "email_verified": None}) == ""
    assert email_security.verified_token_email({"email": "alice@tdgl.ch", "email_verified": "true"}) == ""
    assert email_security.verified_token_email({"email": "alice@tdgl.ch", "email_verified": 1}) == ""
    assert email_security.verified_token_email({"email": 123, "email_verified": True}) == ""
    assert email_security.verified_token_email(None) == ""


def test_verify_firebase_token_and_pending_role_status(monkeypatch):
    fake_db = FakeFirestore(
        members=[
            _FakeSnapshot("pre@asso.ch", {"email": "pre@asso.ch", "role": "member", "status": "approved", "comptaAccess": {"c1": "uploader"}}),
            _FakeSnapshot("pend-uid", {"uid": "pend-uid", "role": "admin", "status": "pending", "comptaAccess": {"c1": "caissier"}}),
        ]
    )
    tokens = {
        "sa-verified": {"uid": "x1", "email": "jean-francois@knebel.ch", "email_verified": True},
        "sa-unverified": {"uid": "x1", "email": "jean-francois@knebel.ch", "email_verified": False},
        "sa-missing": {"uid": "x1", "email": "jean-francois@knebel.ch"},
        "sa-str": {"uid": "x1", "email": "jean-francois@knebel.ch", "email_verified": "true"},
        "pre-verified": {"uid": "u-new", "email": "pre@asso.ch", "email_verified": True},
        "pre-unverified": {"uid": "u-new", "email": "pre@asso.ch", "email_verified": False},
        "pending-user": {"uid": "pend-uid", "email": "p@asso.ch", "email_verified": True},
    }

    monkeypatch.setattr(main, "db", fake_db)
    monkeypatch.setattr(main.firebase_admin, "_apps", {"default": object()})
    monkeypatch.setattr(main.firebase_auth, "verify_id_token", lambda tok: tokens[tok])
    main._ROLE_CACHE.clear()

    # Positive: verified emails work
    assert asyncio.run(main.verify_firebase_token("Bearer sa-verified"))["uid"] == "x1"
    assert asyncio.run(main.verify_firebase_token("Bearer pre-verified"))["uid"] == "u-new"

    # Negative & boundary: unverified / non-bool / pending MUST receive 403
    for tok in ["sa-unverified", "sa-missing", "sa-str", "pre-unverified", "pending-user"]:
        main._ROLE_CACHE.clear()
        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(main.verify_firebase_token(f"Bearer {tok}"))
        assert exc_info.value.status_code == 403, f"Expected 403 for {tok}"


def test_send_email_rejects_unverified_superadmin_and_pre_invited_email(monkeypatch):
    fake_db = FakeFirestore(
        orgs={"org1": {"adminEmail": "tresorier@org1.ch"}},
        members=[
            _FakeSnapshot("tresorier@org1.ch", {"email": "tresorier@org1.ch", "role": "caissier", "status": "approved"}),
        ],
    )
    tokens = {
        "super-verified": {"uid": "u-sa", "email": "Quokka@tdgl.ch", "email_verified": True},
        "super-unverified": {"uid": "u-sa", "email": "Quokka@tdgl.ch", "email_verified": False},
        "super-int": {"uid": "u-sa", "email": "Quokka@tdgl.ch", "email_verified": 1},
        "pre-verified": {"uid": "u-tr", "email": "tresorier@org1.ch", "email_verified": True},
        "pre-unverified": {"uid": "u-tr", "email": "tresorier@org1.ch", "email_verified": False},
        "pre-str": {"uid": "u-tr", "email": "tresorier@org1.ch", "email_verified": "true"},
    }
    sent = []

    monkeypatch.setenv("SMTP_USER", "smtp@asso.ch")
    monkeypatch.setenv("SMTP_PASS", "smtp-secret-password-999")
    monkeypatch.setattr(main, "db", fake_db)
    monkeypatch.setattr(main, "_send_smtp_email_sync", lambda *a: sent.append(a))
    monkeypatch.setattr(main.firebase_admin, "_apps", {"default": object()})
    monkeypatch.setattr(main.firebase_auth, "verify_id_token", lambda tok: tokens[tok])
    main._EMAIL_RATE_LIMITER.reset()

    client = TestClient(main.app)
    payload = {"to": ["membre@asso.ch"], "subject": "Test", "text": "Contenu"}

    assert client.post("/api/send-email", json=payload, headers={"Authorization": "Bearer super-verified"}).status_code == 200
    assert client.post("/api/send-email", json=payload, headers={"Authorization": "Bearer pre-verified"}).status_code == 200
    assert len(sent) == 2

    for bad_tok in ["super-unverified", "super-int", "pre-unverified", "pre-str"]:
        r = client.post("/api/send-email", json=payload, headers={"Authorization": f"Bearer {bad_tok}"})
        assert r.status_code == 403, f"Expected 403 for {bad_tok}, got {r.status_code}"
    assert len(sent) == 2
