"""SEC-04 positive, negative, and boundary/extreme-value tests for /api/send-email."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List

import pytest
from fastapi.testclient import TestClient

_DEFAULT_BACKEND_DIR = str(Path(__file__).resolve().parents[1])
_BACKEND_DIR = os.environ.get("SEC04_BACKEND_DIR") or _DEFAULT_BACKEND_DIR
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import email_security  # noqa: E402
import main  # noqa: E402


class _FakeSnapshot:
    def __init__(self, doc_id: str, data: Optional[Dict[str, Any]]):
        self.id = doc_id
        self._data = data
        self.exists = data is not None

    def to_dict(self) -> Dict[str, Any]:
        return dict(self._data or {})


class _FakeDocumentRef:
    def __init__(self, doc_id: str, store: Dict[str, Dict[str, Any]]):
        self.id = doc_id
        self._store = store

    def get(self) -> _FakeSnapshot:
        return _FakeSnapshot(self.id, self._store.get(self.id))


class _FakeCollectionRef:
    def __init__(self, store: Dict[str, Dict[str, Any]], log_sink: Optional[List[Dict[str, Any]]] = None):
        self._store = store
        self._log_sink = log_sink

    def document(self, doc_id: str) -> _FakeDocumentRef:
        return _FakeDocumentRef(doc_id, self._store)

    def stream(self) -> List[_FakeSnapshot]:
        return [_FakeSnapshot(k, v) for k, v in self._store.items()]

    def add(self, payload: Dict[str, Any]) -> None:
        if self._log_sink is not None:
            self._log_sink.append(payload)


class _FakeGroupRef:
    def __init__(self, docs: List[_FakeSnapshot]):
        self._docs = docs

    def stream(self) -> List[_FakeSnapshot]:
        return list(self._docs)


class FakeFirestore:
    def __init__(
        self,
        users: Optional[Dict[str, Dict[str, Any]]] = None,
        orgs: Optional[Dict[str, Dict[str, Any]]] = None,
        members: Optional[List[_FakeSnapshot]] = None,
    ):
        self.users = users or {}
        self.orgs = orgs or {}
        self.members = members or []
        self.mail_logs: List[Dict[str, Any]] = []

    def collection(self, name: str) -> _FakeCollectionRef:
        if name == "users":
            return _FakeCollectionRef(self.users)
        if name == "organizations":
            return _FakeCollectionRef(self.orgs)
        if name == "mail":
            return _FakeCollectionRef({}, log_sink=self.mail_logs)
        return _FakeCollectionRef({})

    def collection_group(self, name: str) -> _FakeGroupRef:
        if name == "members":
            return _FakeGroupRef(self.members)
        return _FakeGroupRef([])


from typing import Optional  # noqa: E402


def _make_seeded_db() -> FakeFirestore:
    return FakeFirestore(
        users={
            "sa-flag": {"isSuperAdmin": True},
        },
        orgs={
            "org1": {"createdBy": "org-creator", "adminUid": "org-admin", "adminEmail": "admin@org1.ch"},
        },
        members=[
            _FakeSnapshot("cais1", {"uid": "cais1", "role": "member", "status": "approved", "comptaAccess": {"c1": "caissier"}}),
            _FakeSnapshot("loc1", {"uid": "loc1", "role": "member", "status": "approved", "comptaAccess": {"c1": "responsable_location"}}),
            _FakeSnapshot("verif1", {"uid": "verif1", "role": "member", "status": "approved", "comptaAccess": {"c1": "verificateur"}}),
            _FakeSnapshot("viewer1", {"uid": "viewer1", "role": "member", "status": "approved", "comptaAccess": {"c1": "viewer"}}),
            _FakeSnapshot("upl1", {"uid": "upl1", "role": "member", "status": "approved", "comptaAccess": {"c1": "uploader"}}),
            _FakeSnapshot("pending-cais", {"uid": "pending-cais", "role": "admin", "status": "pending", "comptaAccess": {"c1": "caissier"}}),
            _FakeSnapshot("rejected-cais", {"uid": "rejected-cais", "role": "caissier", "status": "rejected"}),
        ],
    )


@pytest.fixture
def patched_app(monkeypatch):
    fake_db = _make_seeded_db()
    sent_calls: List[tuple] = []

    def fake_smtp(*args):
        sent_calls.append(args)

    tokens = {
        "tok-cais": {"uid": "cais1", "email": "cais1@asso.ch"},
        "tok-loc": {"uid": "loc1", "email": "loc1@asso.ch"},
        "tok-verif": {"uid": "verif1", "email": "verif1@asso.ch"},
        "tok-viewer": {"uid": "viewer1", "email": "viewer1@asso.ch"},
        "tok-upl": {"uid": "upl1", "email": "upl1@asso.ch"},
        "tok-pending": {"uid": "pending-cais", "email": "pend@asso.ch"},
        "tok-rejected": {"uid": "rejected-cais", "email": "rej@asso.ch"},
        "tok-stranger": {"uid": "stranger", "email": "stranger@asso.ch"},
        "tok-super-claim": {"uid": "sa-claim", "email": "sa@asso.ch", "superAdmin": True},
        "tok-super-email": {"uid": "any-uid", "email": "Quokka@tdgl.ch", "email_verified": True},
        "tok-no-uid": {"email": "cais1@asso.ch"},
    }

    def fake_verify_token(tok: str):
        if tok not in tokens:
            raise ValueError("bad token")
        return tokens[tok]

    monkeypatch.setenv("SMTP_USER", "smtp@asso.ch")
    monkeypatch.setenv("SMTP_PASS", "smtp-secret-password-999")
    monkeypatch.setenv("MAILER_INTERNAL_SECRET", "internal-mailer-secret-0123456789")
    monkeypatch.setenv("SMTP_FROM_NAME", "AssoCompta (Ne pas répondre)")

    monkeypatch.setattr(main, "db", fake_db)
    monkeypatch.setattr(main, "_send_smtp_email_sync", fake_smtp)
    monkeypatch.setattr(main.firebase_admin, "_apps", {"default": object()})
    monkeypatch.setattr(main.firebase_auth, "verify_id_token", fake_verify_token)
    main._EMAIL_RATE_LIMITER.reset()

    return TestClient(main.app), fake_db, sent_calls


# === 1. Unit Tests: verify_mailer_secret ===

def test_verify_mailer_secret_positive_and_negative_and_boundaries():
    secret16 = "a" * 16
    secret15 = "a" * 15
    assert email_security.verify_mailer_secret(secret16, secret16) is True
    assert email_security.verify_mailer_secret("  " + secret16 + "  ", secret16) is False
    assert email_security.verify_mailer_secret(secret15, secret15) is False
    assert email_security.verify_mailer_secret("", secret16) is False
    assert email_security.verify_mailer_secret(None, secret16) is False
    assert email_security.verify_mailer_secret(secret16 + "\r\n", secret16) is False
    assert email_security.verify_mailer_secret("wrong-secret-0000", secret16) is False


# === 2. Unit Tests: validate_and_sanitize_email_payload ===

def test_payload_validation_positive_and_dedup():
    clean = email_security.validate_and_sanitize_email_payload(
        to=[" Alice@Example.com ", "alice@example.com", "bob@test.ch"],
        subject="  Rappel location  ",
        text="Contenu",
        html="<p>Contenu</p>",
        from_name=" Caissier Asso ",
        reply_to=" reply@asso.ch ",
    )
    assert clean["to"] == ["alice@example.com", "bob@test.ch"]
    assert clean["subject"] == "Rappel location"
    assert clean["from_name"] == "Caissier Asso"
    assert clean["reply_to"] == "reply@asso.ch"


def test_payload_validation_negative_and_injection_and_boundaries():
    # Header injection (CRLF & NUL) across every header-bearing field, incl. trailing CRLF before .strip()
    with pytest.raises(ValueError):
        email_security.validate_and_sanitize_email_payload(["a@x.ch\r\nBcc: evil@x.ch"], "Ok", text="Body")
    with pytest.raises(ValueError):
        email_security.validate_and_sanitize_email_payload(["a@x.ch\r\n"], "Ok", text="Body")
    with pytest.raises(ValueError):
        email_security.validate_and_sanitize_email_payload(["a@x.ch"], "Sujet\nBcc: evil@x.ch", text="Body")
    with pytest.raises(ValueError):
        email_security.validate_and_sanitize_email_payload(["a@x.ch"], "Sujet\r", text="Body")
    with pytest.raises(ValueError):
        email_security.validate_and_sanitize_email_payload(["a@x.ch"], "Sujet\x00", text="Body")
    with pytest.raises(ValueError):
        email_security.validate_and_sanitize_email_payload(["a@x.ch"], "Sujet", text="Body", from_name="Fake <spoof@x.ch>")
    with pytest.raises(ValueError):
        email_security.validate_and_sanitize_email_payload(["a@x.ch"], "Sujet", text="Body", from_name="Ok\nFrom: evil@x.ch")
    with pytest.raises(ValueError):
        email_security.validate_and_sanitize_email_payload(["a@x.ch"], "Sujet", text="Body", from_name="Ok\x00")
    assert email_security.validate_and_sanitize_email_payload(["a@b.c"], "Ok", text="Body")["to"] == ["a@b.c"]
    with pytest.raises(ValueError):
        email_security.validate_and_sanitize_email_payload(["a@x.ch"], "Sujet", text="Body", reply_to="x@y.ch\nBcc: e@e.ch")
    with pytest.raises(ValueError):
        email_security.validate_and_sanitize_email_payload(["a@x.ch"], "Sujet", text="Body", reply_to="not-an-email")

    # Invalid emails & empty bodies
    for bad_addr in ["", "plain", "user@localhost", "a b@x.ch", "user@.ch", "a" * 250 + "@x.ch"]:
        with pytest.raises(ValueError):
            email_security.validate_and_sanitize_email_payload([bad_addr], "Sujet", text="Body")

    with pytest.raises(ValueError):
        email_security.validate_and_sanitize_email_payload([], "Sujet", text="Body")
    with pytest.raises(ValueError):
        email_security.validate_and_sanitize_email_payload(["a@x.ch"], "   ", text="Body")
    with pytest.raises(ValueError):
        email_security.validate_and_sanitize_email_payload(["a@x.ch"], "Sujet", text="   ", html="")
    with pytest.raises(ValueError):
        email_security.validate_and_sanitize_email_payload(["a@x.ch"], "Sujet", text="bad\x00body")
    with pytest.raises(ValueError):
        email_security.validate_and_sanitize_email_payload(["a@x.ch"], "Sujet", text="ok", html="<p>\x00</p>")

    # Extreme boundary checks: 20 recipients ok, 21 rejected; subject 250 ok, 251 rejected; from_name 100/101; text 50k/50k+1
    max_to = [f"u{i}@x.ch" for i in range(20)]
    assert len(email_security.validate_and_sanitize_email_payload(max_to, "a" * 250, text="x" * 50_000, html="h" * 100_000, from_name="f" * 100)["to"]) == 20
    with pytest.raises(ValueError):
        email_security.validate_and_sanitize_email_payload([f"u{i}@x.ch" for i in range(21)], "Ok", text="Body")
    with pytest.raises(ValueError):
        email_security.validate_and_sanitize_email_payload(["a@x.ch"], "a" * 251, text="Body")
    with pytest.raises(ValueError):
        email_security.validate_and_sanitize_email_payload(["a@x.ch"], "Ok", text="Body", from_name="f" * 101)
    with pytest.raises(ValueError):
        email_security.validate_and_sanitize_email_payload(["a@x.ch"], "Ok", text="x" * 50_001)
    with pytest.raises(ValueError):
        email_security.validate_and_sanitize_email_payload(["a@x.ch"], "Ok", text="", html="h" * 100_001)


# === 3. Unit Tests: user_can_send_email & EmailRateLimiter ===

def test_user_can_send_email_roles_and_statuses():
    db = _make_seeded_db()
    sa = {"quokka@tdgl.ch"}
    assert email_security.user_can_send_email("u", "quokka@tdgl.ch", sa, db) is True
    assert email_security.user_can_send_email("sa-flag", "x@x.ch", sa, db) is True
    assert email_security.user_can_send_email("org-admin", "admin@org1.ch", sa, db) is True
    assert email_security.user_can_send_email("cais1", "c@x.ch", sa, db) is True
    assert email_security.user_can_send_email("loc1", "l@x.ch", sa, db) is True

    assert email_security.user_can_send_email("verif1", "v@x.ch", sa, db) is False
    assert email_security.user_can_send_email("viewer1", "w@x.ch", sa, db) is False
    assert email_security.user_can_send_email("upl1", "u@x.ch", sa, db) is False
    assert email_security.user_can_send_email("pending-cais", "p@x.ch", sa, db) is False
    assert email_security.user_can_send_email("rejected-cais", "r@x.ch", sa, db) is False
    assert email_security.user_can_send_email("stranger", "s@x.ch", sa, db) is False
    assert email_security.user_can_send_email("", "s@x.ch", sa, db) is False
    assert email_security.user_can_send_email("cais1", "s@x.ch", sa, None) is False


def test_rate_limiter_sliding_window():
    rl = email_security.EmailRateLimiter(max_requests=3, window_seconds=10.0)
    assert rl.allow("", now=1.0) is False
    assert rl.allow("u1", now=1.0) is True
    assert rl.allow("u1", now=2.0) is True
    assert rl.allow("u1", now=3.0) is True
    assert rl.allow("u1", now=4.0) is False
    assert rl.allow("u1", now=10.9) is False
    assert rl.allow("u2", now=4.0) is True
    # At now=11.0, cutoff=1.0 -> 1.0 expires (ts > 1.0 keeps [2.0, 3.0]), so 11.0 is allowed (bucket=[2.0, 3.0, 11.0])
    assert rl.allow("u1", now=11.0) is True
    # Bucket is full again at now=11.5 -> blocked
    assert rl.allow("u1", now=11.5) is False

# === 4. Integration Tests: FastAPI POST /api/send-email ===

def test_endpoint_positive_privileged_roles_and_internal_secret(patched_app):
    client, fake_db, sent_calls = patched_app
    payload = {"to": ["membre@asso.ch"], "subject": "Rappel", "text": "Bonjour", "html": "<p>Bonjour</p>"}

    # Caissier
    r1 = client.post("/api/send-email", json=payload, headers={"Authorization": "Bearer tok-cais"})
    assert r1.status_code == 200
    assert r1.json()["status"] == "sent"

    # Responsable location
    r2 = client.post("/api/send-email", json=payload, headers={"Authorization": "Bearer tok-loc"})
    assert r2.status_code == 200

    # SuperAdmin claim & SuperAdmin email
    assert client.post("/api/send-email", json=payload, headers={"Authorization": "Bearer tok-super-claim"}).status_code == 200
    assert client.post("/api/send-email", json=payload, headers={"Authorization": "Bearer tok-super-email"}).status_code == 200

    # Internal secret (cron)
    r5 = client.post("/api/send-email", json=payload, headers={"X-Mailer-Secret": "internal-mailer-secret-0123456789"})
    assert r5.status_code == 200
    assert len(sent_calls) == 5
    assert len(fake_db.mail_logs) == 5
    assert fake_db.mail_logs[0]["actorUid"] == "cais1"
    assert fake_db.mail_logs[4]["actorUid"] is None


def test_endpoint_negative_auth_rbac_and_smtp_pass_rejected(patched_app, monkeypatch):
    client, _, sent_calls = patched_app
    payload = {"to": ["membre@asso.ch"], "subject": "Test", "text": "Body"}

    # No auth
    assert client.post("/api/send-email", json=payload).status_code == 401
    # Empty bearer / bad token / missing uid
    assert client.post("/api/send-email", json=payload, headers={"Authorization": "Bearer "}).status_code == 401
    assert client.post("/api/send-email", json=payload, headers={"Authorization": "Bearer bad-tok"}).status_code == 401
    assert client.post("/api/send-email", json=payload, headers={"Authorization": "Bearer tok-no-uid"}).status_code == 401

    # Critical SEC-04 check: SMTP_PASS must NEVER work as X-Mailer-Secret!
    assert client.post("/api/send-email", json=payload, headers={"X-Mailer-Secret": "smtp-secret-password-999"}).status_code == 401
    monkeypatch.setenv("MAILER_INTERNAL_SECRET", "")
    assert client.post("/api/send-email", json=payload, headers={"X-Mailer-Secret": ""}).status_code == 401
    monkeypatch.setenv("MAILER_INTERNAL_SECRET", "internal-mailer-secret-0123456789")

    # Authenticated but insufficient role (uploader, viewer, verificateur, pending, rejected, stranger) -> 403!
    for tok in ["tok-upl", "tok-viewer", "tok-verif", "tok-pending", "tok-rejected", "tok-stranger"]:
        resp = client.post("/api/send-email", json=payload, headers={"Authorization": f"Bearer {tok}"})
        assert resp.status_code == 403, f"Expected 403 for {tok}, got {resp.status_code}"

    # Header injection & invalid payload -> 400
    bad_resp = client.post(
        "/api/send-email",
        json={"to": ["a@x.ch"], "subject": "Hi\r\nBcc: spy@x.ch", "text": "Body"},
        headers={"Authorization": "Bearer tok-cais"},
    )
    assert bad_resp.status_code == 400
    assert len(sent_calls) == 0


def test_endpoint_rate_limit_and_smtp_error_logging(patched_app, monkeypatch):
    client, fake_db, _ = patched_app
    payload = {"to": ["membre@asso.ch"], "subject": "Burst", "text": "Ping"}

    # 15 allowed in window, 16th -> 429
    for _ in range(15):
        assert client.post("/api/send-email", json=payload, headers={"Authorization": "Bearer tok-cais"}).status_code == 200
    r_limited = client.post("/api/send-email", json=payload, headers={"Authorization": "Bearer tok-cais"})
    assert r_limited.status_code == 429

    # Different user (loc1) still has own bucket and gets 500 + ERROR log if SMTP fails
    def boom(*args):
        raise RuntimeError("SMTP refused")

    monkeypatch.setattr(main, "_send_smtp_email_sync", boom)
    r_err = client.post("/api/send-email", json=payload, headers={"Authorization": "Bearer tok-loc"})
    assert r_err.status_code == 500
    assert fake_db.mail_logs[-1]["delivery"]["state"] == "ERROR"
