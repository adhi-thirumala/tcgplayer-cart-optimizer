import type { ProductId, SellerKey, ShippingRule } from '@/core/domain';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function money(amount: number): string {
  return usd.format(amount);
}

export function shippingRule(rule: ShippingRule): string {
  switch (rule._tag) {
    case 'Flat':
      return `flat ${money(rule.price)}`;
    case 'Threshold':
      return `${money(rule.under)}, ${rule.over === 0 ? 'free' : money(rule.over)} from ${money(rule.threshold)}`;
  }
}

export function sellerUrl(sellerKey: SellerKey): string {
  return `https://www.tcgplayer.com/search/all/product?seller=${encodeURIComponent(sellerKey)}`;
}

export function productUrl(productId: ProductId): string {
  return `https://www.tcgplayer.com/product/${productId}`;
}
