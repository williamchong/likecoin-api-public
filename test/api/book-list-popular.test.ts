import { describe, it, expect } from 'vitest';
import axiosist from './axiosist';
import mockEVMAddress from './address';
import { likeNFTBookCollection } from '../../src/util/firebase';

const PATH = '/api/likernft/book/store/list/popular';
const OWNER = mockEVMAddress(0x33);

// The stub firestore no-ops orderBy/limit/startAfter, so rank order and cursor paging are
// not exercised here — those depend on the composite index and need a real Firestore.
// What is exercised: the library scope flag, hidden/redirect exclusion, the null-cursor
// boundary, and cursor validation.
const seedBook = (classId: string, data: Record<string, unknown> = {}) => likeNFTBookCollection
  .doc(classId)
  .set({
    classId, ownerWallet: OWNER, isPlusReadingEnabled: true, plusReadingTotalMs: 0, ...data,
  } as any);

const get = (query = '') => axiosist
  .get(`${PATH}${query}`)
  .catch((err) => (err as any).response);

describe('GET /likernft/book/store/list/popular', () => {
  it('scopes to Plus-reading books with library=1', async () => {
    const inLibrary = mockEVMAddress(0xa1);
    const notInLibrary = mockEVMAddress(0xa2);
    await seedBook(inLibrary, { plusReadingTotalMs: 5000 });
    await seedBook(notInLibrary, { isPlusReadingEnabled: false });

    const res = await get('?library=1');
    expect(res.status).toBe(200);
    const classIds = res.data.list.map((b: any) => b.classId);
    expect(classIds).toContain(inLibrary);
    expect(classIds).not.toContain(notInLibrary);
  });

  it('lists the whole catalogue without library=1', async () => {
    const inLibrary = mockEVMAddress(0xb1);
    const notInLibrary = mockEVMAddress(0xb2);
    await seedBook(inLibrary);
    await seedBook(notInLibrary, { isPlusReadingEnabled: false });

    const res = await get();
    expect(res.status).toBe(200);
    const classIds = res.data.list.map((b: any) => b.classId);
    expect(classIds).toContain(inLibrary);
    expect(classIds).toContain(notInLibrary);
  });

  it('does not leak the popularity counter to clients', async () => {
    const classId = mockEVMAddress(0xa3);
    await seedBook(classId, { plusReadingTotalMs: 123456 });

    const res = await get();
    const book = res.data.list.find((b: any) => b.classId === classId);
    expect(book).toBeDefined();
    // Rank order is public; the minutes behind it (the payout basis) are not.
    expect(book.plusReadingTotalMs).toBeUndefined();
  });

  it('excludes hidden and redirected books from the list', async () => {
    const visible = mockEVMAddress(0xa4);
    const hidden = mockEVMAddress(0xa5);
    const redirected = mockEVMAddress(0xa6);
    await seedBook(visible);
    await seedBook(hidden, { isHidden: true });
    await seedBook(redirected, { redirectClassId: visible });

    const res = await get();
    const classIds = res.data.list.map((b: any) => b.classId);
    expect(classIds).toContain(visible);
    expect(classIds).not.toContain(hidden);
    expect(classIds).not.toContain(redirected);
  });

  it('returns a null cursor when the page is not full', async () => {
    await seedBook(mockEVMAddress(0xa7));

    const res = await get('?limit=100');
    expect(res.status).toBe(200);
    expect(res.data.nextKey).toBeNull();
  });

  it('rejects a cursor that names no book', async () => {
    const res = await get(`?key=${mockEVMAddress(0xbb)}`);
    expect(res.status).toBe(400);
  });

  it('accepts a mixed-case class id as the cursor', async () => {
    // Books are keyed by lowercase class id; an EIP-55 checksummed cursor must still resolve.
    const mixedCaseClassId = '0xAbCdEf8888888888888888888888888888888888';
    await seedBook(mixedCaseClassId.toLowerCase());

    const res = await get(`?key=${mixedCaseClassId}`);
    expect(res.status).toBe(200);
  });
});
