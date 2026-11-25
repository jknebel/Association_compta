"""SEC-08 positive, negative, and boundary/extreme-value tests for AI endpoints & uploads."""

from __future__ import annotations

import asyncio
import base64
import json
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

import main  # noqa: E402
import request_security  # noqa: E402
from test_sec04_email import FakeFirestore  # noqa: E402


class _FakeUpload:
    def __init__(self, chunks: List[bytes]):
        self._chunks = list(chunks)
        self.read_calls = 0

    async def read(self, size: int = -1) -> bytes:
        self.read_calls += 1
        if not self._chunks:
            return b""
        return self._chunks.pop(0)


class _FakePdfDoc:
    def __init__(self, page_count: int):
        self.page_count = page_count
        self.closed = False

    def load_page(self, _idx: int) -> Any:
        return SimpleNamespace(get_pixmap=lambda matrix=None: SimpleNamespace(tobytes=lambda _fmt: b"\xff\xd8\xffjpeg"))

    def close(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def _reset_sec08_state():
    main._AI_RATE_LIMITER.reset()
    main._ROLE_CACHE.clear()
    yield
    main._AI_RATE_LIMITER.reset()
    main._ROLE_CACHE.clear()


def _install_auth(monkeypatch, uid: str = "caller-uid", email: str = "jean-francois@knebel.ch"):
    fake_db = FakeFirestore()
    monkeypatch.setattr(main, "db", fake_db)
    monkeypatch.setattr(main.firebase_admin, "_apps", {"default": object()})
    monkeypatch.setattr(
        main.firebase_auth,
        "verify_id_token",
        lambda _tok: {"uid": uid, "email": email, "email_verified": True},
    )
    return {"Authorization": "Bearer valid-token"}


# --- Unit & Boundary Tests for request_security helpers ---

def test_bounded_upload_exact_limit_and_early_stop():
    # Exact boundary: max_bytes allowed
    exact_upload = _FakeUpload([b"a" * 4096, b"b" * 4096])
    data = asyncio.run(request_security.read_upload_bounded(exact_upload, max_bytes=8192, chunk_size=4096))
    assert len(data) == 8192

    # 1 byte over stops before reading remaining chunks
    oversize_upload = _FakeUpload([b"a" * 4096, b"b" * 4097, b"never-read"])
    with pytest.raises(request_security.PayloadTooLargeError):
        asyncio.run(request_security.read_upload_bounded(oversize_upload, max_bytes=8192, chunk_size=4096))
    assert oversize_upload.read_calls == 2
    assert len(oversize_upload._chunks) == 1

    # 0 bytes rejected
    with pytest.raises(request_security.InvalidUploadMediaError):
        asyncio.run(request_security.read_upload_bounded(_FakeUpload([]), max_bytes=8192))


def test_validate_upload_mime_and_pdf_magic():
    assert request_security.validate_upload_mime("application/pdf; charset=utf-8", request_security.ALLOWED_STATEMENT_MIMES, b"%PDF-1.7\n...") == "application/pdf"
    assert request_security.validate_upload_mime("IMAGE/PNG", request_security.ALLOWED_RECEIPT_MIMES, b"\x89PNG") == "image/png"

    with pytest.raises(request_security.InvalidUploadMediaError):
        request_security.validate_upload_mime("image/svg+xml", request_security.ALLOWED_RECEIPT_MIMES, b"<svg></svg>")

    with pytest.raises(request_security.InvalidUploadMediaError):
        request_security.validate_upload_mime("application/pdf", request_security.ALLOWED_STATEMENT_MIMES, b"NOT-A-PDF")


def test_validate_pdf_page_count_boundaries():
    docs = []

    def fake_open(stream: bytes, filetype: str):
        count = int.from_bytes(stream[-4:], "big")
        doc = _FakePdfDoc(count)
        docs.append(doc)
        return doc

    assert request_security.validate_pdf_page_count(b"%PDF-" + (1).to_bytes(4, "big"), open_pdf_fn=fake_open) == 1
    assert request_security.validate_pdf_page_count(b"%PDF-" + (50).to_bytes(4, "big"), open_pdf_fn=fake_open) == 50
    assert all(d.closed for d in docs)

    with pytest.raises(request_security.PayloadTooLargeError):
        request_security.validate_pdf_page_count(b"%PDF-" + (51).to_bytes(4, "big"), open_pdf_fn=fake_open)
    assert docs[-1].closed

    with pytest.raises(request_security.InvalidUploadMediaError):
        request_security.validate_pdf_page_count(b"%PDF-" + (0).to_bytes(4, "big"), open_pdf_fn=fake_open)

    def broken_open(**_kw):
        raise RuntimeError("corrupt")

    with pytest.raises(request_security.InvalidUploadMediaError):
        request_security.validate_pdf_page_count(b"%PDF-broken", open_pdf_fn=broken_open)


def test_validate_base64_receipt_payload_bounds():
    valid_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\npayload").decode("ascii")
    assert request_security.validate_base64_receipt_payload(valid_b64, "image/png").startswith(b"\x89PNG")

    # Pre-decode base64 char boundary (> MAX_RECEIPT_BASE64_CHARS -> PayloadTooLargeError before decoding)
    huge_b64 = "A" * (request_security.MAX_RECEIPT_BASE64_CHARS + 1)
    with pytest.raises(request_security.PayloadTooLargeError):
        request_security.validate_base64_receipt_payload(huge_b64, "image/jpeg")

    # Decoded bytes boundary: 5 MiB + 1 encodes to 6,990,512 chars (< 7_000_000) -> caught after decode!
    over_5mib_b64 = base64.b64encode(b"x" * (request_security.MAX_RECEIPT_BYTES + 1)).decode("ascii")
    assert len(over_5mib_b64) <= request_security.MAX_RECEIPT_BASE64_CHARS
    with pytest.raises(request_security.PayloadTooLargeError):
        request_security.validate_base64_receipt_payload(over_5mib_b64, "image/jpeg")

    # Exact 5 MiB decoded succeeds
    exact_5mib_b64 = base64.b64encode(b"x" * request_security.MAX_RECEIPT_BYTES).decode("ascii")
    assert len(request_security.validate_base64_receipt_payload(exact_5mib_b64, "image/png")) == request_security.MAX_RECEIPT_BYTES

    with pytest.raises(request_security.InvalidUploadMediaError):
        request_security.validate_base64_receipt_payload(valid_b64, "image/svg+xml")

    with pytest.raises(request_security.InvalidUploadMediaError):
        request_security.validate_base64_receipt_payload("!!!not-base64!!!", "image/jpeg")


def test_bounded_role_cache_ttl_lru_and_negative_entries():
    cache = request_security.BoundedRoleCache(positive_ttl_sec=60.0, negative_ttl_sec=15.0, max_entries=3)
    cache.store(("u1", "a@x.ch"), True, now=100.0)
    cache.store(("u2", "b@x.ch"), False, now=100.0)

    # Negative expires at 115s, positive stays valid at 116s and expires at 160s
    assert cache.get_valid(("u2", "b@x.ch"), now=114.9) is False
    assert cache.get_valid(("u2", "b@x.ch"), now=115.0) is None
    assert cache.get_valid(("u1", "a@x.ch"), now=159.9) is True
    assert cache.get_valid(("u1", "a@x.ch"), now=160.0) is None

    # LRU max_entries eviction
    cache.clear()
    cache.store(("k1", ""), True, now=200.0)
    cache.store(("k2", ""), True, now=200.0)
    cache.store(("k3", ""), True, now=200.0)
    # Touch k1 so k2 becomes least-recently used
    assert cache.get_valid(("k1", ""), now=201.0) is True
    cache.store(("k4", ""), False, now=202.0)
    assert len(cache) == 3
    assert cache.get_valid(("k2", ""), now=202.0) is None
    assert cache.get_valid(("k1", ""), now=202.0) is True
    assert cache.get_valid(("k3", ""), now=202.0) is True
    assert cache.get_valid(("k4", ""), now=202.0) is False


def test_user_has_any_role_caches_negative_but_skips_failed_lookup(monkeypatch):
    calls = {"n": 0}

    class _CountingDb:
        def collection(self, _name: str):
            calls["n"] += 1
            return SimpleNamespace(stream=lambda: [])

        def collection_group(self, _name: str):
            return SimpleNamespace(stream=lambda: [])

    monkeypatch.setattr(main, "db", _CountingDb())
    assert main._user_has_any_role("u-norole", "none@asso.ch") is False
    assert main._user_has_any_role("u-norole", "none@asso.ch") is False
    # Negative lookup MUST be cached (second call does not hit Firestore)
    assert calls["n"] == 1

    # Transient Firestore failure must NOT populate negative cache
    main._ROLE_CACHE.clear()
    calls["n"] = 0

    class _FailingDb:
        def collection(self, _name: str):
            calls["n"] += 1
            raise RuntimeError("transient firestore error")

    monkeypatch.setattr(main, "db", _FailingDb())
    assert main._user_has_any_role("u-err", "err@asso.ch") is False
    assert main._user_has_any_role("u-err", "err@asso.ch") is False
    assert calls["n"] == 2


# --- Endpoint Integration Tests (Positive, Negative, Boundary) ---

def test_process_bank_statement_idor_fix_size_and_pdf_limits(monkeypatch):
    headers = _install_auth(monkeypatch, uid="real-uid-123")
    captured_user_ids: List[str] = []

    async def fake_ainvoke(state):
        captured_user_ids.append(state.user_id)
        return {"extracted_transactions": [], "detected_dates": [], "raw_text": "", "logs": []}

    monkeypatch.setattr(main.compiled_app, "ainvoke", fake_ainvoke)
    monkeypatch.setattr(main.fitz, "open", lambda stream, filetype="pdf": _FakePdfDoc(2))

    client = TestClient(main.app)

    # Positive + IDOR mitigation: spoofed userId form field is ignored in favor of token uid
    resp = client.post(
        "/process-bank-statement",
        headers=headers,
        files={"file": ("stmt.pdf", b"%PDF-1.7\nstatement", "application/pdf")},
        data={"accounts": "[]", "userId": "attacker-spoofed-uid"},
    )
    assert resp.status_code == 200
    assert captured_user_ids == ["real-uid-123"]

    # Spoofed non-PDF or bad magic returns 400 (never masked as 500)
    bad_mime = client.post(
        "/process-bank-statement",
        headers=headers,
        files={"file": ("x.svg", b"<svg/>", "image/svg+xml")},
        data={"accounts": "[]", "userId": "ignored"},
    )
    assert bad_mime.status_code == 400

    # > 50 pages returns 413
    monkeypatch.setattr(main.fitz, "open", lambda stream, filetype="pdf": _FakePdfDoc(51))
    too_many_pages = client.post(
        "/process-bank-statement",
        headers=headers,
        files={"file": ("huge.pdf", b"%PDF-1.7\npages", "application/pdf")},
        data={"accounts": "[]"},
    )
    assert too_many_pages.status_code == 413

    # Exact 10 MiB succeeds; 10 MiB + 1 returns 413
    monkeypatch.setattr(main.fitz, "open", lambda stream, filetype="pdf": _FakePdfDoc(1))
    ok_10m = b"%PDF-" + (b"a" * (request_security.MAX_STATEMENT_BYTES - 5))
    assert client.post(
        "/process-bank-statement",
        headers=headers,
        files={"file": ("max.pdf", ok_10m, "application/pdf")},
        data={"accounts": "[]"},
    ).status_code == 200

    over_10m = ok_10m + b"x"
    assert client.post(
        "/process-bank-statement",
        headers=headers,
        files={"file": ("over.pdf", over_10m, "application/pdf")},
        data={"accounts": "[]"},
    ).status_code == 413


def test_process_receipt_and_analyze_receipt_bounds_and_mime(monkeypatch):
    headers = _install_auth(monkeypatch, uid="receipt-uid")
    monkeypatch.setattr(
        main,
        "get_llm",
        lambda: SimpleNamespace(
            with_structured_output=lambda _schema: SimpleNamespace(
                invoke=lambda _msg: main.ReceiptExtraction(amount=10.0, content="Migros", date="2026-01-01")
            )
        ),
    )

    client = TestClient(main.app)

    # /process-receipt accepts image/png up to 5 MiB, rejects 5 MiB + 1 with 413 and SVG with 400
    assert client.post(
        "/process-receipt",
        headers=headers,
        files={"file": ("r.png", b"\x89PNG\r\n\x1a\nok", "image/png")},
        data={"transactions": "[]"},
    ).status_code == 200

    assert client.post(
        "/process-receipt",
        headers=headers,
        files={"file": ("bad.svg", b"<svg/>", "image/svg+xml")},
        data={"transactions": "[]"},
    ).status_code == 400

    assert client.post(
        "/process-receipt",
        headers=headers,
        files={"file": ("big.png", b"a" * (request_security.MAX_RECEIPT_BYTES + 1), "image/png")},
        data={"transactions": "[]"},
    ).status_code == 413

    # PDF > 50 pages on /process-receipt returns 413
    monkeypatch.setattr(main.fitz, "open", lambda stream, filetype="pdf": _FakePdfDoc(51))
    assert client.post(
        "/process-receipt",
        headers=headers,
        files={"file": ("many.pdf", b"%PDF-1.7\nbody", "application/pdf")},
        data={"transactions": "[]"},
    ).status_code == 413

    # /analyze-receipt enforces MIME, base64 char/byte bounds -> 413 / 400, valid -> 200
    monkeypatch.setattr(
        main,
        "get_llm",
        lambda: SimpleNamespace(
            with_structured_output=lambda _schema: SimpleNamespace(
                invoke=lambda _msg: main.AnalyzeReceiptResponse(date="2026-01-01", amount=12.5, merchantName="Coop")
            )
        ),
    )
    ok_img = base64.b64encode(b"\xff\xd8\xff\xe0jpeg").decode("ascii")
    assert client.post(
        "/analyze-receipt",
        headers=headers,
        json={"base64Data": ok_img, "mimeType": "image/jpeg"},
    ).status_code == 200

    assert client.post(
        "/analyze-receipt",
        headers=headers,
        json={"base64Data": ok_img, "mimeType": "image/svg+xml"},
    ).status_code == 400

    over_b64 = "A" * (request_security.MAX_RECEIPT_BASE64_CHARS + 1)
    assert client.post(
        "/analyze-receipt",
        headers=headers,
        json={"base64Data": over_b64, "mimeType": "image/jpeg"},
    ).status_code == 413


@pytest.mark.parametrize(
    "endpoint,request_kwargs",
    [
        (
            "/process-bank-statement",
            lambda: {
                "files": {"file": ("s.pdf", b"%PDF-1.7\nok", "application/pdf")},
                "data": {"accounts": "[]"},
            },
        ),
        (
            "/process-receipt",
            lambda: {
                "files": {"file": ("r.png", b"\x89PNG\r\n\x1a\n", "image/png")},
                "data": {"transactions": "[]"},
            },
        ),
        (
            "/analyze-receipt",
            lambda: {"json": {"base64Data": base64.b64encode(b"img").decode("ascii"), "mimeType": "image/png"}},
        ),
        (
            "/chat",
            lambda: {"json": {"history": [], "context": {"transactions": [], "accounts": []}, "newMessage": "Hi"}},
        ),
        (
            "/suggest-category",
            lambda: {"json": {"description": "Coop", "accounts": []}},
        ),
        (
            "/audit",
            lambda: {"json": {"transactions": [], "accounts": []}},
        ),
    ],
)
def test_all_six_ai_endpoints_enforce_15_per_min_rate_limit(monkeypatch, endpoint, request_kwargs):
    main._AI_RATE_LIMITER.reset()
    headers = _install_auth(monkeypatch, uid=f"rate-uid-{endpoint}")

    async def fake_ainvoke(_state):
        return {"extracted_transactions": [], "detected_dates": [], "raw_text": "", "logs": []}

    monkeypatch.setattr(main.compiled_app, "ainvoke", fake_ainvoke)
    monkeypatch.setattr(main.fitz, "open", lambda stream, filetype="pdf": _FakePdfDoc(1))

    fake_structured = SimpleNamespace(
        invoke=lambda _arg: main.ReceiptExtraction(amount=1.0, content="x", date="2026-01-01")
    )
    if endpoint == "/analyze-receipt":
        fake_structured = SimpleNamespace(
            invoke=lambda _arg: main.AnalyzeReceiptResponse(date="2026-01-01", amount=1.0, merchantName="x")
        )
    elif endpoint == "/suggest-category":
        fake_structured = SimpleNamespace(
            invoke=lambda _arg: main.SuggestCategoryResponse(accountId=None, memberName=None)
        )

    monkeypatch.setattr(
        main,
        "get_llm",
        lambda: SimpleNamespace(
            with_structured_output=lambda _s: fake_structured,
            invoke=lambda _arg: SimpleNamespace(content="OK"),
        ),
    )
    monkeypatch.setattr(
        main,
        "get_pro_llm",
        lambda: SimpleNamespace(invoke=lambda _arg: SimpleNamespace(content="Audit OK")),
    )
    monkeypatch.setattr(
        main,
        "create_llm",
        lambda **_kw: SimpleNamespace(invoke=lambda _arg: SimpleNamespace(content="Chat OK")),
    )

    client = TestClient(main.app)
    for idx in range(request_security.AI_RATE_LIMIT_MAX_REQUESTS):
        res = client.post(endpoint, headers=headers, **request_kwargs())
        assert res.status_code == 200, f"{endpoint} request #{idx + 1} failed: {res.text}"

    blocked = client.post(endpoint, headers=headers, **request_kwargs())
    assert blocked.status_code == 429
