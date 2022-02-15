/**
 * Utilities to define API part of ASAP apps.
 */

import type * as http from "http";
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
