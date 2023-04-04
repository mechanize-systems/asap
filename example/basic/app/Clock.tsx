import * as React from "react";

export default function Clock({ addon }: { addon: JSX.Element }) {
  let [t, sett] = React.useState(new Date());
  React.useEffect(() => {
    let id = setInterval(() => sett(new Date()), 1000);
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
      {renderAddon && addon}
    </div>
  );
}
