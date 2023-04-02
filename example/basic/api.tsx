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
        <Clock hey={hello} />
      </>
    );
  },
});

export let Time = api.component({
  params: {},
  async render() {
    return <div>current time: {String(new Date())}</div>;
  },
});

function SomethingElse() {
  return <div>SomethingElse</div>;
}
