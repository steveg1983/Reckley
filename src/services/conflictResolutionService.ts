/**
 * Enhanced Conflict Resolution Service
 * Provides intelligent field-level merging and smart conflict detection
 * for a "top tier" sync experience
 */

// es-toolkit, not lodash: lodash was an UNDECLARED (phantom) dependency that
// only resolved through hoisting and could break on any lockfile change.
import { isEqual } from 'es-toolkit';
import { formatDateTime } from '../utils/dateFormatter';

export interface FieldChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  timestamp: number;
}

export interface ConflictAnalysis {
  hasConflict: boolean;
  conflictingFields: string[];
  nonConflictingFields: string[];
  canAutoResolve: boolean;
  suggestedResolution: 'merge' | 'client' | 'server' | 'manual';
  mergedData?: Record<string, unknown>;
  confidence: number; // 0-100 confidence in auto-resolution
}

export interface MergeStrategy {
  type: 'fieldLevel' | 'lastWrite' | 'businessRule' | 'manual';
  rules?: MergeRule[];
}

export interface MergeRule {
  field: string;
  strategy: 'newer' | 'older' | 'sum' | 'min' | 'max' | 'concat' | 'union' | 'clientWins' | 'serverWins';
  condition?: (clientValue: unknown, serverValue: unknown) => boolean;
}

// Business rules for financial data
const FINANCIAL_MERGE_RULES: Record<string, MergeRule[]> = {
  account: [
    { field: 'balance', strategy: 'serverWins' }, // Server is source of truth for balances
    { field: 'name', strategy: 'newer' },
    { field: 'type', strategy: 'newer' },
    { field: 'currency', strategy: 'newer' },
    { field: 'is_active', strategy: 'serverWins' }, // Deletion state from server
  ],
  transaction: [
    { field: 'amount', strategy: 'newer' },
    { field: 'description', strategy: 'newer' },
    { field: 'category', strategy: 'newer' },
    { field: 'date', strategy: 'newer' },
    { field: 'cleared', strategy: 'max' }, // Once cleared, stays cleared
    { field: 'tags', strategy: 'union' }, // Merge tags from both
    { field: 'notes', strategy: 'concat' }, // Append notes
    { field: 'reconciled', strategy: 'max' }, // Once reconciled, stays reconciled
  ],
  budget: [
    { field: 'amount', strategy: 'min' }, // Conservative budget limit
    // NEVER 'sum' accumulated money fields: both replicas usually hold the
    // same running total, so summing double-counts. The server value wins;
    // 'spent' should be recomputed from transactions, not merged.
    { field: 'spent', strategy: 'serverWins' },
    { field: 'category', strategy: 'newer' },
    { field: 'period', strategy: 'newer' },
    { field: 'rolloverMode', strategy: 'newer' },
    { field: 'rolloverTo', strategy: 'newer' },
  ],
  goal: [
    { field: 'targetAmount', strategy: 'newer' },
    // Same double-counting hazard as budget.spent — server wins.
    { field: 'currentAmount', strategy: 'serverWins' },
    { field: 'deadline', strategy: 'newer' },
    { field: 'name', strategy: 'newer' },
    { field: 'achieved', strategy: 'max' }, // Once achieved, stays achieved
  ],
};

export class ConflictResolutionService {
  /**
   * Analyzes two versions of data to detect and potentially resolve conflicts
   */
  static analyzeConflict(
    entityType: string,
    clientData: Record<string, unknown>,
    serverData: Record<string, unknown>,
    clientTimestamp: number,
    serverTimestamp: number
  ): ConflictAnalysis {
    // Quick check: if data is identical, no conflict
    if (isEqual(clientData, serverData)) {
      return {
        hasConflict: false,
        conflictingFields: [],
        nonConflictingFields: [],
        canAutoResolve: true,
        suggestedResolution: 'merge',
        mergedData: clientData,
        confidence: 100,
      };
    }

    // Find which fields changed
    const changedFields = this.getChangedFields(clientData, serverData);
    
    // Separate conflicting vs non-conflicting changes
    const analysis = this.categorizeChanges(
      entityType,
      clientData,
      serverData,
      changedFields,
      clientTimestamp,
      serverTimestamp
    );

    // Attempt smart merge if possible
    if (analysis.canAutoResolve) {
      analysis.mergedData = this.performSmartMerge(
        entityType,
        clientData,
        serverData,
        analysis,
        clientTimestamp,
        serverTimestamp
      );
    }

    return analysis;
  }

  /**
   * Get list of fields that differ between two objects
   */
  private static getChangedFields(obj1: Record<string, unknown>, obj2: Record<string, unknown>): string[] {
    const allKeys = new Set([...Object.keys(obj1), ...Object.keys(obj2)]);
    const changedFields: string[] = [];

    for (const key of allKeys) {
      // Skip metadata fields
      if (['id', 'user_id', 'created_at', 'sync_version'].includes(key)) {
        continue;
      }

      if (!isEqual(obj1[key], obj2[key])) {
        changedFields.push(key);
      }
    }

    return changedFields;
  }

  /**
   * Categorize changes as conflicting or non-conflicting
   */
  private static categorizeChanges(
    entityType: string,
    clientData: Record<string, unknown>,
    serverData: Record<string, unknown>,
    changedFields: string[],
    clientTimestamp: number,
    serverTimestamp: number
  ): ConflictAnalysis {
    const conflictingFields: string[] = [];
    const nonConflictingFields: string[] = [];
    let canAutoResolve = true;
    let confidence = 100;

    for (const field of changedFields) {
      const clientValue = clientData[field];
      const serverValue = serverData[field];

      // Check if this is a true conflict or can be merged
      if (this.isNonConflictingChange(field, clientValue, serverValue, entityType)) {
        nonConflictingFields.push(field);
      } else {
        conflictingFields.push(field);
        
        // Check if we can auto-resolve this conflict
        const rule = this.getMergeRule(entityType, field);
        if (!rule) {
          canAutoResolve = false;
          confidence = 0;
        } else {
          // Reduce confidence for each conflicting field
          confidence = Math.max(0, confidence - 10);
        }
      }
    }

    // Determine suggested resolution strategy
    let suggestedResolution: ConflictAnalysis['suggestedResolution'] = 'manual';
    
    if (changedFields.length === 0) {
      suggestedResolution = 'merge';
      confidence = 100;
    } else if (conflictingFields.length === 0) {
      suggestedResolution = 'merge';
      confidence = 95;
    } else if (canAutoResolve) {
      suggestedResolution = 'merge';
      confidence = Math.max(confidence, 70);
    } else if (clientTimestamp > serverTimestamp) {
      suggestedResolution = 'client';
      confidence = 50;
    } else {
      suggestedResolution = 'server';
      confidence = 50;
    }

    return {
      hasConflict: conflictingFields.length > 0,
      conflictingFields,
      nonConflictingFields,
      canAutoResolve,
      suggestedResolution,
      confidence,
    };
  }

  /**
   * Check if a change is non-conflicting (can be automatically merged)
   */
  private static isNonConflictingChange(
    field: string,
    clientValue: unknown,
    serverValue: unknown,
    _entityType: string
  ): boolean {
    // If one is undefined/null and other has value, take the value
    if ((clientValue == null && serverValue != null) || 
        (clientValue != null && serverValue == null)) {
      return true;
    }

    // Special handling for arrays (tags, categories, etc)
    if (Array.isArray(clientValue) && Array.isArray(serverValue)) {
      // If arrays have no overlapping changes, they can be merged
      return true; // Will be union merged
    }

    // Special handling for notes/description fields - can be concatenated
    if (['notes', 'description', 'memo'].includes(field)) {
      return true; // Will be concatenated
    }

    // For boolean fields like 'cleared' or 'reconciled', true wins
    if (typeof clientValue === 'boolean' && typeof serverValue === 'boolean') {
      return true; // Will use MAX strategy
    }

    // Different fields changed = non-conflicting
    return false;
  }

  /**
   * Get merge rule for a specific field
   */
  private static getMergeRule(entityType: string, field: string): MergeRule | undefined {
    const rules = FINANCIAL_MERGE_RULES[entityType];
    if (!rules) return undefined;
    
    return rules.find(r => r.field === field);
  }

  /**
   * Perform intelligent field-level merge
   */
  private static performSmartMerge(
    entityType: string,
    clientData: Record<string, unknown>,
    serverData: Record<string, unknown>,
    analysis: ConflictAnalysis,
    clientTimestamp: number,
    serverTimestamp: number
  ): Record<string, unknown> {
    const merged = { ...serverData }; // Start with server as base

    // Apply non-conflicting changes from client
    for (const field of analysis.nonConflictingFields) {
      const clientValue = clientData[field];
      const serverValue = serverData[field];
      
      merged[field] = this.mergeFieldValue(
        field,
        clientValue,
        serverValue,
        entityType,
        clientTimestamp,
        serverTimestamp
      );
    }

    // Apply merge rules for conflicting fields
    for (const field of analysis.conflictingFields) {
      const rule = this.getMergeRule(entityType, field);
      if (rule) {
        merged[field] = this.applyMergeRule(
          rule,
          clientData[field],
          serverData[field],
          clientTimestamp,
          serverTimestamp
        );
      } else {
        // Default to newer value
        merged[field] = clientTimestamp > serverTimestamp 
          ? clientData[field] 
          : serverData[field];
      }
    }

    // Preserve important metadata
    merged.updated_at = Math.max(clientTimestamp, serverTimestamp);
    
    return merged;
  }

  /**
   * Merge a single field value based on type and rules
   */
  private static mergeFieldValue(
    field: string,
    clientValue: unknown,
    serverValue: unknown,
    entityType: string,
    clientTimestamp: number,
    serverTimestamp: number
  ): unknown {
    // Handle null/undefined
    if (clientValue == null) return serverValue;
    if (serverValue == null) return clientValue;

    // Arrays - union merge
    if (Array.isArray(clientValue) && Array.isArray(serverValue)) {
      return [...new Set([...clientValue, ...serverValue])];
    }

    // Notes/descriptions - concatenate if different
    if (['notes', 'description', 'memo'].includes(field)) {
      if (clientValue === serverValue) return clientValue;
      
      // Concatenate with a timestamp indicator, in the house date-time shape
      // (4 Sep 2026 ruling). This one ends up INSIDE the user's note, where it
      // outlives the merge — so it reads as the app's own dates read, and it
      // does not carry seconds nobody recorded to.
      //
      // The server side of this pair was formatted into a `_serverTime` nothing
      // ever read; removed rather than restyled.
      const clientTime = formatDateTime(new Date(clientTimestamp));

      return `${serverValue}\n---\n[Added ${clientTime}]: ${clientValue}`;
    }

    // Booleans - true wins (for cleared, reconciled, etc)
    if (typeof clientValue === 'boolean' && typeof serverValue === 'boolean') {
      return clientValue || serverValue;
    }

    // Default to newer value
    return clientTimestamp > serverTimestamp ? clientValue : serverValue;
  }

  /**
   * Apply a specific merge rule
   */
  private static applyMergeRule(
    rule: MergeRule,
    clientValue: unknown,
    serverValue: unknown,
    clientTimestamp: number,
    serverTimestamp: number
  ): unknown {
    // Check condition if exists
    if (rule.condition && !rule.condition(clientValue, serverValue)) {
      return serverValue; // Default to server if condition not met
    }

    switch (rule.strategy) {
      case 'newer':
        return clientTimestamp > serverTimestamp ? clientValue : serverValue;
      
      case 'older':
        return clientTimestamp < serverTimestamp ? clientValue : serverValue;
      
      case 'sum':
        return (Number(clientValue) || 0) + (Number(serverValue) || 0);
      
      case 'min':
        return Math.min(Number(clientValue) || 0, Number(serverValue) || 0);
      
      case 'max':
        return Math.max(Number(clientValue) || 0, Number(serverValue) || 0);
      
      case 'concat':
        if (clientValue === serverValue) return clientValue;
        return `${serverValue}\n${clientValue}`;
      
      case 'union':
        if (Array.isArray(clientValue) && Array.isArray(serverValue)) {
          return [...new Set([...clientValue, ...serverValue])];
        }
        return serverValue;
      
      case 'clientWins':
        return clientValue;
      
      case 'serverWins':
        return serverValue;
      
      default:
        return serverValue;
    }
  }

  /**
   * Generate a human-readable conflict summary
   */
  static generateConflictSummary(analysis: ConflictAnalysis): string {
    if (!analysis.hasConflict) {
      return 'No conflicts detected - changes can be merged automatically.';
    }

    const parts: string[] = [];
    
    if (analysis.conflictingFields.length > 0) {
      parts.push(`Conflicting fields: ${analysis.conflictingFields.join(', ')}`);
    }
    
    if (analysis.nonConflictingFields.length > 0) {
      parts.push(`Compatible changes: ${analysis.nonConflictingFields.join(', ')}`);
    }
    
    if (analysis.canAutoResolve) {
      parts.push(`Automatic resolution available (${analysis.confidence}% confidence)`);
    } else {
      parts.push('Manual resolution required');
    }
    
    return parts.join('\n');
  }

  /**
   * Check if conflict requires user intervention
   */
  static requiresUserIntervention(
    analysis: ConflictAnalysis,
    userPreferences?: { autoResolveThreshold?: number }
  ): boolean {
    const threshold = userPreferences?.autoResolveThreshold || 70;
    
    // Never auto-resolve if confidence too low
    if (analysis.confidence < threshold) {
      return true;
    }
    
    // Conflicting money fields ALWAYS require user review — no confidence
    // score justifies silently picking a side on an amount. (The previous
    // `confidence < 90` guard let single-field amount conflicts auto-resolve
    // at exactly 90.)
    const criticalFields = ['amount', 'balance', 'targetAmount', 'currentAmount', 'spent'];
    const hasCriticalConflict = analysis.conflictingFields.some(f =>
      criticalFields.includes(f)
    );

    if (hasCriticalConflict) {
      return true;
    }

    return !analysis.canAutoResolve;
  }
}

// Export singleton instance for easy use
export const conflictResolver = new ConflictResolutionService();
