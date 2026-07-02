import {
  describe, it, expect, beforeEach, vi,
} from 'vitest';
import { getGoogleMerchantFeedItems, formatGoogleMerchantFeedXML } from '../../src/util/api/likernft/book/googleMerchantCatalog';
import type { GoogleMerchantItem } from '../../src/util/api/likernft/book/googleMerchantCatalog';
import { listLatestNFTBookInfo } from '../../src/util/api/likernft/book/index';
import type { NFTBookListingInfo } from '../../src/types/book';

// Mock only the data fetch; keep the real pure helpers so the mapping logic is
// exercised end-to-end.
vi.mock('../../src/util/api/likernft/book/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/util/api/likernft/book/index')>();
  return {
    ...actual,
    listLatestNFTBookInfo: vi.fn(),
  };
});

const mockedList = vi.mocked(listLatestNFTBookInfo);

function setBooks(books: Array<Partial<NFTBookListingInfo>>) {
  mockedList.mockResolvedValue(books as any);
}

describe('getGoogleMerchantFeedItems', () => {
  beforeEach(() => {
    mockedList.mockReset();
  });

  it('maps each price into a Google Merchant item', async () => {
    setBooks([{
      id: 'class-a',
      classId: 'class-a',
      name: 'The Great Book',
      image: 'https://img.example/a.jpg',
      author: 'Jane Doe',
      publisher: 'Penguin',
      isbn: '978-3-16-148410-0',
      descriptionFull: 'Full description',
      prices: [
        { priceInDecimal: 1500, name: 'Hardcover', stock: 5 },
        { priceInDecimal: 999, stock: 0, isAutoDeliver: false },
      ],
    }]);

    const items = await getGoogleMerchantFeedItems();
    expect(items).toHaveLength(2);
    const [first] = items;
    expect(first.id).toBe('class-a-0');
    expect(first.title).toBe('The Great Book - Hardcover');
    expect(first.link).toContain('/store/class-a');
    expect(first.image_link).toBe('https://img.example/a.jpg');
    expect(first.price).toBe('15.00 USD');
    // Google requires the underscore enum (NOT the legacy "in stock" form)
    expect(first.availability).toBe('in_stock');
    expect(first.condition).toBe('new');
    // author wins over publisher for brand (shared resolveCatalogBrand)
    expect(first.brand).toBe('Jane Doe');
    expect(first.gtin).toBe('9783161484100');
    // valid GTIN present → identifier_exists omitted
    expect(first.identifier_exists).toBeUndefined();
    // multi-edition book → grouped
    expect(first.item_group_id).toBe('class-a');
    expect(first.item_group_title).toBe('The Great Book');
    // exact Google taxonomy value (lowercase "b")
    expect(first.google_product_category).toBe('Media > Books > E-books');

    expect(items[1].availability).toBe('out_of_stock');
  });

  it('emits identifier_exists=no when there is no valid GTIN (ISBN-10)', async () => {
    setBooks([{
      id: 'class-f',
      classId: 'class-f',
      name: 'Solo Work',
      image: 'https://img.example/f.jpg',
      isbn: '0-306-40615-2', // ISBN-10 → not a valid GTIN length
      description: 'short',
      prices: [{ priceInDecimal: 999, stock: 3 }],
    }]);

    const [item] = await getGoogleMerchantFeedItems();
    expect(item.gtin).toBeUndefined();
    expect(item.identifier_exists).toBe('no');
    expect(item.brand).toBe('3ook.com'); // no author/publisher → fallback
    // single edition → no group
    expect(item.item_group_id).toBeUndefined();
  });

  it('truncates title and description to Google limits', async () => {
    setBooks([{
      id: 'long',
      classId: 'long',
      name: 'T'.repeat(200),
      image: 'https://img/o.jpg',
      descriptionFull: 'D'.repeat(6000),
      prices: [{ priceInDecimal: 100, stock: 1 }],
    }]);
    const [item] = await getGoogleMerchantFeedItems();
    expect(item.title).toHaveLength(150);
    expect(item.description).toHaveLength(5000);
  });

  it('applies the same eligibility and variant drop rules as the other feeds', async () => {
    setBooks([
      {
        id: 'hidden', classId: 'hidden', name: 'Hidden', image: 'https://img/x.jpg', isHidden: true, prices: [{ priceInDecimal: 100 }],
      },
      {
        id: 'noimage', classId: 'noimage', name: 'No Image', prices: [{ priceInDecimal: 100 }],
      },
      {
        id: 'ok', classId: 'ok', name: 'OK', image: 'https://img/o.jpg', prices: [{ priceInDecimal: 100, isUnlisted: true }, { priceInDecimal: 200 }],
      },
    ]);
    const items = await getGoogleMerchantFeedItems();
    expect(items.map((i) => i.id)).toEqual(['ok-1']);
  });
});

describe('formatGoogleMerchantFeedXML', () => {
  const baseItem: GoogleMerchantItem = {
    id: 'class-a-0',
    title: 'The Great Book',
    description: 'Full description',
    link: 'https://3ook.com/en/store/class-a?price_index=0',
    image_link: 'https://img.example/a.jpg',
    price: '15.00 USD',
    availability: 'in_stock',
    condition: 'new',
    brand: 'Jane Doe',
    google_product_category: 'Media > Books > E-books',
    gtin: '9783161484100',
    item_group_id: 'class-a',
    item_group_title: 'The Great Book',
  };

  it('produces an RSS 2.0 document with the g: namespace', () => {
    const feed = formatGoogleMerchantFeedXML([baseItem]);
    expect(feed).toContain('<?xml version="1.0" encoding="utf-8"?>');
    expect(feed).toContain('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">');
    expect(feed).toContain('<channel>');
    expect(feed).toContain('<g:id>class-a-0</g:id>');
    // core RSS elements have no g: prefix
    expect(feed).toContain('<title>The Great Book</title>');
    expect(feed).toContain('<link>https://3ook.com/en/store/class-a?price_index=0</link>');
    expect(feed).toContain('<g:availability>in_stock</g:availability>');
    expect(feed).toContain('<g:gtin>9783161484100</g:gtin>');
    expect(feed).toContain('<g:item_group_id>class-a</g:item_group_id>');
  });

  it('emits g:identifier_exists=no instead of g:gtin when GTIN is absent', () => {
    const feed = formatGoogleMerchantFeedXML([{
      ...baseItem,
      gtin: undefined,
      identifier_exists: 'no',
      item_group_id: undefined,
      item_group_title: undefined,
    }]);
    expect(feed).toContain('<g:identifier_exists>no</g:identifier_exists>');
    expect(feed).not.toContain('<g:gtin>');
    expect(feed).not.toContain('<g:item_group_id>');
  });

  it('escapes XML special characters in field values', () => {
    const feed = formatGoogleMerchantFeedXML([{
      ...baseItem,
      title: 'Cats & Dogs <vol 1>',
    }]);
    expect(feed).toContain('<title>Cats &amp; Dogs &lt;vol 1&gt;</title>');
  });
});
