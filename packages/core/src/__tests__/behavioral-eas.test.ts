import { describe, it, expect } from 'vitest';
import { BehavioralEASWriter } from '../attestation/behavioral-eas.js';

// The real Attested(address,address,bytes32,bytes32) topic hash
const ATTESTED_TOPIC = '0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35';
const FAKE_UID = '0x' + 'ab'.repeat(32);
const FAKE_TX_HASH = '0x' + 'ff'.repeat(32);

// Build a mock receipt with an Attested log
function mockReceipt(opts?: { includeLogs?: boolean }) {
  const logs = opts?.includeLogs !== false
    ? [{
        topics: [ATTESTED_TOPIC],
        // EAS packs the UID as the first 32 bytes of log.data
        data: FAKE_UID,
      }]
    : [];
  return { logs, hash: FAKE_TX_HASH };
}

// We need a valid private key to construct a BehavioralEASWriter (it creates a Wallet).
// This is a throwaway key — never funded.
const TEST_PK = '0x' + '01'.repeat(32);
const TEST_SCHEMA = '0x' + 'cc'.repeat(32);

function makeWriter() {
  return new BehavioralEASWriter({ privateKey: TEST_PK, schemaUid: TEST_SCHEMA });
}

describe('BehavioralEASWriter.extractUid', () => {
  it('returns correct UID from a receipt with the Attested event log', () => {
    const writer = makeWriter();
    const uid = writer.extractUid(mockReceipt());
    expect(uid).toBe(FAKE_UID);
  });

  it('returns null when Attested event is not present in logs', () => {
    const writer = makeWriter();
    const uid = writer.extractUid(mockReceipt({ includeLogs: false }));
    expect(uid).toBeNull();
  });

  it('returns null (not tx hash) when logs contain unrelated events', () => {
    const writer = makeWriter();
    const receipt = {
      logs: [{ topics: ['0x0000000000000000000000000000000000000000000000000000000000000001'], data: '0x' + 'aa'.repeat(32) }],
      hash: FAKE_TX_HASH,
    };
    const uid = writer.extractUid(receipt);
    expect(uid).toBeNull();
    expect(uid).not.toBe(FAKE_TX_HASH);
  });
});

describe('BehavioralEASWriter constructor', () => {
  it('throws if privateKey is empty string', () => {
    expect(() => new BehavioralEASWriter({ privateKey: '', schemaUid: TEST_SCHEMA }))
      .toThrow('BehavioralEASWriter requires a non-empty privateKey');
  });
});
