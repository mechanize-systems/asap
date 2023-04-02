/**
 * Utilities to define API part of ASAP apps.
 */

import type * as ws from "ws";
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

export type OnWebSocket = (connection: ws.WebSocket) => void;

export type OnCleanup = () => void;

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
  params?: B;
  handle: (params: EndpointParams<B, P>) => R;
};

export type Endpoint<R, B extends {}, P extends string = string> = {
  (params: EndpointParams<B, P>): Promise<Awaited<R>>;
  $$asapType: "endpoint";
  method: HTTPMethod | null;
  path: P | null;
  doc: string | null;
  params: B;
};

export function endpoint<R, B extends {}, P extends string>(
  config: EndpointSpec<R, B, P>
): Endpoint<R, B, P> {
  async function handle(params: EndpointParams<B, P>) {
    return config.handle(params);
  }
  handle.$$asapType = "endpoint";
  handle.method = config.method ?? "GET";
  handle.path = config.path ?? null;
  handle.params = config.params ?? null;
  handle.doc = config.doc ?? null;
  return handle as Endpoint<R, B, P>;
}

export type ComponentParams<P extends {}> = {
  [name in keyof P]: Refine.CheckerReturnType<P[name]>;
};

export type ComponentSpec<P extends {}> = {
  params: P;
  render: (params: ComponentParams<P>) => JSX.Element | Promise<JSX.Element>;
};

export type Component<P extends {}> = React.FunctionComponent<
  ComponentParams<P>
> & {
  (params: ComponentParams<P>): JSX.Element | Promise<JSX.Element>;
  $$asapType: "component";
  params: P;
};

export function component<P extends {}>(spec: ComponentSpec<P>): Component<P> {
  function component(props: ComponentParams<P>) {
    return spec.render(props);
  }
  component.$$asapType = "component" as const;
  component.params = spec.params;
  return component as any;
}
