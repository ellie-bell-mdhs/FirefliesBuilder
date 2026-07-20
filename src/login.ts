/**
 * One-time calendar login (device-code). Run during setup:
 *
 *   npm run login
 *
 * Prints a URL + code; sign in, and the token is cached to .tokens/ so the
 * background app can refresh silently from then on.
 */
import { makeLogger } from "./logger.js";
import { GraphCalendar } from "./calendar/graph.js";

const log = makeLogger("login");

async function main() {
  const cal = new GraphCalendar(); // throws if MS_CLIENT_ID is unset
  await cal.signIn((message) => console.log("\n" + message + "\n"));
  log.info("signed in — token cached to .tokens/. You can close this and start the app.");
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
