import type { SellerShipping } from '@/core/types';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function money(amount: number): string {
  return usd.format(amount);
}

export function shippingRule(rule: SellerShipping): string {
  if (rule.thresholdPrice === null || rule.priceOver >= rule.priceUnder) return `flat ${money(rule.priceUnder)}`;
  const over = rule.priceOver === 0 ? 'free' : money(rule.priceOver);
  return `${money(rule.priceUnder)}, ${over} from ${money(rule.thresholdPrice)}`;
}

export function sellerUrl(sellerKey: string): string {
  return `https://www.tcgplayer.com/search/all/product?seller=${encodeURIComponent(sellerKey)}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
