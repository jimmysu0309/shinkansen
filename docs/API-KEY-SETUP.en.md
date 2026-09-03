**English** | [繁體中文](API-KEY-SETUP.md)

# Shinkansen — Google Gemini API key setup guide

> This guide walks you through getting a Gemini API key so Shinkansen can translate with Google Gemini. It takes about 2 minutes. The key is free, stays on your device and is never uploaded anywhere

### Step 1: Open the API Keys page and sign in

**Open this link directly: [aistudio.google.com/api-keys](https://aistudio.google.com/api-keys)**

1. Sign in with your Google account (you'll be sent straight back to the API Keys page)
2. On your first visit to Google AI Studio you'll be asked to accept the terms of service — tick the box and click "Continue"

> Don't start from the AI Studio home page — that's the chat interface, and the API Keys entry is tucked away in the left sidebar (on a phone it's behind the menu button too). The direct link above is the fastest route

### Step 2: Create an API key

1. Click "**Create API key**" in the **top right** of the page
2. "Name your key" can stay as the default, or use `Shinkansen` so you recognise it later
3. "Choose an imported project" can stay as the default (if there is none, choose "Create new project")
4. Click "**Create key**"

The key appears immediately, in the form `AIzaSy...` (around 39 characters). Click the copy icon next to it to copy the whole string

> **Tip**: you can always return to the API Keys page later and copy the key again — no need to worry if you miss it the first time

### Step 3: Paste it into Shinkansen

**Chrome / Firefox / Mac**

1. Click the Shinkansen toolbar icon → "Settings" (the settings page opens automatically right after installation)
2. Paste the key into the "**Gemini API Key**" field. It is checked automatically as soon as you paste (you can also click "Test" to re-check), and settings save automatically
3. Open any English web page and press Option+S (Mac) or Alt+S (Windows) to try a translation

**iPhone / iPad**

1. Open the Shinkansen app — step 2 of the first-launch guide is where you paste the key (later, use "API Key & default translator" on the home screen)
2. The key is checked automatically after pasting; tap "Done" or "Save" and it syncs to the Safari extension

### Step 4 (optional): Add a billing method to lift free-tier limits

The free tier has **RPD** (requests per day), **RPM** (requests per minute) and **TPM** (tokens per minute) limits. It's usually enough for everyday reading; add a card if you translate a lot or want advanced models such as Pro

1. Open [Google AI Studio](https://aistudio.google.com/)
2. Click "**Billing**" in the left menu → "**Set up billing**"
3. Enter your payment info (name, address, credit card)
4. After submission, AI Studio automatically upgrades your project to Tier 1, raising RPD / RPM limits and unlocking advanced models like Pro

**Monthly spending cap**: Google enforces a $250 USD per-month cap on Tier 1 accounts. This is a safety mechanism to prevent unexpected runaway bills

*Last updated: 2026-09-03*
