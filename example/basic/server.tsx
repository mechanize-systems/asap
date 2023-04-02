export async function App({}) {
  return (
    <>
      <h1>Hello from server</h1>
      <pre>PATH: {process.env.PATH}</pre>
      <pre>MAN_PATH: {process.env.MANPATH}</pre>
    </>
  );
}
