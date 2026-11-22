import { defineConfig } from 'wxt';

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: ({ browser }) => ({
    name: 'TCGplayer Cart Optimizer',
    description:
      'Rebuild your TCGplayer cart for the lowest total price, including each seller’s free-shipping threshold.',
    permissions: ['storage'],
    host_permissions: ['*://*.tcgplayer.com/*'],
    action: { default_title: 'Optimize TCGplayer cart' },
    // The MILP solver (HiGHS) is WebAssembly bundled with the extension.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'tcgplayer-cart-optimizer@adhithirumala.com',
              // First version (desktop 140, Android 142) that understands data_collection_permissions.
              strict_min_version: '142.0',
              data_collection_permissions: { required: ['none'] },
            },
          },
        }
      : {}),
  }),
});
