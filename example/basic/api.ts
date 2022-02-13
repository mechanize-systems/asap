import * as api from "@mechanize/asap/api";

export let routes = [
  api.route("GET", "/todo", (_req, res) => {
    res.write(JSON.stringify([{ id: "1" }]));
    res.end();
  }),
  api.route("GET", "/todo/:id", (req, res) => {
    res.write(JSON.stringify({ id: req.params.id }));
    res.end();
  }),
  api.route("GET", "/error", (_req, _res) => {
    throw new Error("this is expected!");
  }),
];
