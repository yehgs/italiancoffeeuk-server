import crypto from 'node:crypto';
import { prisma } from '../config/prisma.js';
import { casUpdate } from '../utils/cas.js';
import { HttpError, notFound } from '../utils/httpError.js';
import { resolveSellableProduct } from './manufacturerService.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function itemOut(i) {
  return {
    id: i.itemId,
    manufacturerId: i.manufacturerId,
    section: i.section,
    productId: i.productId,
    product: i.product,
    quantity: i.quantity,
    currency: i.currency,
    sum: i.sum.toFixed(2), // legacy UI parseFloat()s a string
    addedAt: i.addedAt instanceof Date ? i.addedAt.toISOString() : i.addedAt,
  };
}

export async function getCart(userId) {
  const cart = await prisma.cart.findUnique({ where: { userId } });
  return { items: (cart?.items ?? []).map(itemOut) };
}

/** Price, currency and availability always come from the catalogue, never from the browser. */
export async function addToCart(userId, { manufacturerId, section, productId, quantity }) {
  const { manufacturer, product, sellable } = await resolveSellableProduct(manufacturerId, section, productId);
  if (!sellable) throw new HttpError(409, 'PRODUCT_UNAVAILABLE', 'This product is not available for purchase');

  const snapshot = {
    ...product,
    manufacturerId,
    company: manufacturer.company,
  };
  const entry = (qty) => ({
    manufacturerId,
    section,
    productId,
    product: snapshot,
    quantity: qty,
    currency: product.currency,
    sum: round2(product.price * qty),
  });

  const existing = await prisma.cart.findUnique({ where: { userId } });
  if (!existing) {
    try {
      const created = await prisma.cart.create({
        data: { userId, items: [{ itemId: crypto.randomUUID(), addedAt: new Date(), ...entry(quantity) }] },
      });
      return { items: created.items.map(itemOut) };
    } catch (e) {
      if (e?.code !== 'P2002') throw e; // lost a create race; fall through to the update path
    }
  }

  const cart = await casUpdate(prisma.cart, { userId }, (cur) => {
    const items = cur.items ?? [];
    // A cart is single-currency (the old check was inverted and blocked every second item).
    if (items.length > 0 && items.some((i) => i.currency !== product.currency)) {
      throw new HttpError(
        409,
        'CART_CURRENCY_MISMATCH',
        `Please clear your cart first to work with ${product.currency} currency!`,
      );
    }
    const same = items.find((i) => i.manufacturerId === manufacturerId && i.section === section && i.productId === productId);
    if (same) {
      const qty = Math.min(99, same.quantity + quantity);
      return {
        items: {
          set: items.map((i) => (i.itemId === same.itemId ? { ...i, ...entry(qty), itemId: i.itemId, addedAt: i.addedAt } : i)),
        },
      };
    }
    return { items: { set: [...items, { itemId: crypto.randomUUID(), addedAt: new Date(), ...entry(quantity) }] } };
  });
  return { items: cart.items.map(itemOut) };
}

export async function updateQuantity(userId, itemId, quantity) {
  const cart = await casUpdate(prisma.cart, { userId }, (cur) => {
    const items = cur.items ?? [];
    if (!items.some((i) => i.itemId === itemId)) throw notFound('Cart item not found');
    return {
      items: {
        set: items.map((i) => (i.itemId === itemId ? { ...i, quantity, sum: round2(i.product.price * quantity) } : i)),
      },
    };
  });
  return { items: cart.items.map(itemOut) };
}

export async function removeItem(userId, itemId) {
  const cart = await casUpdate(prisma.cart, { userId }, (cur) => {
    const items = cur.items ?? [];
    if (!items.some((i) => i.itemId === itemId)) throw notFound('Cart item not found');
    return { items: { set: items.filter((i) => i.itemId !== itemId) } };
  });
  return { items: cart.items.map(itemOut) };
}

export async function clearCart(userId) {
  await prisma.cart.deleteMany({ where: { userId } });
  return { items: [] };
}
