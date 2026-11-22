# TCGplayer endpoints (undocumented; confirmed 2026-11)

All calls must originate from a `https://www.tcgplayer.com` page context: the APIs answer
`403` to requests without that `Origin`, and the cart endpoints need the site cookies
(`credentials: "include"`). The extension therefore performs every request from its content
script on `*.tcgplayer.com` (`src/tcgplayer/`).

Responses use an envelope `{ "errors": [...], "results": [...] }` unless noted.

## Search products

`POST https://mp-search-api.tcgplayer.com/v1/search/request?q=<query>&isList=false`

```json
{
  "algorithm": "sales_dismax",
  "from": 0,
  "size": 50,
  "filters": { "term": { "productLineName": ["pokemon"] }, "range": {}, "match": {} },
  "listingSearch": {
    "context": { "cart": {} },
    "filters": {
      "term": { "sellerStatus": "Live", "channelId": 0 },
      "range": { "quantity": { "gte": 1 } },
      "exclude": { "channelExclusion": 0 }
    }
  },
  "context": { "cart": {}, "shippingCountry": "US", "userProfile": {} },
  "settings": { "useFuzzySearch": false, "didYouMean": {} },
  "sort": {}
}
```

`results[0]` = `{ totalResults, results[] }`. Items carry `productId, productName, setName, setCode,
rarityName, sealed, marketPrice, lowestPrice, totalListings` and `customAttributes` with gameplay
text: `cardType[]` ("Pokemon" | "Supporter" | "Item" | "Stadium" | "Energy" | ...), `stage, hp,
energyType[], description` (HTML: abilities / trainer / energy text), `attack1..attack4`
(e.g. `"[1P] Spooky Shot (40)"`), `weakness, resistance, retreatCost, number`.

Text formatting differs between printings of the same card ("Pokemon" vs "Pokémon", `<em>`
markup, optional reminder text); `src/catalog` normalizes before comparing.

## Product details

`GET https://mp-search-api.tcgplayer.com/v1/product/<productId>/details` — **no envelope**; the
same fields as a search result (`listings` instead of `totalListings`).

## Products for SKUs

`POST https://mp-search-api.tcgplayer.com/v1/product/getProductForSkus` with a bare JSON array of
SKUs (`[8608694, ...]`). `results[0][]`: `sku, productId, productName, setName, condition,
printing, collectorNumber, rarity`.

## Listings for a product

`POST https://mp-search-api.tcgplayer.com/v1/product/<productId>/listings`

```json
{
  "filters": {
    "term": { "sellerStatus": "Live", "channelId": 0, "language": ["English"], "condition": ["Near Mint"] },
    "range": { "quantity": { "gte": 1 } },
    "exclude": { "channelExclusion": 0 }
  },
  "from": 0,
  "size": 50,
  "sort": { "field": "price+shipping", "order": "asc" },
  "context": { "shippingCountry": "US", "cart": {} },
  "aggregations": ["listingType"]
}
```

`size` above 50 is rejected with `400`. `results[0]` = `{ totalResults, results[] }`; fields used:
`listingId, productId, productConditionId (= SKU), sellerId (string), sellerKey, sellerName,
price, quantity, condition, printing, language, directSeller`. Common cards have thousands of
listings; 16 concurrent requests fetched ~780 pages in ~25 s without rate limiting.

## Seller shipping rules

`POST https://mpapi.tcgplayer.com/v2/seller/shippinginfo?countryCode=US`
body: `[{ "sellerId": 827020, "largestShippingCategoryId": 1 }, ...]` (100 per request works).

`results[0][]`: `sellerId, sellerKey, displayName, isDirect, rating, completedSalesRank,
sellerShippingOptions[]`. The option with `shippingMethodCode === "TCGFIRSTCLASS"` is standard
shipping: `thresholdPrice, shippingPriceUnderThreshold, shippingPriceOverThreshold`. Some sellers
charge the same price over the threshold (no free shipping).

## Cart

Cart key: cookie `StoreCart_PRODUCTION=CK=<32 hex>&Ignore=false`. It is a session cookie for
guests, is created by visiting the cart page, and changes when the user signs in — always re-read it.

| Purpose | Request | Notes |
| --- | --- | --- |
| Items | `POST https://mpgateway.tcgplayer.com/v1/cart/<ck>/validatecart?validateForCheckout=false&countryCode=US` | `results[0].cartItems[]`: `sku, quantity, currentPrice, sellerId, sellerKey, isDirect, customListingKey`. |
| Add | `POST .../v1/cart/<ck>/item/add` body `{ sku, sellerKey, channelId: 0, requestedQuantity, price, isDirect: false, countryCode: "US" }` | `results[0]: { itemQuantityInCart, currentPrice, sellerQuantityAvailable, status }`; `status 0` = ok. Too large a quantity → `errors: [{ code: "CAPI-4", message: "CartItemQuantityNotAvailable" }]`, `status 4`. |
| Clear | `DELETE .../v1/cart/<ck>/items/all` | Empty body on success. Saved-for-later is untouched. |
| Summary | `GET .../v1/cart/<ck>/summary?countryCode=US` | Totals per seller; not used. |

Avoid `validatecartandautosaveforlater` (what the cart page itself calls): it moves items that
can't ship to the visitor's detected country into saved-for-later.

The site's shipping-country preference lives in the `setting` cookie (`CD=US&M=1`).
