import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

// FOX-9819: an empty-body 401 carries its status only in the error's `.code`,
// so a catch site that classified by message text alone read an expired
// sign-in as a transport error. Catch sites classify the caught value itself
// with isAuthLikeError (name, numeric 401, message, other thrown values); only
// the vocabulary module and the authorize probe's message contract may use the
// message-only form.
const SRC = path.resolve(__dirname, "../src");
const MESSAGE_ONLY_ALLOWED = new Set([
  path.join("auth", "authLikeVocabulary.ts"),
  path.join("auth", "authorizeProbe.ts"),
]);

/** Why this source classifies by message text alone, or null. */
function messageOnlyClassification(source: string): string | null {
  // Any reference at all, so an aliased import or a re-export counts too.
  if (/\bisAuthLikeErrorMessage(Text)?\b/.test(source)) return "uses the message-only helper";
  // The error-object helper handed only the message drops `.code` and the name.
  if (/\bisAuthLikeError\s*\([^;{}\n]*?\.message\s*\)/.test(source)) return "passes only .message to isAuthLikeError";
  return null;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
  });
}

describe("auth-like classification at catch sites", () => {
  it("no source file classifies a caught failure by message text alone", () => {
    const offenders = sourceFiles(SRC)
      .map((file) => path.relative(SRC, file))
      .filter((rel) => !MESSAGE_ONLY_ALLOWED.has(rel))
      .flatMap((rel) => {
        const why = messageOnlyClassification(fs.readFileSync(path.join(SRC, rel), "utf8"));
        return why ? [`${rel}: ${why}`] : [];
      });
    expect(offenders).toEqual([]);
  });

  it.each([
    ["a direct call", "if (isAuthLikeErrorMessageText(msg)) {}"],
    ["an aliased import", 'import { isAuthLikeErrorMessageText as messageAuth } from "../auth/authLikeVocabulary.js";'],
    ["a re-export", "export { isAuthLikeErrorMessageText };"],
    ["a private wrapper", "private isAuthLikeErrorMessage(message: string) {}"],
    ["the message handed to the error helper", "if (isAuthLikeError(error.message)) {}"],
    ["a cast message handed to the error helper", "if (isAuthLikeError((error as Error).message)) {}"],
  ])("catches %s", (_label, source) => {
    expect(messageOnlyClassification(source)).not.toBeNull();
  });

  it("allows classifying the caught value itself", () => {
    expect(messageOnlyClassification("if (isAuthLikeError(error) || isAuthLikeError(fallbackError)) {}")).toBeNull();
  });
});
