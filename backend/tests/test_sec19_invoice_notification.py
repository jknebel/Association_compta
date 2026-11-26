"""Positive, negative, and boundary tests for immediate INVOICE_PAYMENT email notifications."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest
from fastapi.testclient import TestClient

_DEFAULT_BACKEND_DIR = str(Path(__file__).resolve().parents[1])
_BACKEND_DIR = os.environ.get("SEC04_BACKEND_DIR") or _DEFAULT_BACKEND_DIR
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import email_security as es  # noqa: E402
import main  # noqa: E402


class _FakeSnap:
    def __init__(self, doc_id: str, data: Dict[str, Any] | None):
        self.id = doc_id
        self._data = data
        self.exists = data is not None

    def to_dict(self):
        return dict(self._data) if self._data is not None else None


class _FakeDocRef:
    def __init__(self, store: Dict[str, Dict[str, Any]], path: str):
        self._store = store
        self._path = path
        self.id = path.split("/")[-1]

    def get(self):
        return _FakeSnap(self.id, self._store.get(self._path))

    def update(self, patch: Dict[str, Any]):
        if self._path in self._store:
            self._store[self._path].update(patch)

    def collection(self, name: str):
        return _FakeColRef(self._store, f"{self._path}/{name}")


class _FakeColRef:
    def __init__(self, store: Dict[str, Dict[str, Any]], prefix: str):
        self._store = store
        self._prefix = prefix

    def document(self, doc_id: str):
        return _FakeDocRef(self._store, f"{self._prefix}/{doc_id}")

    def add(self, data: Dict[str, Any]):
        self._store[f"{self._prefix}/audit-{len(self._store)}"] = dict(data)

    def stream(self):
        prefix_slash = f"{self._prefix}/"
        for k, v in list(self._store.items()):
            if k.startswith(prefix_slash):
                rem = k[len(prefix_slash):]
                if "/" not in rem:
                    yield _FakeSnap(rem, v)


class _FakeInvoiceDb:
    def __init__(self, store: Dict[str, Dict[str, Any]]):
        self.store = store

    def collection(self, name: str):
        return _FakeColRef(self.store, name)

    def collection_group(self, name: str):
        # Match any document whose parent collection equals `name`
        results = []
        for k, v in list(self.store.items()):
            parts = k.split("/")
            if len(parts) >= 2 and parts[-2] == name:
                results.append(_FakeSnap(parts[-1], v))
        return type("_Group", (), {"stream": lambda _self: iter(results)})()


@pytest.fixture(autouse=True)
def _reset_state(monkeypatch):
    main._EMAIL_RATE_LIMITER.reset()
    main._ROLE_CACHE.clear()
    monkeypatch.setenv("SMTP_USER", "noreply@asso.ch")
    monkeypatch.setenv("SMTP_PASS", "super-secret-pass")
    yield
    main._EMAIL_RATE_LIMITER.reset()
    main._ROLE_CACHE.clear()


def test_safe_firestore_segment_and_email_builder_escape_html():
    assert es.is_safe_firestore_segment("TDGL") is True
    assert es.is_safe_firestore_segment("rcpt-1700000000000-ab12cd") is True
    assert es.is_safe_firestore_segment("../etc") is False
    assert es.is_safe_firestore_segment("..") is False
    assert es.is_safe_firestore_segment("a..b") is False
    assert es.is_safe_firestore_segment("a/b") is False
    assert es.is_safe_firestore_segment("") is False

    built = es.build_invoice_payment_email(
        compta_name="Compta <script>x</script>",
        receipt_data={
            "merchantName": "Fournisseur <b>SA</b>",
            "extractedAmount": 149.9,
            "extractedDate": "2026-03-10",
            "submittedByName": "Alice <img src=x>",
            "submittedByEmail": "alice@asso.ch",
        },
    )
    assert "CHF 149.90" in built["subject"]
    assert "<script>" not in built["html"]
    assert "&lt;script&gt;" in built["html"]
    assert "&lt;img src=x&gt;" in built["html"]


def test_notify_invoice_payment_positive_owner_uploader_and_idempotency(monkeypatch):
    store = {
        "organizations/TDGL": {"name": "TDGL", "adminEmail": "admin@tdgl.ch"},
        "organizations/TDGL/members/u-uploader": {
            "uid": "u-uploader",
            "email": "uploader@tdgl.ch",
            "status": "approved",
            "comptaAccess": {"c1": "uploader"},
        },
        "organizations/TDGL/members/u-caissier": {
            "uid": "u-caissier",
            "email": "caissier@tdgl.ch",
            "status": "approved",
            "comptaAccess": {"c1": "caissier"},
        },
        "organizations/TDGL/members/u-rejected": {
            "uid": "u-rejected",
            "email": "rejected@tdgl.ch",
            "status": "rejected",
            "comptaAccess": {"c1": "caissier"},
        },
        "organizations/TDGL/comptabilites/c1": {"name": "Compta Groupe"},
        "organizations/TDGL/comptabilites/c1/receipts/rcpt-1": {
            "id": "rcpt-1",
            "expenseType": "INVOICE_PAYMENT",
            "submittedByUid": "u-uploader",
            "submittedByName": "Membre Test",
            "submittedByEmail": "uploader@tdgl.ch",
            "merchantName": "Imprimerie SA",
            "extractedAmount": 250.0,
            "extractedDate": "2026-03-15",
        },
    }
    fake_db = _FakeInvoiceDb(store)
    sent_calls: List[Any] = []

    monkeypatch.setattr(main, "db", fake_db)
    monkeypatch.setattr(main.firebase_admin, "_apps", {"default": object()})
    monkeypatch.setattr(
        main.firebase_auth,
        "verify_id_token",
        lambda _tok: {"uid": "u-uploader", "email": "uploader@tdgl.ch", "email_verified": True},
    )
    monkeypatch.setattr(
        main,
        "_send_smtp_email_sync",
        lambda *args: sent_calls.append(args),
    )

    client = TestClient(main.app)
    resp = client.post(
        "/api/notify-invoice-payment",
        headers={"Authorization": "Bearer uploader-token"},
        json={"orgId": "TDGL", "comptaId": "c1", "receiptId": "rcpt-1"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "sent"
    assert resp.json()["recipientsCount"] == 2
    assert len(sent_calls) == 1
    assert set(sent_calls[0][3]) == {"admin@tdgl.ch", "caissier@tdgl.ch"}
    assert "invoiceNotificationSentAt" in store["organizations/TDGL/comptabilites/c1/receipts/rcpt-1"]

    # Second call is idempotent -> already_sent, no duplicate email
    resp2 = client.post(
        "/api/notify-invoice-payment",
        headers={"Authorization": "Bearer uploader-token"},
        json={"orgId": "TDGL", "comptaId": "c1", "receiptId": "rcpt-1"},
    )
    assert resp2.status_code == 200
    assert resp2.json()["status"] == "already_sent"
    assert len(sent_calls) == 1


def test_notify_invoice_payment_negative_auth_type_and_path_traversal(monkeypatch):
    store = {
        "organizations/TDGL": {"name": "TDGL"},
        "organizations/TDGL/members/u-other": {
            "uid": "u-other",
            "email": "other@tdgl.ch",
            "status": "approved",
            "comptaAccess": {"c1": "uploader"},
        },
        "organizations/TDGL/comptabilites/c1/receipts/rcpt-inv": {
            "id": "rcpt-inv",
            "expenseType": "INVOICE_PAYMENT",
            "submittedByUid": "u-owner",
        },
        "organizations/TDGL/comptabilites/c1/receipts/rcpt-card": {
            "id": "rcpt-card",
            "expenseType": "DEBIT_CARD",
            "submittedByUid": "u-other",
        },
    }
    fake_db = _FakeInvoiceDb(store)
    monkeypatch.setattr(main, "db", fake_db)
    monkeypatch.setattr(main.firebase_admin, "_apps", {"default": object()})
    monkeypatch.setattr(
        main.firebase_auth,
        "verify_id_token",
        lambda _tok: {"uid": "u-other", "email": "other@tdgl.ch", "email_verified": True},
    )

    client = TestClient(main.app)

    # Path traversal rejected with 400
    r_bad_path = client.post(
        "/api/notify-invoice-payment",
        headers={"Authorization": "Bearer tok"},
        json={"orgId": "../etc", "comptaId": "c1", "receiptId": "rcpt-inv"},
    )
    assert r_bad_path.status_code == 400

    # Wrong expenseType (DEBIT_CARD) rejected with 400
    r_wrong_type = client.post(
        "/api/notify-invoice-payment",
        headers={"Authorization": "Bearer tok"},
        json={"orgId": "TDGL", "comptaId": "c1", "receiptId": "rcpt-card"},
    )
    assert r_wrong_type.status_code == 400

    # Different non-privileged uploader cannot notify for someone else's invoice -> 403
    r_forbidden = client.post(
        "/api/notify-invoice-payment",
        headers={"Authorization": "Bearer tok"},
        json={"orgId": "TDGL", "comptaId": "c1", "receiptId": "rcpt-inv"},
    )
    assert r_forbidden.status_code == 403

    # Missing receipt -> 404
    r_missing = client.post(
        "/api/notify-invoice-payment",
        headers={"Authorization": "Bearer tok"},
        json={"orgId": "TDGL", "comptaId": "c1", "receiptId": "does-not-exist"},
    )
    assert r_missing.status_code == 404
