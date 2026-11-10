import { useMemo } from 'react';
import { useBankConnectionSnapshot } from '@service';
import type { PendingAtBank } from '../services/banking/pendingAtBank';

/**
 * What the bank says is pending on one account, or null.
 *
 * Read off the bank connections the session already holds (the `@service`
 * seam's passive snapshot — never a fetch), so the register and the reconcile
 * screen can both ask without either mounting the syncing hook. A device
 * edition's snapshot is empty, so this is null there: a local file has no bank
 * feed and nothing pending.
 */
export function usePendingAtBank(accountId: string | null | undefined): PendingAtBank | null {
  const connections = useBankConnectionSnapshot();
  return useMemo(() => {
    if (!accountId) return null;
    for (const connection of connections) {
      const pending = connection.pendingAtBank?.[accountId];
      if (pending && pending.items.length > 0) return pending;
    }
    return null;
  }, [connections, accountId]);
}
