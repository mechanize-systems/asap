# ASAP

An opinionated application server for React Single Page Applications.

## Motivation

Next.js and others are great but they favor use cases of landing pages and
ecommerce websites, providing them with SSR, "on the edge" deployment etc.

These are all great features but we don't always need such complexity if all we
want to implement is a simple React app and a few API routes along.

Therefore there's ASAP which:

- ... is a simple application server built on top of [tinyhttp][], [esbuild][]
  and [React][]
- ... strives to enable fast iterative development
- ... and get out of your way in production

## Features

- ASAP is opinionated

- ASAP builds both client and server code with esbuild, you don't need to mess
  with build configuration (also because you can't)

- In development mode ASAP automatically reloads server code on changes, you
  don't need to restart the `asap serve` to iterate

- ASAP provides a very thin client side application framework on top of React
  with type safe routing

## Quickstart

Initialize a new project:

```sh
mkdir example && cd example && pnpm init
```

Add dependencies to the project:

```sh
pnpm add react react-dom @mechanize/asap
```

Let's create a simple app of two pages:

```sh
cat << EOF > ./app.js
import * as React from "react";
import * as ASAP from "@mechanize/asap";

export let routes = {
  index: ASAP.route("/", async () => ({ default: Index })),
  hello: ASAP.route("/hello/:name", async () => ({ default: Hello })),
};

function Index() {
  return (
    <div>
      <p>Welcome!</p>
      <p>
        Go to{" "}
        <ASAP.Link route={routes.hello} params={{ name: "World" }}>
          hello page
        </ASAP.Link>
      </p>
    </div>
  );
}

function Hello({ name }) {
  return <div>Hello, {name}!</div>;
}

ASAP.boot({ routes });
EOF
```

Let's add a few simple API methods:

```sh
cat << EOF > ./api.js
import * as api from "@mechanize/asap/api";

export let routes = [
  api.route("GET", "/todo", (req, res) => {
    res.send([{ id: "1" }]);
  }),
  api.route("GET", "/todo/:id", (req, res) => {
    res.send({ id: req.params.id });
  }),
];
EOF
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

- ASAP runs a [tinyhttp][] server to serve HTML page skeletons (an empty page
  with `<script>` tags to launch the client application) and API requests
- in development ASAP compiles client code with [esbuild][]
- in development ASAP compiles server code with [esbuild][], this allows to hot
  reload server code (on changes the bundle will be rebuilt and the next request
  will be served using newly built code)
- in production [esbuild][] is not used and built bundles are used instead
- on client there's `@mechanize/asap` library which provides suspense-enabled
  typesafe routing

[react]: http://reactjs.org
[tinyhttp]: https://tinyhttp.v1rtl.site
[esbuild]: https://esbuild.github.io
