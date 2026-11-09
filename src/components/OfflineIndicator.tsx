import { useState, useEffect } from 'react';
import { WifiOffIcon } from './icons';
import { SIDE_INSET_MARGINS } from './layout/chromeOffsets';

export default function OfflineIndicator(): React.JSX.Element | null {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    const handleOnline = () => {
      setIsOffline(false);
      // Show "back online" message briefly
      setShowBanner(true);
      setTimeout(() => setShowBanner(false), 3000);
    };

    const handleOffline = () => {
      setIsOffline(true);
      setShowBanner(true);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (!showBanner) return null;

  return (
    <div
      style={SIDE_INSET_MARGINS}
      className={`fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-auto z-50 transition-all duration-300 ${
        isOffline ? 'translate-y-0' : showBanner ? 'translate-y-0' : 'translate-y-full'
      }`}
    >
      <div
        className={`flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg ${
          isOffline
            ? 'bg-orange-500 text-white'
            /* "Back online" is the app's it-worked message, so it takes the
               established success green rather than a stock blue that only ever
               meant "some other state" (stock-blue ruling, 28 Aug 2026). */
            : 'bg-green-700 text-white'
        }`}
      >
        {isOffline ? (
          <>
            <WifiOffIcon size={20} />
            <div>
              <p className="font-medium">You're offline</p>
              {/* This line used to read "Changes will sync when you're back
                  online". It was a promise nothing kept: no write path queues
                  anything, and the service worker that was supposed to has
                  never existed (see the note at the foot of main.tsx). Saying
                  the consequence is the house rule, and the consequence here
                  is that an edit made now is lost. */}
              <p className="text-sm opacity-90">Changes won't save until your connection returns</p>
            </div>
          </>
        ) : (
          <>
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0"
              />
            </svg>
            <p className="font-medium">Back online</p>
          </>
        )}
      </div>
    </div>
  );
}