import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from './icons';
import { pageTipStorageKey } from '../utils/pageTips';
import { CONSENT_CHANGED_EVENT, getConsent } from '../utils/consent';
import { SIDE_INSET_MARGINS } from './layout/chromeOffsets';

interface PageTipProps {
  id: string;
  title: string;
  description: string;
}

/**
 * A one-sentence explanation of the page, dismissible for good.
 *
 * ─ Versioning the id ────────────────────────────────────────────────────
 * A dismissal is permanent for that browser, so anyone who has read a tip
 * will never see it again — including after it is corrected. When a tip's
 * MEANING changes (the page now does something different, or the tip was
 * wrong), bump its id: `dashboard-welcome` → `dashboard-welcome-2`. The new
 * id has no stored dismissal, so the corrected tip is shown once more.
 * Cosmetic edits — wording, punctuation, a clearer verb — keep the same id;
 * re-showing a tip nobody needs re-read is just noise.
 * Settings ▸ App Settings ▸ Page Tips brings back every dismissed tip.
 */
export default function PageTip({ id, title, description }: PageTipProps): React.JSX.Element | null {
  const storageKey = pageTipStorageKey(id);
  const [dismissed, setDismissed] = useState(() => {
    return localStorage.getItem(storageKey) === 'true';
  });

  // One decision at a time. The consent banner is also fixed to the bottom of
  // the viewport and, on a phone, is tall enough that a tip sitting above it
  // covers the very text explaining what is being consented to. Consent is the
  // more important — and legally the more consequential — of the two, so a tip
  // waits until it has been answered.
  const [consentPending, setConsentPending] = useState(() => getConsent() === null);
  useEffect(() => {
    if (!consentPending) return;
    const onChange = () => setConsentPending(getConsent() === null);
    window.addEventListener(CONSENT_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(CONSENT_CHANGED_EVENT, onChange);
  }, [consentPending]);

  if (dismissed || consentPending) return null;

  const handleDismiss = () => {
    localStorage.setItem(storageKey, 'true');
    setDismissed(true);
  };

  // Portalled to <body>: the page-transition wrapper carries a transform, and
  // ANY transform makes an element the containing block for position:fixed
  // descendants. Rendered in place the tip was therefore pinned to the bottom
  // of the page CONTENT, not the viewport — invisible until you scrolled to
  // the very end. Same fix, same reason, as TransferMatchDialog.
  //
  // Mobile offset: the bottom nav is ~78px tall and its quick-action button
  // floats above that to ~136px, both at z-50. Sitting the tip clear of them
  // (bottom-36 = 144px) keeps it fully readable and its dismiss button
  // tappable WITHOUT covering the navigation — which would only trade one
  // hidden control for another. Desktop is unchanged: bottom-right, over the
  // content, where there is nothing to clear.
  return createPortal(
    <div className="fixed bottom-36 left-3 right-3 z-40 md:bottom-4 md:left-auto md:right-4 md:max-w-lg" style={SIDE_INSET_MARGINS}>
      <div className="bg-[#1a2332] text-white p-4 rounded-xl shadow-xl border border-white/10">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <h4 className="text-sm font-semibold mb-1">{title}</h4>
            <p className="text-xs text-white/70 leading-relaxed">{description}</p>
          </div>
          <button
            onClick={handleDismiss}
            className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
            aria-label="Dismiss tip"
          >
            <XIcon size={16} className="text-white/60" />
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
