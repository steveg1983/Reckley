import React, { useState, useEffect } from 'react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { XIcon } from './icons';
import { SIDE_INSET_MARGINS } from './layout/chromeOffsets';

export default function PWAInstallPrompt() {
  const { isInstallable, isInstalled, installApp } = usePWAInstall();
  const [showPrompt, setShowPrompt] = useState(false);
  const [hasBeenDismissed, setHasBeenDismissed] = useState(false);

  useEffect(() => {
    // Check if user has dismissed the prompt before
    const dismissed = localStorage.getItem('pwa-install-dismissed');
    if (dismissed) {
      setHasBeenDismissed(true);
    }
  }, []);

  useEffect(() => {
    // Show prompt after 30 seconds if installable and not dismissed
    if (isInstallable && !hasBeenDismissed && !isInstalled) {
      const timer = setTimeout(() => {
        setShowPrompt(true);
      }, 30000);

      return () => clearTimeout(timer);
    }
  }, [isInstallable, hasBeenDismissed, isInstalled]);

  const handleInstall = async () => {
    const success = await installApp();
    if (success) {
      setShowPrompt(false);
    }
  };

  const handleDismiss = () => {
    setShowPrompt(false);
    setHasBeenDismissed(true);
    localStorage.setItem('pwa-install-dismissed', 'true');
  };

  const handleLater = () => {
    setShowPrompt(false);
    // Don't set permanent dismissal, just hide for this session
  };

  if (!showPrompt || isInstalled) {
    return null;
  }

  return (
    <div className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:max-w-sm z-50 animate-fadeIn" style={SIDE_INSET_MARGINS}>
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-2xl border border-gray-200 dark:border-gray-600 p-4">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center">
            <div className="w-10 h-10 bg-[#8EA9DB] rounded-lg flex items-center justify-center mr-3">
              <span className="text-white font-bold text-lg">W</span>
            </div>
            <div>
              <h3 className="font-semibold text-gray-900 dark:text-white">Install Reckley</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">Get the full app experience</p>
            </div>
          </div>
          <button
            onClick={handleDismiss}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1"
          >
            <XIcon size={16} />
          </button>
        </div>
        
        {/* "Offline support" was in this sentence until 31 Aug 2026 and was never
            true — the service worker it referred to never registered, so an
            installed copy needs a connection exactly as the browser tab does.
            Do not put the claim back without a worker that actually caches. */}
        <div className="text-sm text-gray-600 dark:text-gray-300 mb-4">
          Install Reckley for its own icon, a full screen, and quick access — the same
          app, one tap away.
        </div>
        
        <div className="flex space-x-2">
          <button
            onClick={handleInstall}
            className="flex-1 justify-center bg-[#8EA9DB] hover:bg-[#7A97C9] text-white font-medium py-2 px-4 rounded-lg transition-colors"
          >
            Install
          </button>
          <button
            onClick={handleLater}
            className="flex-1 justify-center bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 font-medium py-2 px-4 rounded-lg transition-colors"
          >
            Later
          </button>
        </div>
      </div>
    </div>
  );
}