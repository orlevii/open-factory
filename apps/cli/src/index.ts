import { run } from "./commands.ts";
import { ask, askHidden, closePrompt } from "./prompt.ts";

const code = await run(process.argv.slice(2), {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
  ask,
  askHidden,
  env: process.env,
  fetch,
});
closePrompt();
process.exit(code);
