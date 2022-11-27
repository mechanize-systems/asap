import * as ASAP from "@mechanize/asap";
import * as api from "api";
import { routes } from "./index";
import usePromise from "./usePromise";

let helloP = api.hello({ greeting: "Hola", name: "World" });

type HelloPageProps = {
  name: string;
};

export default function HelloPage(props: HelloPageProps) {
  let hello = usePromise(helloP);
  return (
    <div>
      <div>
        {props.name}: {hello}
      </div>
      <ASAP.Link route={routes.index} params={{}}>
        Back to /
      </ASAP.Link>
    </div>
  );
}
