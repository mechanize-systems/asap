import * as api from "@mechanize/asap/api";

export let routes = [
  api.route("GET", "/todo", () => {
    return [{ id: "1" }];
  }),
  api.route("GET", "/todo/:id", (_req, _res, { id }) => {
    return { id };
  }),
];
