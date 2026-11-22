import { serveTcgApi } from '@/core/rpc';
import { createTcgApi } from '@/tcgplayer/api';

export default defineContentScript({
  matches: ['*://*.tcgplayer.com/*'],
  main() {
    serveTcgApi(createTcgApi());
  },
});
