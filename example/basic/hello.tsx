import * as React from "react";
import * as ASAP from "@mechanize/asap";

type HelloProps = { name?: string };

export default function Hello(props: HelloProps) {
  return (
    <div>
      <div>HELLO {props.name}</div>
      <ASAP.Link href="/hello/Andrey">HELLO ANDREY</ASAP.Link>
    </div>
  );
}
