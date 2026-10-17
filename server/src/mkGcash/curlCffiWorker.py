#!/usr/bin/env python3
"""Persistent curl_cffi chrome145 session for mkGcash.

Mirrors gcash_chain.py Session(impersonate=TLS_IMPERSONATE). Commands are
newline-delimited JSON on stdin/stdout. Secrets are never logged.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any

from curl_cffi.requests import Session

IMPERSONATE = "chrome145"


def reply(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def safe_error(exc: Exception) -> str:
    text = f"{type(exc).__name__}: {exc}"
    return re.sub(r"(https?://)[^/@\s]+@", r"\1<credentials>@", text)[:500]


def dump_cookies(session: Session) -> list[dict[str, Any]]:
    cookies = []
    jar = getattr(session.cookies, "jar", None)
    items = list(jar) if jar is not None else list(session.cookies)
    for cookie in items:
        item = {
            "name": str(getattr(cookie, "name", "") or ""),
            "value": str(getattr(cookie, "value", "") or ""),
            "domain": str(getattr(cookie, "domain", "") or ""),
            "path": str(getattr(cookie, "path", "") or "/"),
            "httpOnly": bool(cookie.has_nonstandard_attr("HttpOnly")) if hasattr(cookie, "has_nonstandard_attr") else False,
            "secure": bool(getattr(cookie, "secure", False)),
        }
        expires = getattr(cookie, "expires", None)
        if expires:
            item["expires"] = float(expires)
        cookies.append(item)
    return cookies


def main() -> None:
    session: Session | None = None
    for raw in sys.stdin:
        try:
            command = json.loads(raw)
            action = command.get("action")
            if action == "init":
                impersonate = str(command.get("impersonate") or IMPERSONATE)
                session = Session(impersonate=impersonate)
                session.trust_env = False
                reply({"ok": True, "impersonate": impersonate})
                continue
            if session is None:
                raise RuntimeError("worker session is not initialized")
            if action == "set_cookie":
                session.cookies.set(
                    str(command.get("name") or ""),
                    str(command.get("value") or ""),
                    domain=str(command.get("domain") or ".chatgpt.com"),
                    path=str(command.get("path") or "/"),
                )
                reply({"ok": True})
                continue
            if action == "cookies":
                reply({"ok": True, "cookies": dump_cookies(session)})
                continue
            if action == "request":
                timeout_s = float(command.get("timeout") or 30)
                kwargs = {
                    "headers": command.get("headers") or None,
                    "data": command.get("body"),
                    "timeout": max(1.0, timeout_s),
                    "allow_redirects": bool(command.get("allow_redirects")),
                    "verify": True,
                }
                proxy_url = str(command.get("proxy_url") or "")
                if proxy_url:
                    kwargs["proxies"] = {"http": proxy_url, "https": proxy_url}
                response = session.request(
                    str(command.get("method") or "GET"),
                    str(command["url"]),
                    **kwargs,
                )
                reply({
                    "ok": True,
                    "status": response.status_code,
                    "reason": str(response.reason or ""),
                    "headers": dict(response.headers),
                    "text": response.text or "",
                    "url": str(response.url),
                })
                continue
            if action == "close":
                session.close()
                reply({"ok": True})
                return
            raise RuntimeError(f"unknown worker action: {action}")
        except Exception as exc:
            reply({"ok": False, "error": safe_error(exc)})


if __name__ == "__main__":
    main()
