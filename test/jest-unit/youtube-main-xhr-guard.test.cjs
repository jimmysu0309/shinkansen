'use strict';

/**
 * 批次 8 C7（code review 2026-08-03）:content-youtube-main.js MAIN world XHR patch
 * 讀 responseText 的防禦。
 *
 * 背景 bug(潛在):readystatechange listener 直接讀 this.responseText——若 YouTube
 * 對 timedtext 改用 `xhr.responseType = 'json'` / `'arraybuffer'`,讀 responseText
 * 依 XHR spec 直接 throw InvalidStateError → 例外落在宿主頁的事件回呼(頁面層
 * unhandled error)且攔截靜默失效。monkey-patch 對宿主頁的防禦原則:絕不往頁面丟例外。
 *
 * 修法:listener 整段 try/catch + responseType 檢查(非 text 型直接放棄攔截)。
 *
 * 驗的訊號層:patched send 的 readystatechange 回呼對「responseText 會 throw 的
 * XHR」不外洩例外、對正常 text XHR 照常 dispatch CAPTION_EVENT。
 * 不驗:真實 YouTube 播放器的請求形態(harness 抓不到 MAIN world patch 時序)。
 *
 * SANITY 紀錄(已驗證,2026-08-05):把 content-youtube-main.js 的 try/catch +
 * responseType 檢查暫時拆回裸讀 → 「responseType=json 不外洩例外」case fail
 * (收到 InvalidStateError throw)→ 還原後 pass。
 */

const path = require('path');
const fs = require('fs');
const vm = require('vm');

function makeSandbox() {
  const dispatched = [];
  const winListeners = {};
  const win = {
    addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); },
    removeEventListener: () => {},
    dispatchEvent: (ev) => { dispatched.push(ev); return true; },
    fetch: async () => ({ clone: () => ({ text: async () => '' }) }),
  };

  class FakeXHR {
    constructor() {
      this._listeners = {};
      this.readyState = 0;
      this.status = 0;
      this.responseType = '';
    }
    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
    fire(t) { for (const fn of (this._listeners[t] || [])) fn.call(this); }
    open() {}
    send() {}
  }

  class FakeCustomEvent {
    constructor(type, opts) { this.type = type; this.detail = opts?.detail; }
  }

  const ctx = vm.createContext({
    window: win,
    XMLHttpRequest: FakeXHR,
    CustomEvent: FakeCustomEvent,
    JSON, console, setTimeout, clearTimeout,
  });
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../shinkansen/content-youtube-main.js'),
    'utf-8',
  );
  vm.runInNewContext(src, ctx, { filename: 'content-youtube-main.js' });
  return { ctx, FakeXHR, dispatched };
}

describe('批次 8 C7:MAIN world XHR patch 不往宿主頁丟例外', () => {
  test('responseType=json + responseText getter throw → 回呼吞掉例外,不 dispatch', () => {
    const { FakeXHR, dispatched } = makeSandbox();
    const xhr = new FakeXHR();
    xhr.open('GET', '/api/timedtext?v=abc');
    xhr.send();
    xhr.readyState = 4;
    xhr.status = 200;
    xhr.responseType = 'json';
    Object.defineProperty(xhr, 'responseText', {
      get() { throw new Error('InvalidStateError: responseText only for text type'); },
    });
    expect(() => xhr.fire('readystatechange')).not.toThrow();
    expect(dispatched.filter((e) => e.type === 'shinkansen-yt-captions').length).toBe(0);
  });

  test('對照組:一般 text XHR 照常 dispatch CAPTION_EVENT', () => {
    const { FakeXHR, dispatched } = makeSandbox();
    const xhr = new FakeXHR();
    xhr.open('GET', '/api/timedtext?v=abc');
    xhr.send();
    xhr.readyState = 4;
    xhr.status = 200;
    xhr.responseText = '{"events":[]}';
    xhr.fire('readystatechange');
    const evs = dispatched.filter((e) => e.type === 'shinkansen-yt-captions');
    expect(evs.length).toBe(1);
    expect(evs[0].detail.responseText).toBe('{"events":[]}');
  });

  test('對照組:非 timedtext URL 不掛 listener、不 dispatch', () => {
    const { FakeXHR, dispatched } = makeSandbox();
    const xhr = new FakeXHR();
    xhr.open('GET', '/api/other');
    xhr.send();
    xhr.readyState = 4;
    xhr.status = 200;
    xhr.responseText = 'x';
    xhr.fire('readystatechange');
    expect(dispatched.filter((e) => e.type === 'shinkansen-yt-captions').length).toBe(0);
  });
});
