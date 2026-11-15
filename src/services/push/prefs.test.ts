import { describe, it, expect } from 'vitest';
import {
  anyPhoneNotificationOn,
  parseDeviceTimeZone,
  parsePhoneNotificationPrefs,
  DEFAULT_PHONE_NOTIFICATION_PREFS,
} from './prefs';

describe('parsePhoneNotificationPrefs', () => {
  it('reads the stored string, and only a literal true switches anything on', () => {
    expect(parsePhoneNotificationPrefs('{"feedActivity":true,"feedAttention":false,"balanceReminders":"yes"}')).toEqual({
      feedActivity: true,
      feedAttention: false,
      balanceReminders: false,
      lowBalances: false,
    });
    expect(parsePhoneNotificationPrefs('{"lowBalances":true}').lowBalances).toBe(true);
  });

  it('a phone with only "Low balances" on still counts as listening, so it registers for pushes', () => {
    expect(anyPhoneNotificationOn({ ...DEFAULT_PHONE_NOTIFICATION_PREFS, lowBalances: true })).toBe(true);
  });

  it('anything unreadable is "asked for nothing" — a garbage entry must never become a push', () => {
    expect(parsePhoneNotificationPrefs('{not json')).toEqual(DEFAULT_PHONE_NOTIFICATION_PREFS);
    expect(parsePhoneNotificationPrefs(undefined)).toEqual(DEFAULT_PHONE_NOTIFICATION_PREFS);
    expect(parsePhoneNotificationPrefs('[]')).toEqual(DEFAULT_PHONE_NOTIFICATION_PREFS);
    expect(anyPhoneNotificationOn(DEFAULT_PHONE_NOTIFICATION_PREFS)).toBe(false);
  });
});

describe('parseDeviceTimeZone', () => {
  it('accepts a zone Intl knows and refuses everything else', () => {
    expect(parseDeviceTimeZone('Europe/London')).toBe('Europe/London');
    expect(parseDeviceTimeZone('Mars/Olympus_Mons')).toBeNull();
    expect(parseDeviceTimeZone('')).toBeNull();
    expect(parseDeviceTimeZone(42)).toBeNull();
  });
});
