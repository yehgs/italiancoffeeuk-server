import { z } from 'zod';
import { isObjectId } from '../utils/ids.js';

export const objectId = z.string().refine(isObjectId, 'Invalid id');
export const idParams = z.object({ id: objectId });

const trimmed = (max = 200) => z.string().trim().max(max);
// z.string().url() accepts javascript: and data: URLs; stored URLs end up in <img src>/<a href>, so require https.
export const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    try {
      return new URL(v).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Must be an https URL');
const email = z.string().trim().toLowerCase().email().max(254);

// Customers: matches the previous UI rule (letter + number) but 8+ chars.
export const customerPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters long')
  .max(128)
  .regex(/\d/, 'Password must contain at least one number')
  .regex(/[A-Za-z]/, 'Password must contain at least one letter');

export const adminPassword = z
  .string()
  .min(10, 'Admin password must be at least 10 characters long')
  .max(128)
  .regex(/\d/, 'Password must contain at least one number')
  .regex(/[A-Za-z]/, 'Password must contain at least one letter');

// ── auth ──
export const registerBody = z.object({
  email,
  password: customerPassword,
  firstName: trimmed(80).min(1),
  lastName: trimmed(80).min(1),
  phone: trimmed(40).min(3),
  address: trimmed(300).min(1),
  zipCode: trimmed(20).min(1),
  deliveryAddress: z.boolean().optional().default(false),
});
export const loginBody = z.object({ email, password: z.string().min(1).max(128) });
export const forgotBody = z.object({ email });
export const resetBody = z.object({ token: z.string().min(20).max(200), newPassword: customerPassword });
export const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

// ── admins ──
export const adminRole = z.enum(['admin', 'superadmin']);
export const adminCreateBody = z.object({
  firstName: trimmed(80).min(1),
  lastName: trimmed(80).min(1),
  email,
  password: adminPassword,
  role: adminRole.default('admin'),
});
export const adminUpdateBody = z
  .object({
    firstName: trimmed(80).min(1),
    lastName: trimmed(80).min(1),
    email,
    password: adminPassword,
    role: adminRole,
    disabled: z.boolean(),
  })
  .partial();

// ── filter lists ──
export const filterBodies = {
  tags: z.object({ tag: trimmed(80).min(1) }),
  categories: z.object({ category: trimmed(80).min(1) }),
  regions: z.object({ region: trimmed(80).min(1) }),
  'manufacturer-types': z.object({
    typeName: trimmed(80).min(1),
    typeImage: httpsUrl.optional(),
  }),
};

// ── settings ──
export const settingsTarget = z
  .object({ manufacturerId: objectId.optional(), company: trimmed(200).optional() })
  .refine((v) => v.manufacturerId || v.company, 'manufacturerId or company is required');

export const settingsItemSchemas = {
  countries: z.string().trim().min(1).max(80),
  payments: z.string().trim().min(1).max(80),
  currencies: z.object({
    name: z.string().trim().min(1).max(40).transform((s) => s.toUpperCase()),
    symbol: z.string().trim().min(1).max(8),
    rate: z.coerce.number().positive().max(1e9),
  }),
  deliveries: z.object({
    name: z.string().trim().min(1).max(80),
    timeFrame: z.string().trim().min(1).max(80),
    price: z.coerce.number().min(0).max(1e9),
    serviceType: z.string().trim().max(80).optional(),
  }),
};

// ── reviews / subscribers / cart ──
export const reviewBody = z.object({
  comment: trimmed(2000).min(1, 'Please put in a review!'),
  rate: z.coerce.number().int().min(0).max(5),
});
export const subscriberBody = z.object({ email });
export const cartAddBody = z.object({
  manufacturerId: objectId,
  section: z.enum(['products', 'COFFEE BEANS', 'COMPATIBLE CAPSULES', 'ESE PODS', 'GRINDED COFFEE']),
  productId: z.string().min(1).max(100),
  quantity: z.coerce.number().int().min(1).max(99).default(1),
});
export const cartUpdateBody = z.object({ quantity: z.coerce.number().int().min(1).max(99) });

// ── uploads ──
export const uploadSignBody = z.object({
  purpose: z.enum(['logo', 'gallery', 'product', 'manufacturer-type', 'misc']),
  resourceType: z.enum(['image', 'video']).default('image'),
  mime: z.string().max(100).optional(),
  size: z.number().int().positive().optional(),
});

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
