/**
 * Diagnostic: check that FIREFLIES_API_KEY works and the queries the bot depends
 * on return the expected shapes.
 *
 *   npm run verify:fireflies
 */
import { makeLogger } from "./logger.js";
import { FirefliesClient } from "./fireflies/client.js";

const log = makeLogger("verify");

async function main() {
  const ff = new FirefliesClient();

  log.info("1/3 listTranscripts(3) ...");
  const list = await ff.listTranscripts(3);
  log.info(`  ok — ${list.length} transcript(s)`);
  list.forEach((t) => log.info(`    - ${t.id}  "${t.title ?? ""}"`));

  if (list.length) {
    log.info(`2/3 getTranscript(${list[0].id}) ...`);
    const t = await ff.getTranscript(list[0].id);
    log.info(`  ok — is_live=${t.is_live}, ${t.sentences.length} sentence(s)`);
    if (t.sentences[0]) {
      const s = t.sentences[0];
      log.info(`    first: ${s.speaker_name ?? "?"}: ${s.text.slice(0, 60)}`);
    }
  } else {
    log.warn("2/3 skipped — no transcripts to fetch");
  }

  log.info("3/3 active_meetings ...");
  const active = await ff.getActiveMeetings();
  log.info(`  ok — ${active.length} active meeting(s) right now`);
  active.forEach((m) => log.info(`    - ${m.id}  "${m.title ?? ""}"  state=${m.state}`));

  log.info("Fireflies API OK.");
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
