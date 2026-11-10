// Global type declarations

// Network Information API (non-standard browser API)
// Note: effectiveType is string (not strict union) because browser API can return any value
interface NetworkInformation {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
  addEventListener?: (type: string, listener: EventListener) => void;
  removeEventListener?: (type: string, listener: EventListener) => void;
}

// Extend Navigator with non-standard connection APIs
interface Navigator {
  connection?: NetworkInformation;
  mozConnection?: NetworkInformation;
  webkitConnection?: NetworkInformation;
  standalone?: boolean;  // iOS Safari PWA mode
  hapticFeedback?: {
    impactLight?: () => void;
    impactMedium?: () => void;
    impactHeavy?: () => void;
    notificationSuccess?: () => void;
    notificationWarning?: () => void;
    notificationError?: () => void;
    selectionChanged?: () => void;
    [key: string]: (() => void) | undefined;
  };
}

interface Window {
  /**
   * What the installed-app detector saw, attempt by attempt — printed by
   * Settings → App's Display diagnostics so a wrapper regression costs one
   * screenshot. Written only by main.tsx's detection block.
   */
  __wtInstalledAppTrace?: string[];
  Sentry?: {
    captureException: (error: Error) => void;
    captureMessage: (message: string) => void;
    withScope: (callback: (scope: unknown) => void) => void;
  };
  Clerk?: {
    user?: {
      id: string;
      emailAddresses?: Array<{ emailAddress: string }>;
    };
    session?: {
      getToken: () => Promise<string | null>;
    };
  };
  // Realtime sync action timestamp updater for echo prevention
  __updateRealtimeActionTimestamp?: (entity: string, actionType: string) => void;
  /**
   * The bridge the iOS shell injects before the page's own scripts run.
   * Only the two questions the web app asks of it are declared — whether it
   * is there at all, and whether the installed build carries a plugin by
   * name (a page is newer than the app whenever the app has not been
   * updated); the plugins are reached through @capacitor/core's typed
   * proxies, never through this object. See services/push/nativeShell.ts
   * and services/widget/widgetBridge.ts.
   */
  Capacitor?: {
    isNativePlatform?: () => boolean;
    getPlatform?: () => string;
    isPluginAvailable?: (name: string) => boolean;
  };
}
