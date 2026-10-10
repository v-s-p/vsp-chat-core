import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const EXAMPLE_PERSONA = join(__dirname, '..', '..', 'personas', 'example.md');

// A persona is plain instruction text in a file. Private personas (e.g. the
// owner's own) should live OUTSIDE this repository and be pointed to with
// --persona <file> or CHAT_CORE_PERSONA_FILE; only the neutral example ships.
//
// Read on every turn so edits to the file apply without a restart. Returned
// as a `system` message for the provider only — it is never stored in the
// conversation, so switching persona doesn't rewrite history.
export async function loadPersona(path = EXAMPLE_PERSONA) {
  const text = (await readFile(path, 'utf8')).trim();
  if (!text) return null;
  return { name: basename(path).replace(/\.[^.]+$/, ''), message: { role: 'system', content: text } };
}
