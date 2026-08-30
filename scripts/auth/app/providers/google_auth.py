"""Shared Google OAuth login helpers for providers that authenticate via Google.

Extracted verbatim from the former kiro.py adapter so surviving providers
(canva, ...) can reuse the Google email/password filling and consent handling
without depending on the kiro provider module.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any


def _kiro_auth_debug_enabled() -> bool:
    return os.getenv("BATCHER_KIRO_AUTH_DEBUG", "false").lower() == "true"


def _kiro_auth_debug(message: str) -> None:
    if _kiro_auth_debug_enabled():
        print(f"[kiro-auth] {message}", flush=True)


async def _target_url(target: Any) -> str:
    try:
        return str(target.url)
    except Exception:
        return ""


async def _active_element_snapshot(target: Any) -> str:
    try:
        return str(
            await target.evaluate(
                """() => {
                    const el = document.activeElement;
                    if (!el) return 'none';
                    const tag = (el.tagName || '').toLowerCase();
                    const id = el.id ? `#${el.id}` : '';
                    const name = el.getAttribute('name') ? `[name="${el.getAttribute('name')}"]` : '';
                    return `${tag}${id}${name}`;
                }"""
            )
        )
    except Exception:
        return "unknown"


async def _wait_for_google_email_transition(target: Any) -> bool:
    try:
        await target.wait_for_function(
            """() => {
                const host = window.location.host || '';
                const path = window.location.pathname || '';
                const visible = (selectors) => selectors.some((sel) =>
                    Array.from(document.querySelectorAll(sel)).some((el) => el.offsetParent !== null)
                );
                const hasEmail = visible(['#identifierId', 'input[name="identifier"]', 'input[type="email"]']);
                const hasPassword = visible(['input[name="Passwd"]', 'input[type="password"]']);
                if (!host.includes('accounts.google.com')) return true;
                if (hasPassword) return true;
                if (path.includes('/signin/challenge/pwd')) return true;
                return !hasEmail && !path.includes('/signin/identifier');
            }""",
            timeout=10000,
        )
        return True
    except Exception:
        return False


async def _wait_for_google_password_transition(target: Any) -> bool:
    try:
        await target.wait_for_function(
            """() => {
                const host = window.location.host || '';
                const path = window.location.pathname || '';
                const hasPassword = Array.from(
                    document.querySelectorAll('input[name="Passwd"], input[type="password"]')
                ).some((el) => el.offsetParent !== null);
                if (!host.includes('accounts.google.com')) return true;
                if (!path.includes('/challenge/pwd')) return true;
                return !hasPassword;
            }""",
            timeout=12000,
        )
        return True
    except Exception:
        return False


async def _is_password_step(target: Any) -> bool:
    try:
        return bool(
            await target.evaluate(
                """() => {
                    for (const el of document.querySelectorAll('input[type="password"], input[name="Passwd"]')) {
                        if (el.offsetParent !== null) return true;
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _is_email_step(target: Any) -> bool:
    try:
        return bool(
            await target.evaluate(
                """() => {
                    for (const el of document.querySelectorAll('input[type="email"], input[name="identifier"], #identifierId')) {
                        if (el.offsetParent !== null) return true;
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _click_google_next(target: Any) -> bool:
    try:
        return bool(
            await target.evaluate(
                """() => {
                    const bySubmit = document.querySelector('#identifierNext button, #passwordNext button');
                    if (bySubmit && bySubmit.offsetParent !== null) {
                        bySubmit.click();
                        return true;
                    }
                    for (const el of document.querySelectorAll('div.VfPpkd-RLmnJb, button, div[role="button"]')) {
                        const parentBtn = el.closest('button, div[role="button"]') || el;
                        if (parentBtn && parentBtn.offsetParent !== null) {
                            parentBtn.click();
                            return true;
                        }
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _fill_google_email_step(target: Any, email: str) -> bool:
    for selector in ["#identifierId"]:
        try:
            target_url = await _target_url(target)
            _kiro_auth_debug(
                f"email step target={target_url or 'n/a'} selector={selector}"
            )

            try:
                await target.wait_for_selector(selector, state="visible", timeout=3000)
            except Exception:
                pass

            locator = target.locator(selector).first
            if await locator.count() == 0 or not await locator.is_visible():
                continue

            await locator.scroll_into_view_if_needed()
            await locator.click(force=True)
            await asyncio.sleep(0.2)
            _kiro_auth_debug(f"email active={await _active_element_snapshot(target)}")

            try:
                await locator.press("Control+a")
                await locator.press("Backspace")
            except Exception:
                pass

            try:
                await locator.press_sequentially(email, delay=60)
            except Exception as exc:
                _kiro_auth_debug(f"email type failed err={exc}")
                continue

            await asyncio.sleep(0.5)
            value = await locator.input_value()
            _kiro_auth_debug(f"email typed value={value!r}")
            if email.lower() != str(value).lower().strip():
                continue

            clicked = await _click_google_next(target)
            if not clicked:
                await locator.press("Enter")
            await _wait_for_google_email_transition(target)
            return True
        except Exception as exc:
            _kiro_auth_debug(f"email fill error err={exc}")
            continue
    return False


async def _fill_google_password_step(target: Any, password: str) -> bool:
    for selector in ['input[name="Passwd"]', 'input[type="password"]']:
        try:
            target_url = await _target_url(target)
            _kiro_auth_debug(
                f"password step target={target_url or 'n/a'} selector={selector}"
            )

            try:
                await target.wait_for_selector(selector, state="visible", timeout=3000)
            except Exception:
                pass

            locator = target.locator(selector).first
            if await locator.count() == 0 or not await locator.is_visible():
                continue

            await locator.scroll_into_view_if_needed()
            await locator.click(force=True)
            await asyncio.sleep(0.2)
            _kiro_auth_debug(
                f"password active={await _active_element_snapshot(target)}"
            )

            try:
                await locator.press("Control+a")
                await locator.press("Backspace")
            except Exception:
                pass

            try:
                await locator.press_sequentially(password, delay=70)
            except Exception as exc:
                _kiro_auth_debug(f"password type failed err={exc}")
                continue

            await asyncio.sleep(0.5)
            value = await locator.input_value()
            _kiro_auth_debug(f"password typed length={len(str(value))}")
            if len(str(value)) < len(password):
                continue

            clicked = await _click_google_next(target)
            if not clicked:
                await locator.press("Enter")
            await _wait_for_google_password_transition(target)
            return True
        except Exception as exc:
            _kiro_auth_debug(f"password fill error err={exc}")
            continue
    return False


async def _click_continue_button(page: Any) -> None:
    await page.evaluate(
        """() => {
            for (const sel of ['#gaplustosNext button', '#identifierNext button', '#passwordNext button', '#submit', '#confirm']) {
                const el = document.querySelector(sel);
                if (el && el.offsetParent !== null) { el.click(); return; }
            }
            for (const btn of document.querySelectorAll('button, div[role="button"], input[type="submit"]')) {
                if (!btn.offsetParent) continue;
                const txt = (btn.textContent || btn.value || '').toLowerCase().trim();
                if (!txt) continue;
                const keywords = ['next','continue','accept','understand','agree','ok','got it','login','sign in',
                    'mengerti','lanjutkan','setuju','masuk','lewati','berikutnya',
                    'далее','продолжить','принять','понятно','войти','пропустить',
                    'зрозуміло','далі','продовжити','прийняти','увійти','пропустити',
                    'weiter','akzeptieren','verstanden','anmelden',
                    'suivant','continuer','accepter','compris',
                    'siguiente','continuar','aceptar','entendido',
                    'avanti','continua','accetta','capito',
                    'próximo','aceitar','entendi',
                    '次へ','続行','同意','ログイン',
                    '다음','계속','동의','로그인',
                    '下一步','继续','同意','登录',
                    'ถัดไป','ดำเนินการต่อ','ยอมรับ','เข้าสู่ระบบ'];
                if (keywords.some((k) => txt.includes(k))) { btn.click(); return; }
            }
        }"""
    )


async def _handle_google_gaplustos(page: Any) -> bool:
    try:
        current_url = page.url
    except Exception:
        current_url = ""
    if "/speedbump/gaplustos" not in current_url:
        return False

    try:
        try:
            await page.wait_for_selector(
                '#confirm, input[name="confirm"], input[type="submit"]',
                state="visible",
                timeout=5000,
            )
        except Exception:
            pass

        for selector in ["#gaplustosNext button", "#confirm", 'input[name="confirm"]', 'input[type="submit"]']:
            locator = page.locator(selector).first
            try:
                if await locator.count() == 0 or not await locator.is_visible():
                    continue
                await locator.click(force=True)
                _kiro_auth_debug(f"gaplustos clicked selector={selector}")
                return True
            except Exception:
                continue

        return bool(
            await page.evaluate(
                """() => {
                    const el = document.querySelector('#gaplustosNext button');
                    if (el && el.offsetParent !== null) { el.click(); return true; }
                    for (const btn of document.querySelectorAll('button, input[type="submit"]')) {
                        if (!btn.offsetParent) continue;
                        btn.click();
                        return true;
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _handle_google_consent_continue(page: Any) -> bool:
    try:
        current_url = page.url
    except Exception:
        current_url = ""
    if "accounts.google.com" not in current_url:
        return False

    try:
        return bool(
            await page.evaluate(
                """() => {
                    const el = document.querySelector('#submit_approve_access button, #submit_approve_access');
                    if (el && el.offsetParent !== null) { el.click(); return true; }
                    const keywords = ['continue','allow','lanjut','продолжить','разрешить','продовжити','дозволити',
                        'weiter','erlauben','continuer','autoriser','continuar','permitir','続行','허용','继续','允许'];
                    for (const btn of document.querySelectorAll('button, div[role="button"]')) {
                        const txt = (btn.textContent || '').trim().toLowerCase();
                        if (!txt || btn.offsetParent === null) continue;
                        if (keywords.some(k => txt.includes(k))) { btn.click(); return true; }
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _detect_google_blocking_challenge(page: Any) -> str | None:
    try:
        current_url = page.url
    except Exception:
        current_url = ""
    if "accounts.google.com" not in current_url:
        return None

    try:
        marker = str(
            await page.evaluate(
                """() => {
                    const text = (document.body?.innerText || '').toLowerCase();
                    const markers = [
                        'captcha',
                        'try again later',
                        'this browser or app may not be secure',
                        'this browser may not be secure',
                        'unusual traffic',
                        "verify it's you",
                        'verify it’s you',
                        "confirm it's you",
                        'confirm it’s you',
                    ];
                    for (const candidate of markers) {
                        if (text.includes(candidate)) return candidate;
                    }
                    if ((window.location.pathname || '').includes('/challenge/')) {
                        return 'google challenge';
                    }
                    return '';
                }"""
            )
        ).strip()
        return marker or None
    except Exception:
        return None