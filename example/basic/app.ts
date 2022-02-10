import * as ASAP from "@mechanize/asap";

export let routes = {
  index: ASAP.route("/", () => import("./hello")),
  hello: ASAP.route("/hello/:name", () => import("./hello")),
};

ASAP.boot(routes);
