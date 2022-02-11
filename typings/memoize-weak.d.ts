declare module "memoize-weak" {
  export default function memoize<F extends Function>(f: F): F;
}
