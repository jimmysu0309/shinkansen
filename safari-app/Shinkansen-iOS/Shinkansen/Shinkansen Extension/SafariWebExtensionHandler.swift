//
//  SafariWebExtensionHandler.swift
//  Shinkansen Extension
//
//  Created by Jimmy Su on 2026/6/5.
//

import SafariServices
import os.log

// App Group：與 host app 共享的 UserDefaults suite（SPEC-PRIVATE §26.12）。
// 此 handler 跑在 appex（extension 程序），讀得到 host app（主程序）寫進同一 App Group 的值。
private let appGroupID = "group.app.shinkansen.ios"

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        os_log(.default, "Received message from browser.runtime.sendNativeMessage: %@", String(describing: message))

        // background.js 的 pullHostSettings 會送 { action: "pullHostSettings" }；
        // 回傳 host app 寫進 App Group 的設定。
        // pushExtSettings { action, apiKey, model } 則反過來把 extension 現值寫進 App Group,
        // 供 host app 設定畫面回填真值（避免顯示舊值、儲存時覆寫）。其餘訊息維持 echo。
        // 心跳：任何來自 extension 的訊息都代表「擴充功能已在 Safari 啟用且 background 有跑」。
        // 寫進 App Group 的 extLastSeen，host app onboarding 讀它顯示「已啟用 ✓」——iOS 沒有
        // macOS 那種 getStateOfSafariExtension API，這是唯一能讓使用者確認自己做對了的訊號。
        markExtensionSeen()

        var payload: [String: Any]
        if let dict = message as? [String: Any],
           let action = dict["action"] as? String {
            switch action {
            case "pullHostSettings":
                payload = readHostSettings()
            case "pushExtSettings":
                payload = writeExtSettings(dict)
            default:
                payload = ["echo": message as Any]
            }
        } else {
            payload = ["echo": message as Any]
        }

        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [ SFExtensionMessageKey: payload ]
        } else {
            response.userInfo = [ "message": payload ]
        }

        context.completeRequest(returningItems: [ response ], completionHandler: nil)
    }

    // 讀 App Group 共享 UserDefaults 內 host app 寫的設定。
    // seq 一律回（即使 0，代表 host 還沒存過）；apiKey / model 有才回。
    private func readHostSettings() -> [String: Any] {
        guard let defaults = UserDefaults(suiteName: appGroupID) else {
            return ["seq": 0]
        }
        var out: [String: Any] = ["seq": defaults.integer(forKey: "hostSettingsSeq")]
        if let apiKey = defaults.string(forKey: "hostApiKey") {
            out["apiKey"] = apiKey
        }
        if let model = defaults.string(forKey: "hostModel") {
            out["model"] = model
        }
        return out
    }

    private func markExtensionSeen() {
        guard let defaults = UserDefaults(suiteName: appGroupID) else { return }
        defaults.set(Date().timeIntervalSince1970, forKey: "extLastSeen")
    }

    // 把 extension 推來的現值寫進 App Group 的 extApiKey / extModel（與 host* 分開,
    // 不碰 seq → 不觸發 host→ext 的 pull 迴圈）。供 ViewController.sendSettingsToPage 優先讀取。
    // apiKey 一律寫（含空字串=已清空,要如實反映）；model 僅接受三選一,空字串 / 非法 →
    // 清掉 extModel 讓 host fallback 回 hostModel（自訂引擎無法用三選一表示時的退路）。
    private func writeExtSettings(_ dict: [String: Any]) -> [String: Any] {
        guard let defaults = UserDefaults(suiteName: appGroupID) else {
            return ["ok": false]
        }
        if let apiKey = dict["apiKey"] as? String {
            defaults.set(apiKey, forKey: "extApiKey")
        }
        if let model = dict["model"] as? String, ["flash", "lite", "google"].contains(model) {
            defaults.set(model, forKey: "extModel")
        } else {
            defaults.removeObject(forKey: "extModel")
        }
        // 「所有網站」存取權狀態（background 用 permissions.contains 查得）。訊息沒帶 = 未知，不動舊值。
        if let allUrls = dict["allUrls"] as? Bool {
            defaults.set(allUrls, forKey: "extAllUrls")
        }
        return ["ok": true]
    }

}
