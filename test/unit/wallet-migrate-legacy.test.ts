import {
  describe, it, expect, afterEach,
} from 'vitest';
import { checksumAddress } from 'viem';
import { isLegacyV1User, migrateLegacyUserToEVMWallet } from '../../src/util/api/wallet';
import { FieldValue, userCollection } from '../../src/util/firebase';

// A v1 Liker ID (testv1legacy) predates the chain: it holds only the legacy
// ERC-20 `wallet` field, with no likeWallet, cosmosWallet or evmWallet.
// See test/data/user.json.
const V1_LIKER_ID = 'testv1legacy';
const V1_LEGACY_WALLET = '0x8dF1F7A5B0d9dA4CF3F5B3f3Cc31A5B6e0dE79F2';
// Mixed-case on purpose: the link must persist the EIP-55 checksummed form.
const NEW_EVM_WALLET = '0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
const NEW_EVM_WALLET_CHECKSUM = checksumAddress(NEW_EVM_WALLET);
// Held by the `testing` fixture.
const TAKEN_EVM_WALLET = '0x4b25758E41f9240C8EB8831cEc7F1a02686387fa';

describe('isLegacyV1User', () => {
  it('accepts an account with neither chain wallet', () => {
    expect(isLegacyV1User({})).toBe(true);
  });

  // cosmosWallet is written independently of likeWallet, so a doc can hold one
  // without the other; both must veto or the account takes the wrong path.
  it('rejects an account holding either likeWallet or cosmosWallet', () => {
    expect(isLegacyV1User({ likeWallet: 'like1abc' })).toBe(false);
    expect(isLegacyV1User({ cosmosWallet: 'cosmos1abc' })).toBe(false);
  });
});

describe('migrateLegacyUserToEVMWallet', () => {
  // resetTestData() re-requires the cached fixture JSON, so a write to a fixture
  // doc otherwise outlives its test and leaks into later files. Clear it here so
  // every case starts from a pristine v1 doc.
  afterEach(async () => {
    await userCollection.doc(V1_LIKER_ID).update({
      evmWallet: FieldValue.delete(),
      migrateMethod: FieldValue.delete(),
      migrateTimestamp: FieldValue.delete(),
    });
  });

  it('links the EVM wallet onto a v1 Liker ID, checksum-normalized', async () => {
    const res = await migrateLegacyUserToEVMWallet(V1_LIKER_ID, NEW_EVM_WALLET, 'auto');
    expect(res.isMigratedLikerId).toBe(true);
    expect(res.migratedLikerId).toBe(V1_LIKER_ID);
    expect(res.migrateLikerIdError).toBeNull();

    const doc = await userCollection.doc(V1_LIKER_ID).get();
    const data = doc.data();
    // Persisted in EIP-55 form regardless of the input casing, so login (which
    // queries the checksummed address) can resolve it.
    expect(data?.evmWallet).toBe(NEW_EVM_WALLET_CHECKSUM);
    expect(data?.migrateMethod).toBe('auto');
    // The legacy ERC-20 address is a different keypair and must survive untouched.
    expect(data?.wallet).toBe(V1_LEGACY_WALLET);
  });

  it('reports the likeWallet-keyed steps as skipped, not migrated', async () => {
    const res = await migrateLegacyUserToEVMWallet(V1_LIKER_ID, NEW_EVM_WALLET, 'auto');
    expect(res.isMigratedBookUser).toBe(false);
    expect(res.isMigratedBookOwner).toBe(false);
    expect(res.isMigratedLikerLand).toBe(false);
    expect(res.migrateBookUserError).toBeNull();
    expect(res.migrateBookOwnerError).toBeNull();
    expect(res.migrateLikerLandError).toBeNull();
    expect(res.migratedLikerLandUser).toBeNull();
  });

  it('is idempotent when the same EVM wallet is already linked', async () => {
    await migrateLegacyUserToEVMWallet(V1_LIKER_ID, NEW_EVM_WALLET, 'auto');
    const res = await migrateLegacyUserToEVMWallet(V1_LIKER_ID, NEW_EVM_WALLET, 'auto');
    expect(res.isMigratedLikerId).toBe(true);
  });

  it('refuses an account that has a likeWallet, which needs the full migration', async () => {
    const res = await migrateLegacyUserToEVMWallet('testgmaillegacy', NEW_EVM_WALLET, 'auto');
    expect(res.isMigratedLikerId).toBe(false);
    expect(res.migrateLikerIdError).toBe('USER_HAS_LIKE_WALLET');

    const doc = await userCollection.doc('testgmaillegacy').get();
    expect(doc.data()?.evmWallet).toBeUndefined();
  });

  it('refuses an EVM wallet already held by another user', async () => {
    const res = await migrateLegacyUserToEVMWallet(V1_LIKER_ID, TAKEN_EVM_WALLET, 'auto');
    expect(res.isMigratedLikerId).toBe(false);
    expect(res.migrateLikerIdError).toBe('EVM_WALLET_ALREADY_EXIST');

    const doc = await userCollection.doc(V1_LIKER_ID).get();
    expect(doc.data()?.evmWallet).toBeUndefined();
  });

  it('refuses a case-variant of a taken wallet (checksum closes the bypass)', async () => {
    // The lowercase form must still collide with the checksummed record held by
    // `testing`; without normalization the raw-case query would miss it.
    const res = await migrateLegacyUserToEVMWallet(V1_LIKER_ID, TAKEN_EVM_WALLET.toLowerCase(), 'auto');
    expect(res.isMigratedLikerId).toBe(false);
    expect(res.migrateLikerIdError).toBe('EVM_WALLET_ALREADY_EXIST');
  });

  it('refuses an unknown Liker ID', async () => {
    const res = await migrateLegacyUserToEVMWallet('nosuchuser', NEW_EVM_WALLET, 'auto');
    expect(res.isMigratedLikerId).toBe(false);
    expect(res.migrateLikerIdError).toBe('LIKER_ID_NOT_FOUND');
  });
});
