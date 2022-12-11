/// <reference types="react/next" />
/// <reference types="react-dom/next" />

import * as ReactDOM from "react-dom/client";
import * as React from "react";
import * as Router from "./Router";
import * as Routing from "./Routing";
import type * as API from "./api";

type Environment = "client" | "ssr";

let currentEnvironment: Environment =
  typeof window === "undefined" ? "ssr" : "client";

export type ASAPApi = {
  setTitle(title: string): void;
  endpoints: {
    [name: string]: { handle: Function };
  };
  endpointsCache: {
    [path: string]: { used: number; result: unknown };
  };
};

// This is what's being injected by the server.
declare var ASAPConfig: Config;
declare var ASAPBootConfig: BootConfig;
declare var ASAPApi: ASAPApi;

export type Route<P extends string = string> = Router.Route<P>;

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
  if (currentEnvironment === "client")
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
  activeClassName?: undefined | string;
  inactiveClassName?: undefined | string;
} & Omit<React.HTMLProps<HTMLAnchorElement>, "href">;

/**
 * <Link /> component render an <a /> element which performs client side
 * naviation on press.
 */
export let Link = React.forwardRef(
  <P extends string>(
    {
      route,
      params,
      activeClassName,
      inactiveClassName,
      className: defaultClassName,
      ...props
    }: LinkProps<P>,
    ref: React.Ref<HTMLAnchorElement>
  ) => {
    let router = Router.useRouter();
    let href = Routing.href(route, params);
    let [isActive, setIsActive] = React.useState(router.currentPath === href);
    Router.useLocationListener(
      (currentPath) => {
        setIsActive(currentPath === href);
      },
      [href]
    );
    let onClick: React.MouseEventHandler<HTMLAnchorElement> =
      React.useCallback(
        (ev) => {
          ev.preventDefault();
          router.navigate(href);
          props.onClick?.(ev);
        },
        [href]
      );
    let className = React.useMemo(() => {
      let className = [];
      if (defaultClassName != null) className.push(defaultClassName);
      if (isActive) className.push(activeClassName);
      if (!isActive) className.push(inactiveClassName);
      if (className.length > 0) return className.join(" ");
      else return undefined;
    }, [isActive, activeClassName, inactiveClassName]);
    return (
      <a
        {...props}
        className={className}
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
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta charSet="utf-8" />
        <script dangerouslySetInnerHTML={{ __html: boot }} />
        {js}
        {css}
      </head>
      <Body {...props} />
    </html>
  );
}

function Body({ config, boot }: AppProps) {
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
    <body>
      <React.Suspense fallback={<props.AppLoading />}>
        {props.children}
      </React.Suspense>
    </body>
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

export function usePageTitle(title: string) {
  if (currentEnvironment === "client") {
    React.useLayoutEffect(() => {
      ASAPApi.setTitle(title);
    }, [title]);
  } else if (currentEnvironment === "ssr") {
    ASAPApi.setTitle(title);
  }
}

export type Endpoint<
  Result,
  Body extends {},
  Params extends string
> = API.Endpoint<Result, Body, Params>;

export type EndpointParams<
  Body extends {},
  Params extends string
> = API.EndpointParams<Body, Params>;

/**
 * Generate href for an endpoint with params applied.
 */
export function endpointHref<B extends {}, P extends string>(
  endpoint: Endpoint<any, B, P>,
  params: EndpointParams<B, P>
): string {
  let { basePath } = getConfig();
  let route = (endpoint as any as { route: Routing.Route<P> }).route;
  let query = "";
  let qsParams = params;
  if (route.params.length > 0) {
    qsParams = { ...params };
    for (let k of route.params) delete (qsParams as any)[k];
  }
  if (Object.keys(qsParams).length > 0) {
    query = `?${new URLSearchParams(qsParams).toString()}`;
  }
  return `${basePath}/_api${Routing.href(route, params)}${query}`;
}

export async function UNSAFE__call<R, B extends {}, P extends string>(
  endpoint: Endpoint<R, B, P>,
  params: EndpointParams<B, P>
): Promise<R> {
  if (currentEnvironment === "client") {
    let path = endpointHref(endpoint, params);
    if (endpoint.method === "GET") {
      if (path in ASAPApi.endpointsCache) {
        let record = ASAPApi.endpointsCache[path]!;
        if (record.used === 1) {
          delete ASAPApi.endpointsCache[path];
        } else {
          record.used -= 1;
        }
        return record.result as R;
      }
      let resp: Promise<Response> = fetch(path);
      return (await resp).json();
    } else if (endpoint.method === "POST") {
      let resp: Promise<Response> = fetch(path, {
        method: "POST",
        body: JSON.stringify(params),
      });
      return (await resp).json();
    } else {
      throw new Error(`unknown HTTP method ${endpoint.method}`);
    }
  } else if (currentEnvironment === "ssr") {
    let e = ASAPApi.endpoints[endpoint.name]!;
    if (endpoint.method === "GET") {
      let path = endpointHref(endpoint, params);
      if (path in ASAPApi.endpointsCache) {
        let record = ASAPApi.endpointsCache[path]!;
        record.used += 1;
        return record.result as R;
      } else {
        let result = await e.handle!(params);
        ASAPApi.endpointsCache[path] = { used: 1, result };
        return result;
      }
    } else {
      return e.handle!(params);
    }
  } else {
    throw new Error(
      `unable to call endpoint ${endpoint.name}: environment is broken`
    );
  }
}
