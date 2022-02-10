import * as ASAP from "@mechanize/asap";

export let routes = {
  index: ASAP.route("/", () => import("./IndexPage")),
  hello: ASAP.route("/hello/:name", () => import("./HelloPage")),
};

ASAP.boot(routes);
