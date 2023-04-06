import * as React from "react";
import * as Refine from "@recoiljs/refine";
import * as api from "@mechanize/asap/api";
import Clock from "./app/Clock";

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

export let App = api.component({
  params: {},
  async render() {
    return (
      <>
        <h1>Hello from server</h1>
        <SomethingElse />
        <Time />
        <Clock
          addon={
            <React.Suspense fallback={"LOADING"}>
              <api.RenderOnClient>
                <Addon children="OOOP" />
              </api.RenderOnClient>
            </React.Suspense>
          }
        />
      </>
    );
  },
});

export let Addon = api.component({
  params: { children: Refine.string() },
  async render(props) {
    await sleep(3000);
    return <p>HELLO! {props.children}</p>;
  },
});

export let Time = api.component({
  params: {},
  async render() {
    return <div>current time: {String(new Date())}</div>;
  },
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function SomethingElse() {
  return <div>SomethingElse</div>;
}
