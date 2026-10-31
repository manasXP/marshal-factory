import { createInterface } from "node:readline";

// Terminal prompts for the setup scripts. From a pipe, each call reads the next line, so a script
// can also be driven with printf 'a\nb\n' | bun scripts/….

/** A pasted value that went on past a line break: half of a token that wrapped. */
export class WrappedPaste extends Error {
  constructor() {
    super("the pasted value has a line break in it; paste it as one line");
  }
}

let lines: AsyncIterator<string> | undefined;
async function nextLine() {
  lines ??= createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const { value, done } = await lines.next();
  if (done) throw new Error("stdin ended before every answer was given");
  return value;
}

/** One line of input, trimmed. */
export async function ask(question: string): Promise<string> {
  process.stderr.write(question);
  if (!process.stdin.isTTY) return (await nextLine()).trim();
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.once("line", (line) => {
      rl.close();
      resolve(line.trim());
    });
  });
}

/** One line of input without echo, for passwords and tokens. */
export async function askHidden(question: string): Promise<string> {
  process.stderr.write(question);
  const stdin = process.stdin;
  if (!stdin.isTTY) return nextLine();
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (data: Buffer) => {
      const chars = [...data.toString("utf8")];
      for (const [i, char] of chars.entries()) {
        if (char === "\r" || char === "\n" || char === "\u0003") {
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write("\n");
          if (char === "\u0003") reject(new Error("cancelled"));
          else if (chars.slice(i + 1).join("").trim()) reject(new WrappedPaste());
          else resolve(value);
          return;
        }
        if (char === "\u007f") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}
