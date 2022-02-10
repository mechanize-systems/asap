import * as React from "react";
import * as ASAP from "@mechanize/asap";

type HelloPageProps = {
  name: string;
};

export default function HelloPage(props: HelloPageProps) {
  return (
    <div>
      <div>HELLO {props.name}</div>
      <ASAP.Link href="/">Back to /</ASAP.Link>
    </div>
  );
}
