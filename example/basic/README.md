# asap-example-basic

A basic example of using [asap][] to build a simple React app with server API.

The structure is the following:

- `app` directory hosts the entry point for the browser application, the
  `index.ts` exports page routes and boots the app.

      ├── app
      │   ├── HelloPage.tsx
      │   ├── IndexPage.tsx
      │   └── index.ts

- `api.ts` hosts the API for the application.

      ├── api.ts

- `package.json` contains project metadata and specifies dependencies' version
  constraints, `pnpm-lock.yaml` locks those constraints to specific versions so
  builds are reproducible between different machines

      ├── package.json
      ├── pnpm-lock.yaml

- `tsconfig.json` provides [TypeScript][] configuration.

      ├── tsconfig.json

- Finally `README.md` is the file you are reading!

      └── README.md

[asap]: https://github.com/mechanize-systems/asap
[typescript]: https://www.typescriptlang.org
[pnpm]: https://pnpm.io
