#!/usr/bin/env python3
"""Persistent curl_cffi transport for one extract session.

Commands and responses are newline-delimited JSON on stdin/stdout. Secrets are
never passed in argv or written to logs.
"""

from __future__ import annotations

import base64
import json
import re
import sys
from typing import Any

from curl_cffi.requests import Session


def reply(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def safe_error(exc: Exception) -> str:
    text = f"{type(exc).__name__}: {exc}"
    return re.sub(r"(https?://)[^/@\s]+@", r"\1<redacted>@", text)[:500]


def main() -> None:
    session: Session | None = None
    for raw in sys.stdin:
        try:
            command = json.loads(raw)
            action = command.get("action")
            if action == "init":
                session = Session(impersonate=str(command.get("impersonate") or "chrome136"))
                session.trust_env = False
                headers = command.get("headers")
                if isinstance(headers, dict):
                    session.headers.update({str(k): str(v) for k, v in headers.items()})
                proxy = str(command.get("proxy") or "")
                if proxy:
                    session.proxies = {"http": proxy, "https": proxy}
                reply({"ok": True})
                continue
            if session is None:
                raise RuntimeError("worker session is not initialized")
            if action == "seed":
                for item in command.get("cookies") or []:
                    name = str(item.get("name") or "")
                    if not name:
                        continue
                    session.cookies.set(
                        name,
                        str(item.get("value") or ""),
                        domain=str(item.get("domain") or ".chatgpt.com"),
                        path=str(item.get("path") or "/"),
                    )
                reply({"ok": True})
                continue
            if action == "cookies":
                cookies = []
                jar = getattr(session.cookies, "jar", None)
                items = list(jar) if jar is not None else list(session.cookies)
                for cookie in items:
                    rest = getattr(cookie, "_rest", {}) or {}
                    same_site = rest.get("SameSite") or rest.get("samesite") or ""
                    cookies.append(
                        {
                            "name": str(getattr(cookie, "name", "") or ""),
                            "value": str(getattr(cookie, "value", "") or ""),
                            "domain": str(getattr(cookie, "domain", "") or ""),
                            "path": str(getattr(cookie, "path", "") or "/"),
                            "secure": bool(getattr(cookie, "secure", False)),
                            "expires": int(getattr(cookie, "expires", 0) or 0),
                            "sameSite": str(same_site or ""),
                            "hostOnly": not bool(getattr(cookie, "domain_initial_dot", False)),
                        }
                    )
                reply({"ok": True, "cookies": cookies})
                continue
            if action == "request":
                timeout_ms = float(command.get("timeout") or 45000)
                response = session.request(
                    method=str(command.get("method") or "GET"),
                    url=str(command["url"]),
                    headers=command.get("headers") or None,
                    data=command.get("body"),
                    timeout=max(1.0, timeout_ms / 1000.0),
                    allow_redirects=command.get("redirect") != "manual",
                )
                content_type = str(response.headers.get("content-type") or "").lower()
                payload = {
                    "ok": True,
                    "status": response.status_code,
                    "headers": dict(response.headers),
                    "text": "",
                    "url": str(response.url),
                }
                if content_type.startswith("image/"):
                    payload["body_b64"] = base64.b64encode(response.content).decode("ascii")
                else:
                    payload["text"] = response.text
                reply(payload)
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
