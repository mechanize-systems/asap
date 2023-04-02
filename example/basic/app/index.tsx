import "./index.css";
import * as React from "react";
import * as ASAP from "@mechanize/asap";
import { App } from "../api";

export let routes = {
  about: ASAP.route("/about", async () => {
    return { default: App };
  }),
  index: ASAP.route("/", async () => {
    return import("./IndexPage");
  }),
  hello: ASAP.route("/hello/:name", async () => {
    await randomSleep();
    return import("./HelloPage");
  }),
};

function randomSleep() {
  return new Promise((resolve) => setTimeout(resolve, Math.random() * 3000));
}

function AppChrome(props: ASAP.AppChromeProps) {
  return (
    <body>
      <React.Suspense fallback={<props.AppLoading />}>
        {props.isNavigating && (
          <div className="LoadingIndicator">Loading...</div>
        )}
        {props.children}
      </React.Suspense>
    </body>
  );
}

export let config: ASAP.AppConfig = { routes, AppChrome };
