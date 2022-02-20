import { test, expect, Page } from "@playwright/test";
import * as Harness from "./harness";

test("development workflow", async ({ page }) => {
  let project = await createProject();

  let server = project.exec("asap", [
    "serve",
    "--env=development",
    "--port=7777",
  ]);
  await Harness.sleep(500); // TODO: get rid of this by checking stdout logging?
  await runTestScenario(page);

  // Check that server rebuilds the bundle on changes
  {
    await page.goto("http://127.0.0.1:7777/");
    await expectPageContentToBe(page, "this is index");
    await project.writeFile(
      "IndexPage.js",
      `
        import * as React from 'react';
        import * as ASAP from '@mechanize/asap';

        export default function IndexPage() {
          return <div>
            <div className="PageContent">CHANGED!</div>
          </div>
        }
      `
    );
    await Harness.sleep(500); // TODO: get rid of this by checking stdout logging?
    await page.goto("http://127.0.0.1:7777/");
    await expectPageContentToBe(page, "CHANGED!");
  }

  server.kill("SIGTERM");
  await project.dispose();
});

test("production workflow", async ({ page }) => {
  let project = await createProject();
  await project.exec("asap", ["build", "--env", "production"]);

  let server = project.exec("asap", [
    "serve",
    "--env=production",
    "--port=7777",
  ]);
  await Harness.sleep(500); // TODO: get rid of this by checking stdout logging?
  await runTestScenario(page);
  server.kill("SIGTERM");
  await project.dispose();
});

async function runTestScenario(page: Page) {
  // Check that `index` page is rendering.
  {
    await page.goto("http://127.0.0.1:7777/");
    await expectPageContentToBe(page, "this is index");
  }

  // Check that `hello` page is rendering.
  {
    await page.goto("http://127.0.0.1:7777/hello/world");
    await expectPageContentToBe(page, "this is hello: name=world");
  }

  // Test that navigation with links is working.
  {
    // Open `index` page
    await page.goto("http://127.0.0.1:7777/");
    await expectPageContentToBe(page, "this is index");
    // Now navigate to `hello` page
    page.locator(".Link").click();
    await page.waitForNavigation();
    expect(page.url()).toBe("http://127.0.0.1:7777/hello/world");
    await expectPageContentToBe(page, "this is hello: name=world");
    // Press Back button
    page.goBack();
    await page.waitForNavigation();
    expect(page.url()).toBe("http://127.0.0.1:7777/");
    await expectPageContentToBe(page, "this is index");
  }
}

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
          index: ASAP.route('/', () => import("./IndexPage")),
          hello: ASAP.route('/hello/:name', async () => ({default: Hello})),
        }

        function Hello({name}) {
          return <div>
            <div className="PageContent">this is hello: name={name}</div>
            <ASAP.Link
              className="Link"
              route={routes.index}
              params={{}}>
              INDEX
            </ASAP.Link>
          </div>
        }

        ASAP.boot({routes});
      `,
      "IndexPage.js": `
        import * as React from 'react';
        import * as ASAP from '@mechanize/asap';
        import {routes} from './app';

        export default function IndexPage() {
          return <div>
            <div className="PageContent">this is index</div>
            <ASAP.Link 
              className="Link"
              route={routes.hello}
              params={{name: 'world'}}>
              HELLO
            </ASAP.Link>
          </div>
        }
      `,
      "api.js": `
        import * as api from "@mechanize/asap/api";

        export let routes = [
          api.route("GET", "/todo", (req, res) => {
            res.send([{ id: "1" }]);
          }),
          api.route("GET", "/todo/:id", (req, res) => {
            res.send({ id: req.params.id });
          }),
        ];
      `,
    },
  });
}
