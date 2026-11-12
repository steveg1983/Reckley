/**
 * OFXImportService Tests
 * Tests for OFX file parsing and transaction import
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ofxImportService } from './ofxImportService';
import { smartCategorizationService } from './smartCategorizationService';
import type { Transaction, Account, Category } from '../types';

// Mock smartCategorizationService
vi.mock('./smartCategorizationService', () => ({
  smartCategorizationService: {
    learnFromTransactions: vi.fn(),
    suggestCategories: vi.fn()
  }
}));

const expectDateOnly = (value: Date | string | undefined, expected: string) => {
  const normalized = value instanceof Date ? value.toISOString().split('T')[0] : value;
  expect(normalized).toBe(expected);
};

describe('OFXImportService', () => {
  // Sample OFX content
  const validOFXContent = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<DTSERVER>20240120120000[0:GMT]
<LANGUAGE>ENG
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<STMTRS>
<CURDEF>GBP
<BANKACCTFROM>
<BANKID>123456
<ACCTID>12345678
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20240101000000[0:GMT]
<DTEND>20240131235959[0:GMT]
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240115120000[0:GMT]
<TRNAMT>-25.50
<FITID>2024011501
<NAME>TESCO STORES
<MEMO>Grocery shopping
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240120090000[0:GMT]
<TRNAMT>2500.00
<FITID>2024012001
<NAME>EMPLOYER PAYMENT
<MEMO>Salary
</STMTTRN>
<STMTTRN>
<TRNTYPE>CHECK
<DTPOSTED>20240110150000[0:GMT]
<TRNAMT>-100.00
<FITID>2024011001
<NAME>Check #1234
<CHECKNUM>1234
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>5000.00
<DTASOF>20240131235959[0:GMT]
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

  const mockAccounts: Account[] = [
    {
      id: 'acc1',
      name: 'Main Current Account (****5678)',
      institution: 'Test Bank',
      type: 'current',
      balance: 5000,
      currency: 'GBP',
      isActive: true
    },
    {
      id: 'acc2',
      name: 'Savings Account',
      institution: 'Test Bank',
      type: 'savings',
      balance: 10000,
      currency: 'GBP',
      isActive: true
    }
  ];

  const mockCategories: Category[] = [
    { id: 'food', name: 'Food & Dining', type: 'expense', icon: 'restaurant' },
    { id: 'salary', name: 'Salary', type: 'income', icon: 'briefcase' },
    { id: 'shopping', name: 'Shopping', type: 'expense', icon: 'shopping-bag' }
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseOFX', () => {
    it('parses valid OFX content', () => {
      const result = ofxImportService.parseOFX(validOFXContent);

      expect(result.account).toEqual({
        bankId: '123456',
        accountId: '12345678',
        accountType: 'CHECKING',
        branchId: undefined,
        isCreditCardStatement: false
      });

      expect(result.transactions).toHaveLength(3);
      expect(result.currency).toBe('GBP');
      expect(result.startDate).toBe('2024-01-01');
      expect(result.endDate).toBe('2024-01-31');
      expect(result.balance).toEqual({
        amount: 5000,
        dateAsOf: '2024-01-31'
      });
    });

    it('parses transactions correctly', () => {
      const result = ofxImportService.parseOFX(validOFXContent);
      const [transaction1, transaction2, transaction3] = result.transactions;

      // First transaction - DEBIT
      expect(transaction1).toEqual({
        type: 'DEBIT',
        datePosted: '2024-01-15',
        amount: -25.50,
        fitId: '2024011501',
        name: 'TESCO STORES',
        memo: 'Grocery shopping',
        checkNum: undefined,
        refNum: undefined,
        sequence: 0
      });

      // Second transaction - CREDIT
      expect(transaction2).toEqual({
        type: 'CREDIT',
        datePosted: '2024-01-20',
        amount: 2500,
        fitId: '2024012001',
        name: 'EMPLOYER PAYMENT',
        memo: 'Salary',
        checkNum: undefined,
        refNum: undefined,
        sequence: 1
      });

      // Third transaction - CHECK
      expect(transaction3).toEqual({
        type: 'CHECK',
        datePosted: '2024-01-10',
        amount: -100,
        fitId: '2024011001',
        name: 'Check #1234',
        memo: undefined,
        checkNum: '1234',
        refNum: undefined,
        sequence: 2
      });
    });

    it('throws error for invalid OFX content', () => {
      expect(() => ofxImportService.parseOFX('Invalid content')).toThrow('Invalid OFX file: <OFX> tag not found');
    });

    it('throws error when account ID is missing', () => {
      const invalidOFX = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKACCTFROM>
<BANKID>123456
<ACCTTYPE>CHECKING
</BANKACCTFROM>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

      expect(() => ofxImportService.parseOFX(invalidOFX)).toThrow('Account ID not found in OFX file');
    });

    it('handles OFX without balance information', () => {
      const ofxWithoutBalance = validOFXContent.replace(/<LEDGERBAL>[\s\S]*?<\/LEDGERBAL>/g, '');
      const result = ofxImportService.parseOFX(ofxWithoutBalance);

      expect(result.balance).toBeUndefined();
    });

    it('handles OFX without date range', () => {
      const ofxWithoutDates = validOFXContent
        .replace(/<DTSTART>.*?\n/g, '')
        .replace(/<DTEND>.*?\n/g, '');
      const result = ofxImportService.parseOFX(ofxWithoutDates);

      expect(result.startDate).toBeUndefined();
      expect(result.endDate).toBeUndefined();
    });

    it('cleans HTML entities in strings', () => {
      const ofxWithEntities = validOFXContent.replace(
        'TESCO STORES',
        'MARKS &amp; SPENCER'
      );
      const result = ofxImportService.parseOFX(ofxWithEntities);

      expect(result.transactions[0].name).toBe('MARKS & SPENCER');
    });

    it('handles credit card accounts', () => {
      const creditCardOFX = validOFXContent.replace(
        '<BANKACCTFROM>',
        '<CCACCTFROM>'
      ).replace(
        '</BANKACCTFROM>',
        '</CCACCTFROM>'
      ).replace(
        '<ACCTTYPE>CHECKING',
        '<ACCTTYPE>CREDITCARD'
      );

      const result = ofxImportService.parseOFX(creditCardOFX);
      expect(result.account.accountType).toBe('CREDITCARD');
      expect(result.account.isCreditCardStatement).toBe(true);
    });

    it('recognises a card statement that omits ACCTTYPE, rather than filing it as a current account', () => {
      const creditCardOFX = validOFXContent
        .replace('<BANKACCTFROM>', '<CCACCTFROM>')
        .replace('</BANKACCTFROM>', '</CCACCTFROM>')
        .replace('<ACCTTYPE>CHECKING\n', '')
        .replace('<BANKID>123456\n', '');

      const result = ofxImportService.parseOFX(creditCardOFX);
      expect(result.account.isCreditCardStatement).toBe(true);
      expect(result.account.accountType).toBe('CREDITCARD');
    });

    it('reads the closing balance from LEDGERBAL, never from AVAILBAL', () => {
      // AVAILBAL on a card is the REMAINING CREDIT, so a £20 debt on a £3,300
      // limit publishes 3280 there. Taken as the bank balance it would tell the
      // user their card was thousands in credit.
      const ofxWithAvailableBalance = validOFXContent.replace(
        '</LEDGERBAL>',
        `</LEDGERBAL>
<AVAILBAL>
<BALAMT>3280.00
<DTASOF>20240131235959[0:GMT]
</AVAILBAL>`
      );

      const result = ofxImportService.parseOFX(ofxWithAvailableBalance);
      expect(result.balance).toEqual({ amount: 5000, dateAsOf: '2024-01-31' });
    });

    it('offers no balance when the file has only an available balance', () => {
      const ofxWithoutLedger = validOFXContent.replace(
        /<LEDGERBAL>[\s\S]*?<\/LEDGERBAL>/g,
        `<AVAILBAL>
<BALAMT>3280.00
<DTASOF>20240131235959[0:GMT]
</AVAILBAL>`
      );

      const result = ofxImportService.parseOFX(ofxWithoutLedger);
      expect(result.balance).toBeUndefined();
    });

    it('keeps the file position of each transaction — the bank\'s own order', () => {
      // OFX lists <STMTTRN> in STATEMENT order, and that is the only record of
      // which of a day's transactions came first. The parser used to throw it
      // away, leaving the register to invent a same-day order; on an account
      // swept back to zero each evening, the invented order showed balances the
      // account never held.
      const result = ofxImportService.parseOFX(validOFXContent);

      // The fixture lists 15 Jan, then 20 Jan, then 10 Jan — file order, NOT
      // date order, which is the point: position is recorded as found.
      expect(result.transactions.map(t => t.sequence)).toEqual([0, 1, 2]);
      expect(result.transactions.map(t => t.datePosted))
        .toEqual(['2024-01-15', '2024-01-20', '2024-01-10']);
    });

    it('numbers the rows it keeps, leaving no gap for one it had to skip', () => {
      // A block missing its FITID is dropped. Counting it would leave a hole in
      // the sequence that reads like a transaction that went missing.
      const withUnusableRow = validOFXContent.replace('<FITID>2024012001\n', '');

      const result = ofxImportService.parseOFX(withUnusableRow);
      expect(result.transactions).toHaveLength(2);
      expect(result.transactions.map(t => t.sequence)).toEqual([0, 1]);
    });

    it('counts the rows it had to skip rather than losing them in silence', () => {
      // Dropping a row the file describes is a payment that will not be in the
      // register. The caller has to be able to say so.
      const withUnusableRow = validOFXContent.replace('<FITID>2024012001\n', '');

      expect(ofxImportService.parseOFX(withUnusableRow).unreadableRows).toBe(1);
      expect(ofxImportService.parseOFX(validOFXContent).unreadableRows).toBe(0);
    });

    it('survives an unreadable TRNAMT instead of failing the whole import', () => {
      // `new Decimal('N/A')` THROWS, exactly as it does for a BALAMT of
      // '5000.00CR'. Reading TRNAMT straight through Decimal cost the user
      // every transaction in the file over one malformed tag.
      const withJunkAmount = validOFXContent.replace('<TRNAMT>2500.00', '<TRNAMT>N/A');

      const result = ofxImportService.parseOFX(withJunkAmount);
      expect(result.transactions).toHaveLength(2);
      expect(result.unreadableRows).toBe(1);
      // Never NaN: a NaN amount poisons every balance downstream.
      expect(result.transactions.some(t => Number.isNaN(t.amount))).toBe(false);
      expect(result.transactions.map(t => t.sequence)).toEqual([0, 1]);
    });

    it('carries the unreadable count through the import path to the caller', async () => {
      const withJunkAmount = validOFXContent.replace('<TRNAMT>2500.00', '<TRNAMT>N/A');

      const result = await ofxImportService.importTransactions(withJunkAmount, mockAccounts, []);
      expect(result.unreadableRows).toBe(1);
      expect(result.transactions).toHaveLength(2);
    });

    it('records a zero LEDGERBAL as a real closing balance of 0.00', () => {
      // ABSENT and ZERO are different, and only one of them means "the file
      // says nothing". A zero ledger balance is a statement of fact and is
      // written like any other: accounts on a nightly two-way sweep — the
      // balance moved to a linked savings account each night — legitimately
      // close at exactly 0.00 every single day, as does a card paid off in
      // full. Refusing to record those (on the theory that a bank publishing
      // a non-zero AVAILBAL beside a zero LEDGERBAL must have left the ledger
      // unfilled) would deny the swept account the one correct figure it has,
      // for ever. AVAILBAL says nothing about whether the ledger is true; on a
      // swept current account it is the overdraft headroom, which is non-zero
      // precisely BECAUSE the balance is zero.
      const sweptToZero = validOFXContent.replace(
        /<LEDGERBAL>[\s\S]*?<\/LEDGERBAL>/g,
        `<LEDGERBAL><BALAMT>0</BALAMT><DTASOF>20240131235959</DTASOF></LEDGERBAL>
<AVAILBAL><BALAMT>250.00</BALAMT><DTASOF>20240131235959</DTASOF></AVAILBAL>`
      );

      expect(ofxImportService.parseOFX(sweptToZero).balance)
        .toEqual({ amount: 0, dateAsOf: '2024-01-31' });
    });

    it('carries that zero through the import path to the caller', async () => {
      const sweptToZero = validOFXContent.replace('<BALAMT>5000.00', '<BALAMT>0.00');

      const result = await ofxImportService.importTransactions(sweptToZero, mockAccounts, []);

      // Not undefined: the caller must be able to tell a zero balance from no
      // balance, because planStatementBankBalance writes the first and skips
      // the second.
      expect(result.statementBalance).toEqual({ amount: 0, dateAsOf: '2024-01-31' });
    });

    it('survives an unreadable BALAMT instead of failing the whole import', () => {
      // `new Decimal('12.34CR')` throws; one odd tag must not cost the user
      // their transactions.
      const ofxWithJunkBalance = validOFXContent.replace('<BALAMT>5000.00', '<BALAMT>5000.00CR');

      const result = ofxImportService.parseOFX(ofxWithJunkBalance);
      expect(result.balance).toBeUndefined();
      expect(result.transactions).toHaveLength(3);
    });

    it('keeps a card statement\'s negative closing balance negative', () => {
      // OFX signs the balance the same way it signs the transactions beside
      // it, and this app stores a liability negative — so it passes straight
      // through. Negating it here (as the TrueLayer card API needs) would turn
      // a debt into an asset.
      const creditCardOFX = validOFXContent
        .replace('<BANKACCTFROM>', '<CCACCTFROM>')
        .replace('</BANKACCTFROM>', '</CCACCTFROM>')
        .replace('<ACCTTYPE>CHECKING', '<ACCTTYPE>CREDITCARD')
        .replace('<BALAMT>5000.00', '<BALAMT>-1234.56');

      const result = ofxImportService.parseOFX(creditCardOFX);
      expect(result.account.isCreditCardStatement).toBe(true);
      expect(result.balance?.amount).toBe(-1234.56);
    });

    it('reads the account tags from the account section, not from anywhere in the file', () => {
      // A payee address block carrying its own <BANKID> must not become the
      // statement's sort code.
      const ofxWithPayeeBlock = validOFXContent.replace(
        '<BANKACCTFROM>',
        `<PAYEEBANKACCTFROM>
<BANKID>999999
<ACCTID>99999999
</PAYEEBANKACCTFROM>
<BANKACCTFROM>`
      );

      const result = ofxImportService.parseOFX(ofxWithPayeeBlock);
      expect(result.account.bankId).toBe('123456');
      expect(result.account.accountId).toBe('12345678');
    });
  });

  describe('findMatchingAccount', () => {
    it('matches account by last 4 digits in name', () => {
      const ofxAccount = {
        accountId: '12345678',
        accountType: 'CHECKING',
        bankId: '123456'
      };

      const match = ofxImportService.findMatchingAccount(ofxAccount, mockAccounts);
      expect(match).toBe(mockAccounts[0]); // Matches '****5678'
    });

    it('matches account by type when only one of that type exists', () => {
      const ofxAccount = {
        accountId: '99999999',
        accountType: 'SAVINGS'
      };

      const match = ofxImportService.findMatchingAccount(ofxAccount, mockAccounts);
      expect(match).toBe(mockAccounts[1]); // Only one savings account
    });

    it('returns null when no match found', () => {
      const ofxAccount = {
        accountId: '11111111',
        accountType: 'INVESTMENT'
      };

      const match = ofxImportService.findMatchingAccount(ofxAccount, mockAccounts);
      expect(match).toBeNull();
    });

    it('matches by bank ID (sort code)', () => {
      const accountWithSortCode: Account = {
        id: 'acc3',
        name: 'Business Account',
        institution: 'Bank 123456',
        type: 'current',
        balance: 0,
        currency: 'GBP',
        isActive: true
      };

      const ofxAccount = {
        accountId: '87654321',
        accountType: 'CHECKING',
        bankId: '123456'
      };

      const match = ofxImportService.findMatchingAccount(ofxAccount, [...mockAccounts, accountWithSortCode]);
      expect(match).toBe(accountWithSortCode);
    });
  });

  describe('matchAccount confidence', () => {
    const ofxAccount = {
      accountId: '12345678',
      accountType: 'CHECKING',
      bankId: '123456',
      isCreditCardStatement: false
    };

    it('calls a match on the account\'s own recorded details an identifier match', () => {
      const recorded: Account = {
        ...mockAccounts[1],
        id: 'acc-recorded',
        sortCode: '12-34-56',
        accountNumber: '12345678'
      };

      const match = ofxImportService.matchAccount(ofxAccount, [recorded]);
      expect(match).toEqual({ account: recorded, confidence: 'identifier' });
    });

    it('prefers the recorded identifiers over an account whose NAME happens to contain the digits', () => {
      const recorded: Account = {
        ...mockAccounts[1],
        id: 'acc-recorded',
        sortCode: '12-34-56',
        accountNumber: '12345678'
      };

      // mockAccounts[0] is named "Main Current Account (****5678)".
      const match = ofxImportService.matchAccount(ofxAccount, [...mockAccounts, recorded]);
      expect(match?.account).toBe(recorded);
    });

    it('calls a name-substring match a guess', () => {
      const match = ofxImportService.matchAccount(ofxAccount, mockAccounts);
      expect(match).toEqual({ account: mockAccounts[0], confidence: 'heuristic' });
    });

    it('calls the only-account-of-this-type fallback a guess', () => {
      const match = ofxImportService.matchAccount(
        { accountId: '99999999', accountType: 'SAVINGS', isCreditCardStatement: false },
        mockAccounts
      );
      expect(match).toEqual({ account: mockAccounts[1], confidence: 'heuristic' });
    });
  });

  describe('importTransactions', () => {
    const existingTransactions: Transaction[] = [
      {
        id: '1',
        date: '2024-01-01',
        description: 'Existing transaction',
        amount: 50,
        type: 'expense',
        accountId: 'acc1',
        category: 'food',
        cleared: true,
        recurring: false
      }
    ];

    it('never marks an imported OFX transaction as cleared', async () => {
      const result = await ofxImportService.importTransactions(
        validOFXContent,
        mockAccounts,
        []
      );
      expect(result.transactions.length).toBeGreaterThan(0);
      // Every one, not "none happened to be true" — a partly-cleared import is
      // the shape that hides a row nobody checked.
      expect(result.transactions.every(t => t.cleared === false)).toBe(true);
    });

    it('hands the statement\'s closing balance to the caller', async () => {
      // Parsed and then dropped, this was the bug: the file states the very
      // figure Reconciliation shows as "Bank Balance N/A".
      const result = await ofxImportService.importTransactions(
        validOFXContent,
        mockAccounts,
        []
      );

      expect(result.statementBalance).toEqual({ amount: 5000, dateAsOf: '2024-01-31' });
    });

    it('reports no closing balance when the file states none', async () => {
      const ofxWithoutBalance = validOFXContent.replace(/<LEDGERBAL>[\s\S]*?<\/LEDGERBAL>/g, '');

      const result = await ofxImportService.importTransactions(
        ofxWithoutBalance,
        mockAccounts,
        []
      );

      expect(result.statementBalance).toBeUndefined();
    });

    it('imports transactions successfully', async () => {
      const result = await ofxImportService.importTransactions(
        validOFXContent,
        mockAccounts,
        existingTransactions
      );

      expect(result.newTransactions).toBe(3);
      expect(result.duplicates).toBe(0);
      expect(result.matchedAccount).toBe(mockAccounts[0]);

      expect(result.transactions).toHaveLength(3);
      
      const [trx1, trx2, trx3] = result.transactions;
      
      // Check first transaction (signed convention: expense stored negative).
      // Called by its payee (NAME); the memo is a note — see the description
      // spec below for the HSBC statement that settled which is which.
      expect(trx1).toMatchObject({
        date: expect.any(Date),
        description: 'TESCO STORES',
        amount: -25.50,
        type: 'expense',
        accountId: 'acc1',
        // Imported statements arrive UNRECONCILED. The bank having processed a
        // payment is not the same as the user having checked it against their
        // statement, and importing is precisely when that check should happen.
        cleared: false
      });
      expectDateOnly(trx1.date, '2024-01-15');
      // The memo, and only the memo: no FITID line (the bank's id rides in
      // import_source_id and the import RPC refuses a repeat by it).
      expect(trx1.notes).toBe('Grocery shopping');

      // Check second transaction
      expect(trx2).toMatchObject({
        date: expect.any(Date),
        description: 'EMPLOYER PAYMENT',
        amount: 2500,
        type: 'income',
        accountId: 'acc1',
        cleared: false
      });
      expectDateOnly(trx2.date, '2024-01-20');

      // Check third transaction (signed convention: expense stored negative)
      expect(trx3).toMatchObject({
        date: expect.any(Date),
        description: 'Check #1234',
        amount: -100,
        type: 'expense',
        accountId: 'acc1',
        cleared: false
      });
      expectDateOnly(trx3.date, '2024-01-10');
      expect(trx3.notes).toBe('Check #: 1234');
    });

    it('uses specified account ID', async () => {
      const result = await ofxImportService.importTransactions(
        validOFXContent,
        mockAccounts,
        existingTransactions,
        { accountId: 'acc2' }
      );

      expect(result.matchedAccount).toBe(mockAccounts[1]);
      expect(result.transactions.every(t => t.accountId === 'acc2')).toBe(true);
      // The caller named the account, so the file did not choose it and there
      // is no confidence in the match to report.
      expect(result.matchConfidence).toBeNull();
    });

    it('always reports the file\'s own account, matched or not', async () => {
      const matched = await ofxImportService.importTransactions(validOFXContent, mockAccounts, []);
      expect(matched.ofxAccount.accountId).toBe('12345678');
      expect(matched.matchConfidence).toBe('heuristic');

      const unmatched = await ofxImportService.importTransactions(validOFXContent, [], []);
      expect(unmatched.ofxAccount.accountId).toBe('12345678');
      expect(unmatched.matchConfidence).toBeNull();
    });

    it('detects and skips duplicate transactions', async () => {
      const existingWithDuplicate: Transaction[] = [
        {
          id: '1',
          date: '2024-01-15',
          description: 'TESCO STORES',
          amount: 25.50,
          type: 'expense',
          accountId: 'acc1',
          category: 'food',
          cleared: true,
          notes: 'FITID: 2024011501',
          recurring: false
        }
      ];

      const result = await ofxImportService.importTransactions(
        validOFXContent,
        mockAccounts,
        existingWithDuplicate
      );

      expect(result.duplicates).toBe(1);
      expect(result.newTransactions).toBe(2); // Only 2 new transactions
    });

    it('imports all transactions when skipDuplicates is false', async () => {
      const existingWithDuplicate: Transaction[] = [
        {
          id: '1',
          date: '2024-01-15',
          description: 'TESCO STORES',
          amount: 25.50,
          type: 'expense',
          accountId: 'acc1',
          category: 'food',
          cleared: true,
          notes: 'FITID: 2024011501',
          recurring: false
        }
      ];

      const result = await ofxImportService.importTransactions(
        validOFXContent,
        mockAccounts,
        existingWithDuplicate,
        { skipDuplicates: false }
      );

      expect(result.duplicates).toBe(0);
      expect(result.newTransactions).toBe(3);
    });

    it('auto-categorizes transactions when enabled', async () => {
      (smartCategorizationService.learnFromTransactions as any).mockImplementation(() => {});
      (smartCategorizationService.suggestCategories as any).mockImplementation((transaction: any) => {
        // Check the description field of the transaction
        if (transaction.description?.includes('TESCO')) {
          return [{ categoryId: 'food', confidence: 0.8, reason: 'Merchant match' }];
        }
        if (transaction.description?.includes('EMPLOYER')) {
          return [{ categoryId: 'salary', confidence: 0.9, reason: 'Keyword match' }];
        }
        return [];
      });

      const result = await ofxImportService.importTransactions(
        validOFXContent,
        mockAccounts,
        existingTransactions,
        { 
          autoCategorize: true,
          categories: mockCategories
        }
      );

      expect(smartCategorizationService.learnFromTransactions).toHaveBeenCalledWith(
        existingTransactions,
        mockCategories
      );

      expect(result.transactions[0].category).toBe('food');
      expect(result.transactions[1].category).toBe('salary');
      expect(result.transactions[2].category).toBe(''); // No suggestion
    });

    /**
     * The category is still applied — a good guess saves the typing — but it
     * must arrive MARKED as a guess. A filled-in category that looked identical
     * to a chosen one is the whole reason "have I checked this row?" was
     * unanswerable after an import.
     */
    it('marks an auto-categorized row as SUGGESTED, not as the user\'s choice', async () => {
      vi.mocked(smartCategorizationService.learnFromTransactions).mockImplementation(() => {});
      vi.mocked(smartCategorizationService.suggestCategories).mockImplementation(transaction =>
        transaction.description?.includes('TESCO')
          ? [{ categoryId: 'food', confidence: 0.8, reason: 'Merchant match' }]
          : []
      );

      const result = await ofxImportService.importTransactions(
        validOFXContent,
        mockAccounts,
        existingTransactions,
        { autoCategorize: true, categories: mockCategories }
      );

      const guessed = result.transactions[0];
      expect(guessed.category).toBe('food');
      expect(guessed.categoryConfirmed).toBe(false);
    });

    it('leaves a row the categoriser said nothing about CONFIRMED — a blank is not a guess', async () => {
      vi.mocked(smartCategorizationService.suggestCategories).mockReturnValue([]);

      const result = await ofxImportService.importTransactions(
        validOFXContent,
        mockAccounts,
        existingTransactions,
        { autoCategorize: true, categories: mockCategories }
      );

      expect(result.transactions.every(t => t.category === '')).toBe(true);
      // Nothing was suggested, so nothing is outstanding: an uncategorised row
      // is a different chore, with its own screen and its own count.
      expect(result.transactions.every(t => t.categoryConfirmed === true)).toBe(true);
    });

    it('imports with no categoriser at all as confirmed', async () => {
      const result = await ofxImportService.importTransactions(
        validOFXContent,
        mockAccounts,
        existingTransactions
      );

      expect(result.transactions.every(t => t.categoryConfirmed === true)).toBe(true);
    });

    it('respects confidence threshold for auto-categorization', async () => {
      (smartCategorizationService.suggestCategories as any).mockReturnValue([
        { categoryId: 'food', confidence: 0.6, reason: 'Low confidence' }
      ]);

      const result = await ofxImportService.importTransactions(
        validOFXContent,
        mockAccounts,
        existingTransactions,
        {
          autoCategorize: true,
          categories: mockCategories
        }
      );

      // All categories should be empty due to low confidence — and a category
      // that was never applied leaves nothing to confirm.
      expect(result.transactions.every(t => t.category === '')).toBe(true);
      expect(result.transactions.every(t => t.categoryConfirmed === true)).toBe(true);
    });

    it('handles unmatched account', async () => {
      const result = await ofxImportService.importTransactions(
        validOFXContent,
        [], // No existing accounts
        []
      );

      expect(result.matchedAccount).toBeNull();
      expect(result.ofxAccount).toEqual({
        bankId: '123456',
        accountId: '12345678',
        accountType: 'CHECKING',
        branchId: undefined,
        isCreditCardStatement: false
      });
      expect(result.transactions.every(t => t.accountId === 'default')).toBe(true);
    });

    it('calls a row by its payee (NAME), and keeps an informative memo as a note', async () => {
      // This used to pin `memo || name`. On the owner's HSBC statement (29 Sep
      // 2026) NAME is the payee ("PAYPAL PAYMENT") and MEMO the channel
      // ("DD"), so the register showed a column of "DD"s where the bank's own
      // statement showed names. The payee is the description; the memo is a
      // note when it says something the payee does not.
      const result = await ofxImportService.importTransactions(
        validOFXContent,
        mockAccounts,
        []
      );

      expect(result.transactions[0].description).toBe('TESCO STORES');
      expect(result.transactions[0].notes).toBe('Grocery shopping');
      // No memo: the name alone, and nothing invented for the notes.
      expect(result.transactions[2].description).toBe('Check #1234');
    });

    it("keeps the bank's own reference number out of the notes", async () => {
      // Owner, 12 Nov 2026, of a Coutts statement: every row arrived with
      // "Ref: <nine digits>" in Notes. REFNUM is the bank's serial, a second
      // id beside the FITID; nobody wrote it and no statement prints it.
      const withRefs = validOFXContent.replace(/(<FITID>[^<\n]*)/g, '$1\n<REFNUM>700000001');
      expect(ofxImportService.parseOFX(withRefs).transactions[0].refNum).toBe('700000001');

      const result = await ofxImportService.importTransactions(withRefs, mockAccounts, []);

      expect(result.transactions).toHaveLength(3);
      for (const transaction of result.transactions) {
        expect(transaction.notes ?? '').not.toMatch(/Ref|700000001/);
      }
      // What a person wrote or can find the row by is still there.
      expect(result.transactions[0].notes).toBe('Grocery shopping');
      expect(result.transactions[2].notes).toBe('Check #: 1234');
    });

    it('correctly determines transaction types', async () => {
      const ofxWithVariousTypes = validOFXContent + `
<STMTTRN>
<TRNTYPE>INT
<DTPOSTED>20240125100000[0:GMT]
<TRNAMT>5.00
<FITID>2024012501
<NAME>Interest payment
</STMTTRN>
<STMTTRN>
<TRNTYPE>FEE
<DTPOSTED>20240126100000[0:GMT]
<TRNAMT>-2.50
<FITID>2024012601
<NAME>Monthly fee
</STMTTRN>`;

      const modifiedOFX = ofxWithVariousTypes.replace('</BANKTRANLIST>', '</BANKTRANLIST>');
      const insertPoint = modifiedOFX.lastIndexOf('</BANKTRANLIST>');
      const finalOFX = modifiedOFX.slice(0, insertPoint) + 
        ofxWithVariousTypes.slice(ofxWithVariousTypes.lastIndexOf('<STMTTRN>')) + 
        modifiedOFX.slice(insertPoint);

      const result = await ofxImportService.importTransactions(
        finalOFX,
        mockAccounts,
        []
      );

      // Check that INT type becomes income
      const interestTrx = result.transactions.find(t => t.description === 'Interest payment');
      expect(interestTrx?.type).toBe('income');

      // Check that FEE type becomes expense
      const feeTrx = result.transactions.find(t => t.description === 'Monthly fee');
      expect(feeTrx?.type).toBe('expense');
    });

    it('treats a reversed credit (TRNTYPE CREDIT with negative TRNAMT) as an expense', async () => {
      const reversedCreditOFX = validOFXContent.replace(
        '</BANKTRANLIST>',
        `<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240122100000[0:GMT]
<TRNAMT>-45.00
<FITID>2024012201
<NAME>Salary reversal
</STMTTRN>
</BANKTRANLIST>`
      );

      const result = await ofxImportService.importTransactions(
        reversedCreditOFX,
        mockAccounts,
        []
      );

      const reversed = result.transactions.find(t => t.description === 'Salary reversal');
      // Signed TRNAMT is authoritative: a negative CREDIT is money OUT.
      expect(reversed).toMatchObject({
        amount: -45,
        type: 'expense'
      });
    });

    it('treats a reversed debit (TRNTYPE DEBIT with positive TRNAMT) as income', async () => {
      const reversedDebitOFX = validOFXContent.replace(
        '</BANKTRANLIST>',
        `<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240123100000[0:GMT]
<TRNAMT>30.00
<FITID>2024012301
<NAME>Fee refund
</STMTTRN>
</BANKTRANLIST>`
      );

      const result = await ofxImportService.importTransactions(
        reversedDebitOFX,
        mockAccounts,
        []
      );

      const reversed = result.transactions.find(t => t.description === 'Fee refund');
      // Signed TRNAMT is authoritative: a positive DEBIT is money IN.
      expect(reversed).toMatchObject({
        amount: 30,
        type: 'income'
      });
    });

    it('lets TRNTYPE break the tie only for zero amounts', async () => {
      const zeroAmountOFX = validOFXContent.replace(
        '</BANKTRANLIST>',
        `<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240124100000[0:GMT]
<TRNAMT>0.00
<FITID>2024012401
<NAME>Zero credit adjustment
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240124110000[0:GMT]
<TRNAMT>0.00
<FITID>2024012402
<NAME>Zero debit adjustment
</STMTTRN>
</BANKTRANLIST>`
      );

      const result = await ofxImportService.importTransactions(
        zeroAmountOFX,
        mockAccounts,
        []
      );

      const zeroCredit = result.transactions.find(t => t.description === 'Zero credit adjustment');
      const zeroDebit = result.transactions.find(t => t.description === 'Zero debit adjustment');
      expect(zeroCredit?.type).toBe('income');
      expect(zeroDebit?.type).toBe('expense');
    });
  });

  describe('edge cases', () => {
    it('handles empty transaction list', () => {
      const ofxWithNoTransactions = validOFXContent.replace(
        /<BANKTRANLIST>[\s\S]*?<\/BANKTRANLIST>/,
        '<BANKTRANLIST>\n</BANKTRANLIST>'
      );

      const result = ofxImportService.parseOFX(ofxWithNoTransactions);
      expect(result.transactions).toHaveLength(0);
    });

    it('handles malformed dates', () => {
      const ofxWithBadDate = validOFXContent.replace(
        '20240115120000[0:GMT]',
        '20240115'
      );

      const result = ofxImportService.parseOFX(ofxWithBadDate);
      expect(result.transactions[0].datePosted).toEqual('2024-01-15');
    });

    it('handles missing transaction fields', () => {
      const ofxWithIncompleteTransaction = validOFXContent.replace(
        /<STMTTRN>[\s\S]*?<\/STMTTRN>/,
        `<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240115120000
<TRNAMT>-50.00
</STMTTRN>`
      );

      const result = ofxImportService.parseOFX(ofxWithIncompleteTransaction);
      // Should skip transaction without FITID
      expect(result.transactions).toHaveLength(2); // Only the other 2 valid transactions
    });

    it('handles special characters in transaction names', () => {
      const ofxWithSpecialChars = validOFXContent.replace(
        'TESCO STORES',
        'MARKS &amp; SPENCER &lt;UK&gt;'
      );

      const result = ofxImportService.parseOFX(ofxWithSpecialChars);
      expect(result.transactions[0].name).toBe('MARKS & SPENCER <UK>');
    });

    it('handles very large amounts', () => {
      const ofxWithLargeAmount = validOFXContent.replace(
        '<TRNAMT>2500.00',
        '<TRNAMT>999999.99'
      );

      const result = ofxImportService.parseOFX(ofxWithLargeAmount);
      expect(result.transactions[1].amount).toBe(999999.99);
    });

    it('handles multiple accounts in same file', async () => {
      // OFX standard typically has one account per file, but test robustness
      const result = await ofxImportService.importTransactions(
        validOFXContent,
        mockAccounts,
        []
      );

      // Should still process normally
      expect(result.newTransactions).toBe(3);
      expect(result.matchedAccount).toBe(mockAccounts[0]);
    });
  });
});

describe('a tag that is present but empty', () => {
  // Regression: a private-bank Sage-format export writes <MEMO></MEMO> for a
  // transaction with no memo. The old reader was `closed || unclosed`, and ''
  // is falsy, so it fell through to the line-terminated read and captured the
  // literal "</MEMO>". 17 of the 19 transactions in the reported file were
  // described that way.
  const emptyMemoOFX = `<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>GBP</CURDEF>
<BANKACCTFROM><BANKID>123456</BANKID><ACCTID>12345678</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>CREDIT</TRNTYPE>
<DTPOSTED>20260806000000.000</DTPOSTED>
<TRNAMT>2000</TRNAMT>
<FITID>ABC123</FITID>
<NAME>Two Way Sweep from account 04357</NAME>
<MEMO></MEMO>
</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

  it('reads an empty element as empty, not as its own closing tag', () => {
    const parsed = ofxImportService.parseOFX(emptyMemoOFX);
    expect(parsed.transactions).toHaveLength(1);
    expect(parsed.transactions[0].name).toBe('Two Way Sweep from account 04357');
    expect(parsed.transactions[0].memo).toBeUndefined();
  });

  it('leaves no value shaped like a tag anywhere in the parse', () => {
    const parsed = ofxImportService.parseOFX(emptyMemoOFX);
    const values = parsed.transactions.flatMap(t => [t.name, t.memo, t.type, t.fitId, t.checkNum, t.refNum]);
    // Whole-parse assertion rather than memo-only: the same reader served
    // TRNTYPE, TRNAMT, FITID, NAME, CHECKNUM and REFNUM, so an empty
    // <TRNAMT></TRNAMT> would have become the string "</TRNAMT>".
    expect(values.filter(v => typeof v === 'string' && /^<\/?[A-Z]+>$/.test(v))).toEqual([]);
  });
});
