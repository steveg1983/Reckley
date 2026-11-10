# The iOS shell

A Capacitor app: a native window around the **cloud** edition, running on
TestFlight since 26 August 2026.

## It has no copy of the app in it

`capacitor.config.ts` sets `server.url` to `https://www.reckley.co.uk`,
so the web view loads production. **A deploy IS the mobile release** — a web
fix reaches the phone with no rebuild and no review.

**The domain move (rename phase 6).** Up to build 5 the shell loaded
`www.wealthtrackerpro.co.uk`. Clerk's production domain moved to
`reckley.co.uk` on 26 Oct 2026, after which the old host could not hold a
session (WebKit drops the now third‑party cookie), so the old host 308s to
the new one and `server.allowNavigation` lets an installed build 5 follow
that redirect inside the app instead of handing it to Safari. **Build 6
(29 Oct 2026) loads the new host directly** — the URL being the one change
here that a deploy cannot deliver.

That is the opposite of the desktop edition, which embeds its renderer at
compile time and is frozen until someone cuts a release. The two are not
comparable and the difference has caught us out once already: a fix reported
from the desktop build was the one fix that could not reach it.

The catch, which looks like a bug and is not: the web view keeps the old page
alive while the app is backgrounded, so an iPhone can run yesterday's build
for days. **Force-quit before diagnosing anything on the phone.**

The `www/` directory exists only because Capacitor demands one; a single
offline page lives there for the no-network case. App Store *review* (later —
TestFlight does not care) will want the assets bundled instead, which means
CORS work on the API and a second deploy pipeline.

## The iPhone Duo — what the fold actually reports (9 Nov 2026)

Measured with a scratch probe in `SceneDelegate` (never committed), as UIKit's
`safeAreaInsets` and as the web view's own `env()` — the two agreed every time.
The closed row is the Xcode 27.2 simulator's; the two open rows were measured
on the owner's Duo (iOS 27.3) and, where the simulator could be put in the same
state, it gave the same numbers.

| state | window (pt) | safe-area insets t / r / b / l |
| --- | --- | --- |
| closed, upright | 466 × 678 | 0 / **84** / 34 / 0 |
| open, held wide | 951 × 669 | 0 / **84** / 34 / 0 |
| open, held upright | 669 × 951 | **82** / 0 / 34 / 0 |

The camera and the vertical status pill live in one corner of the inner
display, and iOS bills them as a safe-area inset along the WHOLE edge the pill
sits on — the full height of the right edge when closed. Apple's own Settings
leaves that entire column to the pill and its Back button, so that is the
convention. There is no top inset at all when closed (the status bar is a
2pt-tall frame), so nothing keyed on `safe-area-inset-top` saw the pill, and
the app drew its header's right-hand controls under it.

What follows from the table:

- **The web pays the sides now.** `--wt-side-inset-left/right` in `index.css`
  (from `env()`, never zeroed) and `SIDE_INSET_*` / `sidePadding` in
  `components/layout/chromeOffsets.ts`. Every fixed bar pads its content by
  them and keeps its background full-bleed; every floating card steps in by a
  margin. 0px on every other device, so the change is invisible there.
- **No native work was needed for the pill.** The web view is full-bleed and
  honest (window width equal to the screen's, `env()` right 84px), so a web
  deploy fixes the installed build 6 too. The iOS 27.2 SDK has a hinge API
  (`UIHingeInteraction`: closed / partially open / fully open, plus the angle)
  and nothing for the pill; the web has neither and needs neither.
- **The open display lands in the `md` breakpoint** (951px wide), where the
  desktop top bar is drawn — and five labelled items, the brand and the
  right-hand cluster overlapped there (also an iPad held upright). The item
  labels fold to icons below `lg` and the search field narrows.
- **A build made with the iOS 27.1+ SDK fills the inner display**; older
  builds are letterboxed. Build 6 was made with Xcode 27.1, build 7 onward with
  27.2 (the active Xcode since 9 Nov; it dropped Simulator.app for Device Hub).
- **Device Hub reads the daemons that were running when it opened.** After
  `xcode-select -s`, kill `CoreSimulatorService`, `CoreDeviceService` and
  `remotepairingd` (or restart) or it lists the OLD Xcode's simulators as
  "unavailable", shows none of the new runtime's, and will not pair a phone —
  while each Add Device still quietly creates and boots a device behind it.
- `xcrun devicectl device capture screenshot` captures the PRIMARY display,
  which on the Duo is the outer one — black whenever the phone is open. Pass
  `--display-unique-id` of the active display from
  `devicectl device info displays` (the inner one listed itself as
  `123-456-789`) and the inner screen comes back. `devicectl device copy from
  --domain-type appDataContainer` is how the probe's log came off the phone.

## Associated Domains — why a password would not save

iOS will not offer to save or fill a credential in an app's web view, and will
not allow a passkey, until the app has **proved it owns the domain**. Before
26 August it had not, so Apple Passwords ignored the sign-in form entirely
while Safari on the same Mac remembered it perfectly.

The proof is **two-sided**, and both halves must agree or iOS silently
believes neither:

| half | where | says |
| --- | --- | --- |
| the claim | `ios/App/App/App.entitlements` | `webcredentials:www.wealthtrackerpro.co.uk` and `webcredentials:www.reckley.co.uk` |
| the answer | `public/.well-known/apple-app-site-association` | `VT6W829WRX.com.wealthtracker.mobile` |

Three things that are easy to get wrong, all of which we did:

- **The file must be JSON, and it was HTML.** The path answered `200` long
  before the file existed, because the SPA catch-all in `vercel.json` served
  `index.html` for it. The rewrite now exempts `/.well-known`, and a header
  rule pins `application/json`. A `200` is not evidence; check the
  content-type.
- **Only `www` is claimed, on each domain.** Both apexes 308-redirect to
  their `www` (measured) and Apple does not follow redirects. Both hosts serve
  the same association file from the same deployment (measured 14 Oct: `200`,
  `application/json`), and both are claimed for the length of the move, so a
  credential saved under either keeps filling. `www` is also the
  origin the web view actually loads, so it is the origin a saved credential
  is scoped to.
- **The entitlement is Xcode's file, not ours.** Xcode rewrites it and strips
  comments whenever the capability is touched, which is why this explanation
  lives here instead. The capability itself is enabled through Xcode
  (target → Signing & Capabilities → + Capability → Associated Domains), which
  with automatic signing also enables it on the App ID and regenerates the
  profile.

**Order matters when shipping this**: the association file must be live on the
domain before an install can believe it. Deploy the web change first, then
build.

## Home-screen widgets (10 Nov 2026, first in build 8)

The first native surface the shell has: a WidgetKit extension,
`ios/App/ReckleyWidgets`, with one widget — **Key Budgets**, small and medium.
It fetches for itself (owner's ruling, 10 Nov): it holds a read-only key and
asks `GET /api/widget/budgets`, so it is current while the app is closed.

**How the key gets there.** The page cannot reach a widget and a widget cannot
read the page's session, so the app target carries one small Capacitor plugin,
`ReckleyWidget` (`App/ReckleyWidgetPlugin.swift`), and the Settings card
(`src/components/settings/WidgetSettings.tsx`) calls it:

| call | does |
| --- | --- |
| `status()` | `{ hasKey, keyId }` — never the key |
| `setKey({ key, keyId, origin })` | stores all three as ONE keychain item, redraws |
| `clearKey()` | forgets it, redraws |
| `reload()` | redraws — a setting changed |

Things that are true of it and not obvious:

- **The plugin is registered by hand.** It is not a package, so Capacitor's
  class list does not find it: `ReckleyBridgeViewController.capacitorDidLoad()`
  registers the instance and `Main.storyboard` names that class. Registered
  there, its script is injected at document start, which is what makes
  `Capacitor.isPluginAvailable('ReckleyWidget')` true on the REMOTE page —
  and that answer is the only thing that draws the Settings card. Measured in
  the simulator against production, 10 Nov.
- **The key is in the keychain, in a group both binaries are entitled to**
  (`keychain-access-groups` in `App/App.entitlements` and
  `ReckleyWidgets/ReckleyWidgets.entitlements`; spelled a third time in
  `Shared/WidgetKeyStore.swift`, which is compiled into both targets). Not an
  App Group: a shared preferences file goes into backups and a this-device
  keychain item does not, and a keychain group needs nothing registered in the
  Apple account. The app's own group stays FIRST in its list, because the
  first group is where an app's unqualified keychain items go.
- **A keychain item outlives the app.** `forgetIfFreshInstall()` runs as the
  plugin loads: no marker in the app's preferences beside a held key means the
  key belonged to a copy that was deleted.
- **The key and the origin are never changed apart.** The origin is where the
  key is sent. A page in the web view can replace both together and can read
  neither back.
- **A key the server refuses is forgotten by the widget itself** (401 → the
  item is deleted), so the Settings card stops saying "on" for a key that was
  revoked from somewhere else. Proven end to end in the simulator with a
  made-up key: the app stored it, the widget sent it to production, production
  answered 401, and the app then reported no key.
- **The widget does no arithmetic.** Every figure arrives as the words to draw
  (`api/_lib/widget-budgets.ts`); `percent` is the length of a bar.
- **The extension needs iOS 17**; the app still installs on 15. A phone older
  than 17 simply has no Reckley widget to add.
- **`src/services/widget/__tests__/nativeContract.test.ts` reads the Swift,
  the two entitlements, the storyboard and the project file**, because nothing
  else in CI compiles the page and the shell together.

**Proving it in a simulator** needs no Apple account:
`xcodebuild -project App.xcodeproj -scheme App -configuration Debug
-destination id=<sim> -derivedDataPath <scratch> build` — WITHOUT
`CODE_SIGNING_ALLOWED=NO` this time, because the simulated entitlements are
what carry the keychain group. Then `simctl install`, sign in, Settings.
Adding the widget by script: long-press the wallpaper, then the top-left
button → Add Widget. The simulator tool's `tap` misses that button; a
two-point `touch_path` hits it.

**Not proven until build 8 is on a phone:** automatic signing creating the
extension's App ID (`com.wealthtracker.mobile.widgets`) and its distribution
profile from the API key; the keychain group between two device-signed
binaries (a simulator does not enforce it — the release script checks the
signed entitlements for exactly this reason); and whether a locked phone
blanks the rows marked `privacySensitive` when "Hide figures while the phone
is locked" is on.

## Releasing to TestFlight

`scripts/ios-release.sh [build-number]` — archives, checks the entitlement
survived into the signed binary, exports and uploads. No Xcode, no GUI.

**Why a script and not two xcodebuild commands.** Build 2 could not be
uploaded headlessly. The first failure said App Store Connect access was
required; the second said the plain truth:

> Provisioning profile "iOS Team Store Provisioning Profile:
> com.wealthtracker.mobile" doesn't include the
> com.apple.developer.associated-domains entitlement.

Adding a capability in Xcode regenerates the **development** profile — the
**distribution** profile is a separate object and does not follow. Only
something holding an App Store Connect session can regenerate it, so the
upload went through Xcode's Organizer.

An **App Store Connect API key** is that session. With
`-authenticationKeyPath/-ID/-IssuerID`, `-allowProvisioningUpdates` regenerates
the distribution profile itself. The key lives in
`~/Documents/WealthTracker-signing/` and Apple allows it to be downloaded
**once** — back that folder up.

A build number already on App Store Connect is rejected *after* the upload
rather than before, so the script sets it deliberately and refuses to let
Xcode renumber.

**Build with a released Xcode, never a beta.** Build 4 (17 Oct 2026)
archived and signed under `Xcode-beta.app`, the only Xcode on the MacBook
then, and App Store Connect refused it at the very end of the upload:
"Unsupported SDK or Xcode version". The script now refuses a beta before it
starts. With both installed, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
scripts/ios-release.sh <n>` picks the released one for that run and leaves
`xcode-select` alone. Whether a refused upload uses up its build number is
not documented, so the retry took the next number.

App Store icons must carry **no alpha channel** — the upload is rejected for
it, and the fix is a JPEG round-trip through `sips`.

A **native** change (icons, `Info.plist`, permissions, entitlements, the shell
itself) is the only reason to cut a new build. Everything else arrives by
deploying the web app.

**Capacitor is held at ≥ 7.6.9** (17 Oct 2026, build 4). Every 7.x before it
carries GHSA-rvm3-566m-v7fv (critical): the navigation guard checked a link's
host but not its path, so a tapped link to the internal proxy path
`/_capacitor_http_interceptor_` could fetch any URL and run it at the app's
own origin, with every plugin in reach, whether or not `CapacitorHttp` is
enabled. A native fix reaches a phone only in a new build, so a security
release of `@capacitor/ios` is itself a reason to cut one. The pin lives in
three places that must agree: `package.json`/`package-lock.json`,
`ios/App/CapApp-SPM/Package.swift` (written by `cap sync`) and Xcode's
`Package.resolved`.

## Push notifications (11 Sep 2026)

The shell carries `@capacitor/push-notifications`, the `aps-environment`
entitlement, and the two `AppDelegate` methods that hand the APNs token to
the plugin. Everything that DECIDES to push lives on the server (the cloud
refresh cron and the reminders cron under `api/cron/`), and everything a
person can choose lives in the web app (Settings → App Settings → Phone
notifications, drawn only inside this shell). The phone's only jobs are to
ask iOS for a token and to hand it to `push_devices`, which
`src/services/push/pushRegistration.ts` does on every launch.

**Three things this needs that the code cannot supply:**

1. **An APNs key.** Apple Developer → Keys → `+` → tick *Apple Push
   Notifications service (APNs)*. Download the `.p8` **once** (Apple never
   offers it again — keep it beside the App Store Connect key in
   `~/Documents/WealthTracker-signing/`) and note the ten-character Key ID.
2. **Three Vercel environment variables**, server-side, none `VITE_`-prefixed:
   `APNS_TEAM_ID` (`VT6W829WRX`), `APNS_KEY_ID`, and `APNS_PRIVATE_KEY` (the
   `.p8` contents — pasted with real newlines, or with the two characters
   `\n` where a one-line field forces it; both are read). Until all three are
   set every push is skipped and logged once per cold start; nothing else
   changes.
3. **A new TestFlight build.** The entitlement and the plugin are native, so
   this is one of the rare changes a deploy cannot carry:
   `scripts/ios-release.sh <next build number>`. The script now refuses to
   upload an archive whose signed entitlements lack `aps-environment`. With
   automatic signing and the App Store Connect key, `-allowProvisioningUpdates`
   adds the Push Notifications capability to the App ID and regenerates the
   distribution profile itself — the same mechanism that carried Associated
   Domains.

**How build 3 actually went up (11 Sep 2026), so build 4 needs no detective
work.** `scripts/ios-release.sh 3` archived cleanly and proved both
entitlements, then `-exportArchive` refused: *"You haven't been given access
to cloud-managed distribution certificates."* Adding a capability to the App
ID means the distribution profile must be regenerated, and regenerating it
wanted a cloud-managed distribution certificate — which the App Store Connect
API key (`K3X6D83JFR`, App Manager role) is not permitted to create. Two
things had to be done by hand, once each:

1. **The App ID capability**: developer.apple.com → Identifiers →
   `com.wealthtracker.mobile` → tick *Push Notifications* → Save. (No SSL
   certificates: the key is how the server authenticates.)
2. **The export**: the archive the script had built was opened in Xcode's
   Organizer (`open /path/to/wt-ios-<ts>.xcarchive`) and uploaded with
   *Distribute App → App Store Connect → Upload*, signed in as the Account
   Holder. Xcode minted the certificate and profile the key could not.

To make the script self-sufficient again, give it a key with the **Admin**
role (App Store Connect → Users and Access → Integrations → App Store Connect
API; a new key, since a key's role cannot be changed) and put its id in
`ASC_KEY_ID`. Until then, the script gets as far as a proven archive and the
Organizer finishes the job.

**Sandbox versus production, and why the server does not care.** A build run
from Xcode registers a *sandbox* token; a TestFlight or App Store build a
*production* one; the phone cannot tell which. The server assumes production
and, on Apple's `BadDeviceToken`, tries the sandbox host once and remembers
the answer on the row (`api/_lib/push.ts`). A token Apple reports
`Unregistered` is retired, never deleted.

**Proving it on a phone.** Switch on any phone notification in Settings (the
one act that shows Apple's permission prompt), then trigger a push from the
server side: run the cron by hand —

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://www.reckley.co.uk/api/cron/reminders
```

— with a balance reminder scheduled for a minute ago and not yet acknowledged.
The response says how many were `pushed`; the phone says the rest. The
simulator receives no APNs pushes at all, so this is a real-device check.
