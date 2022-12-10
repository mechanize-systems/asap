import { test, expect, Page } from "@playwright/test";
import * as Harness from "./harness";

test("development workflow", async ({ page, request }) => {
  let project = await createProject();

  let server = project.exec("asap", [
    "serve",
    "--env=development",
    "--port=7777",
  ]);
  await Harness.sleep(500);
  // App works
  {
    await page.goto("http://127.0.0.1:7777/");
    await expectPageContentToBe(page, "this is index");
  }
  // API should return 404
  {
    let resp = await request.get("http://127.0.0.1:7777/_api/");
    expect(resp.status()).toBe(404);
  }
  // Create api.js entry point and see it automatically discovered by ASAP
  {
    await project.writeFile(
      `api.js`,
      `
      import * as API from '@mechanize/asap/api';
      export let routes = [
        API.route('GET', '/', (req, res) => {
          res.send({hello: 'world'})
        })
      ]
      `
    );
    await Harness.sleep(500);
    let resp = await request.get("http://127.0.0.1:7777/_api/");
    expect(resp.status()).toBe(200);
    let body = await resp.body();
    expect(JSON.parse(body.toString())).toEqual({ hello: "world" });
  }
  // Remove api.js and observe 404 again
  {
    await project.unlink(`api.js`);
    await Harness.sleep(500);
    let resp = await request.get("http://127.0.0.1:7777/_api/");
    expect(resp.status()).toBe(404);
  }
  server.kill("SIGTERM");
  await project.dispose();
});

test("production workflow", async ({ page, request }) => {
  let project = await createProject();
  await project.exec("asap", ["build", "--env", "production"]);

  let server = project.exec("asap", [
    "serve",
    "--env=production",
    "--port=7777",
  ]);
  await Harness.sleep(500);
  // App works
  {
    await page.goto("http://127.0.0.1:7777/");
    await expectPageContentToBe(page, "this is index");
  }
  // API should return 404
  {
    let resp = await request.get("http://127.0.0.1:7777/_api/");
    expect(resp.status()).toBe(404);
  }
  server.kill("SIGTERM");
  await project.dispose();
});

async function expectPageContentToBe(page: Page, text: string) {
  let content = await page.waitForSelector(".PageContent");
  expect(await content.innerHTML()).toBe(text);
}

function createProject() {
  return Harness.createTestProject({
    files: {
      "app.js": `
        import * as React from 'react';
        import * as ASAP from '@mechanize/asap';

        export let routes = {
          index: ASAP.route('/', async () => ({default: Index})),
        }

        export let config = {routes}

        function Index() {
          return <div className="PageContent">this is index</div>;
        }
      `,
    },
  });
}
