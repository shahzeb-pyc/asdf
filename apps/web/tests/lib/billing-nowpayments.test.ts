import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createNowPaymentsPayment,
  estimateUsdt,
  getNowPaymentsConfig,
  minimumUsdt,
  NOWPAYMENTS_API_BASE,
  NowPaymentsError,
} from '@/lib/billing/nowpayments';
import { logServerError } from '@/lib/server-analytics';

/**
 * NOWPayments client (subscription crypto checkout), tested with a
 * mocked fetch — no real provider call. Covers: the USDT estimate,
 * the best-effort minimum (null, never invented), payment creation
 * mapping, and every fail-loud branch (refusal with the provider's
 * message, unusable body, unreachable provider).
 */

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

const mockedLogServerError = vi.mocked(logServerError);

function jsonResponse(ok: boolean, status: number, body: unknown): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  delete process.env.NOWPAYMENTS_API_KEY;
  delete process.env.NOWPAYMENTS_IPN_SECRET;
});

describe('getNowPaymentsConfig', () => {
  it('returns the keys when set', () => {
    process.env.NOWPAYMENTS_API_KEY = 'key-1';
    process.env.NOWPAYMENTS_IPN_SECRET = 'secret-1';
    expect(getNowPaymentsConfig()).toEqual({ apiKey: 'key-1', ipnSecret: 'secret-1' });
  });

  it('treats empty strings as missing', () => {
    process.env.NOWPAYMENTS_API_KEY = '';
    process.env.NOWPAYMENTS_IPN_SECRET = '';
    expect(getNowPaymentsConfig()).toEqual({ apiKey: null, ipnSecret: null });
  });

  it('returns nulls when unset', () => {
    expect(getNowPaymentsConfig()).toEqual({ apiKey: null, ipnSecret: null });
  });
});

describe('estimateUsdt', () => {
  it('converts a PKR total to USDT on TRC20', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(true, 200, { estimated_amount: 2.5 }));
    await expect(estimateUsdt(700, 'trc20', 'key-1')).resolves.toBe(2.5);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url.startsWith(`${NOWPAYMENTS_API_BASE}/estimate?`)).toBe(true);
    expect(url).toContain('currency_from=pkr');
    expect(url).toContain('currency_to=usdttrc20');
    expect(url).toContain('amount=700');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ 'x-api-key': 'key-1' }),
    });
  });

  it('uses the BEP20 ticker for bep20', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(true, 200, { estimated_amount: 2.5 }));
    await estimateUsdt(700, 'bep20', 'key-1');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('currency_to=usdtbsc');
  });

  it('fails loud on a provider refusal, carrying the provider message', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(false, 422, { message: 'Amount too small' })
    );
    await expect(estimateUsdt(70, 'trc20', 'key-1')).rejects.toThrow(
      'Crypto checkout was refused: Amount too small'
    );
    await expect(estimateUsdt(70, 'trc20', 'key-1')).rejects.toBeInstanceOf(
      NowPaymentsError
    );
  });

  it('falls back to the status when the refusal carries no message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(false, 500, {}));
    await expect(estimateUsdt(70, 'trc20', 'key-1')).rejects.toThrow('status 500');
  });

  it('fails loud on an unusable estimate body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(true, 200, { estimated_amount: 0 }));
    await expect(estimateUsdt(700, 'trc20', 'key-1')).rejects.toThrow(
      'could not price your total in USDT'
    );
  });

  it('fails loud when the provider cannot be reached', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(estimateUsdt(700, 'trc20', 'key-1')).rejects.toThrow(
      'could not be reached right now'
    );
  });
});

describe('minimumUsdt', () => {
  it('returns the minimum when the provider answers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(true, 200, { min_amount: 1.2 }));
    await expect(minimumUsdt('trc20', 'key-1')).resolves.toBe(1.2);
  });

  it('returns null on an unusable body instead of inventing a minimum', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(true, 200, { min_amount: 0 }));
    await expect(minimumUsdt('trc20', 'key-1')).resolves.toBeNull();
  });

  it('returns null — and logs — when the provider cannot answer', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(minimumUsdt('trc20', 'key-1')).resolves.toBeNull();
    expect(mockedLogServerError).toHaveBeenCalledWith(
      '[billing] nowpayments minimum unavailable',
      expect.anything(),
      { source: 'billing' }
    );
  });
});

describe('createNowPaymentsPayment', () => {
  const args = {
    priceAmountPkr: 700,
    network: 'trc20' as const,
    orderId: 'order-1',
    ipnCallbackUrl: 'https://app.example.com/api/billing/nowpayments/webhook',
  };

  it('maps a successful payment, keeping a null pay amount', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(true, 201, {
        payment_id: 'np-1',
        pay_address: 'TABC123',
        pay_amount: 2.5,
      })
    );
    await expect(createNowPaymentsPayment(args, 'key-1')).resolves.toEqual({
      paymentId: 'np-1',
      payAddress: 'TABC123',
      payAmount: 2.5,
      payCurrency: 'usdttrc20',
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({
      price_amount: 700,
      price_currency: 'pkr',
      pay_currency: 'usdttrc20',
      order_id: 'order-1',
    });
  });

  it('maps a missing pay amount to null', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(true, 201, { payment_id: 'np-1', pay_address: 'TABC123' })
    );
    const created = await createNowPaymentsPayment(args, 'key-1');
    expect(created.payAmount).toBeNull();
  });

  it('fails loud on an unusable payment body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(true, 201, { payment_id: 'np-1' }));
    await expect(createNowPaymentsPayment(args, 'key-1')).rejects.toThrow(
      'did not return a usable payment'
    );
  });

  it('carries the provider error field on refusal', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(false, 400, { error: 'Invalid pay currency' })
    );
    await expect(createNowPaymentsPayment(args, 'key-1')).rejects.toThrow(
      'Crypto checkout was refused: Invalid pay currency'
    );
  });
});
