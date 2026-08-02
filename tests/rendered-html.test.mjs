import assert from "node:assert/strict";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("renders the NexaGift thesis prototype", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>NexaGift \| Explainable AI Fraud Security<\/title>/i);
  assert.match(html, /AI-Powered Gift Card Fraud Detection/);
  assert.match(html, /Customer Security Flow/);
  assert.match(html, /NexaGift Secure Portal/);
  assert.match(html, /Enter Secure Portal/);
  assert.match(html, /Detect • Explain • Protect/);
  assert.doesNotMatch(html, /codex-preview/i);
});

test("renders the complete customer and admin demo routes", async () => {
  const routeExpectations = [
    ["/login", /Login \/ Register/],
    ["/gift-cards", /Gift Card Selection/],
    ["/checkout", /AI Risk Check/],
    ["/otp", /OTP Verification/],
    ["/result", /Final Result \/ Status/],
    ["/admin", /Admin Login/],
    ["/admin/dashboard", /Admin Dashboard/],
    ["/admin/transactions", /Risky Transactions/],
    ["/admin/review", /Transaction Detail \/ Review/],
    ["/admin/audit", /Audit Log/],
  ];

  for (const [path, expectation] of routeExpectations) {
    const response = await render(path);
    assert.equal(response.status, 200, `${path} should render`);
    const html = await response.text();
    assert.match(html, expectation, `${path} should contain its page heading`);
    assert.doesNotMatch(html, /trained model prediction is unavailable/i);
  }
});
