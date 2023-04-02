import * as React from "react";
import { Time } from "../api";

export default function Clock({
  hey,
}: {
  hey: (params: { name: string }) => Promise<string>;
}) {
  let [t, sett] = React.useState(new Date());
  React.useEffect(() => {
    let id = setInterval(() => sett(new Date()));
    return () => clearInterval(id);
  }, []);
  let handleClick = async () => {
    console.log(await hey({ name: String(t) }));
  };
  return (
    <div>
      <p>{String(t)}</p>
      <Time />
      <button onClick={handleClick}>ok</button>
    </div>
  );
}
