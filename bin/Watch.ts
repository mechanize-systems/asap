/**
 * Watch service.
 *
 * This is based on watchman package.
 */

import * as Watchman from "fb-watchman";
import { deferred, Deferred } from "./PromiseUtil";
import debug from "debug";

let log = debug("asap:Watch");

export class Watch {
  _ready: Deferred<any>;
  _client: Watchman.Client;

  constructor() {
    this._ready = deferred();
    this._client = new Watchman.Client();
    this._client.capabilityCheck(
      { optional: [], required: [] },
      (err, resp) => {
        if (err) this._ready.reject(err);
        else this._ready.resolve(resp);
      }
    );
  }

  stop() {
    this._client.end();
  }

  /**
   * Query for the current logical clock value.
   */
  async clock(path: string): Promise<number> {
    log("clock");
    await this._ready.promise;
    let def = deferred<number>();
    this._client.command(["clock", path], (err, resp) => {
      if (err != null) def.reject(err);
      else {
        log("clock %s", resp.clock);
        def.resolve(resp.clock as number);
      }
    });
    return def.promise;
  }

  /**
   * Subscribe for changes at the `path` root.
   */
  async subscribe(
    spec: { path: string; since?: number | null | undefined },
    onChange: (resp: any) => void
  ) {
    await this._ready.promise;
    let sub = {
      expression: [
        "anyof",
        ["match", "*.js"],
        ["match", "*.ts"],
        ["match", "*.tsx"],
        ["match", "*.css"],
      ],
      fields: ["name", "size", "mtime_ms", "exists", "type"],
      since: spec.since,
    };
    let def = deferred();
    log("subscribe");
    this._client.command(
      ["subscribe", spec.path, spec.path, sub],
      (err, resp) => {
        if (err) def.reject(err);
        else def.resolve(resp);
      }
    );
    this._client.on("subscription", (resp) => {
      log("changes detected");
      if (resp.subscription !== spec.path) return;
      onChange(resp);
    });
    return def.promise.then(() => () => {
      this._client.command(["unsubscribe", spec.path, spec.path], (err) => {
        log("unsubscribe");
        console.error(err);
      });
    });
  }
}
