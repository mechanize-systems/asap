import * as api from "@mechanize/asap/api";

export let settings = api.endpoint({
  handle: () => {
    return {
      theme: "dark",
    };
  },
});

export let hello = api.endpoint({
  method: "GET",
  path: "/hello/:name",
  handle: (params) => {
    return `Hello, ${params.name}`;
  },
});
