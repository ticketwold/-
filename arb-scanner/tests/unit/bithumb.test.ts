import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchBithumbUsdtKrw, getUsdtKrwRate } from '../../src/core/bithumb';

const storage: Record<string, unknown> = {};

beforeEach(() => {
  Object.keys(storage).forEach((k) => delete storage[k]);
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(storage, obj);
        }),
      },
    },
  });
  vi.stubGlobal('fetch', vi.fn());
});

describe('bithumb', () => {
  it('parses live ticker', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { closing_price: '1425.5' } }),
    } as Response);

    const rate = await fetchBithumbUsdtKrw();
    expect(rate?.krw).toBe(1425.5);
    expect(rate?.source).toBe('bithumb');
  });

  it('falls back to manual rate', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const rate = await getUsdtKrwRate(1399);
    expect(rate.krw).toBe(1399);
    expect(rate.source).toBe('manual');
  });
});
