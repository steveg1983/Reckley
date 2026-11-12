import type { Transaction, Account, Category } from '../types';
import { smartCategorizationService } from './smartCategorizationService';
import { parseMoneyInput } from '../utils/decimal';
import { findAccountByOfxIdentifiers } from '../utils/ofxAccountIdentifiers';
import { isSelfTransferCategory } from '../utils/transferMatch';
import {
  findStatementDuplicates,
  type IncomingStatementRow,
  type StatementDuplicateMatch
} from '../utils/statementDuplicates';
import type { StatementBalance } from '../utils/statementBankBalance';

interface OFXTransaction {
  type: string;
  datePosted: string;
  amount: number;
  fitId: string;
  name: string;
  memo?: string;
  checkNum?: string;
  refNum?: string;
  /**
   * Position in the file, from 0. OFX lists <STMTTRN> in STATEMENT order, so
   * this is the bank's own sequence — the only record of which of a day's
   * transactions came first, and until now the one thing this parser threw
   * away. See Transaction.statementSequence.
   */
  sequence: number;
}

export interface OFXAccount {
  bankId?: string;
  accountId: string;
  accountType: string;
  branchId?: string;
  /**
   * True when the statement came from <CCACCTFROM> rather than <BANKACCTFROM>.
   * It matters because in a card section <ACCTID> is the CARD number, which
   * some banks publish in full — so nothing may treat it as an account number.
   */
  isCreditCardStatement: boolean;
}

/**
 * How much the account match is worth trusting.
 *
 * 'identifier' means the account's own recorded sort code / account number (or
 * a card's last 4) is the one in the file — a fact. 'heuristic' means the file
 * was matched by a digit or two appearing in the account's name, or by being
 * the only account of its type — a guess that is usually right and sometimes
 * spectacularly wrong. Callers that write anything permanent must tell them
 * apart.
 */
export type AccountMatchConfidence = 'identifier' | 'heuristic';

export interface AccountMatch {
  account: Account;
  confidence: AccountMatchConfidence;
}

interface OFXParseResult {
  account: OFXAccount;
  transactions: OFXTransaction[];
  balance?: StatementBalance;
  currency?: string;
  startDate?: string;
  endDate?: string;
  /**
   * <STMTTRN> blocks the parser could not turn into a transaction — no date,
   * no amount, an amount that is not a number, or no FITID to identify it by.
   *
   * Counted rather than merely skipped because each one is a payment the file
   * describes and this import will not record. Silently dropping it leaves a
   * register that cannot be reconciled and nothing to say why.
   */
  unreadableRows: number;
}

/**
 * Does a statement line's MEMO say anything its NAME does not?
 *
 * Kept: a reference ("83 SAG BP", "Loan BP", "S GREEN CR"), a place
 * ("Caterham )))"), a card channel with a place ("PLYMOUTH VIS"). Dropped: the
 * memo repeating the payee, and a bare transaction-type code on its own —
 * "DD", "CR", "BP", "VIS", "ATM", "SO", "TFR" — which the row's type already
 * says and which would otherwise put the same two letters in a thousand notes.
 */
export const memoWorthKeeping = (memo: string | undefined, name: string): boolean => {
  if (!memo) return false;
  const trimmed = memo.trim();
  if (trimmed === '') return false;
  if (trimmed.toLowerCase() === name.trim().toLowerCase()) return false;
  return !/^[A-Za-z]{2,4}$/.test(trimmed);
};

export class OFXImportService {
  /**
   * Parse OFX file content
   */
  parseOFX(content: string): OFXParseResult {
    // Remove headers and get to the actual OFX content
    const ofxStart = content.indexOf('<OFX>');
    if (ofxStart === -1) {
      throw new Error('Invalid OFX file: <OFX> tag not found');
    }
    
    const ofxContent = content.substring(ofxStart);
    
    // Parse account information
    const account = this.parseAccountInfo(ofxContent);

    // Parse transactions
    const { transactions, unreadableRows } = this.parseTransactions(ofxContent);

    // Parse balance
    const balance = this.parseBalance(ofxContent);
    
    // Parse date range
    const startDate = this.readTag(ofxContent, 'DTSTART');
    const endDate = this.readTag(ofxContent, 'DTEND');
    
    // Parse currency
    const currency = this.readTag(ofxContent, 'CURDEF') || 
                    'GBP';
    
    return {
      account,
      transactions,
      balance,
      currency,
      startDate: startDate ? this.parseOFXDate(startDate) : undefined,
      endDate: endDate ? this.parseOFXDate(endDate) : undefined,
      unreadableRows
    };
  }
  
  /**
   * Parse account information from OFX
   */
  private parseAccountInfo(content: string): OFXAccount {
    // Which section describes the account decides what <ACCTID> MEANS: in
    // <CCACCTFROM> it is the card number, in <BANKACCTFROM> the account
    // number. Read the tags from inside that section rather than from the
    // whole file, so a value from elsewhere in the statement cannot stand in
    // for one the section omitted.
    const cardBlock = this.extractBlock(content, 'CCACCTFROM');
    const bankBlock = this.extractBlock(content, 'BANKACCTFROM');
    const isCreditCardStatement = cardBlock !== null;
    const accountBlock = cardBlock ?? bankBlock ?? content;

    const accountId = this.readTag(accountBlock, 'ACCTID');

    if (!accountId) {
      throw new Error('Account ID not found in OFX file');
    }

    const bankId = this.readTag(accountBlock, 'BANKID');

    const branchId = this.readTag(accountBlock, 'BRANCHID');

    // Card sections routinely omit <ACCTTYPE> — it would be saying the
    // obvious. Defaulting those to CHECKING would file a card statement as a
    // current account, so the section itself supplies the answer.
    const accountType = this.readTag(accountBlock, 'ACCTTYPE') ||
                       (isCreditCardStatement ? 'CREDITCARD' : 'CHECKING');

    return {
      bankId: bankId || undefined,
      accountId: accountId.trim(),
      accountType,
      branchId: branchId || undefined,
      isCreditCardStatement
    };
  }

  /**
   * The contents of an OFX element, or null when the file has no such element.
   * SGML-style OFX often omits closing tags on leaf values but not on the
   * blocks, so an unclosed block is treated as absent rather than swallowing
   * the rest of the file.
   */
  private extractBlock(content: string, tagName: string): string | null {
    const openTag = `<${tagName}>`;
    const closeTag = `</${tagName}>`;
    const start = content.indexOf(openTag);
    if (start === -1) return null;

    const end = content.indexOf(closeTag, start + openTag.length);
    if (end === -1) return null;

    return content.substring(start + openTag.length, end);
  }
  
  /**
   * Parse transactions from OFX, and say how many rows were unreadable.
   *
   * The amount goes through parseMoneyInput for the same reason parseBalance
   * does: `new Decimal('N/A')` THROWS, and a throw here would abort the whole
   * import over one malformed tag — the user would lose an entire statement to
   * a row their bank got wrong. A row whose TRNAMT cannot be read is left out
   * and counted, never guessed at and never imported as NaN, which would
   * poison every balance downstream.
   */
  private parseTransactions(content: string): { transactions: OFXTransaction[]; unreadableRows: number } {
    const transactions: OFXTransaction[] = [];
    let unreadableRows = 0;

    // Find all transaction blocks
    const transactionPattern = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/g;
    let match;

    while ((match = transactionPattern.exec(content)) !== null) {
      const transBlock = match[1];
      
      const type = this.readTag(transBlock, 'TRNTYPE') || 
                  'OTHER';
      
      const datePosted = this.readTag(transBlock, 'DTPOSTED');
      
      const amountStr = this.readTag(transBlock, 'TRNAMT');
      
      const fitId = this.readTag(transBlock, 'FITID');
      
      const memo = this.readTag(transBlock, 'MEMO');

      // NAME is the payee — what a bank statement prints in its description
      // column. A file with no NAME at all falls back to the memo, then to
      // "Unknown", so a row is never described as nothing.
      const name = this.readTag(transBlock, 'NAME') || memo || 'Unknown';

      const checkNum = this.readTag(transBlock, 'CHECKNUM');
      
      const refNum = this.readTag(transBlock, 'REFNUM');
      
      const amount = amountStr === null ? null : parseMoneyInput(amountStr);

      if (!datePosted || amount === null || !fitId) {
        unreadableRows++;
        continue;
      }

      transactions.push({
        type,
        datePosted: this.parseOFXDate(datePosted),
        amount,
        fitId: fitId.trim(),
        name: this.cleanString(name),
        memo: memo ? this.cleanString(memo) : undefined,
        checkNum: checkNum || undefined,
        refNum: refNum || undefined,
        // Position among the rows KEPT, not among the <STMTTRN> blocks seen:
        // a block missing a date, amount or FITID is skipped above, and
        // counting it would leave a gap that reads as a lost transaction.
        sequence: transactions.length
      });
    }

    return { transactions, unreadableRows };
  }
  
  /**
   * The statement's CLOSING balance, read from <LEDGERBAL> and nowhere else.
   *
   * The distinction is not pedantry. A statement carries two balances, and the
   * other one is a trap: <AVAILBAL> on a credit card is the REMAINING CREDIT,
   * so a £20 debt on a £3,300 limit publishes an <AVAILBAL><BALAMT> of 3280 —
   * the same trap cardNormalization documents for the bank feed. Reading the
   * first <BALAMT> in the file happened to land on the ledger only because the
   * OFX schema orders LEDGERBAL before AVAILBAL; now that this figure decides
   * what the account reconciles against, it is read from the aggregate that
   * defines it. A file with no closed <LEDGERBAL> has no closing balance to
   * offer, and says so by returning nothing rather than by guessing.
   *
   * The amount goes through parseMoneyInput, which returns null for anything
   * that is not a plain signed decimal. `new Decimal('12.34CR')` THROWS, and a
   * throw here would fail the whole import over one unreadable tag.
   */
  private parseBalance(content: string): StatementBalance | undefined {
    const ledgerBlock = this.extractBlock(content, 'LEDGERBAL');
    if (!ledgerBlock) {
      return undefined;
    }

    const balanceAmount = this.readTag(ledgerBlock, 'BALAMT');
    const balanceDate = this.readTag(ledgerBlock, 'DTASOF');

    if (!balanceAmount || !balanceDate) {
      return undefined;
    }

    const amount = parseMoneyInput(balanceAmount);
    if (amount === null) {
      return undefined;
    }

    return {
      amount,
      dateAsOf: this.parseOFXDate(balanceDate)
    };
  }
  
  /**
   * Extract value between tags or until newline
   */
  private extractValue(content: string, startTag: string, endTag: string): string | null {
    const startIndex = content.indexOf(startTag);
    if (startIndex === -1) return null;

    const valueStart = startIndex + startTag.length;
    const valueEnd = endTag === '\n'
      ? content.indexOf('\n', valueStart)
      : content.indexOf(endTag, valueStart);

    if (valueEnd === -1) return null;

    return content.substring(valueStart, valueEnd).trim();
  }

  /**
   * A tag's value, whether or not it is closed — and telling APART "the tag is
   * not here" from "the tag is here and empty".
   *
   * The old readers were `closed || unclosed`, which cannot make that
   * distinction, because an empty value is '' and '' is falsy. A Sage-format private-bank export
   * writes <MEMO></MEMO> for a transaction with no memo, so the closed read
   * correctly returned '', the || fell through to the unclosed read, and that
   * one runs to the end of the LINE — capturing the literal text "</MEMO>".
   * Every affected transaction was then described as "</MEMO>".
   *
   * It was never memo-specific: the same pattern read TRNTYPE, DTPOSTED,
   * TRNAMT, FITID, NAME, CHECKNUM and REFNUM, so any of them, present but
   * empty, yielded its own closing tag as its value. An empty <TRNAMT></TRNAMT>
   * would have become the string "</TRNAMT>".
   *
   * So: try the closed form first and RETURN it if the tag was there at all,
   * empty or not. Only fall back to the line-terminated read when the tag is
   * genuinely unclosed — the SGML style OFX 1.x also permits.
   */
  private readTag(content: string, tagName: string): string | null {
    const closed = this.extractValue(content, `<${tagName}>`, `</${tagName}>`);
    if (closed !== null) return closed;
    return this.extractValue(content, `<${tagName}>`, '\n');
  }
  
  /**
   * Parse OFX date format (YYYYMMDDHHMMSS or YYYYMMDD)
   */
  private parseOFXDate(dateStr: string): string {
    // Remove timezone info if present [0:GMT]
    const cleanDate = dateStr.replace(/\[.*?\]/, '');
    
    // Extract date parts
    const year = cleanDate.substring(0, 4);
    const month = cleanDate.substring(4, 6);
    const day = cleanDate.substring(6, 8);
    
    return `${year}-${month}-${day}`;
  }
  
  /**
   * Clean string values from OFX
   */
  private cleanString(str: string): string {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
  }
  
  /**
   * Convert OFX transaction type to our transaction type
   */
  private getTransactionType(ofxType: string, amount: number): 'income' | 'expense' {
    // Signed convention: the signed TRNAMT is authoritative. A negative amount
    // is money OUT even when TRNTYPE is CREDIT/DEP/INT/DIV (e.g. a reversed
    // credit), and a positive amount is money IN even when TRNTYPE is DEBIT.
    if (amount < 0) {
      return 'expense';
    }
    if (amount > 0) {
      return 'income';
    }

    // Zero/ambiguous amount: let the OFX transaction type break the tie.
    const incomeTypes = ['CREDIT', 'DEP', 'INT', 'DIV'];
    return incomeTypes.includes(ofxType) ? 'income' : 'expense';
  }
  
  /**
   * Match OFX account to existing account
   */
  findMatchingAccount(ofxAccount: OFXAccount, existingAccounts: Account[]): Account | null {
    return this.matchAccount(ofxAccount, existingAccounts)?.account ?? null;
  }

  /**
   * Match OFX account to existing account, saying how sure the match is.
   *
   * The first tier is the only one that is evidence: the account's own
   * recorded sort code / account number is the file's. Everything below it
   * looks for the file's digits inside a display name or falls back to "the
   * only account of that type", both of which match by coincidence often
   * enough that nothing permanent should be written on their say-so.
   */
  matchAccount(ofxAccount: OFXAccount, existingAccounts: Account[]): AccountMatch | null {
    const byIdentifier = findAccountByOfxIdentifiers(ofxAccount, existingAccounts);
    if (byIdentifier) {
      return { account: byIdentifier, confidence: 'identifier' };
    }

    const guess = this.guessMatchingAccount(ofxAccount, existingAccounts);
    return guess ? { account: guess, confidence: 'heuristic' } : null;
  }

  private guessMatchingAccount(ofxAccount: OFXAccount, existingAccounts: Account[]): Account | null {
    // First try exact account number match (last 4 digits)
    const ofxLast4 = ofxAccount.accountId.slice(-4);

    for (const account of existingAccounts) {
      // Check if account name or institution contains the account number
      if (account.name.includes(ofxLast4) || 
          (account.institution && account.institution.includes(ofxLast4))) {
        return account;
      }
      
      // Check if account has matching sort code (UK specific)
      if (ofxAccount.bankId && account.institution) {
        const sortCode = ofxAccount.bankId.slice(-6); // UK sort codes are 6 digits
        if (account.institution.includes(sortCode)) {
          return account;
        }
      }
    }
    
    // Try matching by account type
    const typeMap: Record<string, Account['type']> = {
      'CHECKING': 'current',
      'SAVINGS': 'savings',
      'CREDITCARD': 'credit',
      'CREDITLINE': 'credit',
      'LOAN': 'loan',
      'INVESTMENT': 'investment'
    };
    
    const mappedType = typeMap[ofxAccount.accountType];
    if (mappedType) {
      const typeMatches = existingAccounts.filter(a => a.type === mappedType);
      if (typeMatches.length === 1) {
        return typeMatches[0];
      }
    }
    
    return null;
  }
  
  /**
   * Import OFX transactions
   */
  async importTransactions(
    ofxContent: string,
    existingAccounts: Account[],
    existingTransactions: Transaction[],
    options: {
      accountId?: string;
      skipDuplicates?: boolean;
      duplicateThreshold?: number;
      categories?: Category[];
      autoCategorize?: boolean;
      /**
       * FITIDs the user has looked at and decided to import anyway — rows the
       * amount-and-date rule flagged as already held but which are genuinely
       * new (two £20 withdrawals on one day). Never overrides a FITID match:
       * there the bank itself says the two are the same transaction.
       */
      importAnywayFitIds?: readonly string[];
    } = {}
  ): Promise<{
    transactions: Omit<Transaction, 'id'>[];
    matchedAccount: Account | null;
    /**
     * What the file says about its own account, matched or not. Callers need
     * it to show which account the statement came from, and to offer its
     * details to an account that has none recorded.
     */
    ofxAccount: OFXAccount;
    /**
     * How the account above was found — null when the caller named the
     * account itself, because then the file did not choose it.
     */
    matchConfidence: AccountMatchConfidence | null;
    /**
     * What the bank says the account was worth at the end of the statement —
     * the figure Reconciliation calls Bank Balance. Undefined when the file
     * carries no <LEDGERBAL>.
     *
     * The sign is the file's own, untouched, and that is deliberate. OFX signs
     * BALAMT in the same frame as the TRNAMTs beside it: on a card statement a
     * purchase is a negative TRNAMT, so a card with money owing closes on a
     * negative ledger balance — which is exactly how this app stores a
     * liability. TrueLayer's /cards surface is the opposite (`current` is the
     * amount owed, positive) and cardNormalization negates it for that reason;
     * applying that negation here would turn a correctly-signed debt into an
     * asset. Whichever way a file signs its balance, it signs its transactions
     * the same way, and this importer already stores those verbatim.
     */
    statementBalance?: StatementBalance;
    /**
     * Every row in the file, in file order — including the ones this call
     * decided not to import. The review list is built from these, and
     * `duplicateMatches` indexes into them.
     */
    statementRows: IncomingStatementRow[];
    /**
     * What the register already holds, split by how sure the match is:
     * `certain` is the bank's own FITID on both sides, `possible` is same
     * account / exact amount / near date and wants a human. Reported whether
     * or not `skipDuplicates` acted on them.
     */
    duplicateMatches: { certain: StatementDuplicateMatch[]; possible: StatementDuplicateMatch[] };
    /** How many rows were left out as already held. */
    duplicates: number;
    newTransactions: number;
    /**
     * Rows in the file this import could not read at all — see
     * OFXParseResult.unreadableRows. Nothing was written for them, so a caller
     * that does not surface this is losing payments in silence.
     */
    unreadableRows: number;
  }> {
    const parseResult = this.parseOFX(ofxContent);

    // Find matching account
    let matchedAccount: Account | null = null;
    let matchConfidence: AccountMatchConfidence | null = null;
    if (options.accountId) {
      matchedAccount = existingAccounts.find(a => a.id === options.accountId) || null;
    } else {
      const match = this.matchAccount(parseResult.account, existingAccounts);
      matchedAccount = match?.account ?? null;
      matchConfidence = match?.confidence ?? null;
    }

    const destinationAccountId = matchedAccount?.id || 'default';

    // Every row is drafted BEFORE anything is dropped, so the duplicate rule
    // sees the same list the user is shown and the two cannot disagree about
    // which row is which.
    const drafts: Omit<Transaction, 'id'>[] = [];
    const statementRows: IncomingStatementRow[] = [];

    for (const ofxTrx of parseResult.transactions) {
      // Signed convention: OFX TRNAMT is already signed at the source
      // (debits negative, credits positive), so store the signed value directly.
      const amount = ofxTrx.amount;
      const type = this.getTransactionType(ofxTrx.type, ofxTrx.amount);

      // THE PAYEE IS THE DESCRIPTION. This read `memo || name`, which is
      // backwards for every UK bank that fills both: HSBC's NAME is the
      // payee ("PAYPAL PAYMENT", "PIZZA FEDERICCI") and its MEMO is the
      // channel or the place ("DD", "SEVENOAKS )))"), so the register showed
      // a column of "DD"s where the statement showed names (owner, 29 Sep
      // 2026). The memo goes to notes when it says something the payee does
      // not — a reference like "83 SAG BP" — and is dropped when it is a bare
      // type code the description would only be muddied by.
      const description = ofxTrx.name;

      // No FITID line. It lived here from before `import_source_id` existed,
      // because notes was the only place a running app could read it back
      // from; the bank's id now rides in `import_source_id` (fitid:…) and the
      // import RPC refuses a repeat by it, so the note was doing nothing but
      // filling the notes column with a 31-digit number (owner, 29 Sep 2026).
      // readFitId in utils/statementDuplicates still reads the OLD notes, so
      // rows written before this keep their certainty.
      //
      // No REFNUM line either, for the same reason (owner, 12 Nov 2026, of a
      // Coutts statement: "a field that keeps getting inserted into Notes").
      // Coutts fills REFNUM on every row with its own nine-digit serial, a
      // second id beside the FITID that no person wrote and no statement
      // prints, so every row arrived with "Ref: 722957308" in a column meant
      // for the user's words. A cheque number stays: that one is on the
      // cheque stub and is how a person finds the row.
      const notes = [
        memoWorthKeeping(ofxTrx.memo, ofxTrx.name) ? ofxTrx.memo : null,
        ofxTrx.checkNum ? `Check #: ${ofxTrx.checkNum}` : null
      ].filter(Boolean).join('\n');

      const transaction: Omit<Transaction, 'id'> = {
        date: new Date(ofxTrx.datePosted),
        description,
        amount,
        type,
        accountId: destinationAccountId,
        category: '',
        // A blank category has nothing to vouch for, so it starts confirmed;
        // the auto-categorise pass below is the ONLY thing in this importer
        // that can turn it into a guess, and it says so when it does.
        categoryConfirmed: true,
        // Deliberately NOT cleared, despite the file coming from the bank.
        // "Cleared" here does not mean the bank has processed it — it means the
        // USER has checked it against their statement and finalised the
        // reconciliation. Importing a statement is the moment that check should
        // happen, so arriving pre-cleared skips the one step that would catch a
        // missing or wrong row and leave the account agreeing with the bank.
        // Every other file importer already defaults this false; OFX was alone.
        cleared: false,
        notes,
        isRecurring: false,
        // The bank's own order within the statement, kept so the register's
        // running balance can walk a day the way the bank printed it instead of
        // guessing. Duplicates are skipped above, so this stays the position in
        // the FILE, not in this batch — re-importing an overlapping statement
        // must not renumber the rows it shares with the last one.
        statementSequence: ofxTrx.sequence
      };

      // Auto-categorize if enabled
      if (options.autoCategorize && options.categories) {
        // Train the model if we have existing transactions
        if (existingTransactions.length > 0) {
          smartCategorizationService.learnFromTransactions(existingTransactions, options.categories);
        }

        // Get category suggestions
        const suggestions = smartCategorizationService.suggestCategories(transaction as Transaction, 1);

        if (suggestions.length > 0 &&
            suggestions[0].confidence >= 0.7 &&
            // A transfer to the account the row is already in describes nothing
            // — and it is exactly what the merchant key "immediate faster
            // payment" produces on an account whose own sweeps share it.
            !isSelfTransferCategory(options.categories, suggestions[0].categoryId, destinationAccountId)) {
          transaction.category = suggestions[0].categoryId;
          // The app's opinion, not the user's. Marked so the register can show
          // it as a suggestion and offer one-click agreement: a filled-in
          // category that looked identical to a chosen one is precisely what
          // made "have I checked this row?" unanswerable on a fresh import.
          // The category is still APPLIED — a good guess saves the typing, and
          // it counts in reports exactly as it did before.
          transaction.categoryConfirmed = false;
        }
      }

      drafts.push(transaction);
      statementRows.push({
        date: transaction.date,
        amount,
        description,
        fitId: ofxTrx.fitId
      });
    }

    const duplicateMatches = findStatementDuplicates(
      statementRows,
      existingTransactions,
      destinationAccountId
    );

    // Which drafts to leave out. FITID matches are the bank's own word and are
    // never overridden; an amount-and-date match is evidence a human may have
    // already looked at and overruled.
    const importAnyway = new Set(options.importAnywayFitIds ?? []);
    const skipped = new Set<number>();
    if (options.skipDuplicates !== false) {
      for (const match of duplicateMatches.certain) {
        skipped.add(match.incomingIndex);
      }
      for (const match of duplicateMatches.possible) {
        if (match.fitId !== null && importAnyway.has(match.fitId)) continue;
        skipped.add(match.incomingIndex);
      }
    }

    const transactions = drafts.filter((_, index) => !skipped.has(index));

    return {
      transactions,
      matchedAccount,
      ofxAccount: parseResult.account,
      matchConfidence,
      statementBalance: parseResult.balance,
      statementRows,
      duplicateMatches,
      duplicates: skipped.size,
      newTransactions: transactions.length,
      unreadableRows: parseResult.unreadableRows
    };
  }
}

export const ofxImportService = new OFXImportService();