import { z } from 'zod';
import {
  CommissionStatusSchema,
  PayoutRequestStatusSchema,
  SellerPayoutMethodSchema,
  SellerScopeSchema,
  SellerStatusSchema,
} from '@fbuploadpro/contracts';

/** Response schemas for the sellers API surface (typed client only). */

export const ReferralValidateResponseSchema = z.object({
  valid: z.boolean(),
  sellerName: z.string().nullable(),
});
export type ReferralValidateResponse = z.infer<typeof ReferralValidateResponseSchema>;

export const SellerBalanceSchema = z.object({
  pending: z.number().int().min(0),
  payable: z.number().int().min(0),
  requested: z.number().int().min(0),
  paid: z.number().int().min(0),
});
export type SellerBalance = z.infer<typeof SellerBalanceSchema>;

export const SellerCodeItemSchema = z.object({
  code: z.string(),
  current: z.boolean(),
  createdAt: z.string(),
});
export type SellerCodeItem = z.infer<typeof SellerCodeItemSchema>;

export const SellerDashboardResponseSchema = z.object({
  sellerId: z.string().uuid(),
  name: z.string().nullable(),
  email: z.string(),
  rate: z.number().int(),
  scope: SellerScopeSchema,
  status: SellerStatusSchema,
  currentCode: z.string().nullable(),
  codes: z.array(SellerCodeItemSchema),
  referralLink: z.string().nullable(),
  signups: z.number().int().min(0),
  purchasers: z.number().int().min(0),
  balances: SellerBalanceSchema,
  payoutDetails: z
    .object({
      method: SellerPayoutMethodSchema,
      accountLabel: z.string(),
    })
    .nullable(),
});
export type SellerDashboardResponse = z.infer<typeof SellerDashboardResponseSchema>;

export const SellerReferredUserSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  email: z.string(),
  referralCode: z.string().nullable(),
  purchased: z.boolean(),
  signedUpAt: z.string(),
});
export type SellerReferredUser = z.infer<typeof SellerReferredUserSchema>;

export const SellerReferredUsersResponseSchema = z.object({
  users: z.array(SellerReferredUserSchema),
  total: z.number().int().min(0),
});
export type SellerReferredUsersResponse = z.infer<typeof SellerReferredUsersResponseSchema>;

export const SellerCommissionItemSchema = z.object({
  id: z.string().uuid(),
  buyerName: z.string().nullable(),
  buyerEmail: z.string(),
  paymentId: z.string().uuid(),
  periodStartsAt: z.string(),
  rate: z.number().int(),
  scope: SellerScopeSchema,
  amountPkr: z.number().int().min(0),
  status: CommissionStatusSchema,
  createdAt: z.string(),
});
export type SellerCommissionItem = z.infer<typeof SellerCommissionItemSchema>;

export const SellerPayoutRequestItemSchema = z.object({
  id: z.string().uuid(),
  sellerId: z.string().uuid(),
  sellerName: z.string().nullable(),
  sellerEmail: z.string(),
  totalPkr: z.number().int().min(0),
  commissionCount: z.number().int().min(0),
  status: PayoutRequestStatusSchema,
  payoutMethod: SellerPayoutMethodSchema.nullable(),
  payoutAccount: z.string().nullable(),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type SellerPayoutRequestItem = z.infer<typeof SellerPayoutRequestItemSchema>;

export const SellerPayoutRequestsResponseSchema = z.object({
  requests: z.array(SellerPayoutRequestItemSchema),
  total: z.number().int().min(0),
});
export type SellerPayoutRequestsResponse = z.infer<typeof SellerPayoutRequestsResponseSchema>;

export const AdminSellerItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  email: z.string(),
  currentCode: z.string().nullable(),
  rate: z.number().int(),
  scope: SellerScopeSchema,
  status: SellerStatusSchema,
  signups: z.number().int().min(0),
  purchasers: z.number().int().min(0),
  payablePkr: z.number().int().min(0),
  paidPkr: z.number().int().min(0),
  createdAt: z.string(),
});
export type AdminSellerItem = z.infer<typeof AdminSellerItemSchema>;

export const AdminSellersResponseSchema = z.object({
  sellers: z.array(AdminSellerItemSchema),
  total: z.number().int().min(0),
});
export type AdminSellersResponse = z.infer<typeof AdminSellersResponseSchema>;

export const AdminSellerDetailResponseSchema = z.object({
  seller: AdminSellerItemSchema,
  codes: z.array(SellerCodeItemSchema),
  balances: SellerBalanceSchema,
  commissions: z.array(SellerCommissionItemSchema),
  payoutRequests: z.array(SellerPayoutRequestItemSchema),
  referredUsers: z.array(SellerReferredUserSchema),
  referredTotal: z.number().int().min(0),
});
export type AdminSellerDetailResponse = z.infer<typeof AdminSellerDetailResponseSchema>;

export const SellerCreateResponseSchema = z.object({
  sellerId: z.string().uuid(),
});
export type SellerCreateResponse = z.infer<typeof SellerCreateResponseSchema>;

export const SellerOkResponseSchema = z.object({
  ok: z.literal(true),
});
export type SellerOkResponse = z.infer<typeof SellerOkResponseSchema>;

export const SellerCodeResponseSchema = z.object({
  code: z.string(),
});
export type SellerCodeResponse = z.infer<typeof SellerCodeResponseSchema>;

export const SellerPayoutRequestCreatedSchema = z.object({
  request: SellerPayoutRequestItemSchema,
  count: z.number().int().min(0),
});
export type SellerPayoutRequestCreated = z.infer<typeof SellerPayoutRequestCreatedSchema>;
