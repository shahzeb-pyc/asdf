import { z } from 'zod';
import { BrandSchema } from './brand';

export const RESERVED_SUBDOMAINS = [
  'admin',
  'api',
  'app',
  'auth',
  'billing',
  'dashboard',
  'internal',
  'mail',
  'status',
  'system',
  'test',
  'www',
] as const;

export type ReservedSubdomain = (typeof RESERVED_SUBDOMAINS)[number];

export const SubdomainSchema = z
  .string()
  .min(1, 'Subdomain cannot be empty')
  .max(50, 'Subdomain cannot exceed 50 characters')
  .regex(
    /^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/,
    'Subdomain must be lowercase alphanumeric and may contain internal hyphens'
  )
  .refine(
    (val) => !RESERVED_SUBDOMAINS.includes(val as ReservedSubdomain),
    { message: 'Subdomain is a reserved identifier' }
  );

export type Subdomain = z.infer<typeof SubdomainSchema>;

export const UserRoleSchema = z.enum(['user', 'seller', 'admin']);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const UserStatusSchema = z.enum(['active', 'suspended']);
export const UserStatusEnum = UserStatusSchema.enum;
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email().max(255),
  name: z.string().max(100).nullable().optional(),
  subdomain: SubdomainSchema.optional(),
  role: UserRoleSchema.default('user'),
  status: UserStatusSchema.default('active'),
  /** White-label brand the account belongs to (spec 191). Defaults to ours. */
  brand: BrandSchema.default('fbuploadpro'),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type User = z.infer<typeof UserSchema>;
