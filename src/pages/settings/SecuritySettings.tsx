import React, { useState } from 'react';
import { securityService } from '../../services/securityService';
import {
  ShieldIcon,
  FileTextIcon,
  RefreshCwIcon
} from '../../components/icons';
import PageWrapper from '../../components/PageWrapper';
// Through the seam: this deletes an ACCOUNT WITH A COMPANY — Stripe, the rows,
// the Clerk identity — which a device edition does not have. The ledger's own
// wipe is a different act at a different address (/settings/data), and it is
// mounted in both editions. See src/editions/service.ts.
import { DangerZone } from '@service';
import type { SecuritySettings as SecuritySettingsType } from '../../services/securityService';
import { formatDateTime } from '../../utils/dateFormatter';
import { SESSION_ENDS_ON_LEAVE, SESSION_TIMEOUT_CHANGED_EVENT } from '../../hooks/useSessionTimeout';

export default function SecuritySettings() {
  const [settings, setSettings] = useState<SecuritySettingsType>(
    securityService.getSecuritySettings()
  );

  const handleSessionTimeoutChange = (timeout: number) => {
    securityService.updateSecuritySettings({ sessionTimeout: timeout });
    setSettings({ ...settings, sessionTimeout: timeout });
    // Takes effect now, not at the next launch.
    window.dispatchEvent(new Event(SESSION_TIMEOUT_CHANGED_EVENT));
  };

  return (
    <PageWrapper title="Security Settings">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="bg-white dark:bg-gray-800 border border-line dark:border-gray-700 rounded-lg p-6 mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-page font-semibold mb-2 text-gray-900 dark:text-white">Security Settings</h1>
              <p className="text-body text-gray-500 dark:text-gray-400">
                Protect your financial data with advanced security features
              </p>
            </div>
            <ShieldIcon size={48} className="text-gray-300 dark:text-gray-600" />
          </div>
        </div>


        {/* Security Features */}
        <div className="space-y-6">
          {/* ─ FOUR PANELS REMOVED, 15 August 2026 ────────────────────────
              Two-Factor Authentication, Biometric Authentication, End-to-End
              Encryption and Read-Only Mode. All four were DEAD, and dead in
              the one place where a dead control is not an inconvenience but a
              false statement about safety:

                - nothing anywhere read `readOnlyMode`;
                - `verifyBiometric()` was defined and never called, so enabling
                  it registered a credential nothing ever asked for;
                - `encryptData`/`decryptData` were never called by anything, so
                  "End-to-End Encryption" encrypted nothing;
                - the only `twoFactorEnabled` reader was `authService` reading
                  CLERK's own unrelated property.

              A dead toggle accepts input and reports a state back, so a user
              files it as a protection they have chosen. Removed rather than
              relabelled "coming soon", which is still a claim.

              Where each goes instead, on the owner's ruling:
                - two-factor is Clerk's and should be handed to Clerk rather
                  than reimplemented here;
                - read-only was not wanted;
                - encryption in TRANSIT is TLS and always on, at REST is
                  Supabase's, and the file a user carries away got real
                  encryption this morning. Nothing was left for a toggle to
                  decide. */}

          {/* Session Timeout */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6">
            <h3 className="text-card font-semibold text-gray-900 dark:text-white flex items-center gap-2 mb-4">
              <RefreshCwIcon size={20} className="text-orange-600 dark:text-orange-400" />
              Session Timeout
            </h3>
            <div className="space-y-3">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Automatically log out after a period of inactivity
              </p>
              <div className="flex items-center gap-4">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Timeout after:
                </label>
                <select
                  aria-label="Session timeout"
                  value={settings.sessionTimeout}
                  onChange={(e) => handleSessionTimeoutChange(Number(e.target.value))}
                  className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                >
                  {/* 0 is NEVER, and the hook does nothing at all when it is
                      set — no listeners, no interval. A "never" that quietly
                      kept measuring would be the same lie in the other
                      direction. */}
                  {/* The strictest, owner's ask 19 Nov 2026: signed out
                      whenever the app is left or closed, for somebody who
                      signs back in with a passkey in a glance. */}
                  <option value={SESSION_ENDS_ON_LEAVE}>When I leave the app</option>
                  <option value={0}>Never</option>
                  <option value={5}>5 minutes</option>
                  <option value={15}>15 minutes</option>
                  <option value={30}>30 minutes</option>
                  <option value={60}>1 hour</option>
                  <option value={120}>2 hours</option>
                </select>
              </div>
            </div>
          </div>

          {/* Audit Logs */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6">
            <h3 className="text-card font-semibold text-gray-900 dark:text-white flex items-center gap-2 mb-4">
              <FileTextIcon size={20} className="text-gray-600 dark:text-gray-400" />
              Security Information
            </h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded">
                <span className="text-sm text-gray-700 dark:text-gray-300">Failed login attempts</span>
                <span className="font-medium text-gray-900 dark:text-white">
                  {settings.failedAttempts}
                </span>
              </div>
              {settings.lastLogin && (
                <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded">
                  <span className="text-sm text-gray-700 dark:text-gray-300">Last login</span>
                  <span className="font-medium text-gray-900 dark:text-white">
                    {formatDateTime(new Date(settings.lastLogin))}
                  </span>
                </div>
              )}
              <button
                onClick={() => window.location.href = '/settings/security/audit-logs'}
                className="w-full justify-center px-4 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
              >
                View Audit Logs
              </button>
            </div>
          </div>
        </div>

        {/* Account deletion (GDPR right to erasure) */}
        <div className="mt-6">
          <DangerZone />
        </div>

        {/* Two-Factor Setup Modal */}
        {/* The 2FA SETUP MODAL went with its panel. It generated a secret
            and backup codes that nothing ever checked at sign-in — the
            ceremony of security without the thing itself, which is worse
            than its absence because it is convincing. Clerk does this
            properly and already holds the session. */}
      </div>
    </PageWrapper>
  );
}
