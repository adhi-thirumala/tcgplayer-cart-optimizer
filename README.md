# TCGplayer Cart Optimizer

A Chrome and Firefox extension that rebuilds your TCGplayer cart for the lowest total price,
shipping included. Most sellers charge $1.49 under a $5 subtotal and ship free above it, so buying
a whole cart from a few sellers usually costs far less than buying each card at its lowest price.

1. Put the cards you want in your TCGplayer cart (any sellers, any printings).
2. Click the toolbar button on a TCGplayer tab, then **Optimize cart** in the popup.
3. The popup shows the savings and package count; click **Replace my cart with this** to apply.
   The work runs in the background, so you can close the popup and come back for the result.
4. For more control, click **Full page ↗**: edit quantities, review the per-seller plan, exclude
   sellers, and set rating and condition filters. Printings with identical card text are merged,
   for example every *Black Belt's Training*; tick **Exact printing only** for a printing you want,
   such as an illustration rare. Options saved there apply to the popup too.

The extension needs no account, server, or API key. It calls TCGplayer's website APIs from your
TCGplayer tab, solves the purchase as a mixed-integer program with [HiGHS](https://highs.dev)
(WebAssembly) on your machine, and writes the result to your cart. It sends nothing anywhere else.

## How it works

```mermaid
flowchart LR
  U[Popup / full page] -- state + commands --> B[Background: optimizer]
  B -- port RPC --> C[Content script on tcgplayer.com]
  C -- cart, search, listings, shipping --> T[(TCGplayer APIs)]
  B --> K[Catalog: interchangeable printings]
  B --> H[Solver host page: Web Worker, HiGHS MILP]
  H --> B
  B -- clear + add --> C
```

The code uses [Effect](https://effect.website): `Schema` decodes every TCGplayer response and
stored setting, errors are tagged values, and interrupting a job (Cancel, or starting another)
stops its requests and its solver worker.

- `src/tcgplayer/` is the API client. It runs in the content script, because TCGplayer answers
  only requests from its own origin. `rpcs.ts` declares the calls the optimizer page can make.
  Endpoints are documented in [`docs/tcgplayer-api.md`](docs/tcgplayer-api.md).
- `src/core/port-rpc.ts` carries `effect/rpc` over `browser.runtime` ports.
- `src/catalog/` turns cart lines into requirements. Two products are interchangeable when the
  card name and the full gameplay text (attacks, abilities, HP, weakness and so on) match after
  normalization. Jumbo, World Championship deck and code-card printings are never substitutes.
- `src/solver/` holds the model: integer copies per listing, a binary "ships a package" and
  "reaches free shipping" per seller, an optional package cap, and a penalized shortfall so the
  solver still returns the best partial plan when stock runs out. Before solving, exact dominance
  rules drop sellers and listings that cannot be in any optimal plan (see `model.ts`). On a real
  22-card cart they cut 28k listings and 6.8k sellers to about 5k and 800.
- `src/ui/machine.ts` is the optimizer's state machine: every state it can be in, and the
  events that move it. `optimizer.ts` runs the jobs that emit those events. It lives in the
  background script, and `remote.ts` mirrors its state to the popup and the full page, which
  render it with React and send commands back. The background stays alive while a job runs and
  for 10 minutes after the last page closes, so a finished plan is still there when you reopen.
- `src/solver/host.ts` runs solves in `solver-host.html`, because the background cannot start the
  solver worker: an offscreen document in Chrome, a hidden iframe in Firefox's background page.

## Development

Requires Node 20+ and pnpm.

```sh
pnpm install
pnpm dev            # Chrome with the extension loaded and hot reload
pnpm dev:firefox    # Firefox
pnpm test           # unit tests
pnpm compile        # type-check
```

`scripts/check-fixture.ts` re-solves a captured market snapshot (kept out of git in
`.local-fixtures/`) and checks the totals against an independent PuLP/CBC model:
`bun scripts/check-fixture.ts`.

## Building and publishing

```sh
pnpm zip            # .output/tcgplayer-cart-optimizer-<version>-chrome.zip
pnpm zip:firefox    # .output/…-firefox.zip and …-sources.zip (AMO wants the sources)
```

Bump `version` in `package.json` before every store upload; both stores reject a version they have
already seen.

### Chrome Web Store

1. Register at the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole)
   (one-time US$5 fee, 2-step verification required).
2. **New item** → upload the Chrome zip.
3. Store listing: description, at least one 1280×800 screenshot, a 128×128 icon, category
   *Shopping*. Put `Source code (AGPL-3.0): https://github.com/<you>/tcgplayer-cart-optimizer`
   in the description. This line is the AGPL "clear directions" to the source.
4. Privacy tab: single purpose ("optimizes the user's TCGplayer cart"); justify `storage`
   (remembers options and locked printings) and the `tcgplayer.com` host permission (reads and
   writes the user's cart, fetches listings); declare that no user data is collected; link a
   privacy policy (a short page saying exactly that is fine).
5. Submit for review (typically hours to a few days). Later updates: upload a new zip with a
   higher version.

### Firefox Add-ons (AMO)

1. Sign in at the [Add-on Developer Hub](https://addons.mozilla.org/developers/) (free).
2. **Submit a New Add-on** → *On this site* → upload the Firefox zip.
3. When asked about source code, answer **yes** and upload the `-sources.zip` (the build is
   bundled/minified, so reviewers rebuild it with `pnpm install && pnpm zip:firefox`).
4. Listing: summary, description with the source link, *Shopping* category, license
   **GNU Affero General Public License v3.0**, screenshots. Data collection is already declared
   as none in the manifest.
5. Automated validation runs immediately; human review may follow. Updates go through
   **Upload New Version**.

The add-on ID (`tcgplayer-cart-optimizer@adhithirumala.com` in `wxt.config.ts`) is permanent once
published; change it before the first upload if you want a different one.

`wxt submit` (from [publish-browser-extension](https://wxt.dev/guide/essentials/publishing.html))
can automate later uploads to both stores with API credentials.

## Limitations

- US shipping, English cards, single cards (no sealed product), seller-fulfilled items
  (TCGplayer Direct's own consolidated shipping isn't modelled).
- Listings are a snapshot: an item can sell between optimizing and replacing the cart. The result
  screen reports anything that couldn't be added in full.
- TCGplayer's APIs are undocumented and may change without notice.

## License

[AGPL-3.0-or-later](LICENSE). Not affiliated with or endorsed by TCGplayer.
