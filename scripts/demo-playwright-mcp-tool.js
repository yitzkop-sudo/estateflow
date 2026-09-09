const { spawn } = require("node:child_process");

async function main() {
  // We intentionally invoke the MCP server using the same stdio config as blackbox_mcp_settings.json.
  // Then we call a single Playwright MCP tool to demonstrate capability.
  //
  // Tool: browser_navigate
  // Follow-up tool: browser_snapshot (returns accessibility snapshot)
  //
  // Note: This script requires @modelcontextprotocol/sdk to be available.
  // If it's missing, run: npm i -D @modelcontextprotocol/sdk
  // Use installed MCP SDK. Import the concrete CJS entrypoints from the installed dist.
  const { Client } = require("@modelcontextprotocol/sdk/client");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio");

  const serverName = "github.com/microsoft/playwright-mcp";

  const child = spawn("npx", ["-y", "@playwright/mcp@latest"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  child.stderr.on("data", (d) => {
    // MCP client typically ignores stderr; we still surface it for debugging.
    process.stderr.write(`[${serverName} stderr] ${d.toString()}`);
  });

  const transport = new StdioClientTransport(child.stdin, child.stdout);
  const client = new Client(
    transport,
    {
      name: serverName,
    }
  );

  await client.connect();

  // Ask the server to list tools (capabilities proof).
  const tools = await client.tools.list();
  console.log("Playwright MCP tools available (count):", tools.tools.length);

  const navigateResult = await client.tools.call({
    name: "browser_navigate",
    arguments: {
      url: "https://example.com",
    },
  });

  console.log("browser_navigate result:", navigateResult);

  const snapshotResult = await client.tools.call({
    name: "browser_snapshot",
    arguments: {
      // return the snapshot text (no filename)
      depth: 4,
      boxes: false,
    },
  });

  // The snapshot can be large; print a small portion.
  const snapshotText = snapshotResult?.snapshot ?? snapshotResult?.data ?? snapshotResult;
  const asString = typeof snapshotText === "string" ? snapshotText : JSON.stringify(snapshotText, null, 2);
  console.log("browser_snapshot (first 600 chars):\n", asString.slice(0, 600));

  await client.close();
  child.kill();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
