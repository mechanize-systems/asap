/// <reference types="react-dom/next" />

import * as ReactDOM from "react-dom";
import * as React from "react";
import * as Router from "./Router";
import * as Routing from "./Routing";

// This is what's being injected by the server.
declare var ASAPConfig: Config;

export let route = Router.route;
export let useRouter = Router.useRouter;
export let href = Routing.href;

export type Config = { basePath: string };
export let getConfig = (): Config => ASAPConfig;

export type AppConfig = {
  /**
   * A set of routes for the application.
   *
   * See @see route function on how to define routes.
   */
  routes: Router.Routes;

  /**
   * A component which renders application chrome (the UI around page
   * components).
   */
  AppChrome?: React.ComponentType<AppChromeProps>;

  /**
   * A component which renders a loading screen (while application page is being
   * loaded).
   */
  AppLoading?: React.ComponentType<AppLoadingProps>;

  /**
   * A component which renders when no page route matches the current pathname.
   */
  AppOnPageNotFound?: React.ComponentType<AppOnPageNotFoundProps>;
};

export type AppChromeProps = {
  isNavigating: boolean;
  children: React.ReactNode;
  AppLoading: React.ComponentType<AppLoadingProps>;
};

export type AppLoadingProps = {};

export type AppOnPageNotFoundProps = {};

/** Boot application with routes. */
export function boot(config: AppConfig) {
  window.addEventListener("DOMContentLoaded", async () => {
    // TODO: error handling
    let element = document.getElementById("asap");
    let root = ReactDOM.createRoot(element!);
    root.render(
      <React.StrictMode>
        <App config={config} />
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
    let onClick: React.MouseEventHandler<HTMLAnchorElement> =
      React.useCallback(
        (ev) => {
          ev.preventDefault();
          router.navigate(href);
          props.onClick?.(ev);
        },
        [href]
      );
    return (
      <a
        {...props}
        ref={ref}
        href={getConfig().basePath + href}
        onClick={onClick}
      />
    );
  }
);

type AppProps = {
  config: AppConfig;
};

function App({ config }: AppProps) {
  let [isNavigating, path, router] = Router.useLocation({
    basePath: getConfig().basePath,
  });
  let [route, params] = React.useMemo(
    () => match(config.routes, path),
    [config.routes, path]
  );
  if (route == null || params == null) {
    let AppOnPageNotFound =
      config.AppOnPageNotFound ?? AppOnPageNotFoundDefault;
    return <AppOnPageNotFound />;
  }
  let AppChrome = config.AppChrome ?? AppChromeDefault;
  let AppLoading = config.AppLoading ?? AppLoadingDefault;
  return (
    <Router.ContextProvider value={router}>
      <AppChrome isNavigating={isNavigating} AppLoading={AppLoading}>
        <route.Page key={route.path} {...params} />
      </AppChrome>
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

function AppChromeDefault(props: AppChromeProps) {
  return <React.Suspense fallback={<props.AppLoading />}></React.Suspense>;
}

function AppLoadingDefault(_props: AppLoadingProps) {
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      Loading...
    </div>
  );
}

function AppOnPageNotFoundDefault(_props: AppOnPageNotFoundProps) {
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      404 PAGE NOT FOUND...
    </div>
  );
}
