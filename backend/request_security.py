"""SEC-08 request, upload, PDF, base64, and bounded role-cache security guards."""

from __future__ import annotations

import base64
import binascii
import time
from collections import OrderedDict
from typing import Any, Callable, FrozenSet, Optional, Tuple

MAX_STATEMENT_BYTES = 10 * 1024 * 1024  # 10 MiB
MAX_RECEIPT_BYTES = 5 * 1024 * 1024     # 5 MiB
MAX_RECEIPT_BASE64_CHARS = 7_000_000
MAX_PDF_PAGES = 50

ALLOWED_STATEMENT_MIMES: FrozenSet[str] = frozenset({"application/pdf"})
ALLOWED_RECEIPT_MIMES: FrozenSet[str] = frozenset({
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
})

AI_RATE_LIMIT_MAX_REQUESTS = 15
AI_RATE_LIMIT_WINDOW_SEC = 60.0


class PayloadTooLargeError(ValueError):
    """Raised when an upload or decoded payload exceeds configured safety bounds (HTTP 413)."""


class InvalidUploadMediaError(ValueError):
    """Raised when an upload is empty, malformed, or uses a disallowed MIME type (HTTP 400)."""


async def read_upload_bounded(
    upload_file: Any,
    max_bytes: int,
    chunk_size: int = 65536,
) -> bytes:
    """Stream-read an uploaded file in chunks and fail fast above max_bytes."""
    if max_bytes <= 0:
        raise ValueError("max_bytes must be positive.")
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive.")

    buf = bytearray()
    while True:
        chunk = await upload_file.read(chunk_size)
        if not chunk:
            break
        if len(buf) + len(chunk) > max_bytes:
            raise PayloadTooLargeError(
                f"Uploaded payload exceeds maximum allowed size of {max_bytes} bytes."
            )
        buf.extend(chunk)

    if len(buf) == 0:
        raise InvalidUploadMediaError("Uploaded file is empty.")
    return bytes(buf)


def validate_upload_mime(
    content_type: Optional[str],
    allowed_mimes: FrozenSet[str],
    raw_bytes: Optional[bytes] = None,
) -> str:
    """Normalize and enforce an allowlisted MIME type (and %PDF- signature for PDFs)."""
    norm = (content_type or "").split(";", 1)[0].strip().lower()
    if norm not in allowed_mimes:
        raise InvalidUploadMediaError(f"Unsupported or disallowed content type: {norm or 'missing'}.")
    if norm == "application/pdf" and raw_bytes is not None:
        if not raw_bytes.lstrip().startswith(b"%PDF-"):
            raise InvalidUploadMediaError("Invalid PDF payload: missing %PDF- header.")
    return norm


def validate_pdf_page_count(
    raw_pdf: bytes,
    max_pages: int = MAX_PDF_PAGES,
    open_pdf_fn: Optional[Callable[..., Any]] = None,
) -> int:
    """Validate that raw_pdf opens cleanly and has 1..max_pages pages."""
    if max_pages <= 0:
        raise ValueError("max_pages must be positive.")
    if open_pdf_fn is None:
        import fitz  # Lazy import so unit checks work without PyMuPDF when mocked
        open_pdf_fn = fitz.open

    try:
        pdf_doc = open_pdf_fn(stream=raw_pdf, filetype="pdf")
    except Exception as err:
        raise InvalidUploadMediaError("Could not read PDF file.") from err

    try:
        page_count = getattr(pdf_doc, "page_count", None)
        if page_count is None:
            page_count = len(pdf_doc)
        if not isinstance(page_count, int) or isinstance(page_count, bool) or page_count <= 0:
            raise InvalidUploadMediaError("PDF document contains no readable pages.")
        if page_count > max_pages:
            raise PayloadTooLargeError(
                f"PDF page count ({page_count}) exceeds maximum of {max_pages} pages."
            )
        return page_count
    finally:
        close_fn = getattr(pdf_doc, "close", None)
        if callable(close_fn):
            close_fn()


def validate_base64_receipt_payload(
    base64_data: Any,
    mime_type: Any,
    max_chars: int = MAX_RECEIPT_BASE64_CHARS,
    max_decoded_bytes: int = MAX_RECEIPT_BYTES,
) -> bytes:
    """Validate MIME type, bounded base64 character length, decode strictly, and check decoded size."""
    norm_mime = validate_upload_mime(
        mime_type if isinstance(mime_type, str) else None,
        ALLOWED_RECEIPT_MIMES,
    )
    if not isinstance(base64_data, str):
        raise InvalidUploadMediaError("base64Data must be a non-empty string.")

    clean = "".join(base64_data.split())
    if not clean:
        raise InvalidUploadMediaError("base64Data must not be empty.")
    if len(clean) > max_chars:
        raise PayloadTooLargeError(
            f"Encoded base64 payload ({len(clean)} chars) exceeds limit of {max_chars}."
        )

    try:
        decoded = base64.b64decode(clean, validate=True)
    except (binascii.Error, ValueError) as err:
        raise InvalidUploadMediaError("Invalid base64 encoding in receipt payload.") from err

    if len(decoded) == 0:
        raise InvalidUploadMediaError("Decoded receipt payload is empty.")
    if len(decoded) > max_decoded_bytes:
        raise PayloadTooLargeError(
            f"Decoded receipt size ({len(decoded)} bytes) exceeds limit of {max_decoded_bytes} bytes."
        )

    validate_upload_mime(norm_mime, ALLOWED_RECEIPT_MIMES, decoded)
    return decoded


class BoundedRoleCache:
    """LRU + TTL cache storing positive (60s) and negative (15s) Firebase role resolutions."""

    def __init__(
        self,
        positive_ttl_sec: float = 60.0,
        negative_ttl_sec: float = 15.0,
        max_entries: int = 1000,
    ) -> None:
        if max_entries <= 0:
            raise ValueError("max_entries must be positive.")
        self.positive_ttl_sec = positive_ttl_sec
        self.negative_ttl_sec = negative_ttl_sec
        self.max_entries = max_entries
        self._entries: "OrderedDict[Tuple[Any, ...], Tuple[bool, float]]" = OrderedDict()

    def get_valid(self, key: Tuple[Any, ...], now: Optional[float] = None) -> Optional[bool]:
        current = time.monotonic() if now is None else float(now)
        entry = self._entries.get(key)
        if entry is None:
            return None
        has_role, expires_at = entry
        if expires_at <= current:
            self._entries.pop(key, None)
            return None
        self._entries.move_to_end(key)
        return has_role

    def store(self, key: Tuple[Any, ...], has_role: bool, now: Optional[float] = None) -> None:
        current = time.monotonic() if now is None else float(now)
        ttl = self.positive_ttl_sec if has_role else self.negative_ttl_sec
        self._entries[key] = (bool(has_role), current + ttl)
        self._entries.move_to_end(key)
        while len(self._entries) > self.max_entries:
            self._entries.popitem(last=False)

    def clear(self) -> None:
        self._entries.clear()

    def __len__(self) -> int:
        return len(self._entries)
