//! Self-update — asking, never assuming.
//!
//! # Why this is in Rust and not the renderer
//!
//! The same sentence `document.rs` opens with: the WebView is not the part of
//! this program that should be able to replace the program. An update is the
//! most privileged thing this binary ever does to itself, and the renderer —
//! shared, cloud-edition code that happens to be running in a desktop window —
//! has no business initiating it. Keeping it here has three further effects
//! that each matter on their own:
//!
//!   * the renderer's size ratchet never sees it (`bundle:check:desktop`);
//!   * the app's CSP does not have to admit an update host into `connect-src`,
//!     because the download is not made by the WebView;
//!   * `src/desktop/routes.ts` and the shared UI stay identical between the
//!     two editions, which is the whole premise of `docs/edition-gating.md`.
//!
//! # Why it asks
//!
//! An accounts application may not restart itself under someone's hands. The
//! check is silent, the offer is a native dialog, and declining is free — the
//! next launch asks again. This is the house rule about saying the consequence
//! before the remedy, applied to the one action whose consequence is "the
//! window you are working in will close".
//!
//! # What a failed check must never do
//!
//! Interrupt. GitHub being unreachable, a rate limit, an aeroplane — none of
//! them are the user's problem and none of them get a dialog. The error goes
//! to stderr and the program carries on exactly as it would have. The only
//! thing a broken update path may cost is the update.
//!
//! # The signature, and Apple's
//!
//! Every artefact is signed with the release keypair; the public half lives in
//! `tauri.conf.json` and the private half only in the repository's Actions
//! secrets, so an endpoint that served a hostile payload would be refused by
//! the updater before a byte of it ran. That is separate from APPLE
//! notarisation, and CI does that too: `.github/workflows/desktop-release.yml`
//! holds the Developer ID certificate, signs the `.app`, has Apple notarise it
//! and staples the ticket BEFORE bundling it into both the `.dmg` and this
//! updater's archive, so the two carry the same signed, notarised app. The
//! 0.1.6 and 0.1.7 build logs show every step ("Notarizing Finished with
//! status Accepted", "Stapling app"). Until this paragraph was corrected on
//! 7 Nov 2026 it said the archive was only ad-hoc signed and the `.dmg`
//! notarised by hand — true of 0.1.1 and 0.1.2, before the certificate was in
//! Actions secrets. See that file's SIGNING note for the three signatures.

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

/// Look for a newer release, and offer it if there is one.
///
/// Returns immediately: the work happens on the async runtime so that a slow
/// or unreachable endpoint cannot hold up the window. Call it once, from
/// `setup`.
pub fn offer_any_update(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = look(handle).await {
            // Deliberately stderr and nothing else. See the module header.
            eprintln!("reckley-desktop: the update check did not complete: {error}");
        }
    });
}

/// The check itself, separated so that every failure above has one place to land.
async fn look(app: AppHandle) -> Result<(), tauri_plugin_updater::Error> {
    let Some(update) = app.updater()?.check().await? else {
        // Already current. The overwhelmingly common case, and it says nothing.
        return Ok(());
    };

    let installed = app.package_info().version.to_string();
    let offered = update.version.clone();

    let accepted = app
        .dialog()
        .message(format!(
            "Reckley {offered} is available. You are running {installed}.\n\n\
             Downloading takes a moment, and the app will close and reopen to \
             finish. Your data is untouched — it stays in your ledger file."
        ))
        .title("An update is available")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Update and restart".to_owned(),
            "Not now".to_owned(),
        ))
        .blocking_show();

    if !accepted {
        // No nagging, no "are you sure", no deferral bookkeeping. The next
        // launch will make the same offer, which is reminder enough.
        return Ok(());
    }

    // The two closures are progress hooks. There is no progress bar to drive —
    // a native dialog cannot host one — so they are empty by intent rather
    // than by omission.
    update.download_and_install(|_chunk, _total| {}, || {}).await?;

    // Replaces the running process with the new build. Diverges, so nothing
    // after it can run.
    app.restart();
}
