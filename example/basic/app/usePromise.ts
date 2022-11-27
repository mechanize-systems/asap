let cache: WeakMap<
  Promise<unknown>,
  { promise: Promise<unknown>; value?: unknown; error?: Error }
> = new WeakMap();

export default function usePromise<P>(promise: Promise<P>): P {
  let record = cache.get(promise);
  if (record == null) {
    let promise1 = promise.then(
      (value) => {
        cache.set(promise, { promise: promise1, value });
        return value;
      },
      (error: Error) => {
        cache.set(promise, { promise: promise1, error });
        throw error;
      }
    );
    record = { promise: promise1 };
    cache.set(promise, record);
  }
  if ("value" in record) {
    return record.value as P;
  } else if ("error" in record) {
    throw record.error;
  } else {
    throw record.promise;
  }
}
