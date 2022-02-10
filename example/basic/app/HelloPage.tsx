import * as React from "react";
import * as ASAP from "@mechanize/asap";
import { routes } from "./index";

type HelloPageProps = {
  name: string;
};

export default function HelloPage(props: HelloPageProps) {
  return (
    <div>
      <div>HELLO {props.name}</div>
      <ASAP.Link href={ASAP.href(routes.index)}>Back to /</ASAP.Link>
    </div>
  );
}
