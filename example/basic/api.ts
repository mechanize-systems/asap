import * as api from "@mechanize/asap/api";

export let routes = [
  api.route("GET", "/todo", (_req, res) => {
    res.send([{ id: 1 }]);
  }),
  api.route("GET", "/todo/:id", (req, res) => {
    res.send({ id: req.params.id });
  }),
  api.route("GET", "/error", (_req, _res) => {
    throw new Error("this is expected!");
  }),
];
