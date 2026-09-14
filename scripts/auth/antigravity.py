#!/usr/bin/env python3
"""
Antigravity OAuth Authentication Script
Uses Playwright to authenticate with Google Cloud Code Assist and extract tokens.
"""

import asyncio
import json
import os
import sys
import time
import requests
from playwright.async_api import async_playwright, BrowserContext, Page


ANTIGRAVITY_CONFIG = {
    "auth_url": "https://console.cloud.google.com/code-assist",
    "oauth_client_id": "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com",
    "redirect_uri": "https://console.cloud.google.com/code-assist/oauth/callback",
}


async def extract_tokens_from_page(page: Page) -> dict | None:
    """Try to find OAuth tokens in page responses or local storage."""
    
    # Check network responses for access tokens
    responses = []
    
    async def on_response(response):
        try:
            if response.url and "token" in response.url.lower():
                body = await response.text()
                try:
                    data = json.loads(body)
                    if "access_token" in data:
                        responses.append(data)
                except:
                    pass
        except:
            pass
    
    page.on("response", on_response)
    
    # Also check localStorage after page load
    await page.wait_for_load_state("networkidle")
    
    # Try to access token from various common locations
    try:
        local_storage = await page.evaluate("localStorage")
        
        for key, value in local_storage.items():
            try:
                parsed = json.loads(value)
                if isinstance(parsed, dict):
                    if "accessToken" in parsed and "projectId" in parsed:
                        return parsed
            except:
                continue
    except:
        pass
    
    return None if not responses else responses[0]


async def authenticate_with_google(
    email: str | None = None,
    headless: bool = True,
    save_context: bool = True,
) -> dict | None:
    """
    Authenticate with Google Cloud Code Assist via manual login flow.
    
    This requires you to manually enter credentials in the browser window.
    Once logged in, it extracts the access token and project ID.
    """
    
    context_options = {
        "viewport": {"width": 1920, "height": 1080},
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    }
    
    if email and save_context:
        context_path = f".playwright_antigravity_{email}"
        if os.path.exists(context_path):
            context_options["storage_state"] = context_path
            print(f"Using existing session for {email}")
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=headless)
        
        if email and save_context and not os.path.exists(f".playwright_antigravity_{email}"):
            context = await browser.new_context(**context_options)
            page = await context.new_page()
            
            # Navigate to Cloud Code Assist
            print(f"Opening Google Cloud Code Assist...")
            await page.goto(ANTIGRAVITY_CONFIG["auth_url"], wait_until="domcontentloaded")
            
            # Wait for user to complete authentication
            print("Waiting for you to complete Google sign-in...")
            print("- Open the browser window that just appeared")
            print("- Sign in with your Google account")
            print("- Grant permissions to Cloud Code Assist")
            print("- Once done, this script will continue automatically")
            
            # Wait for navigation callback or timeout
            try:
                await asyncio.wait_for(
                    page.goto(ANTIGRAVITY_CONFIG["redirect_uri"], wait_until="commit"),
                    timeout=300  # 5 minutes timeout
                )
            except asyncio.TimeoutError:
                print("No redirect detected yet. Checking current page for tokens...")
            
            # Extract tokens from either location
            tokens = await extract_tokens_from_page(page)
            
            if tokens:
                # Save context for future use
                context_path = f".playwright_antigravity_{email}"
                await context.storage_state(path=context_path)
                print(f"\n✓ Tokens extracted successfully!")
                print(f"Access token: {tokens.get('accessToken', '***')[0:20]}...")
                print(f"Project ID: {tokens.get('projectId', '***')}")
                
                await browser.close()
                return {
                    "accessToken": tokens.get("accessToken"),
                    "projectId": tokens.get("projectId"),
                    "refreshToken": tokens.get("refreshToken"),
                }
            
            await browser.close()
            print("\n✗ Failed to extract tokens. Please try again.")
            return None
        
        else:
            # Resume existing session or new flow
            context = await browser.new_context(**context_options)
            page = await context.new_page()
            
            print(f"Navigating to Google Cloud Code Assist...")
            await page.goto(ANTIGRAVITY_CONFIG["auth_url"], wait_until="domcontentloaded")
            
            try:
                await asyncio.wait_for(
                    page.goto(ANTIGRAVITY_CONFIG["redirect_uri"], wait_until="commit"),
                    timeout=120
                )
            except asyncio.TimeoutError:
                print("Waiting for authentication completion...")
                await asyncio.sleep(5)
            
            tokens = await extract_tokens_from_page(page)
            await browser.close()
            
            return tokens


async def extract_project_id_and_token(auth_code: str | None = None) -> dict:
    """
    Alternative method: Directly fetch credentials using OAuth code exchange.
    Requires manual extraction of authorization code first.
    """
    
    if not auth_code:
        print("\n=== Manual Token Extraction ===")
        print("Follow these steps:")
        print("1. Visit: https://accounts.google.com/o/oauth2/v2/auth?client_id=YOUR_CLIENT_ID&redirect_uri=https://console.cloud.google.com/code-assist/oauth/callback&scope=https://www.googleapis.com/auth/cloud-code-assistant.userinfo&response_type=code&access_type=offline")
        print("2. Sign in and grant permissions")
        print("3. Copy the 'code' parameter from the redirect URL")
        print("=" * 50)
        
        auth_code = input("\nEnter authorization code: ").strip()
        
        if not auth_code:
            raise ValueError("Authorization code required")
    
    # Exchange code for tokens
    token_response = requests.post(
        ANTIGRAVITY_CONFIG["token_url"],
        data={
            "grant_type": "authorization_code",
            "code": auth_code,
            "client_id": ANTIGRAVITY_CONFIG["oauth_client_id"],
            "client_secret": os.environ.get("GOOGLE_CLIENT_SECRET", ""),
            "redirect_uri": ANTIGRAVITY_CONFIG["redirect_uri"],
        },
    )
    
    if not token_response.ok:
        raise RuntimeError(f"Failed to exchange code: {token_response.text}")
    
    tokens = token_response.json()
    
    # Get project ID from user info endpoint
    userinfo_response = requests.get(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        headers={"Authorization": f"Bearer {tokens['access_token']}"},
    )
    
    if not userinfo_response.ok:
        raise RuntimeError("Failed to get user info")
    
    user_info = userinfo_response.json()
    
    return {
        "accessToken": tokens["access_token"],
        "refreshToken": tokens.get("refresh_token"),
        "expiresAt": int(time.time()) + tokens.get("expires_in", 3600),
        "projectId": user_info.get("id"),  # Or parse from a separate API call
    }


def main():
    """Main entry point for CLI usage."""
    
    import argparse
    
    parser = argparse.ArgumentParser(description="Authenticate with Google Cloud Code Assist (Antigravity)")
    parser.add_argument("--email", type=str, help="Email address for persistent session")
    parser.add_argument("--headless", action="store_false", default=True, help="Run browser in headless mode")
    parser.add_argument("--extract-code", action="store_true", help="Extract auth code instead of automated flow")
    
    args = parser.parse_args()
    
    try:
        if args.extract_code:
            tokens = asyncio.run(extract_project_id_and_token())
        else:
            tokens = asyncio.run(
                authenticate_with_google(email=args.email, headless=args.headless)
            )
        
        if tokens:
            # Output tokens as JSON
            print("\n" + "=" * 50)
            print("AUTH SUCCESS - Tokens:")
            print(json.dumps(tokens, indent=2))
            print("=" * 50)
            
            # Optionally save to file
            output_file = os.environ.get("ANTEGRAVITY_TOKENS_FILE", ".antigravity-tokens.json")
            with open(output_file, "w") as f:
                json.dump(tokens, f, indent=2)
            print(f"\nTokens saved to {output_file}")
            
            return 0
        else:
            print("\nAuthentication failed")
            return 1
            
    except KeyboardInterrupt:
        print("\nCancelled by user")
        return 1
    except Exception as e:
        print(f"\nError: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return 2


if __name__ == "__main__":
    sys.exit(main())
