import UIKit
import WebKit

/// Card Market for iPhone: the same site as the web version, full screen, so the two never drift apart.
/// The address comes from CardMarketURL in Info.plist (set by the build). Links to TCGplayer, eBay and
/// PriceCharting open in Safari (or their own app); everything else stays in here.

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = MainViewController()
        window?.makeKeyAndVisible()
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { UpdateCheck.run() }   // a newer build in AltStore?
        return true
    }
}

let siteURL = URL(string: Bundle.main.object(forInfoDictionaryKey: "CardMarketURL") as? String ?? "")
    ?? URL(string: "https://card-market.pages.dev")!
let ink = UIColor(red: 0.055, green: 0.075, blue: 0.114, alpha: 1)     // #0e131d, the site's dark background
let paper = UIColor(red: 0.957, green: 0.961, blue: 0.976, alpha: 1)   // #f4f5f9, light background

final class MainViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private var web: WKWebView!
    private let offline = UIView()
    private let offlineText = UILabel()
    private var loadedOnce = false

    override func viewDidLoad() {
        super.viewDidLoad()
        let bg = UIColor { $0.userInterfaceStyle == .dark ? ink : paper }
        view.backgroundColor = bg

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()          // keeps the sign-in, cached prices and offline search
        config.allowsInlineMediaPlayback = true
        config.applicationNameForUserAgent = "CardMarketApp/1"
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.isOpaque = false
        web.backgroundColor = bg
        web.scrollView.backgroundColor = bg
        web.scrollView.contentInsetAdjustmentBehavior = .never   // the page pads itself for the notch and home bar
        let refresh = UIRefreshControl()
        refresh.addTarget(self, action: #selector(pulled(_:)), for: .valueChanged)
        web.scrollView.refreshControl = refresh
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.topAnchor), web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor), web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        buildOffline(bg)
        web.load(URLRequest(url: siteURL))
        NotificationCenter.default.addObserver(self, selector: #selector(cameBack), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    private func buildOffline(_ bg: UIColor) {
        offline.backgroundColor = bg
        offline.isHidden = true
        offline.translatesAutoresizingMaskIntoConstraints = false
        offlineText.numberOfLines = 0
        offlineText.textAlignment = .center
        offlineText.font = .preferredFont(forTextStyle: .body)
        offlineText.textColor = .secondaryLabel
        let retry = UIButton(type: .system)
        retry.setTitle("Try again", for: .normal)
        retry.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        retry.addTarget(self, action: #selector(reload), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [offlineText, retry])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        offline.addSubview(stack)
        view.addSubview(offline)
        NSLayoutConstraint.activate([
            offline.topAnchor.constraint(equalTo: view.topAnchor), offline.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            offline.leadingAnchor.constraint(equalTo: view.leadingAnchor), offline.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: offline.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: offline.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: offline.trailingAnchor, constant: -32),
        ])
    }

    @objc private func pulled(_ c: UIRefreshControl) { web.reload(); DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { c.endRefreshing() } }
    @objc private func reload() { offline.isHidden = true; web.load(URLRequest(url: web.url ?? siteURL)) }
    @objc private func cameBack() { if !offline.isHidden { reload() } }

    // Same site stays in the app; anything else (TCGplayer, eBay, PriceCharting) goes to Safari or its app.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        let inside = url.host == siteURL.host || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data"
        if inside { return decisionHandler(.allow) }
        if ["http", "https", "mailto", "tel"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
        decisionHandler(.cancel)
    }

    // target=_blank links on the same site (rare) open in place.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if url.host == siteURL.host { webView.load(action.request) } else { UIApplication.shared.open(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loadedOnce = true; offline.isHidden = true }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    private func failed(_ error: Error) {
        let e = error as NSError
        if e.code == NSURLErrorCancelled { return }
        // Once the page has loaded, its own offline cache handles bad signal; only cover a cold start with no connection.
        if loadedOnce { return }
        offlineText.text = "Can't reach Card Market right now.\n\(e.localizedDescription)"
        offline.isHidden = false
    }

    // Alerts and confirms from the page (e.g. "remove from collection?").
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(a, animated: true)
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .default }
}
