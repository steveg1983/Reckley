#!/usr/bin/env bash
#
# Build the iOS shell and upload it to TestFlight, without Xcode's GUI.
#
# WHY THIS EXISTS. On 26 Aug 2026 a headless `xcodebuild -exportArchive`
# failed twice over: first "App Store Connect access for VT6W829WRX is
# required", then — more revealingly — 
#
#     Provisioning profile "iOS Team Store Provisioning Profile:
#     com.wealthtracker.mobile" doesn't include the
#     com.apple.developer.associated-domains entitlement.
#
# Adding a capability in Xcode regenerates the DEVELOPMENT profile; the
# DISTRIBUTION profile is a separate object and does not follow. Regenerating
# it needs App Store Connect access, which a shell does not have — so the
# upload had to go through Xcode's Organizer, which holds the session.
#
# An App Store Connect API key IS that access. With the three
# -authentication* flags below, `-allowProvisioningUpdates` can regenerate the
# distribution profile itself, and the upload needs no GUI and no human.
#
# Usage:  scripts/ios-release.sh [build-number]
#         (build number defaults to the CURRENT_PROJECT_VERSION already set)
#
# Needs, in ~/Documents/WealthTracker-signing (or ASC_KEY_DIR):
#   AuthKey_<KEYID>.p8   downloadable from Apple exactly once — back it up
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="$REPO_ROOT/apps/mobile/ios/App"
KEY_DIR="${ASC_KEY_DIR:-$HOME/Documents/WealthTracker-signing}"
KEY_ID="${ASC_KEY_ID:-K3X6D83JFR}"
ISSUER_ID="${ASC_ISSUER_ID:-5eefcc4c-7800-4c5f-b6ac-3ffb9c88655a}"
KEY_PATH="$KEY_DIR/AuthKey_${KEY_ID}.p8"
ARCHIVE="${TMPDIR:-/tmp}/wt-ios-$(date +%s).xcarchive"

# A BETA XCODE BUILDS, ARCHIVES AND SIGNS — AND THEN APPLE REFUSES THE UPLOAD.
# Build 4 (17 Oct 2026) went all the way to "Completing upload…" under
# /Applications/Xcode-beta.app (SDK iPhoneOS27.0, Xcode 27A5252f) and came
# back "Unsupported SDK or Xcode version … you need to use the latest Release
# Candidates (RC) for SDKs and Xcode to submit the app". Ask the question in
# the first second instead. `xcrun --find` honours DEVELOPER_DIR, so
#   DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/ios-release.sh 5
# picks a released Xcode for one run without touching `xcode-select`.
# Betas install as Xcode-beta.app; an RC Apple ships under that name can be
# let through with ALLOW_BETA_XCODE=1.
XCODEBUILD_PATH="$(xcrun --find xcodebuild 2>/dev/null || true)"
case "$XCODEBUILD_PATH" in
  *-beta.app/*|*-Beta.app/*)
    if [ "${ALLOW_BETA_XCODE:-}" != "1" ]; then
      echo "The selected Xcode is a beta: $XCODEBUILD_PATH" >&2
      echo "App Store Connect refuses uploads built with a beta SDK, after the whole archive and upload." >&2
      echo "Install the released Xcode, then run:" >&2
      echo "  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/ios-release.sh <build-number>" >&2
      echo "(If this beta is in fact a Release Candidate, ALLOW_BETA_XCODE=1 lets it through.)" >&2
      exit 1
    fi
    ;;
esac
echo "==> Using $(xcodebuild -version 2>/dev/null | tr '\n' ' ')from ${XCODEBUILD_PATH%/usr/bin/xcodebuild}"

if [ ! -f "$KEY_PATH" ]; then
  echo "No App Store Connect key at $KEY_PATH" >&2
  echo "Apple allows the .p8 to be downloaded ONCE; if it is lost, revoke the" >&2
  echo "key in App Store Connect and generate a new one." >&2
  exit 1
fi

# A build number already on App Store Connect is rejected, and the rejection
# arrives after the upload rather than before it — so it is worth setting
# deliberately rather than discovering.
if [ "${1:-}" != "" ]; then
  echo "==> Setting build number to $1"
  /usr/bin/sed -i '' "s/CURRENT_PROJECT_VERSION = [0-9][0-9]*;/CURRENT_PROJECT_VERSION = $1;/g" \
    "$IOS_DIR/App.xcodeproj/project.pbxproj"
fi

echo "==> Syncing Capacitor (config and entitlements)"
# In a subshell, FROM apps/mobile: `npm --prefix … exec` only relocates
# node_modules, not the working directory, so run from the repo root it
# looked for ios/ beside package.json and refused with "ios platform has not
# been added yet" (11 Sep 2026, build 3). Capacitor's sync wants to be run
# where capacitor.config.ts is.
(cd "$REPO_ROOT/apps/mobile" && npx --no-install cap sync ios)

echo "==> Archiving"
xcodebuild archive \
  -project "$IOS_DIR/App.xcodeproj" \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$KEY_PATH" \
  -authenticationKeyID "$KEY_ID" \
  -authenticationKeyIssuerID "$ISSUER_ID" \
  DEVELOPMENT_TEAM=VT6W829WRX

# Prove the entitlements survived into the SIGNED BINARY rather than trusting
# the project file. This is the whole point of the build, and it is cheap.
APP="$ARCHIVE/Products/Applications/App.app"
# Push notifications (11 Sep 2026): the aps-environment entitlement is what
# lets iOS hand the app an APNs token. The project file says "development";
# an App Store export re-signs it "production" from the distribution profile,
# and a build carrying NEITHER would register no token and push nothing —
# silently. Refuse it here rather than discover it on a phone.
APS_ENV="$(codesign -d --entitlements - --xml "$APP" 2>/dev/null | plutil -extract aps-environment raw -o - - 2>/dev/null || true)"
if [ -z "$APS_ENV" ]; then
  echo "The archive does not carry the aps-environment entitlement — no push token would ever arrive. Refusing to upload." >&2
  exit 1
fi
# "development" here is expected: the App Store export re-signs it
# "production" from the distribution profile. What matters is that it exists.
echo "==> Push entitlement present: aps-environment = $APS_ENV"
if ! codesign -d --entitlements :- "$APP" 2>/dev/null | grep -q "webcredentials:"; then
  echo "The archive does not carry the associated-domains entitlement — refusing to upload." >&2
  exit 1
fi
# Every claimed host on the one `==>` line: build 6's log printed the second
# host on a bare line of its own, and it was read as missing.
echo "==> Entitlement present: $(codesign -d --entitlements :- "$APP" 2>/dev/null | grep -o 'webcredentials:[^<]*' | paste -sd ' ' -)"

# The home-screen widgets (build 8, Nov 2026). The widget is a second signed
# binary inside the app, and it reads its key from a keychain group BOTH must
# be entitled to. An archive without the extension has no widgets; one where
# either binary lacks the group has a widget that says "turn me on" for ever,
# because the app writes the key where the widget may not look. Neither shows
# on a simulator build, which does not enforce the group.
WIDGETS="$APP/PlugIns/ReckleyWidgets.appex"
if [ ! -d "$WIDGETS" ]; then
  echo "The archive does not carry the widget extension — refusing to upload." >&2
  exit 1
fi
WIDGET_GROUP="VT6W829WRX.com.wealthtracker.mobile.widget"
for SIGNED in "$APP" "$WIDGETS"; do
  if ! codesign -d --entitlements :- "$SIGNED" 2>/dev/null | grep -q "<string>$WIDGET_GROUP</string>"; then
    echo "$(basename "$SIGNED") is not entitled to the keychain group $WIDGET_GROUP — the widget could never read its key. Refusing to upload." >&2
    exit 1
  fi
done
APP_BUILD="$(plutil -extract CFBundleVersion raw -o - "$APP/Info.plist")"
WIDGET_BUILD="$(plutil -extract CFBundleVersion raw -o - "$WIDGETS/Info.plist")"
if [ "$APP_BUILD" != "$WIDGET_BUILD" ]; then
  echo "The app is build $APP_BUILD and its widget extension is build $WIDGET_BUILD — App Store Connect refuses a mismatch. Refusing to upload." >&2
  exit 1
fi
echo "==> Widget extension present, build $WIDGET_BUILD, both binaries entitled to $WIDGET_GROUP"

EXPORT_PLIST="${TMPDIR:-/tmp}/wt-export-options.plist"
cat > "$EXPORT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key><string>app-store-connect</string>
	<key>destination</key><string>upload</string>
	<key>teamID</key><string>VT6W829WRX</string>
	<key>signingStyle</key><string>automatic</string>
	<key>uploadSymbols</key><true/>
	<!-- Never true: the build number is chosen above, deliberately. Letting
	     Xcode renumber invites a collision with something already uploaded. -->
	<key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST

echo "==> Exporting and uploading to App Store Connect"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  -exportPath "${TMPDIR:-/tmp}/wt-ios-export" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$KEY_PATH" \
  -authenticationKeyID "$KEY_ID" \
  -authenticationKeyIssuerID "$ISSUER_ID"

echo "==> Uploaded. It appears in TestFlight once Apple finishes processing."
