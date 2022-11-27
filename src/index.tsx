/// <reference types="react/next" />
/// <reference types="react-dom/next" />

import * as ReactDOM from "react-dom/client";
import * as React from "react";
import * as Router from "./Router";
import * as Routing from "./Routing";
import type * as API from "./api";

// This is what's being injected by the server.
declare var ASAPConfig: Config;
declare var ASAPBootConfig: BootConfig;
declare var ASAPEndpoints: { [name: string]: { handle: Function } };

export let route = Router.route;

export let useRouter = Router.useRouter;

/**
 * Generate `href` for the specified `route` and route `params`.
 */
export let href: typeof Routing.href = (route, params) => {
  let basePath = getConfig().basePath;
  return basePath + Routing.href(route, params);
};

/**
 * Generate href for the specified `href` respecting currently configured
 * `basePath`.
 */
export let href0 = (href: string) => {
  let basePath = getConfig().basePath;
  return basePath + href;
};

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
  if (typeof window === "undefined") return;
  ReactDOM.hydrateRoot(document, render(config, ASAPBootConfig));
}

export function render(config: AppConfig, boot: BootConfig) {
  return (
    <React.StrictMode>
      <App config={config} boot={boot} />
    </React.StrictMode>
  );
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

export type BootConfig = {
  basePath: string;
  initialPath?: string;
  js: string;
  css: string | null;
};
export type AppProps = {
  config: AppConfig;
  boot: BootConfig;
};

export function App(props: AppProps) {
  let js = <script async defer type="module" src={props.boot.js} />;
  let css =
    props.boot.css != null ? (
      <link rel="stylesheet" href={props.boot.css} />
    ) : null;
  let boot = `
    window.ASAPConfig = ${JSON.stringify({ basePath: props.boot.basePath })};
    window.ASAPBootConfig = ${JSON.stringify(props.boot)};
  `;
  return (
    <html>
      <head>
        <script dangerouslySetInnerHTML={{ __html: boot }} />
        {js}
        {css}
      </head>
      <body>
        <Content {...props} />
      </body>
    </html>
  );
}

function Content({ config, boot }: AppProps) {
  let asapConfig = getConfig();
  let [isNavigating, path, router] = Router.useLocation({
    basePath: asapConfig.basePath,
    initialPath: boot.initialPath,
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
  return (
    <React.Suspense fallback={<props.AppLoading />}>
      {props.children}
    </React.Suspense>
  );
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

export async function UNSAFE__call<R, B, P extends string>(
  endpoint: { name: string; method: API.HTTPMethod; route: Routing.Route<P> },
  params: Routing.RouteParams<P> & B
): Promise<R> {
  if (typeof window !== "undefined") {
    let basePath = getConfig().basePath;
    let path = `${basePath}/_api${Routing.href(endpoint.route, params)}`;
    let resp: Promise<Response>;
    if (endpoint.method === "GET") {
      resp = fetch(path);
    } else if (endpoint.method === "POST") {
      resp = fetch(path, { method: "POST", body: JSON.stringify(params) });
    } else {
      throw new Error(`unknown HTTP method ${endpoint.method}`);
    }
    let result = await (await resp).text();
    return JSON.parse(result);
  } else if (typeof ASAPEndpoints !== "undefined") {
    let e = ASAPEndpoints[endpoint.name]!;
    return e.handle!(params);
  } else {
    throw new Error(`unable to call endpoint ${name}: environment is broken`);
  }
}
