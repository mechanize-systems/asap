import "./index.css";
import * as React from "react";
import * as ASAP from "@mechanize/asap";

export let routes = {
  index: ASAP.route("/", async () => {
    await randomSleep();
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
    <React.Suspense fallback={<props.AppLoading />}>
      {props.isNavigating && (
        <div className="LoadingIndicator">Loading...</div>
      )}
      {props.children}
    </React.Suspense>
  );
}

ASAP.boot({ routes, AppChrome });
