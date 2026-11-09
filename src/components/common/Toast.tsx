import React, { useEffect, useState } from 'react';
import { XIcon, CheckCircleIcon, AlertCircleIcon } from '../icons';
import { InfoIcon } from '../icons/InfoIcon';
import { SAFE_AREA_TOP, SIDE_INSET_MARGINS } from '../layout/chromeOffsets';

export interface ToastMessage {
  id: string;
  title?: string;
  message: string;
  type: 'success' | 'error' | 'warning' | 'info';
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface ToastProps {
  toast: ToastMessage;
  onDismiss: (id: string) => void;
}

export function Toast({ toast, onDismiss }: ToastProps): React.JSX.Element {
  const [isVisible, setIsVisible] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);

  const handleDismiss = React.useCallback(() => {
    setIsLeaving(true);
    window.setTimeout(() => {
      onDismiss(toast.id);
    }, 300);
  }, [onDismiss, toast.id]);

  useEffect(() => {
    // Trigger enter animation
    const enterTimer = window.setTimeout(() => setIsVisible(true), 10);

    if (toast.duration === 0) {
      return () => {
        window.clearTimeout(enterTimer);
      };
    }

    const dismissTimer = window.setTimeout(() => {
      handleDismiss();
    }, toast.duration ?? 5000);

    return () => {
      window.clearTimeout(enterTimer);
      window.clearTimeout(dismissTimer);
    };
  }, [toast.duration, handleDismiss]);

  // Three of these four say something about the state of the reader's money —
  // it worked, it failed, look at this — and colour is how they say it. `info`
  // says none of those: it is the app talking, and a remark that needs no
  // attention gets no hue (stock-blue ruling, 28 Aug 2026). It keeps its icon,
  // its ground and its border; what it loses is the claim.
  const icons = {
    success: <CheckCircleIcon size={20} className="text-green-500" />,
    error: <AlertCircleIcon size={20} className="text-red-500" />,
    warning: <AlertCircleIcon size={20} className="text-yellow-500" />,
    info: <InfoIcon size={20} className="text-gray-500 dark:text-gray-400" />,
  };

  const bgColors = {
    success: 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800',
    error: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800',
    warning: 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800',
    info: 'bg-gray-50 dark:bg-gray-700/50 border-gray-200 dark:border-gray-700',
  };

  const textColors = {
    success: 'text-green-800 dark:text-green-200',
    error: 'text-red-800 dark:text-red-200',
    warning: 'text-yellow-800 dark:text-yellow-200',
    info: 'text-gray-800 dark:text-gray-200',
  };

  return (
    <div
      className={`
        flex items-start gap-3 p-4 rounded-lg border shadow-lg
        ${bgColors[toast.type]}
        transform transition-all duration-300 ease-out
        ${isVisible && !isLeaving ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0'}
        min-w-[300px] max-w-[500px]
      `}
      role="alert"
      aria-live="polite"
    >
      <div className="flex-shrink-0 mt-0.5">
        {icons[toast.type]}
      </div>
      
      <div className="flex-1 min-w-0">
        {toast.title && (
          <p className={`font-semibold ${textColors[toast.type]}`}>
            {toast.title}
          </p>
        )}
        <p className={`text-sm ${textColors[toast.type]} ${toast.title ? 'mt-1' : ''}`}>
          {toast.message}
        </p>
        
        {toast.action && (
          <button
            onClick={toast.action.onClick}
            className={`
              mt-2 text-sm font-medium underline
              ${textColors[toast.type]} hover:no-underline
            `}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      
      <button
        onClick={handleDismiss}
        className={`
          flex-shrink-0 p-1 rounded-md
          ${textColors[toast.type]} hover:bg-black/5 dark:hover:bg-white/5
          min-w-[44px] min-h-[44px] flex items-center justify-center
        `}
        aria-label="Dismiss notification"
      >
        <XIcon size={16} />
      </button>
    </div>
  );
}

interface ToastContainerProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps): React.JSX.Element {
  return (
    <div
      className="fixed top-4 right-4 z-50 space-y-3"
      // Clear of the status bar and of the iPhone Duo's pill column; both 0px
      // on a desktop, where top-4 right-4 is the whole story.
      style={{ ...SIDE_INSET_MARGINS, marginTop: SAFE_AREA_TOP }}
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map(toast => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
