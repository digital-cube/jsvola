import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useVola, VolaProvider } from "../src/index.js";

function Probe() {
  const client = useVola();
  void client.live();
  return null;
}

function ShowBase() {
  return <span data-testid="base">{useVola().baseUrl}</span>;
}

describe("VolaProvider", () => {
  it("hands the client to useVola()", () => {
    render(
      <VolaProvider baseUrl="http://localhost:8300/vola/">
        <ShowBase />
      </VolaProvider>,
    );
    expect(screen.getByTestId("base").textContent).toBe("http://localhost:8300/vola");
  });

  it("passes apiKey and fetch on to the client", async () => {
    let authorization: string | null = null;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as typeof fetch;
    render(
      <VolaProvider baseUrl="http://x/vola" apiKey="vola_test_k" fetch={fetchImpl}>
        <Probe />
      </VolaProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authorization).toBe("Bearer vola_test_k");
  });

  it("useVola() throws outside a provider", () => {
    expect(() => render(<ShowBase />)).toThrow(/inside <VolaProvider>/);
  });
});
