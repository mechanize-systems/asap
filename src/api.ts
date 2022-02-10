import type * as Fastify from "fastify";
import * as Routing from "./Routing";

export type Request = Parameters<Fastify.RouteHandler>[0];
export type Response = Parameters<Fastify.RouteHandler>[1];
export type HTTPMethod = Fastify.HTTPMethods;

export type Route<P extends string> = Routing.Route<P> & {
  method: HTTPMethod;
  handle: Handler<Routing.RouteParams<P>>;
};

type Handler<Params> = (
  req: Request,
  res: Response,
  params: Params
) => string | Promise<string>;

export function route<P extends string>(
  method: HTTPMethod,
  path: P,
  handle: Handler<Routing.RouteParams<P>>
): Route<P> {
  let route = Routing.route(path);
  return { ...route, method, handle };
}
