"""SEC-04 security helpers for the AssoCompta email dispatch endpoint."""

from __future__ import annotations

import hmac
import re
import threading
import time
from typing import AbstractSet, Any, Dict, Iterable, List, Optional

PRIVILEGED_EMAIL_ROLES = frozenset({
    "admin",
    "caissier",
    "comptable",
    "responsable_location",
    "location",
    "locations",
})

MAX_RECIPIENTS = 20
MAX_SUBJECT_LEN = 250
MAX_TEXT_LEN = 50_000
MAX_HTML_LEN = 100_000
MAX_FROM_NAME_LEN = 100
MIN_INTERNAL_SECRET_LEN = 16
DEFAULT_RATE_LIMIT = 15
DEFAULT_RATE_WINDOW_SEC = 60.0

_EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"
)


def verified_token_email(decoded_token: Any) -> str:
    """Return normalized email only when Firebase ID token asserts email_verified is strictly True."""
    if not isinstance(decoded_token, dict):
        return ""
    if decoded_token.get("email_verified") is not True:
        return ""
    raw_email = decoded_token.get("email")
    return raw_email.strip().lower() if isinstance(raw_email, str) else ""


def has_header_injection(value: str) -> bool:
    """Return True if value contains CR, LF, or NUL bytes."""
    return "\r" in value or "\n" in value or "\x00" in value


def is_valid_email_address(addr: str) -> bool:
    """Strict syntax and header-injection validation for a single e-mail address."""
    if not isinstance(addr, str):
        return False
    if has_header_injection(addr):
        return False
    if len(addr) > 254:
        return False
    return bool(_EMAIL_RE.match(addr))


def verify_mailer_secret(provided: Optional[str], configured_secret: Optional[str]) -> bool:
    """Constant-time check for X-Mailer-Secret against MAILER_INTERNAL_SECRET."""
    if not isinstance(provided, str) or not isinstance(configured_secret, str):
        return False
    secret = configured_secret.strip()
    if len(secret) < MIN_INTERNAL_SECRET_LEN or not provided:
        return False
    return hmac.compare_digest(provided.encode("utf-8"), secret.encode("utf-8"))


def validate_and_sanitize_email_payload(
    to: Iterable[Any],
    subject: Any,
    text: Optional[str] = "",
    html: Optional[str] = None,
    from_name: Optional[str] = None,
    reply_to: Optional[str] = None,
    default_from_name: str = "AssoCompta (Ne pas répondre)",
) -> Dict[str, Any]:
    """Validate and sanitize all email fields against injection and resource abuse."""
    if not isinstance(to, list) or len(to) == 0:
        raise ValueError("No valid recipient email addresses provided.")
    if len(to) > MAX_RECIPIENTS:
        raise ValueError(f"Too many recipients (max {MAX_RECIPIENTS}).")

    clean_recipients: List[str] = []
    seen = set()
    for raw_addr in to:
        if not isinstance(raw_addr, str) or has_header_injection(raw_addr):
            raise ValueError("Invalid recipient email address.")
        addr = raw_addr.strip().lower()
        if not is_valid_email_address(addr):
            raise ValueError(f"Invalid recipient email address: {addr}")
        if addr not in seen:
            seen.add(addr)
            clean_recipients.append(addr)

    if not isinstance(subject, str) or has_header_injection(subject):
        raise ValueError("Invalid email subject.")
    clean_subject = subject.strip()
    if not clean_subject:
        raise ValueError("Email subject cannot be empty.")
    if len(clean_subject) > MAX_SUBJECT_LEN:
        raise ValueError(f"Email subject too long (max {MAX_SUBJECT_LEN}).")

    default_from = (default_from_name or "AssoCompta (Ne pas répondre)").strip()
    if from_name is None or from_name == "":
        clean_from_name = default_from
    else:
        if not isinstance(from_name, str) or has_header_injection(from_name):
            raise ValueError("Invalid sender display name.")
        if "<" in from_name or ">" in from_name:
            raise ValueError("Sender display name cannot contain angle brackets.")
        clean_from_name = from_name.strip() or default_from
        if len(clean_from_name) > MAX_FROM_NAME_LEN:
            raise ValueError(f"Sender display name too long (max {MAX_FROM_NAME_LEN}).")

    clean_reply_to: Optional[str] = None
    if reply_to is not None and reply_to != "":
        if not isinstance(reply_to, str) or has_header_injection(reply_to):
            raise ValueError("Invalid Reply-To address.")
        candidate = reply_to.strip()
        if candidate:
            if not is_valid_email_address(candidate):
                raise ValueError("Invalid Reply-To email address.")
            clean_reply_to = candidate

    clean_text = "" if text is None else text
    if not isinstance(clean_text, str) or "\x00" in clean_text:
        raise ValueError("Invalid email text body.")
    if len(clean_text) > MAX_TEXT_LEN:
        raise ValueError(f"Email text body too long (max {MAX_TEXT_LEN}).")

    clean_html: Optional[str] = None
    if html is not None and html != "":
        if not isinstance(html, str) or "\x00" in html:
            raise ValueError("Invalid email HTML body.")
        if len(html) > MAX_HTML_LEN:
            raise ValueError(f"Email HTML body too long (max {MAX_HTML_LEN}).")
        clean_html = html

    if not clean_text.strip() and not (clean_html or "").strip():
        raise ValueError("Email body cannot be empty.")

    return {
        "to": clean_recipients,
        "subject": clean_subject,
        "text": clean_text,
        "html": clean_html,
        "from_name": clean_from_name,
        "reply_to": clean_reply_to,
    }


def _norm_role(raw_role: Any) -> str:
    return raw_role.strip().lower() if isinstance(raw_role, str) else ""


def user_can_send_email(
    uid: str,
    email: str,
    super_admin_emails: AbstractSet[str],
    db_client: Any,
) -> bool:
    """Return True iff the authenticated user holds a privileged role permitted to send mail."""
    norm_email = (email or "").strip().lower()
    if norm_email and norm_email in super_admin_emails:
        return True
    if not uid or not db_client:
        return False

    try:
        user_snap = db_client.collection("users").document(uid).get()
        if getattr(user_snap, "exists", False):
            user_data = user_snap.to_dict() or {}
            if user_data.get("isSuperAdmin") is True:
                return True

        for org_doc in db_client.collection("organizations").stream():
            org_data = org_doc.to_dict() or {}
            org_admin_email = (org_data.get("adminEmail") or "").strip().lower()
            if (
                org_data.get("createdBy") == uid
                or org_data.get("adminUid") == uid
                or (norm_email and org_admin_email == norm_email)
            ):
                return True

        for m_doc in db_client.collection_group("members").stream():
            m_data = m_doc.to_dict() or {}
            m_email = (m_data.get("email") or "").strip().lower()
            m_id_lower = str(m_doc.id).strip().lower()
            matches = (
                m_doc.id == uid
                or m_data.get("uid") == uid
                or (norm_email and (m_email == norm_email or m_id_lower == norm_email))
            )
            if not matches:
                continue

            status = (m_data.get("status") or "approved").strip().lower()
            if status != "approved":
                continue

            if _norm_role(m_data.get("role")) in PRIVILEGED_EMAIL_ROLES:
                return True

            compta_access = m_data.get("comptaAccess")
            if isinstance(compta_access, dict) and any(
                _norm_role(role_val) in PRIVILEGED_EMAIL_ROLES
                for role_val in compta_access.values()
            ):
                return True
    except Exception as exc:
        print(f"Email role check failed for uid={uid}: {exc}")
        return False

    return False


class EmailRateLimiter:
    """Thread-safe per-actor sliding-window rate limiter."""

    def __init__(
        self,
        max_requests: int = DEFAULT_RATE_LIMIT,
        window_seconds: float = DEFAULT_RATE_WINDOW_SEC,
    ) -> None:
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._buckets: Dict[str, List[float]] = {}
        self._lock = threading.Lock()

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()

    def allow(self, key: str, now: Optional[float] = None) -> bool:
        if not isinstance(key, str) or not key.strip():
            return False
        current = time.monotonic() if now is None else float(now)
        cutoff = current - self.window_seconds
        with self._lock:
            bucket = self._buckets.get(key, [])
            bucket = [ts for ts in bucket if ts > cutoff]
            if len(bucket) >= self.max_requests:
                self._buckets[key] = bucket
                return False
            bucket.append(current)
            self._buckets[key] = bucket
            return True


_SAFE_DOC_ID_RE = re.compile(r"^[A-Za-z0-9._@-]{1,128}$")
_CAISSIER_NOTIFICATION_ROLES = {"admin", "caissier", "comptable"}


def is_safe_firestore_segment(value: Any) -> bool:
    """Validates a Firestore path segment (no slashes, traversal, or control chars)."""
    if not isinstance(value, str):
        return False
    stripped = value.strip()
    if not stripped or stripped in (".", "..") or ".." in stripped or "/" in stripped or "\\" in stripped:
        return False
    return bool(_SAFE_DOC_ID_RE.match(stripped))


def resolve_compta_caissier_emails_from_db(
    db_client: Any,
    org_id: str,
    compta_id: str,
    fallback_emails: Optional[Iterable[str]] = None,
) -> List[str]:
    """Resolves deduplicated caissier/admin email addresses for a given compta from Firestore."""
    recipients: set[str] = set()
    if db_client is not None and org_id:
        try:
            org_ref = db_client.collection("organizations").document(org_id)
            org_snap = org_ref.get()
            if getattr(org_snap, "exists", False):
                org_data = org_snap.to_dict() or {}
                admin_email = (org_data.get("adminEmail") or "").strip().lower()
                if admin_email and _is_valid_email(admin_email):
                    recipients.add(admin_email)

            for m_doc in org_ref.collection("members").stream():
                m_data = m_doc.to_dict() or {}
                if (m_data.get("status") or "approved").strip().lower() != "approved":
                    continue
                m_email = (m_data.get("email") or "").strip().lower()
                if not m_email or not _is_valid_email(m_email):
                    continue
                has_org_role = _norm_role(m_data.get("role")) in _CAISSIER_NOTIFICATION_ROLES
                compta_access = m_data.get("comptaAccess")
                has_compta_role = (
                    isinstance(compta_access, dict)
                    and _norm_role(compta_access.get(compta_id)) in _CAISSIER_NOTIFICATION_ROLES
                )
                if has_org_role or has_compta_role:
                    recipients.add(m_email)
        except Exception as exc:
            print(f"Caissier email lookup failed: {type(exc).__name__}")

    if not recipients and fallback_emails:
        for item in fallback_emails:
            if isinstance(item, str):
                norm = item.strip().lower()
                if norm and _is_valid_email(norm):
                    recipients.add(norm)

    return sorted(recipients)


def build_invoice_payment_email(
    compta_name: str,
    receipt_data: Dict[str, Any],
    fallback_submitter_name: str = "",
    fallback_submitter_email: str = "",
) -> Dict[str, str]:
    """Builds a safe, HTML-escaped immediate notification email for an INVOICE_PAYMENT receipt."""
    import html as _html

    safe_compta = (compta_name or "Comptabilité").strip() or "Comptabilité"
    submitter_name = (
        str(receipt_data.get("submittedByName") or "").strip()
        or fallback_submitter_name.strip()
        or "Un membre"
    )
    submitter_email = (
        str(receipt_data.get("submittedByEmail") or "").strip()
        or fallback_submitter_email.strip()
        or "—"
    )
    motif = (
        str(receipt_data.get("merchantName") or "").strip()
        or str(receipt_data.get("description") or "").strip()
        or str(receipt_data.get("fileName") or "").strip()
        or "Facture"
    )
    raw_amount = receipt_data.get("extractedAmount")
    try:
        amount = float(raw_amount) if raw_amount is not None else 0.0
    except (TypeError, ValueError):
        amount = 0.0
    date_str = str(receipt_data.get("extractedDate") or receipt_data.get("uploadDate") or "—").strip()[:20]

    subject = f"[AssoCompta — {safe_compta}] Nouvelle facture à payer : {motif} (CHF {amount:.2f})"
    text_body = (
        f"Bonjour,\n\n"
        f"Une nouvelle facture à payer vient d'être transmise par {submitter_name} ({submitter_email}) :\n\n"
        f"• Comptabilité : {safe_compta}\n"
        f"• Fournisseur / Motif : {motif}\n"
        f"• Date de la facture : {date_str}\n"
        f"• Montant : CHF {amount:.2f}\n\n"
        f"La photo ou le PDF de la facture est disponible dans l'onglet « Remboursements & Factures » "
        f"pour effectuer le paiement et la marquer comme payée :\n"
        f"https://compta-ai-v2.web.app\n\n"
        f"Cordialement,\nAssoCompta TDGL"
    )
    html_body = (
        '<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; '
        'border: 1px solid #ddd6fe; border-radius: 12px; background: #ffffff;">'
        '<h2 style="color: #6d28d9; margin-top: 0;">📄 Nouvelle facture à payer</h2>'
        f'<p>Bonjour,</p><p><strong>{_html.escape(submitter_name)}</strong> '
        f'({_html.escape(submitter_email)}) vient de transmettre une facture à régler directement :</p>'
        '<div style="background: #f5f3ff; border: 1px solid #ddd6fe; border-left: 4px solid #7c3aed; '
        'padding: 14px 16px; margin: 16px 0; border-radius: 8px;">'
        f'<p style="margin: 4px 0;"><strong>Comptabilité :</strong> {_html.escape(safe_compta)}</p>'
        f'<p style="margin: 4px 0;"><strong>Fournisseur / Motif :</strong> {_html.escape(motif)}</p>'
        f'<p style="margin: 4px 0;"><strong>Date de la facture :</strong> {_html.escape(date_str)}</p>'
        f'<p style="margin: 6px 0 0 0;"><strong>Montant :</strong> '
        f'<span style="color: #6d28d9; font-weight: bold; font-size: 17px;">CHF {amount:.2f}</span></p>'
        '</div>'
        '<p style="color: #334155; font-size: 13px;">'
        'Ouvrez la photo ou le PDF de la facture dans l\'onglet <strong>« Remboursements &amp; Factures »</strong> '
        'pour effectuer le paiement puis marquez-la comme payée : '
        '<a href="https://compta-ai-v2.web.app" style="color: #6d28d9;">compta-ai-v2.web.app</a></p>'
        '<hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />'
        '<p style="color: #94a3b8; font-size: 11px; margin: 0;">Notification immédiate envoyée par AssoCompta TDGL.</p>'
        '</div>'
    )
    return {"subject": subject, "text": text_body, "html": html_body}
