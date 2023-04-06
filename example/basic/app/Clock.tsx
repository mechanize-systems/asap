import * as React from "react";

export default function Clock({ addon }: { addon: JSX.Element }) {
  let [t, sett] = React.useState("OK");
  React.useEffect(() => {
    let id = setInterval(() => sett(String(new Date())), 1000);
    return () => clearInterval(id);
  }, []);
  let [renderAddon, setRenderAddon] = React.useState(false);
  let handleClick = async () => {
    setRenderAddon(true);
  };
  return (
    <div>
      {String(t)}
      <button onClick={handleClick}>ok</button>
      {addon}
      {renderAddon && addon}
    </div>
  );
}
