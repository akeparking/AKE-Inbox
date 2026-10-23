import { describe, expect, it } from 'vitest';
import { redactPayload } from './http';

describe('conversion payload previews', () => {
  it('redacts click and user identifiers recursively while retaining receipt correlation fields', () => {
    const payload = {
      events: [{
        transactionId: 'stable-fictional-event',
        adIdentifiers: { gclid: 'fictional-click', gbraid: 'fictional-braid', wbraid: 'fictional-web-braid', sessionAttributes: 'fictional-session' },
        userData: { userIdentifiers: [{ emailAddress: 'fictional-hash', phoneNumber: 'fictional-phone-hash' }] },
        consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_DENIED' },
      }],
    };
    expect(redactPayload(payload)).toEqual({ events: [{
      transactionId: 'stable-fictional-event',
      adIdentifiers: { gclid: '[redacted]', gbraid: '[redacted]', wbraid: '[redacted]', sessionAttributes: '[redacted]' },
      userData: { userIdentifiers: [{ emailAddress: '[redacted]', phoneNumber: '[redacted]' }] },
      consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_DENIED' },
    }] });
    expect(payload.events[0].adIdentifiers.gclid).toBe('fictional-click');
  });
});
