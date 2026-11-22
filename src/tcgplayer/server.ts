import { Layer } from 'effect';
import { RpcServer } from 'effect/rpc';
import { portServerProtocol } from '@/core/port-rpc';
import { addToCart, clearCart, fetchListings, fetchSellers, getProducts, readCart, searchProducts } from './api';
import { TcgHttp } from './http';
import { TCG_PORT, TcgRpcs, streamProgress } from './rpcs';

const handlers = TcgRpcs.toLayer({
  ReadCart: () => readCart,
  SearchProducts: ({ query }) => searchProducts(query),
  GetProducts: ({ productIds }) => getProducts(productIds),
  FetchListings: ({ productIds, conditions }) => streamProgress((report) => fetchListings(productIds, conditions, report)),
  FetchSellers: ({ sellerIds }) => streamProgress((report) => fetchSellers(sellerIds, report)),
  ClearCart: () => clearCart,
  AddToCart: ({ items }) => streamProgress((report) => addToCart(items, report)),
});

/** Serves `TcgRpcs` to extension pages that connect to this tab. */
export const TcgServer = RpcServer.layer(TcgRpcs).pipe(
  Layer.provide(handlers),
  Layer.provide(Layer.effect(RpcServer.Protocol)(portServerProtocol(TCG_PORT))),
  Layer.provide(TcgHttp.layer),
);
