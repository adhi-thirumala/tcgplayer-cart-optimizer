import { Effect, Layer } from 'effect';
import { TcgServer } from '@/tcgplayer/server';

export default defineContentScript({
  matches: ['*://*.tcgplayer.com/*'],
  main() {
    Effect.runFork(Layer.launch(TcgServer));
  },
});
