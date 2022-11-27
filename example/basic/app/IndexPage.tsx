import * as ASAP from "@mechanize/asap";
import { routes } from "./index";

type IndexPageProps = {};

export default function IndexPage(_props: IndexPageProps) {
  return (
    <div>
      <div>Welcome!</div>
      <ASAP.Link route={routes.hello} params={{ name: "message" }}>
        Say hello!
      </ASAP.Link>
    </div>
  );
}
