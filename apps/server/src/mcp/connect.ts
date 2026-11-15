/**
 * StreamerAI Agent Connector. Started as the signed-in person through a
 * `streamerai-agent://connect?...` link (registered by Windows setup) or a
 * command copied from StreamerAI Settings:
 *
 *   node dist/mcp/connect.js "streamerai-agent://connect?server=...&ticket=..."
 */
import { connectAgentHosts } from "./mcp-connector.js";

const args = process.argv.slice(2);
const link = args.find((value) => !value.startsWith("--")) ?? "";
const wait = !args.includes("--no-wait") && process.stdout.isTTY;

process.stdout.write("StreamerAI Agent Connector\n\n");
const outcome = await connectAgentHosts({
  link,
  log: (line) => process.stdout.write(`${line}\n`),
});
if (outcome.message) process.stdout.write(`\n${outcome.message}\n`);
else if (outcome.ok)
  process.stdout.write(
    "\nDone. Restart the connected agents (or start a new session) to load StreamerAI. You can close this window.\n",
  );
else
  process.stdout.write(
    "\nNothing was connected. Install Claude Code, Codex, Claude Desktop or Cursor, then try again.\n",
  );
process.exitCode = outcome.ok ? 0 : 1;
// A link-started console window closes with the process; keep the result readable.
if (wait) await new Promise((resolve) => setTimeout(resolve, 10_000));
