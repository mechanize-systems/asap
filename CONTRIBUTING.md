# CONTRIBUTING

Make sure you have the following software installed:

1. Node.js
2. pnpm
3. watchman

Clone the repo:

    git clone ...

Install dependencies:

    pnpm install

Run the build:

    make check build

Define the following environment variables:

    export PROJECT__ROOT="$PWD"
    export PATH="$PROJECT__ROOT/.bin:$PATH"

Now you have `asap` executable available which rebuilds the `bin/` source code
on each invocation:

    asap --help

To typecheck the project:

    make check

We use [debug][] npm package for debig logs, enable it by setting `DEBUG`
environment variable:

    DEBUG='asap:*' asap

## Code Organization

The `bin` directory hosts the `asap` executable code with `main.ts` being the
entry point (this is the module which is being run when you invoke `asap`):

    bin
    ├── Build.ts
    ├── main.ts
    ├── PromiseUtil.ts
    ├── RouteSet.ts
    ├── types.ts
    └── Watch.ts

The `src` directory hosts the `asap` library which exposes applicaton api:

    src
    ├── index.tsx
    ├── api.ts
    ├── Router.ts
    └── Routing.ts

There are three main entry points to the asap:

- `bin/main.ts` provides `asap` executable
- `src/index.ts` provides `@mechanize/asap` client side application library
- `src/api.ts` provides `@mechanize/asap/api` server side API library
