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
- Camera / visualiser: the iPad captures at up to 4K and sends live video (up to 1080p, up to 8 Mbps, tuned for sharp detail) to the companion, which shows it full-screen on the classroom display. **Freeze** sends a full-resolution still; chosen photos are sent the same way (up to 4K). Apple Pencil ink on the camera or photo appears on the classroom display. In live view a finger taps to focus and pinches to zoom; zoom, focus, light and camera switching appear only when the iPad's browser exposes them.
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
- The iPad and PC must be on a network that allows AirPlay discovery between them — if an Apple TV works on that network, this should too.

## Teacher setup

Teachers should use the packaged Windows application, not Python or PowerShell. Open `ClassroomBridge.exe`, choose **Start companion**, and enter the displayed code in Classroom Bridge on the iPad. Keep the PC window open for the lesson and choose **Stop** when finished.

The Windows executable is produced by the GitHub Actions workflow at `.github/workflows/build-windows-companion.yml`. After the source is in a GitHub repository, run **Build Windows companion** from the Actions tab and download the `ClassroomBridge-Windows-x64` artifact. The workflow is configured to build automatically when companion source changes are pushed. The executable is unsigned; school security may block it, in which case school IT must review and approve it. Do not bypass school security controls.

The companion captures and controls the signed-in Windows desktop after the iPad pairs. Use it only on a school-approved PC and close it when finished.

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
