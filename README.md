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

```sh
mkdir example && cd example && pnpm init
```

Add dependencies to the project:

```sh
pnpm add react react-dom @mechanize/asap
```

Let's create a simple app of two pages:

```sh
cat <<EOF
import * as ASAP from "@mechanize/asap";

export let routes = {
  index: ASAP.route("/", () => () => <div>index</div>),
  hello: ASAP.route("/hello/:name", () => ({name}) => <div>hello {name}</div>),
};

ASAP.boot(routes);
EOF > ./app.js
```

Let's add a few simple API methods:

```sh
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

Now we can serve the app:

```sh
pnpm asap serve
```

Now for production you'd want to the optimized bundle first:

```sh
pnpm asap build --env production
```

And finally serve the app in production environment:

```sh
pnpm asap serve --env production
```

## Design Overview

- asap runs a [tinyhttp][] server to server HTML page skeletons (an empty page
  with `<script>` tags to launch the client application) and API requests
- in development asap compiles client code with [esbuild][]
- in development asap compiles server code with [esbuild][], this allows to hot
  reload server code (on changes the bundle will be rebuilt and the next request
  will be served using newly built code)
- in production [esbuild][] is not used and built bundles are used instead
- on client there's `@mechanize/asap` library which provides suspense-enabled
  typesafe routing

[tinyhttp]: https://tinyhttp.v1rtl.site
[esbuild]: https://esbuild.github.io
