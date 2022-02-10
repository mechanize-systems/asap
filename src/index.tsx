/// <reference types="react-dom/next" />

import * as ReactDOM from "react-dom";
import * as React from "react";
import * as Router from "./Router";

export let route = Router.route;

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

export type LinkProps = React.HTMLProps<HTMLAnchorElement>;

/**
 * <Link /> component render an <a /> element which performs client side
 * naviation on press.
 */
export function Link(props: LinkProps) {
  let router = Router.useRouter();
  let onClick: React.MouseEventHandler = (ev) => {
    ev.preventDefault();
    if (props.href != null) router.navigate(props.href);
  };
  return <a {...props} onClick={onClick} />;
}

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
    let params = Router.matches(route, path);
    if (params == null) continue;
    return [route, params] as any;
  }
  return [null, null];
}
