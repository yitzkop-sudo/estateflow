const { spawn } = require("node:child_process");

async function main() {
  // Demonstrate MCP Filesystem server capability with a single read-only tool.
  // Tool used: list_allowed_directories
  const serverName = "github.com/modelcontextprotocol/servers/tree/main/src/filesystem";

  // Must be an allowed directory for the filesystem server.
  const allowedDir = "c:/Users/Ez/EstateFlow";

  // Run the locally installed filesystem MCP server directly (avoid `npx`, which is not on PATH).
  // Expected CLI entrypoint (CJS) from the package:
  // node node_modules/@modelcontextprotocol/server-filesystem/dist/cli.js stdio <roots...?>
  const serverCliPath =
    "node_modules/@modelcontextprotocol/server-filesystem/dist/cli.js";

  // Server expects either:
  //   cli.js <dir1> <dir2> ...   (allowed dirs)
  // and internally starts with stdio transport.
  // We pass the allowed directory and the server will use stdio by default.
  const child = spawn(
    "node",
    [serverCliPath, allowedDir],
    { stdio: ["pipe", "pipe", "pipe"], env: process.env }
  );

  child.stderr.on("data", (d) => {
    process.stderr.write(`[${serverName} stderr] ${d.toString()}`);
  });

  const { Client } = require("@modelcontextprotocol/sdk/client");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio");

  const transport = new StdioClientTransport(child.stdin, child.stdout);
  const client = new Client(transport, { name: serverName });

  await client.connect();

  // Capability proof: fetch allowed directories.
  const res = await client.tools.call({
    name: "list_allowed_directories",
    arguments: {},
  });

  console.log("list_allowed_directories result:\n", JSON.stringify(res, null, 2));

  // Optional proof: directory_tree on the allowed root (may be large).
  const treeRes = await client.tools.call({
    name: "directory_tree",
    arguments: {
      path: allowedDir,
      excludePatterns: [],
    },
  });

  const treeText =
    typeof treeRes === "string" ? treeRes : JSON.stringify(treeRes, null, 2);

  console.log("directory_tree (first 800 chars):\n", treeText.slice(0, 800));

  await client.close();
  child.kill();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
