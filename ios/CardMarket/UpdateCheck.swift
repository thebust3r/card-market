import UIKit

/// Looks at the Card Market AltStore source now and then. When there's a newer build of this app, it says so once,
/// with a button that opens AltStore (where the Update button is). iPhone apps can't install their own updates.
enum UpdateCheck {
    static let source = URL(string: "https://raw.githubusercontent.com/thebust3r/card-market/main/altstore-source.json")!

    static func run() {
        let prefs = UserDefaults.standard
        let last = prefs.double(forKey: "updateCheckedAt")
        if Date().timeIntervalSince1970 - last < 6 * 3600 { return }          // a few times a day at most
        prefs.set(Date().timeIntervalSince1970, forKey: "updateCheckedAt")
        guard let me = Bundle.main.bundleIdentifier,
              let mine = Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") else { return }
        var req = URLRequest(url: source)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.timeoutInterval = 10
        URLSession.shared.dataTask(with: req) { data, _, _ in
            guard let data = data,
                  let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let apps = j["apps"] as? [[String: Any]],
                  let app = apps.first(where: { $0["bundleIdentifier"] as? String == me }),
                  let v = (app["versions"] as? [[String: Any]])?.first,
                  let newest = Int(v["buildVersion"] as? String ?? "") , newest > mine,
                  prefs.integer(forKey: "updateToldAbout") < newest else { return }
            DispatchQueue.main.async { tell(newest: newest, name: app["name"] as? String ?? "Card Market") }
        }.resume()
    }

    private static func tell(newest: Int, name: String) {
        guard let root = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first?.rootViewController else { return }
        var top = root
        while let p = top.presentedViewController { top = p }
        UserDefaults.standard.set(newest, forKey: "updateToldAbout")
        let a = UIAlertController(title: "\(name) update ready",
                                  message: "A new version is out. Open AltStore and tap Update next to \(name) (in My Apps).",
                                  preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Open AltStore", style: .default) { _ in
            if let u = URL(string: "altstore://") { UIApplication.shared.open(u) }
        })
        a.addAction(UIAlertAction(title: "Later", style: .cancel))
        top.present(a, animated: true)
    }
}
