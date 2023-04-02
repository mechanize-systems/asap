import * as React from "react";

export default function Clock() {
  let [t, sett] = React.useState(new Date());
  React.useEffect(() => {
    let id = setInterval(() => sett(new Date()));
    return () => clearInterval(id);
  }, []);
  return <div>{String(t)}</div>;
}
