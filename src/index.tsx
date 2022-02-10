/// <reference types="react-dom/next" />

import * as ReactDOM from "react-dom";
import * as React from "react";
import * as Router from "./Router";
import * as Routing from "./Routing";

export let route = Router.route;
export let href = Routing.href;

/** Boot application with routes. */
export function boot(routes: Router.Routes) {
  window.addEventListener("DOMContentLoaded", async () => {
    // TODO: error handling
    let element = document.getElementById("asap");
    let root = ReactDOM.createRoot(element!);
    root.render(
      <React.StrictMode>
        <React.Suspense fallback={<div>Loading...</div>}>
          <App routes={routes} />
        </React.Suspense>
      </React.StrictMode>
    );
  });
}

export type LinkProps<P extends string> = {
  route: Router.Route<P>;
  params: Router.RouteParams<P>;
} & Omit<React.HTMLProps<HTMLAnchorElement>, "href">;

/**
 * <Link /> component render an <a /> element which performs client side
 * naviation on press.
 */
export let Link = React.forwardRef(
  <P extends string>(
    { route, params, ...props }: LinkProps<P>,
    ref: React.Ref<HTMLAnchorElement>
  ) => {
    let router = Router.useRouter();
    let href = Routing.href(route, params);
    let onClick: React.MouseEventHandler<HTMLAnchorElement> = React.useCallback(
      (ev) => {
        ev.preventDefault();
        router.navigate(href);
        props.onClick?.(ev);
      },
      [href]
    );
    return <a {...props} ref={ref} href={href} onClick={onClick} />;
  }
);

type AppProps = {
  routes: Router.Routes;
};

function App({ routes }: AppProps) {
  let [_updatingPath, path, router] = Router.useLocation();
  let [route, params] = React.useMemo(
    () => match(routes, path),
    [routes, path]
  );
  if (route == null || params == null) return <div>404 NOT FOUND</div>;
  return (
    <Router.ContextProvider value={router}>
      <route.Page {...params} />
    </Router.ContextProvider>
  );
}

function match<T extends string>(
  routes: Router.Routes,
  path: string
): [Router.Route<T>, Router.RouteParams<T>] | [null, null] {
  for (let route of Object.values(routes)) {
    let params = Routing.matches(route, path);
    if (params == null) continue;
    return [route, params] as any;
  }
  return [null, null];
}
