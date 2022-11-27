import * as api from "@mechanize/asap/api";
import * as Refine from "@recoiljs/refine";

export let settings = api.endpoint({
  handle: () => {
    return {
      theme: "dark",
    };
  },
});

export let hello = api.endpoint({
  method: "POST",
  path: "/hello/:greeting",
  body: {
    name: Refine.string(),
  },
  handle: (params) => {
    return `${params.greeting}, ${params.name}`;
  },
});
