# asap

Application server for React Single Page Applications.

## Motivation

Next.js and others are great but they favor use case of landing pages and
ecommerce websites, providing them with SSR, "on the edge" deployment etc.

These are all great features but we don't always need such complexity if all we
want to implement is a simple React app and few API routes along.

Therefore there's asap which:

- ... is a simple application server built on top of fastify, esbuild and React
- ... strives to enable fast iterations in development
- ... and get out of your way in production

## Getting Started

Install:

```
$ pnpm install -g @mechanize/asap
```
