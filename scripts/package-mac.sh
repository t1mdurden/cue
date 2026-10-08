#!/usr/bin/env bash
# Build Cue.app and, with --install, put it in /Applications. Electron's documented manual
# packaging, no packager dependency: copy the Electron.app already in client/node_modules, put the
# overlay plus a copy of the app server in Contents/Resources/app, rebrand Info.plist, sign with a
# local self-signed certificate ("Cue Local Signing", made on first run) so the signature's identity
# stays the same across rebuilds and macOS keeps the Screen Recording / Microphone grants.
# The app starts its server (scripts/start-local.sh --services-only), which starts llama.cpp and
# whisper.cpp (Homebrew) only when the backend chosen in Setup needs them.
#   npm run mac-app            # build dist/Cue.app and install it
set -euo pipefail
cd "$(dirname "$0")/.."

ELECTRON=client/node_modules/electron/dist/Electron.app
[ -d "$ELECTRON" ] || { echo "[package] no Electron binary yet: run npm run app once (it installs Electron)" >&2; exit 1; }
python3 -c "import PIL" 2>/dev/null || { echo "[package] the icon is drawn with Pillow: pip3 install pillow" >&2; exit 1; }
command -v swiftc >/dev/null || { echo "[package] swiftc not found: xcode-select --install (builds the screen-text reader)" >&2; exit 1; }
OUT=dist/Cue.app
APP="$OUT/Contents/Resources/app"
SERVER="$APP/server"

rm -rf dist
mkdir -p dist
ditto "$ELECTRON" "$OUT"
rm -f "$OUT/Contents/Resources/default_app.asar" "$OUT/Contents/Resources/electron.icns"

# The overlay (Electron main + preload) and the app server it starts, with the server's packages:
# everything installed except onnxruntime-web, of which the page needs only the built dist/.
mkdir -p "$SERVER/scripts" "$SERVER/node_modules/onnxruntime-web" "$SERVER/bin"
cp client/package.json client/main.js client/preload.js "$APP/"
cp -R package.json src public "$SERVER/"
cp scripts/start-local.sh "$SERVER/scripts/"
rsync -a --exclude /onnxruntime-web node_modules/ "$SERVER/node_modules/"
cp -R node_modules/onnxruntime-web/dist "$SERVER/node_modules/onnxruntime-web/"
# screen-text, pdf-text and system-audio (the other side of the call, and its permission)
for src in native/*.swift; do swiftc -O "$src" -o "$SERVER/bin/$(basename "$src" .swift)"; done

python3 scripts/make-icon.py "$OUT/Contents/Resources/Cue.icns" >/dev/null

mv "$OUT/Contents/MacOS/Electron" "$OUT/Contents/MacOS/Cue"
plist() { /usr/libexec/PlistBuddy -c "$2" "$1" >/dev/null; }
INFO="$OUT/Contents/Info.plist"
VERSION="$(sed -n 's/^ *"version": "\(.*\)",$/\1/p' package.json | head -1)"
plist "$INFO" "Set :CFBundleName Cue"
plist "$INFO" "Set :CFBundleDisplayName Cue"
plist "$INFO" "Set :CFBundleIdentifier local.cue.app"
plist "$INFO" "Set :CFBundleExecutable Cue"
plist "$INFO" "Set :CFBundleIconFile Cue.icns"
plist "$INFO" "Set :CFBundleShortVersionString $VERSION"
plist "$INFO" "Set :CFBundleVersion $VERSION"
plist "$INFO" "Set :LSApplicationCategoryType public.app-category.productivity"
plist "$INFO" "Delete :ElectronAsarIntegrity"          # it pinned default_app.asar, removed above
plist "$INFO" "Add :LSUIElement bool true"             # no Dock icon flash before dock.hide()
plist "$INFO" "Set :NSMicrophoneUsageDescription 'Cue transcribes your side of the conversation on this Mac.'"
plist "$INFO" "Add :NSAudioCaptureUsageDescription string 'Cue transcribes the other side of the call (system audio) on this Mac.'"
for helper in "$OUT"/Contents/Frameworks/Electron\ Helper*.app; do
  id="$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$helper/Contents/Info.plist")"
  plist "$helper/Contents/Info.plist" "Set :CFBundleIdentifier ${id/com.github.Electron/local.cue.app}"
done

# TCC (Screen Recording, Microphone, System Audio) remembers an app by its designated requirement.
# An ad hoc signature's requirement is the build's cdhash, so every rebuild was a new, unknown app:
# the grant vanished and the toggle disappeared from System Settings. A self-signed certificate in
# the login keychain gives `identifier local.cue.app and certificate leaf = H"..."`, stable until the
# certificate changes (10 years). Not notarized, valid on this Mac only.
IDENTITY="Cue Local Signing"
if ! security find-identity -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
  echo "[package] creating the local signing certificate \"$IDENTITY\" in the login keychain"
  CERT_TMP="$(mktemp -d)"
  printf '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=%s\n[v3]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n' "$IDENTITY" > "$CERT_TMP/req.cnf"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$CERT_TMP/req.cnf" -keyout "$CERT_TMP/key.pem" -out "$CERT_TMP/cert.pem" 2>/dev/null
  openssl pkcs12 -export -legacy -inkey "$CERT_TMP/key.pem" -in "$CERT_TMP/cert.pem" -out "$CERT_TMP/id.p12" -passout pass:cue -name "$IDENTITY"
  security import "$CERT_TMP/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P cue -T /usr/bin/codesign >/dev/null
  rm -rf "$CERT_TMP"
fi
codesign --force --deep --sign "$IDENTITY" "$OUT" 2>/dev/null
codesign --verify --deep --strict "$OUT"
codesign -d -r- "$OUT" 2>&1 | grep -q 'certificate leaf' || { echo "[package] signature is not bound to $IDENTITY" >&2; exit 1; }
echo "[package] built $OUT ($(du -sh "$OUT" | cut -f1))"

if [ "${1:-}" = "--install" ]; then
  # -x: the whole command line, so a shell whose text merely mentions the path does not count.
  if pgrep -xf "/Applications/Cue.app/Contents/MacOS/Cue" >/dev/null; then
    echo "[package] Cue is running — quit it (Settings > General > Quit) and run this again" >&2; exit 1
  fi
  rm -rf /Applications/Cue.app
  ditto "$OUT" /Applications/Cue.app
  # First install: carry over the sessions and Settings of `npm run app` (same keychain key).
  SUPPORT="$HOME/Library/Application Support/Cue"
  if [ ! -f "$SUPPORT/store.json" ] && [ -f data/store.json ]; then
    mkdir -p "$SUPPORT" && cp data/store.json "$SUPPORT/store.json"
    echo "[package] copied data/store.json to $SUPPORT"
  fi
  echo "[package] installed /Applications/Cue.app"
fi
