#!/usr/bin/env python3
"""AMO 版本 release notes 補寫（web-ext --amo-metadata 不保證帶 release_notes，送審後另 PATCH）。

用法：
  tools/release/amo-release-notes.py <version> --en-US <file|text> --zh-TW <file|text> [--dry-run]

憑證讀 ~/.shinkansen-amo-creds（同 firefox-amo-submit.sh：標準 export 兩行或裸值兩行）。
JWT HS256 用標準庫 hmac 自簽，零相依。AMO 限制：release_notes 每語 ≤ 3000 字。
"""
import argparse, base64, hashlib, hmac, json, os, pathlib, sys, time, urllib.request, urllib.error

ADDON = 'shinkansen@jimmy.zm.su'
API = 'https://addons.mozilla.org/api/v5'


def load_creds():
    p = pathlib.Path.home() / '.shinkansen-amo-creds'
    key = secret = None
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' in line and line.startswith('export'):
            k, v = line.split('=', 1)
            v = v.strip().strip('\'"')
            if 'KEY' in k:
                key = v
            elif 'SECRET' in k:
                secret = v
        elif line.startswith('user:'):
            key = line
        else:
            secret = line
    if not key or not secret:
        sys.exit('憑證檔缺 issuer / secret')
    return key, secret


def jwt(key, secret):
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=')
    now = int(time.time())
    header = b64(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode())
    payload = b64(json.dumps({'iss': key, 'jti': os.urandom(8).hex(), 'iat': now, 'exp': now + 240}).encode())
    sig = b64(hmac.new(secret.encode(), header + b'.' + payload, hashlib.sha256).digest())
    return (header + b'.' + payload + b'.' + sig).decode()


def call(method, path, token, body=None):
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': f'JWT {token}', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f'{method} {path} → {e.code}: {e.read().decode()[:500]}')


def text_of(arg):
    p = pathlib.Path(arg)
    return p.read_text().strip() if p.is_file() else arg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('version')
    ap.add_argument('--en-US', dest='en', required=True)
    ap.add_argument('--zh-TW', dest='zh', required=True)
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    notes = {'en-US': text_of(a.en), 'zh-TW': text_of(a.zh)}
    for loc, t in notes.items():
        if len(t) > 3000:
            sys.exit(f'{loc} release notes {len(t)} 字 > 3000')
    key, secret = load_creds()
    token = jwt(key, secret)
    versions = call('GET', f'/addons/addon/{ADDON}/versions/?filter=all_with_unlisted&_={int(time.time())}', token)
    match = [v for v in versions.get('results', []) if v.get('version') == a.version]
    if not match:
        sys.exit(f'AMO 上找不到版本 {a.version}（有：{[v.get("version") for v in versions.get("results", [])][:5]}）')
    vid = match[0]['id']
    print(f'version {a.version} → id {vid}')
    if a.dry_run:
        print(json.dumps(notes, ensure_ascii=False, indent=2)); return
    res = call('PATCH', f'/addons/addon/{ADDON}/versions/{vid}/', jwt(key, secret), {'release_notes': notes})
    got = res.get('release_notes') or {}
    for loc in notes:
        print(f'  {loc}: {len(got.get(loc) or "")} 字')
    # 讀回驗證（帶 cache-buster）
    back = call('GET', f'/addons/addon/{ADDON}/versions/{vid}/?_={int(time.time())}', jwt(key, secret))
    ok = all((back.get('release_notes') or {}).get(loc) == notes[loc] for loc in notes)
    print('讀回一致' if ok else '讀回不一致（AMO 快取可能延遲，稍後再查）')


if __name__ == '__main__':
    main()
