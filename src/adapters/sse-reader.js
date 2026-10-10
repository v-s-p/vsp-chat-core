// Minimal SSE frame reader: yields the joined `data:` payload of each event.
// Tolerates CRLF framing and frames/UTF-8 sequences split across chunks.
// Kept separate (rather than refactoring OpenAICompatibleAdapter's proven
// parser) so P2 cannot regress the validated P1 path.
export async function* readSseData(reader) {
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
    }
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) yield data;
    }
    if (done) return;
  }
}
