# Classroom Bridge

Classroom Bridge is a prototype for operating a Windows classroom PC from an iPad while mirroring the iPad app to the classroom display. The iPad interface keeps the PC or camera/photo view full-screen, with setup and teaching tools in separate panels.

## What is included

- `public/`: Home Screen web app, full-screen PC/camera/photo views, Apple Pencil ink, keyboard shortcuts, and explicit clipboard tools.
- `worker.js`: short-lived pairing and WebRTC signaling. It does not relay the screen or camera media.
- `pc-companion/companion_ui.py`: double-click Windows companion window with a pairing code and status.
- `pc-companion/agent.py`: Windows screen capture, remote mouse/keyboard, and WebRTC signaling.
- `wrangler.toml`: Cloudflare Worker, static asset, and free-tier SQLite Durable Object configuration.

## Current prototype limits

- The Windows PC must remain awake, logged in, and running the companion.
- iPad and PC need working internet access for signaling and a network path that permits direct WebRTC media. School Wi-Fi may block peer connections; this prototype has no TURN relay fallback.
- Screen pixels, the iPad camera and control input travel directly between PC and iPad when WebRTC connects. Pairing offer/answer data passes through Cloudflare; no video does.
- Camera / visualiser: tap **Camera** and the iPad camera starts and appears full-screen on the classroom display (live video up to 1080p, sent peer-to-peer). The round shutter captures a full-quality photo (up to 4K) into the filmstrip. Photos are grouped into named **lessons** kept on the iPad (IndexedDB) until deleted; each photo keeps its own annotations and adjustments.
  - Annotation (left toolbar): pen, highlighter, shapes (line, arrow, rectangle, ellipse, highlight box), text, marking stamps (✓ ✗ ★ ? and counting numbers), laser pointer, whole-item eraser, colours, sizes, undo/redo, clear. The PC draws the same items from the same geometry (`public/vis-items.js` ⇄ `pc-companion/visualiser.py`).
  - Presenting (right side): rotate, brightness/contrast/black & white with **Document** presets, spotlight, curtain, video recording (with the microphone if allowed), **Hold** (freeze the projector) and **Blank**. Pinch a photo to zoom and pan; the projector follows.
  - Photos (top bar and **＋**): compare 2–4 photos side by side, crop & straighten a page by its corners, whiteboard pages (blank, lined, squared, dotted, music staff, chalkboard), time-lapse capture, save to iPad (share sheet) or to the PC (`Documents/Classroom Bridge/<date>/`, OneDrive-synced if Documents is), and export a lesson as a PDF.
  - In live view a finger taps to focus (only if Safari supports it) and pinches to zoom; once an Apple Pencil is used, a finger no longer draws, so a resting hand leaves no marks. Two fingers always zoom and pan photos.
- Apple Pencil ink is drawn over the iPad's PC view. It appears on the mirrored TV but is not written into the PowerPoint file.
- Pinching the PC view also invokes the host computer's built-in screen magnifier, so the zoom is visible on the classroom display. Windows uses Magnifier; Mac requires **System Settings → Accessibility → Zoom → Use keyboard shortcuts to zoom**. Magnification is stepped on the host and resets with the iPad's `1×` control or when the app disconnects.
- The app offers PC mouse control, typed text, a limited set of Windows shortcut keys, and user-initiated text clipboard transfer in either direction. It is not a production remote-support product.
- The companion creates a random pairing code once and saves it in the signed-in user's local application data. It stays the same across companion restarts on that computer and account. If opted in, the iPad browser also saves the code locally. Keep the code private; it is the key used to join the companion while it is running.
- Clipboard access is user-initiated. iPad browser clipboard permissions may prompt or block reads; use the on-screen typing field or manually copy text if the browser refuses. See [WebKit's Async Clipboard API notes](https://webkit.org/blog/10855/async-clipboard-api/).
- The companion should only be installed and used on a school-approved PC. It can view and control the logged-in Windows desktop.

## iPad apps (OneDrive, PowerPoint, PDFs)

To teach from any iPad app with its own Apple Pencil tools, the teacher mirrors the iPad to the classroom PC exactly as they would to an Apple TV: Control Centre → **Screen Mirroring** → **Classroom Bridge - _PC name_**. The first time, the iPad asks for the 4-digit PIN shown in the companion window; after that the PC remembers that iPad. While one iPad is mirroring, no other device can take over. Video goes directly over the school network (hardware H.264), so pen writing stays smooth, and nothing passes through Cloudflare.

- **Windows:** the companion bundles [UxPlay](https://github.com/FDH2/UxPlay), a free GPL-licensed AirPlay receiver (licences are in `airplay/licenses`). It starts and stops with the companion and shows the mirrored iPad full-screen. It uses UxPlay's built-in discovery, so Apple Bonjour is not needed. Windows asks once to allow it through the firewall (fixed ports TCP 7000, 7001, 7100 and UDP 6000, 6001, 7011, plus mDNS UDP 5353); school IT may need to approve this.
- **Mac:** macOS has a built-in AirPlay Receiver (System Settings → General → AirDrop & Handoff), so nothing extra is bundled.
- The **iPad apps** button in the web app shows these steps with the PC's exact name and PIN, and checks the receiver, its Bluetooth beacon, the firewall, and whether the iPad and PC reach each other directly.

### When the PC isn't listed under Screen Mirroring

iPads find AirPlay receivers with mDNS (Bonjour), which only reaches devices on the same network segment. School networks often put iPads and PCs on different Wi-Fi networks or VLANs, or stop Wi-Fi devices from seeing each other, and let only registered Apple TVs through (a Bonjour gateway such as Cisco or Aruba AirGroup). So an Apple TV appearing does not mean the PC can.

- **Bluetooth beacon (no IT change needed):** on Windows the companion also advertises the receiver over Bluetooth LE, the way UxPlay's `uxplay-beacon.py` does. An iPad near the PC then lists it and connects over the normal network. The PC needs Bluetooth 4.0 or later that can advertise; most laptops have it, and a USB Bluetooth adapter works on a desktop. The companion window says whether the beacon is on.
- **The iPad must still be able to reach the PC's address** (TCP 7000, 7001, 7100 and UDP 6000, 6001, 7011). The **iPad apps** panel's last check shows this: if the iPad and PC "only reach each other through the internet", the network is keeping them apart and IT needs to allow it.
- **For IT:** add the classroom PCs to the AirPlay/Bonjour gateway the way the Apple TVs are, or allow traffic from the iPad network to the PCs on those ports. The MSI's firewall rule for the receiver accepts connections from any address (not only the PC's own subnet) for this reason; connections still need the receiver's PIN.

## Teacher setup

Teachers should use the packaged Windows application, not Python or PowerShell. Open `ClassroomBridge.exe`, choose **Start companion**, and enter the displayed code in Classroom Bridge on the iPad. Keep the PC window open for the lesson and choose **Stop** when finished.

The Windows executable is produced by the GitHub Actions workflow at `.github/workflows/build-windows-companion.yml`. After the source is in a GitHub repository, run **Build Windows companion** from the Actions tab and download the `ClassroomBridge-Windows-x64` artifact. The workflow is configured to build automatically when companion source changes are pushed. The executable is unsigned; school security may block it, in which case school IT must review and approve it. Do not bypass school security controls.

The companion captures and controls the signed-in Windows desktop after the iPad pairs. Use it only on a school-approved PC and close it when finished.

## Everyday use

- **Opens by itself:** the companion connects as soon as it opens, reconnects after a network drop or sleep, and (after the first run) opens automatically at sign-in, quietly in the background. Closing its window keeps it running — in the system tray on Windows, in the Dock on a Mac. The window has a switch to stop opening at sign-in, and **Quit** to stop completely.
- **Pair by QR code:** the companion window shows a QR code; on the iPad tap ⚙ → **Scan QR code**. The code is a link (`…/#pair=CODE`), so scanning it with the iPad Camera app also pairs. The QR reader (jsQR, Apache-2.0) is bundled in `public/vendor/` so it works on locked-down networks.
- **Save PC screen** (⎙ in PC mode): the PC captures its whole screen, including Apple Pencil ink on its overlay, and the photo is added to the current lesson, so it appears in the filmstrip and the lesson PDF.
- **Camera in a corner** (◳ in PC mode): the live iPad camera appears in a corner of the PC display over a slide; move it between corners, change its size (S/M/L) or hide it from the preview on the iPad.

## School IT: Windows installer (MSI)

Each Windows build also produces `ClassroomBridge-Windows-x64.msi` (WiX Toolset 5, `installer/ClassroomBridge.wxs`): a per-machine install into Program Files with a Start menu entry, Windows Firewall rules for the AirPlay receiver (local subnet only), and opening at sign-in for every user. Silent install: `msiexec /i ClassroomBridge-Windows-x64.msi /qn` (add `AUTOSTART=0` to skip opening at sign-in). New MSIs upgrade in place.

MSI installs update themselves: the MSI registers a scheduled task, **Classroom Bridge Updater**, that runs as the system account three minutes after start-up and once a day. It checks the downloads page, verifies the newest MSI against its published SHA-256 fingerprint and installs it silently, keeping the `AUTOSTART` choice. It never updates while the companion is open, so a PC that stays on all day updates when it next starts. The log is `C:\Program Files\Classroom Bridge\update.log`. To manage updates yourself, install with `AUTOUPDATE=0` (or set `AutoUpdate` to `0` under `HKLM\Software\Classroom Bridge`). The task runs as the system account and uses the PC's own internet access; behind a proxy that needs a signed-in user, set the machine proxy (`netsh winhttp set proxy`) or deploy MSIs yourself. Whoever can publish to the downloads repository (the `DOWNLOADS_TOKEN` secret) controls what these PCs install, so keep that token private.

CI installs the MSI on a Windows runner, checks files, firewall rules, the shortcut, the sign-in entry and the updater task, runs the task, upgrades through it to a newer test MSI, then uninstalls and checks nothing is left.

## Code signing

Unsigned apps trigger Windows SmartScreen and macOS Gatekeeper warnings. The build workflows sign automatically once these repository secrets exist, and skip signing until then:

- **Windows** — Microsoft Trusted Signing (Azure Artifact Signing, about US$10/month): `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (an app registration with the *Artifact Signing Certificate Profile Signer* role), `SIGNING_ENDPOINT` (e.g. `https://weu.codesigning.azure.net/`), `SIGNING_ACCOUNT`, `SIGNING_PROFILE`. Microsoft decides eligibility (identity validation; individual developers have been limited to some countries, organisations need verifiable history) — a school or trust may need to own the account.
- **macOS** — Apple Developer Program (about £79/year): `MACOS_CERTIFICATE` (base64 of a *Developer ID Application* .p12), `MACOS_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` (an app-specific password). The app is signed with the hardened runtime (`installer/macos-entitlements.plist`), notarised and stapled.

## Companion downloads and updates

Each companion build on `main` or the development branch is published as a release of the public [classroom-bridge-downloads](https://github.com/Khodell93/classroom-bridge-downloads/releases/latest) repository (only the built apps; this source repository stays private). Installed companions check those releases when they open and every six hours. With **Install updates automatically** ticked (the default), a newer build installs by itself — straight after opening, or later once no iPad is connected and the computer has been unused for 20 minutes — so a lesson is never interrupted. It downloads the update, checks it against the published SHA-256, replaces the app and reopens it (hidden again if it was running in the background). Untick the box to update only with **Update now**. MSI installs update through their scheduled task instead (above). Either way, a yellow banner in the companion window says when a newer version is available; on an MSI install its **Update now** starts the updater task (teachers are allowed to run it) and the companion reopens when the update is in.

Only one companion runs per sign-in: opening it again shows the running one, and the MSI copy closes any downloaded copy (and removes that copy's sign-in entry), because two companions with the same pairing code keep disconnecting each other. On a Mac the app must be in a folder the account can write to (normally Applications), not run directly from Downloads.

Publishing needs a `DOWNLOADS_TOKEN` repository secret: a fine-grained personal access token limited to `classroom-bridge-downloads` with **Contents: Read and write**. Without it, builds still succeed and skip publishing.

## Automatic deploys

The **Deploy web app** workflow publishes the iPad web app and Worker whenever they change on `main` or the development branch. It needs two repository secrets, added once:

1. In Cloudflare, go to **My Profile → API Tokens → Create Token**, use the **Edit Cloudflare Workers** template, choose your account, and create it. Copy the token.
2. Copy your **Account ID** from the Cloudflare dashboard (Workers & Pages overview, right-hand side).
3. In GitHub, open the repository's **Settings → Secrets and variables → Actions → New repository secret** and add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. Run it once from **Actions → Deploy web app → Run workflow**.

Until the secrets exist the workflow just shows a warning and skips the deploy.

## Deploy to your Cloudflare account

Cloudflare Workers Free currently includes Durable Objects within documented limits. The WebSocket Durable Object uses the hibernation API so an idle pairing session does not stay actively executing. Free quotas can still be exceeded, at which point requests may fail. Review the current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) before deployment.

From this directory, install Wrangler and sign in:

```sh
npm install
npx wrangler login
```

Then deploy:

```sh
npm run deploy
```

Wrangler prints a `workers.dev` URL. Use that URL on the iPad. For developer testing only, the Python companion can be launched from PowerShell:

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
py -m pip install -r pc-companion\requirements.txt
py pc-companion\agent.py --signal wss://YOUR-WORKER-URL
```

The command-line companion prints a 12-character pairing code. Enter it in Classroom Bridge on the iPad. Select **PC** or **Camera**, then use Control Centre's **Screen Mirroring** to mirror the iPad to the classroom TV.

For Home Screen installation, open the deployed URL in Safari, tap Share, then **Add to Home Screen**. Allow camera access when asked. If the school account blocks Worker deployment, ask the Cloudflare administrator to authorize it; do not switch the account to a paid plan just to test this prototype.

## Development

```sh
npm install
npm run dev
```

The local preview does not run the Windows companion end to end unless the companion is configured to connect to the same locally running Worker endpoint.
