from __future__ import annotations

import base64
import hashlib
import hmac
import secrets


class PasswordHasher:
    def __init__(self, *, n: int = 2**14, r: int = 8, p: int = 1, dklen: int = 32) -> None:
        self._n = n
        self._r = r
        self._p = p
        self._dklen = dklen

    def hash(self, password: str) -> str:
        if len(password) < 8:
            raise ValueError("password must be at least 8 characters")
        salt = secrets.token_bytes(16)
        digest = hashlib.scrypt(
            password.encode("utf-8"), salt=salt, n=self._n, r=self._r, p=self._p, dklen=self._dklen
        )
        salt_text = base64.urlsafe_b64encode(salt).decode("ascii")
        digest_text = base64.urlsafe_b64encode(digest).decode("ascii")
        return f"scrypt${self._n}${self._r}${self._p}${self._dklen}${salt_text}${digest_text}"

    def verify(self, password: str, encoded: str) -> bool:
        try:
            scheme, n, r, p, dklen, salt_b64, digest_b64 = encoded.split("$", 6)
            if scheme != "scrypt":
                return False
            salt = base64.urlsafe_b64decode(salt_b64.encode("ascii"))
            expected = base64.urlsafe_b64decode(digest_b64.encode("ascii"))
            actual = hashlib.scrypt(
                password.encode("utf-8"), salt=salt, n=int(n), r=int(r), p=int(p), dklen=int(dklen)
            )
        except Exception:
            return False
        return hmac.compare_digest(actual, expected)
