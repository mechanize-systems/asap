import type * as Fastify from "fastify";
import * as Routing from "./Routing";

export type Request = Parameters<Fastify.RouteHandler>[0];
export type Response = Parameters<Fastify.RouteHandler>[1];
export type HTTPMethod = Fastify.HTTPMethods;
export type RouteParams<P extends string> = Routing.RouteParams<P>;

export type Route<P extends string = string> = Routing.Route<P> & {
  method: HTTPMethod;
  handle: Handler<Routing.RouteParams<P>>;
};

export type Routes = Route[];

type Handler<Params> = (
  req: Request,
  res: Response,
  params: Params
) => unknown | Promise<unknown>;

export function route<P extends string>(
  method: HTTPMethod,
  path: P,
  handle: Handler<Routing.RouteParams<P>>
): Route<P> {
  let route = Routing.route(path);
  return { ...route, method, handle };
}
