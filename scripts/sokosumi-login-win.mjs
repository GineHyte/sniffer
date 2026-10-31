// Preload for `sokosumi auth login` on Windows (Sokosumi CLI 1.0.4). The CLI opens the browser with
// `cmd /c start "" <url>`, and cmd cuts the URL at the first `&`, so Sokosumi answers "response_type is required".
// This swaps that one call for rundll32, which keeps the full URL, and prints the URL as a fallback.
// Usage: see README.md, "Windows notes".
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const original = cp.spawn;

cp.spawn = function patchedSpawn(command, args, options) {
  if (command === 'cmd' && Array.isArray(args) && args[0] === '/c' && args[1] === 'start') {
    const url = args[args.length - 1];
    process.stderr.write(`\nLogin URL (paste into the browser if it does not open):\n${url}\n\n`);
    return original.call(this, 'rundll32', ['url.dll,FileProtocolHandler', url], options);
  }
  return original.apply(this, arguments);
};
syncBuiltinESMExports();
