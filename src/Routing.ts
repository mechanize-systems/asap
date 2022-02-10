/**
 * Path routing.
 *
 * This provides typesafe route matching.
 */

import * as regexparam from "regexparam";

/**
 * Extracts type of route parameters from a statically known route.
 */
export type RouteParams<P extends string> = params<split<P>>;

/**
 * Function which loads a page with specified props.
 */

/**
 * Represents a route.
 */
export type Route<Path extends string> = {
  path: Path;
  regexp: RegExp;
  params: string[];
};

/**
 * Generate href for this route with specified params.
 */
export function href<P extends string>(
  route: Route<P>,
  params: RouteParams<P>
): string {
  return regexparam.inject(route.path, params as any);
}

/**
 * Load and return a page component for this route.
 */
export function matches<P extends string>(
  route: Route<P>,
  path: string
): RouteParams<P> {
  const m = route.regexp.exec(path);
  if (m == null) return null;
  let params: Record<string, string> = {};
  route.params.forEach((param, idx) => {
    params[param] = m[idx + 1]!;
  });
  return params as unknown as RouteParams<P>;
}

/**
 * Represents a route configuration.
 */
export function route<P extends string>(path: P): Route<P> {
  let { keys: params, pattern: regexp } = regexparam.parse(path);
  return { path, params, regexp };
}

/*
 * Aux types for lifting URLs to type system.
 */

type split<S extends string> = string extends S
  ? string[]
  : S extends "/"
  ? []
  : S extends `${infer T}/${infer U}`
  ? [T, ...split<U>]
  : [S];

type param<T> = T extends `:${infer K}`
  ? [K, string]
  : T extends `*`
  ? ["path", string]
  : [never, never];

type params<T extends string[]> = {
  [K in param<T[number]>[0]]: Extract<param<T[number]>, [K, any]>[1];
};
