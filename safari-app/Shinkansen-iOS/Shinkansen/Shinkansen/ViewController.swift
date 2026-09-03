//
//  ViewController.swift
//  Shinkansen
//
//  Created by Jimmy Su on 2026/6/5.
//

import UIKit
import WebKit

class ViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    // App Group：與 Safari extension（appex）共享的 UserDefaults suite。
    // host app 把 onboarding / 設定畫面選的 API Key + 預設模型寫進這裡，extension 的
    // background.js 經 native messaging 拉走（見 Shinkansen Extension/SafariWebExtensionHandler.swift）。
    // SPEC-PRIVATE §26.12。
    private let appGroupID = "group.app.shinkansen.ios"
    private var sharedDefaults: UserDefaults? { UserDefaults(suiteName: appGroupID) }

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self
        // 說明頁內容較長（啟用步驟 + 連結），允許捲動，避免小螢幕被裁切。
        self.webView.scrollView.isScrollEnabled = true

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)

        // 使用者去 Safari / 系統設定啟用擴充功能後切回本 App → 重新讀 App Group 的擴充功能狀態，
        // onboarding「在 Safari 啟用」步驟與主畫面的狀態列即時翻綠，不用重開 App。
        NotificationCenter.default.addObserver(self, selector: #selector(appDidBecomeActive),
                                               name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    @objc private func appDidBecomeActive() {
        sendExtStatusToPage()
    }

    // 外部 http(s) 連結（API Key 教學 / 隱私權 / 主頁 / 版本紀錄）改用系統 Safari 開啟，
    // 不在 host WKWebView 內導覽，避免使用者點完卡在 GitHub 等外部頁回不到說明畫面。
    // 初始 Main.html 是 file:// → scheme 非 http(s) → 照常允許載入。
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased(),
           scheme == "http" || scheme == "https" {
            decisionHandler(.cancel)
            UIApplication.shared.open(url)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // 頁面載好先推一次擴充功能狀態（之後由 didBecomeActive 與頁面主動 getExtStatus 更新）
        sendExtStatusToPage()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        switch action {
        case "saveSettings":
            saveSettings(body)
        case "getSettings":
            sendSettingsToPage()
        case "openSettings":
            openAppSettings()
        case "getExtStatus":
            sendExtStatusToPage()
        default:
            break
        }
    }

    // 開啟系統「設定」。iOS 沒有公開、可上架的深層連結直達「Safari → 擴充功能」那頁
    // （App-Prefs: 私有 scheme 會被 App Review 退件，且 iOS 18+ WEB_EXTENSIONS 子路徑已失效），
    // 故只能用官方 openSettingsURLString 開到本 App 的設定頁，再由說明文字引導使用者前往
    // Safari → 擴充功能開啟 Shinkansen。
    private func openAppSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    // 把 onboarding / 設定畫面選的 API Key + 預設模型寫進 App Group，並遞增 seq
    // （extension 端用 seq > consumedSeq 判斷有沒有新設定要套用）。
    private func saveSettings(_ body: [String: Any]) {
        guard let defaults = sharedDefaults else { return }
        if let apiKey = body["apiKey"] as? String {
            defaults.set(apiKey, forKey: "hostApiKey")
        }
        if let model = body["model"] as? String,
           ["flash", "lite", "google"].contains(model) {
            defaults.set(model, forKey: "hostModel")
        }
        let seq = defaults.integer(forKey: "hostSettingsSeq") + 1
        defaults.set(seq, forKey: "hostSettingsSeq")
    }

    // 設定畫面開啟時回填現值。單一資料源（CLAUDE.md §5）：API Key / 預設模型的「真值」在
    // extension storage,extension 會把現值推進 App Group 的 extApiKey/extModel（見
    // SafariWebExtensionHandler.writeExtSettings + background.js pushExtSettings）。這裡優先讀
    // ext*（extension 真值），讀不到才 fallback hostApiKey/hostModel（host 自己上次寫的、可能過時）。
    // 這樣設定畫面顯示的就是目前真正在用的設定,按儲存只會把同值寫回,不會把現值覆寫清掉。
    private func sendSettingsToPage() {
        guard let defaults = sharedDefaults else { return }
        let apiKey = defaults.string(forKey: "extApiKey") ?? defaults.string(forKey: "hostApiKey") ?? ""
        let model = defaults.string(forKey: "extModel") ?? defaults.string(forKey: "hostModel") ?? ""
        let js = "window.__skApplySettings && window.__skApplySettings(\(jsStringLiteral(apiKey)), \(jsStringLiteral(model)))"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    // 擴充功能狀態 → 頁面。extLastSeen 由 appex handler 在收到任何 extension 訊息時寫入
    // （= 擴充功能已在 Safari 啟用且跑過），extAllUrls 是 background 查到的「所有網站」存取權。
    // iOS 沒有 macOS 的 SFSafariExtensionManager.getStateOfSafariExtension，這是唯一可行的偵測。
    private func sendExtStatusToPage() {
        guard let defaults = sharedDefaults else { return }
        let lastSeen = defaults.double(forKey: "extLastSeen")
        let allUrls: String
        if let v = defaults.object(forKey: "extAllUrls") as? Bool { allUrls = v ? "true" : "false" } else { allUrls = "null" }
        let js = "window.__skApplyExtStatus && window.__skApplyExtStatus({enabled: \(lastSeen > 0), lastSeen: \(lastSeen), allUrls: \(allUrls)})"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    // 把任意字串安全包成 JS 字串字面值（用 JSON 編碼處理引號 / 反斜線 / 換行，
    // 避免 evaluateJavaScript 注入或語法破壞）。
    private func jsStringLiteral(_ s: String) -> String {
        if let data = try? JSONSerialization.data(withJSONObject: [s]),
           let arr = String(data: data, encoding: .utf8) {
            return String(arr.dropFirst().dropLast())   // ["..."] → "..."
        }
        return "\"\""
    }

}
