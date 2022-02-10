import * as api from "@mechanize/asap/api";

export let routes = [
  api.route("GET", "/todo", () => "list todos!!"),
  api.route("GET", "/todo/:item", (_req, _res, { item }) => `todo: ${item}`),
];
