/* Splits a newline-delimited JSON stream into messages.

   Only complete lines are parsed; the trailing partial line waits for the
   next chunk. Parsing the whole buffer and retrying it on failure (the old
   approach) handled every line before a split line twice, which a text
   delta event can't tolerate. */
export const createNdjsonParser = (onMessage: (msg: any) => void) => {
  let buffer = '';

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      console.warn('Skipping malformed stream line');
      return;
    }
    onMessage(msg);
  };

  return {
    push(text: string) {
      buffer += text;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleLine(line);
        newline = buffer.indexOf('\n');
      }
    },
    flush() {
      const rest = buffer;
      buffer = '';
      handleLine(rest);
    },
  };
};

/* Reads an NDJSON response body to the end, calling onMessage per line. */
export const readNdjsonStream = async (
  body: ReadableStream<Uint8Array>,
  onMessage: (msg: any) => void,
) => {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = createNdjsonParser(onMessage);

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }

  parser.push(decoder.decode());
  parser.flush();
};
