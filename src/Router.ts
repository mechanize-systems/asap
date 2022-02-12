/// <reference types="react/next" />
/**
 * 2019 - 2022 Copyright Alexey Taktarov <molefrog@gmail.com>
 * 2022 - now Copyright Andrey Popp <me@andreypopp.com>
 *
 * Licensed under ISC
 */

import * as React from "react";
import * as Routing from "./Routing";

export type Routes = { [name: string]: Route<any> };

export type Route<P extends string> = Routing.Route<P> & {
  Page: React.ComponentType<Routing.RouteParams<P>>;
};

export type RouteParams<P extends string> = Routing.RouteParams<P>;

type Page<Props> = { default: (props: Props) => JSX.Element };

type LoadPage<Path extends string> = () => Promise<
  Page<Routing.RouteParams<Path>>
>;

export function route<P extends string, L extends LoadPage<P>>(
  path: P,
  loadPage: L
): Route<P> {
  let route = Routing.route(path);
  let Page = React.lazy(loadPage as any);
  return { ...route, Page };
}

export type Router = {
  navigate: (path: string, config?: { replace?: boolean }) => void;
};

let Context = React.createContext<Router | null>(null);

export let ContextProvider = Context.Provider;

export function useRouter(): Router {
  let ctx = React.useContext(Context);
  return ctx!;
}

/**
 * @see https://developer.mozilla.org/en-US/docs/Web/API/History
 */
const eventPopstate = "popstate";
const eventPushState = "pushState";
const eventReplaceState = "replaceState";
const events = [eventPopstate, eventPushState, eventReplaceState];

export function useLocation({ basePath = "" }: { basePath?: string } = {}) {
  let [isNavigating, startTransition] = React.useTransition();
  const [{ path, search }, update] = React.useState(() => ({
    path: currentPathname(basePath),
    search: location.search,
  }));
  const prevHash = React.useRef(path + search);

  React.useEffect(() => {
    // this function checks if the location has been changed since the
    // last render and updates the state only when needed.
    // unfortunately, we can't rely on `path` value here, since it can be stale,
    // that's why we store the last pathname in a ref.
    const checkForUpdates = () => {
      const pathname = currentPathname(basePath);
      const search = location.search;
      const hash = pathname + search;

      if (prevHash.current !== hash) {
        prevHash.current = hash;
        startTransition(() => {
          update({ path: pathname, search });
        });
      }
    };

    events.forEach((e) => addEventListener(e, checkForUpdates));

    // it's possible that an update has occurred between render and the effect handler,
    // so we run additional check on mount to catch these updates. Based on:
    // https://gist.github.com/bvaughn/e25397f70e8c65b0ae0d7c90b731b189
    checkForUpdates();

    return () => events.forEach((e) => removeEventListener(e, checkForUpdates));
  }, [basePath]);

  // the 2nd argument of the `useLocation` return value is a function
  // that allows to perform a navigation.
  //
  // the function reference should stay the same between re-renders, so that
  // it can be passed down as an element prop without any performance concerns.
  let router: Router = React.useMemo(
    () => ({
      navigate: (to: string, { replace = false }: { replace?: boolean } = {}) =>
        history[replace ? eventReplaceState : eventPushState](
          null,
          "",
          // handle nested routers and absolute paths
          to[0] === "~" ? to.slice(1) : basePath + to
        ),
    }),
    [basePath]
  );

  return [isNavigating, path, router] as const;
}

// While History API does have `popstate` event, the only
// proper way to listen to changes via `push/replaceState`
// is to monkey-patch these methods.
//
// See https://stackoverflow.com/a/4585031
if (typeof history !== "undefined") {
  for (let type of [eventPushState, eventReplaceState]) {
    let original = (history as any)[type];

    (history as any)[type] = function () {
      let result = original.apply(this, arguments);
      let event = new Event(type);
      (event as any).arguments = arguments;

      dispatchEvent(event);
      return result;
    };
  }
}

let currentPathname = (basePath: string, path = location.pathname) =>
  !path.toLowerCase().indexOf(basePath.toLowerCase())
    ? path.slice(basePath.length) || "/"
    : "~" + path;
