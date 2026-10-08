// Proof that the overlay's invisibility is real, not just a flag we set.
//
// Content protection on macOS maps to NSWindowSharingNone: the window is excluded from the system
// capture path (CGDisplayStream / ScreenCaptureKit). Every screen recorder and streamer reads that
// same path — QuickTime, Zoom, Teams, Meet, OBS, and Electron's own desktopCapturer. So we prove it
// against desktopCapturer: if the window is absent from a desktopCapturer frame, it is absent from
// all of them.
//
// A synthetic probe window (solid magenta, a colour nothing else on the desktop shows) stands in for
// the overlay. We capture the display twice and count magenta pixels:
//   protection ON  -> magenta must be gone   (invisible to the recorder)
//   protection OFF -> magenta must be present (control: capture itself works)
// The probe is test-created, so the capture reads only our own marker, never the desktop's content.
//
// Run: npm --prefix client run proof        (needs Screen Recording permission for Electron — see
// the gate message this prints if the capture comes back black).
const { app, BrowserWindow, desktopCapturer, screen } = require("electron");

const MAGENTA = { r: 255, g: 0, b: 255 };
const PAGE = `data:text/html,${encodeURIComponent(`<!doctype html><meta charset=utf-8>
<body style="margin:0;background:rgb(255,0,255);display:flex;align-items:center;justify-content:center;height:100vh;font:700 42px system-ui;color:#000">
CUE INVISIBILITY PROBE</body>`)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fraction of pixels in a BGRA bitmap that are the probe's magenta, and the mean luma (to tell a
// real empty capture from a black one that means we were never granted Screen Recording).
function analyze(bitmap) {
  let magenta = 0, lumaSum = 0;
  const pixels = bitmap.length / 4;
  for (let i = 0; i < bitmap.length; i += 4) {
    const b = bitmap[i], g = bitmap[i + 1], r = bitmap[i + 2];
    if (r > 200 && g < 70 && b > 200) magenta++;
    lumaSum += 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return { magentaFraction: magenta / pixels, meanLuma: lumaSum / pixels };
}

async function capture(display) {
  const scale = Math.min(1, 1600 / Math.max(display.bounds.width, display.bounds.height));
  for (let attempt = 0; attempt < 5; attempt++) {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: Math.round(display.bounds.width * scale), height: Math.round(display.bounds.height * scale) },
    });
    const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (source && !source.thumbnail.isEmpty()) return analyze(source.thumbnail.toBitmap());
    await sleep(400);
  }
  throw new Error("desktopCapturer returned no screen frame");
}

async function run() {
  if (app.dock) app.dock.hide();
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const w = Math.min(1000, area.width - 80), h = Math.min(680, area.height - 80);
  const win = new BrowserWindow({
    width: w, height: h,
    x: Math.round(area.x + (area.width - w) / 2), y: Math.round(area.y + (area.height - h) / 2),
    frame: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false, resizable: false, show: false,
    backgroundColor: "#ff00ff",
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenScreens: true });
  await win.loadURL(PAGE);

  // Protected: the probe is on screen but must not reach the recorder.
  win.setContentProtection(true);
  win.showInactive();
  await sleep(1200);
  const hidden = await capture(display);

  // Control: same window, protection off, must reach the recorder.
  win.setContentProtection(false);
  await sleep(1200);
  const shown = await capture(display);

  win.destroy();

  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  console.log(`[proof] protection ON : magenta=${pct(hidden.magentaFraction)} luma=${hidden.meanLuma.toFixed(1)}`);
  console.log(`[proof] protection OFF: magenta=${pct(shown.magentaFraction)} luma=${shown.meanLuma.toFixed(1)}`);

  if (shown.meanLuma < 3 && hidden.meanLuma < 3) {
    console.error("[gate] Capture came back black. Grant Screen Recording to Electron in System Settings " +
      "> Privacy & Security > Screen & System Audio Recording, then run again. This proves nothing until then.");
    app.exit(2);
    return;
  }

  const hiddenOk = hidden.magentaFraction < 0.005;   // essentially no probe pixels in the frame
  const shownOk = shown.magentaFraction > 0.05;      // the probe fills a clear chunk of the frame
  const pass = hiddenOk && shownOk;
  console.log(pass
    ? `[proof] PASS — invisible when protected (${pct(hidden.magentaFraction)}), visible when not (${pct(shown.magentaFraction)}).`
    : `[proof] FAIL — hiddenOk=${hiddenOk} shownOk=${shownOk}`);
  app.exit(pass ? 0 : 1);
}

app.whenReady().then(run).catch((error) => { console.error("[proof] error:", error.message); app.exit(3); });
