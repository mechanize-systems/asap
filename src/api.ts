/**
 * Utilities to define API part of ASAP apps.
 */

import type * as http from "http";
import type * as Refine from "@recoiljs/refine";
import * as Routing from "./Routing";

export type Request<Params = void> = http.IncomingMessage & {
  params: Params;
};
export type Response = http.ServerResponse & {
  send(body: unknown): void;
};
export type Next = (err?: any) => void;
export type HTTPMethod = "GET" | "POST";
export type RouteParams<P extends string> = Routing.RouteParams<P>;

export type Route<P extends string = string> = Routing.Route<P> & {
  method: HTTPMethod;
  handle: Handle<Routing.RouteParams<P>>;
};

export type Routes = Route[];

export type Handle<Params> = (
  req: Request<Params>,
  res: Response,
  next: Next
) => unknown | Promise<unknown>;

export function route<P extends string>(
  method: HTTPMethod,
  path: P,
  handle: Handle<Routing.RouteParams<P>>
): Route<P> {
  let route = Routing.route(path);
  return { ...route, method, handle };
}

export type EndpointParams<
  B extends {},
  P extends string
> = Routing.RouteParams<P> & {
  [name in keyof B]: Refine.CheckerReturnType<B[name]>;
};

export type EndpointSpec<R, B extends {}, P extends string = string> = {
  method?: HTTPMethod;
  path?: P;
  doc?: string | null;
  body?: B;
  handle: (params: EndpointParams<B, P>) => R;
};

export type Endpoint<R, B extends {}, P extends string = string> = {
  (params: EndpointParams<B, P>): Promise<R>;
  type: "Endpoint";
  method: HTTPMethod;
  path: P | null;
  doc: string | null;
  body: B;
};

export function endpoint<R, B extends {}, P extends string>(
  config: EndpointSpec<R, B, P>
): Endpoint<R, B, P> {
  async function handle(params: EndpointParams<B, P>) {
    return config.handle(params);
  }
  handle.type = "Endpoint";
  handle.method = config.method ?? "GET";
  handle.path = config.path ?? null;
  handle.body = config.body ?? null;
  handle.doc = config.doc ?? null;
  return handle as Endpoint<R, B, P>;
}
