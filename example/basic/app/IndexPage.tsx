import * as React from "react";
import * as ASAP from "@mechanize/asap";

type IndexPageProps = {};

export default function IndexPage(_props: IndexPageProps) {
  return (
    <div>
      <div>Welcome!</div>
      <ASAP.Link href="/hello/Andrey">Say hello!</ASAP.Link>
    </div>
  );
}
