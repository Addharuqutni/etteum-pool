from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import aiohttp

from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError
from app.providers.base import NormalizedAccount, ProviderAdapter
from app.providers.google_auth import (
    _click_google_next,
    _detect_google_blocking_challenge,
    _fill_google_email_step,
    _fill_google_password_step,
    _handle_google_consent_continue,
    _handle_google_gaplustos,
    _is_email_step,
    _is_password_step,
)

_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# Constants copied verbatim from src/proxy/providers/antigravity.ts:16-38
ANTIGRAVITY_CLIENT_ID = (
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
)
ANTIGRAVITY_CLIENT_SECRET = "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"
ANTIGRAVITY_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token"
ANTIGRAVITY_USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo"
ANTIGRAVITY_LOAD_CODE_ASSIST_URL = (
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
)
ANTIGRAVITY_ONBOARD_USER_URL = (
    "https://cloudcode-pa.googleapis.com/v1internal:onboardUser"
)
ANTIGRAVITY_OPERATION_BASE = "https://cloudcode-pa.googleapis.com/v1internal"
ANTIGRAVITY_USER_AGENT = "antigravity/hub/2.1.4 windows/amd64"
ANTIGRAVITY_SCOPES = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
]
LOAD_CODE_ASSIST_METADATA = {
    "ideType": "ANTIGRAVITY",
    "platform": "PLATFORM_UNSPECIFIED",
    "pluginType": "GEMINI",
}

ANTIGRAVITY_REDIRECT_PATH = "/oauth/antigravity/callback"
DEFAULT_CALLBACK_PORT = int(os.getenv("ANTIGRAVITY_CALLBACK_PORT", "1457"))


def _debug(msg: str) -> None:
    if os.getenv("BATCHER_DEBUG", "").lower() == "true":
        print(f"[antigravity-debug] {msg}", flush=True)


class _CallbackState:
    __slots__ = ("code", "error", "state", "lock")

    def __init__(self) -> None:
        self.code: str | None = None
        self.error: str | None = None
        self.state: str | None = None
        self.lock = threading.Lock()


def _make_handler(state: _CallbackState, expected_state: str):
    class CallbackHandler(BaseHTTPRequestHandler):
        def log_message(self, *args, **kwargs):  # silence
            return

        def do_GET(self):
            if not self.path.startswith(ANTIGRAVITY_REDIRECT_PATH):
                self.send_response(404)
                self.end_headers()
                return
            params = parse_qs(urlparse(self.path).query)
            with state.lock:
                err = params.get("error", [None])[0]
                code = params.get("code", [None])[0]
                returned_state = params.get("state", [None])[0]
                if err:
                    state.error = (
                        f"{err}: {params.get('error_description', [''])[0]}"
                    )
                elif code:
                    if expected_state and returned_state != expected_state:
                        state.error = "state mismatch"
                    else:
                        state.code = code
                        state.state = returned_state
                else:
                    state.error = "missing code"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                b"<html><body><h3>Authentication complete.</h3>"
                b"<p>You may close this window.</p></body></html>"
            )

    return CallbackHandler


def _start_callback_server(
    state: _CallbackState, expected_state: str, port: int
) -> HTTPServer:
    handler_cls = _make_handler(state, expected_state)
    last_err: Exception | None = None
    for attempt_port in (port, port + 1, port + 2, 0):
        try:
            srv = HTTPServer(("127.0.0.1", attempt_port), handler_cls)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            return srv
        except OSError as exc:
            last_err = exc
            continue
    raise RetryableBatcherError(
        ErrorCode.browser_start_failed,
        f"failed to bind antigravity callback server: {last_err}",
    )


async def _exchange_code(code: str, redirect_uri: str) -> dict[str, Any]:
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "client_id": ANTIGRAVITY_CLIENT_ID,
        "client_secret": ANTIGRAVITY_CLIENT_SECRET,
        "redirect_uri": redirect_uri,
    }
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(
            ANTIGRAVITY_TOKEN_URL,
            data=form,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        ) as resp:
            text = await resp.text()
            if resp.status != 200:
                raise RetryableBatcherError(
                    ErrorCode.auth_token_extraction_failed,
                    f"token exchange failed ({resp.status}): {text[:200]}",
                )
            return json.loads(text)


async def _fetch_userinfo(access_token: str) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {access_token}"}
    timeout = aiohttp.ClientTimeout(total=15)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(
                f"{ANTIGRAVITY_USERINFO_URL}?alt=json", headers=headers
            ) as resp:
                if resp.status != 200:
                    return {}
                return await resp.json()
    except Exception:
        return {}


def _default_tier(payload: dict[str, Any]) -> str:
    tiers = payload.get("allowedTiers") or []
    for tier in tiers:
        if isinstance(tier, dict) and tier.get("isDefault") and tier.get("id"):
            return str(tier["id"])
    return "legacy-tier"


def _extract_project_id(payload: dict[str, Any]) -> str:
    if not isinstance(payload, dict):
        return ""
    top = payload.get("cloudaicompanionProject")
    if isinstance(top, str) and top:
        return top
    if isinstance(top, dict) and top.get("id"):
        return str(top["id"])
    response = payload.get("response")
    if isinstance(response, dict):
        return _extract_project_id(response)
    return ""


async def _provision_project_id(access_token: str) -> str:
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "User-Agent": ANTIGRAVITY_USER_AGENT,
    }
    timeout = aiohttp.ClientTimeout(total=30)
    body_load = {"metadata": LOAD_CODE_ASSIST_METADATA}

    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(
            ANTIGRAVITY_LOAD_CODE_ASSIST_URL, json=body_load, headers=headers
        ) as resp:
            text = await resp.text()
            if resp.status != 200:
                raise RetryableBatcherError(
                    ErrorCode.provider_token_exchange_failed,
                    f"loadCodeAssist failed ({resp.status}): {text[:200]}",
                )
            load_payload = json.loads(text)

        project_id = _extract_project_id(load_payload)
        if project_id:
            return project_id

        tier = _default_tier(load_payload)
        body_onboard = {"tierId": tier, "metadata": LOAD_CODE_ASSIST_METADATA}
        async with session.post(
            ANTIGRAVITY_ONBOARD_USER_URL, json=body_onboard, headers=headers
        ) as resp:
            text = await resp.text()
            if resp.status != 200:
                raise RetryableBatcherError(
                    ErrorCode.provider_token_exchange_failed,
                    f"onboardUser failed ({resp.status}): {text[:200]}",
                )
            operation = json.loads(text)

        project_id = _extract_project_id(operation)
        if project_id:
            return project_id

        op_name = operation.get("name") if isinstance(operation, dict) else None
        if not op_name:
            raise RetryableBatcherError(
                ErrorCode.provider_token_exchange_failed,
                "onboardUser returned no operation name",
            )
        # ponytail: fixed 30x2s poll, replace with server-suggested backoff if
        # provisioning starts taking >60s in the wild.
        op_url = f"{ANTIGRAVITY_OPERATION_BASE}:{op_name}"
        for _ in range(30):
            await asyncio.sleep(2)
            async with session.get(op_url, headers=headers) as resp:
                if resp.status != 200:
                    continue
                op_payload = await resp.json()
            project_id = _extract_project_id(op_payload)
            if project_id:
                return project_id
            if isinstance(op_payload, dict) and op_payload.get("done"):
                break

    raise RetryableBatcherError(
        ErrorCode.provider_token_exchange_failed,
        "antigravity project provisioning timed out",
    )


async def _try_fill_google_login(
    page: Any, email: str, password: str, callback_state: _CallbackState
) -> None:
    try:
        email_typed = False
        password_typed = False
        for _ in range(120):
            try:
                current_url = page.url or ""
            except Exception:
                current_url = ""
            if current_url and "accounts.google.com" not in current_url:
                return
            with callback_state.lock:
                if callback_state.code or callback_state.error:
                    return

            try:
                await _handle_google_gaplustos(page)
                await _handle_google_consent_continue(page)
            except Exception:
                pass

            try:
                marker = await _detect_google_blocking_challenge(page)
            except Exception:
                marker = None
            # Only hard blockers should abort. Soft challenges (verify-it's-you, /challenge/
            # for phone/OTP, consent screens) are user-solvable — keep polling the callback.
            hard_blockers = (
                "browser may not be secure",
                "browser or app may not be secure",
                "unusual traffic",
                "captcha",
                "try again later",
            )
            if marker and any(b in marker for b in hard_blockers):
                with callback_state.lock:
                    if not callback_state.error and not callback_state.code:
                        callback_state.error = f"google challenge: {marker}"
                return

            try:
                if not email_typed and await _is_email_step(page):
                    if await _fill_google_email_step(page, email):
                        await _click_google_next(page)
                        email_typed = True
                        await asyncio.sleep(2)
                        continue
                if not password_typed and await _is_password_step(page):
                    if await _fill_google_password_step(page, password):
                        await _click_google_next(page)
                        password_typed = True
                        await asyncio.sleep(2)
                        continue
            except Exception as exc:
                _debug(f"fill step error: {exc}")

            await asyncio.sleep(1)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        _debug(f"_try_fill_google_login unexpected: {exc}")
        return


class AntigravityProviderAdapter(ProviderAdapter):
    name = "antigravity"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [p.strip() for p in raw_line.split("|")]
        if len(parts) < 2 or not parts[0] or not parts[1]:
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "antigravity account must be email|password",
            )
        email = parts[0]
        password = parts[1]
        if not _EMAIL_PATTERN.match(email):
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "antigravity account email format is invalid",
            )
        return NormalizedAccount(
            provider=self.name,
            identifier=email,
            secret=password,
            raw=raw_line,
        )

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        if os.getenv("BATCHER_ENABLE_CAMOUFOX", "false").lower() != "true":
            return {"mode": "password", "stub": True}

        engine = os.getenv("BROWSER_ENGINE", "camoufox").lower()
        headless = os.getenv("BATCHER_CAMOUFOX_HEADLESS", "false").lower() == "true"

        oauth_state = secrets.token_urlsafe(24)
        callback_state = _CallbackState()

        srv = _start_callback_server(callback_state, oauth_state, DEFAULT_CALLBACK_PORT)
        bound_port = srv.server_address[1]
        redirect_uri = f"http://localhost:{bound_port}{ANTIGRAVITY_REDIRECT_PATH}"

        params = {
            "client_id": ANTIGRAVITY_CLIENT_ID,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(ANTIGRAVITY_SCOPES),
            "access_type": "offline",
            "prompt": "consent",
            "state": oauth_state,
        }
        authorize_url = f"{ANTIGRAVITY_AUTH_URL}?{urlencode(params)}"

        proxy_url = os.getenv("BATCHER_PROXY_URL", "")

        if engine in ("chromium", "chrome", "playwright"):
            # ponytail: minimal chromium branch, share manager/browser/page keys with camoufox branch
            try:
                from playwright.async_api import async_playwright
            except Exception as exc:
                try:
                    srv.shutdown()
                except Exception:
                    pass
                raise RetryableBatcherError(
                    ErrorCode.browser_start_failed,
                    f"playwright import failed: {exc}",
                ) from exc

            launch_kwargs: dict[str, Any] = {
                "headless": headless,
                "args": ["--disable-blink-features=AutomationControlled"],
            }
            # Prefer real Chrome to reduce Google automation detection.
            if engine != "chromium":
                launch_kwargs["channel"] = "chrome"
            if proxy_url:
                parsed = urlparse(proxy_url)
                proxy_cfg: dict[str, Any] = {
                    "server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"
                }
                if parsed.username:
                    proxy_cfg["username"] = parsed.username
                if parsed.password:
                    proxy_cfg["password"] = parsed.password
                launch_kwargs["proxy"] = proxy_cfg

            try:
                manager = async_playwright()
                pw = await manager.__aenter__()
                try:
                    browser = await pw.chromium.launch(**launch_kwargs)
                except Exception:
                    # Fallback to bundled chromium if the "chrome" channel is missing.
                    launch_kwargs.pop("channel", None)
                    browser = await pw.chromium.launch(**launch_kwargs)
                context = await browser.new_context(
                    viewport={"width": 1280, "height": 800},
                    user_agent=(
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/131.0.0.0 Safari/537.36"
                    ),
                )
                page = await context.new_page()
                page.set_default_timeout(120000)
                await page.goto(authorize_url, wait_until="domcontentloaded", timeout=30000)
            except Exception as exc:
                try:
                    srv.shutdown()
                except Exception:
                    pass
                raise RetryableBatcherError(
                    ErrorCode.browser_start_failed,
                    f"chromium launch failed: {exc}",
                ) from exc

            return {
                "mode": "password",
                "stub": False,
                "manager": manager,
                "browser": browser,
                "page": page,
                "callback_server": srv,
                "callback_state": callback_state,
                "oauth_state": oauth_state,
                "redirect_uri": redirect_uri,
            }

        try:
            from browserforge.fingerprints import Screen
            from camoufox.async_api import AsyncCamoufox
        except Exception as exc:
            try:
                srv.shutdown()
            except Exception:
                pass
            raise RetryableBatcherError(
                ErrorCode.browser_start_failed,
                f"camoufox import failed: {exc}",
            ) from exc

        camoufox_kwargs: dict[str, Any] = {
            "headless": headless,
            "os": "windows",
            "block_webrtc": True,
            "humanize": False,
            "screen": Screen(max_width=1920, max_height=1080),
        }

        if proxy_url:
            parsed = urlparse(proxy_url)
            proxy_cfg = {
                "server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"
            }
            if parsed.username:
                proxy_cfg["username"] = parsed.username
            if parsed.password:
                proxy_cfg["password"] = parsed.password
            camoufox_kwargs["proxy"] = proxy_cfg
            camoufox_kwargs["geoip"] = True

        try:
            manager = AsyncCamoufox(**camoufox_kwargs)
            browser = await manager.__aenter__()
            page = await browser.new_page()
            page.set_default_timeout(120000)
            await page.goto(authorize_url, wait_until="domcontentloaded", timeout=30000)
        except Exception as exc:
            try:
                srv.shutdown()
            except Exception:
                pass
            raise RetryableBatcherError(
                ErrorCode.browser_start_failed,
                f"camoufox launch failed: {exc}",
            ) from exc

        return {
            "mode": "password",
            "stub": False,
            "manager": manager,
            "browser": browser,
            "page": page,
            "callback_server": srv,
            "callback_state": callback_state,
            "oauth_state": oauth_state,
            "redirect_uri": redirect_uri,
        }

    async def authenticate(
        self, account: NormalizedAccount, session: Any
    ) -> dict[str, Any]:
        if session is None:
            raise RetryableBatcherError(
                ErrorCode.browser_unexpected_state,
                "no session for antigravity auth",
            )

        if session.get("stub"):
            return {
                "mode": "password",
                "authorization_code": "stub-antigravity-code",
                "redirect_uri": "http://localhost:0/stub",
            }

        page = session["page"]
        callback_state: _CallbackState = session["callback_state"]

        fill_task = asyncio.create_task(
            _try_fill_google_login(
                page, account.identifier, account.secret, callback_state
            )
        )

        timeout_seconds = int(os.getenv("ANTIGRAVITY_LOGIN_TIMEOUT", "300"))
        deadline = time.monotonic() + timeout_seconds

        try:
            while time.monotonic() < deadline:
                with callback_state.lock:
                    if callback_state.error:
                        err = callback_state.error
                        if err.startswith("google challenge:"):
                            raise NonRetryableBatcherError(
                                ErrorCode.browser_challenge_blocked, err
                            )
                        raise NonRetryableBatcherError(
                            ErrorCode.auth_invalid_credentials,
                            f"antigravity callback error: {err}",
                        )
                    if callback_state.code:
                        return {
                            "mode": "password",
                            "authorization_code": callback_state.code,
                            "redirect_uri": session["redirect_uri"],
                        }
                await asyncio.sleep(0.5)
        finally:
            fill_task.cancel()
            try:
                await fill_task
            except Exception:
                pass

        raise RetryableBatcherError(
            ErrorCode.auth_timeout,
            f"antigravity login timed out after {timeout_seconds}s",
        )

    async def fetch_tokens(
        self,
        account: NormalizedAccount,
        auth_state: dict[str, Any],
        session: Any,
    ) -> dict[str, str]:
        code = auth_state.get("authorization_code", "")
        redirect_uri = auth_state.get("redirect_uri", "")
        if not code or code == "stub-antigravity-code":
            raise RetryableBatcherError(
                ErrorCode.auth_token_extraction_failed,
                "no authorization_code returned",
            )

        data = await _exchange_code(code, redirect_uri)
        access_token = data.get("access_token", "")
        if not access_token:
            raise RetryableBatcherError(
                ErrorCode.auth_token_extraction_failed,
                "token response missing access_token",
            )

        userinfo = await _fetch_userinfo(access_token)
        project_id = await _provision_project_id(access_token)

        expires_in = int(data.get("expires_in") or 3600)
        expires_at = (
            datetime.fromtimestamp(time.time() + expires_in, tz=timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )

        return {
            "accessToken": access_token,
            "projectId": project_id,
            "refreshToken": data.get("refresh_token", ""),
            "expiresAt": expires_at,
            "email": (userinfo.get("email") or account.identifier).lower(),
            "scope": data.get("scope", ""),
        }

    async def fetch_quota(
        self,
        account: NormalizedAccount,
        tokens: dict[str, str],
        session: Any,
    ) -> dict[str, Any] | None:
        access_token = tokens.get("accessToken", "")
        if not access_token:
            return None
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "User-Agent": ANTIGRAVITY_USER_AGENT,
        }
        body = {"metadata": LOAD_CODE_ASSIST_METADATA}
        timeout = aiohttp.ClientTimeout(total=20)
        try:
            async with aiohttp.ClientSession(timeout=timeout) as sess:
                async with sess.post(
                    ANTIGRAVITY_LOAD_CODE_ASSIST_URL, json=body, headers=headers
                ) as resp:
                    if resp.status != 200:
                        return None
                    await resp.read()
        except Exception:
            return None
        # ponytail: antigravity has no per-account credit counter the pool tracks;
        # return a sentinel so runner treats the login as usable without triggering
        # codebuddy's mandatory-quota branch (runner.ts:519, :533).
        return {"limit": 1, "remaining": 1}

    async def cleanup_session(self, session: Any) -> None:
        if not isinstance(session, dict):
            return
        srv = session.get("callback_server")
        if srv is not None:
            try:
                srv.shutdown()
            except Exception:
                pass
        browser = session.get("browser")
        manager = session.get("manager")
        try:
            if browser:
                await browser.close()
        except Exception:
            pass
        try:
            if manager:
                await manager.__aexit__(None, None, None)
        except Exception:
            pass
