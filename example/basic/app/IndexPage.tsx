import * as React from "react";
import * as ASAP from "@mechanize/asap";
import { routes } from "./index";

type IndexPageProps = {};

export default function IndexPage(_props: IndexPageProps) {
  return (
    <div>
      <div>Welcome!</div>
      <ASAP.Link href={ASAP.href(routes.hello, { name: "World" })}>
        Say hello!
      </ASAP.Link>
    </div>
  );
}
