# asap

An opinionated application server for React Single Page Applications.

## Motivation

Next.js and others are great but they favor use case of landing pages and
ecommerce websites, providing them with SSR, "on the edge" deployment etc.

These are all great features but we don't always need such complexity if all we
want to implement is a simple React app and a few API routes along.

Therefore there's asap which:

- ... is a simple application server built on top of fastify, esbuild and React
- ... strives to enable fast iterative development
- ... and get out of your way in production

## Quickstart

Init a new project:

```
mkdir example && cd example && npm init
```

Add dependencies to the project:

```
pnpm add react react-dom @mechanize/asap
```

Let's create a simple app of two pages:

```
cat <<EOF
import * as ASAP from "@mechanize/asap";

export let routes = {
  index: ASAP.route("/", () => () => <div>index</div>),
  hello: ASAP.route("/hello/:name", () => ({name}) => <div>hello {name}</div>),
};

ASAP.boot(routes);
EOF > ./app.js
```

Now we can serve the app:

```
pnpm asap serve
```

Let's add a few simple API methods:

```
cat <<EOF
import * as api from "@mechanize/asap/api";

export let routes = [
  api.route("GET", "/todo", () => {
    return [{ id: "1" }];
  }),
  api.route("GET", "/todo/:id", (_req, _res, { id }) => {
    return { id };
  }),
];
EOF > ./api.js
```

Serve the app with API:

```
pnpm asap serve
```

Now for productionyou'd want to the optimized bundle first:

```
pnpm asap build --env production
```

And finally serve the app in production environment:

```
pnpm asap serve --env production
```

## Design Overview

asap works on top of fastify, esbuild and React:

- The esbuild is used to build bundles for app pages and for API.
- The fastify is used to serve a page skeleton, app pages bundle and handle API
  requests.
- On changes asap rebuidlds both the app pages bundle the API bundle.
