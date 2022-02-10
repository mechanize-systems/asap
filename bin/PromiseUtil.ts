class NOTHING {}
const nothing = new NOTHING();

class Deferred<T> {
  promise: Promise<T>;
  error: Error | null;
  _value: T | NOTHING;
  _resolve: (value: T) => void;
  _reject: (err: Error) => void;

  constructor() {
    this._resolve = null as any;
    this._reject = null as any;
    this._value = nothing;
    this.error = null;
    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    }) as Promise<T>;
  }

  resolve = (value: T) => {
    if (this.isCompleted) throw new Error("promise already completed");
    this._value = value;
    this._resolve(value);
  };

  reject = (error: Error) => {
    if (this.isCompleted) throw new Error("promise already completed");
    this.error = error;
    this._reject(error);
  };

  get isResolved() {
    return this._value !== nothing;
  }

  get isRejected() {
    return this.error !== null;
  }

  get isCompleted() {
    return this.isResolved || this.isRejected;
  }

  get value() {
    if (this.isResolved) return this._value as T;
    if (this.isRejected) throw this.error;
    throw new Error("value is not yet available");
  }

  getOrSuspend(): T {
    if (this.isResolved) return this._value as T;
    if (this.isRejected) throw this.error;
    throw this.promise;
  }
}

export type { Deferred };

export function deferred<T>(): Deferred<T> {
  return new Deferred<T>();
}
