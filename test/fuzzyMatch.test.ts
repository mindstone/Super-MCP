import { describe, expect, it } from "vitest";
import { findBestMatch } from "../src/utils/fuzzyMatch.js";

describe("findBestMatch", () => {
  it.each([
    ["thread_ts", ["ts"], "ts"],
    ["fromDate", ["fromDateTime"], "fromDateTime"],
    ["max_results", ["max_messages"], "max_messages"],
    ["task_gid", ["task_id"], "task_id"],
    ["user_id", ["user"], "user"],
    ["qurey", ["query"], "query"],
    ["reminder", ["reminders"], "reminders"],
    ["zzzzz", ["query"], null],
    ["limit", ["id"], null],
    ["thread_id", ["message_id"], null],
  ] as const)("suggests %s from %j as %s", (unknown, fields, expected) => {
    expect(findBestMatch(unknown, [...fields])).toBe(expected);
  });

  it.each([
    ["user_id", ["user", "userId", "user-id"], "user-id"],
    ["USER-ID", ["userId", "user_id"], "userId"],
    ["thread_ts", ["thread_id", "ts"], "ts"],
    ["fromDate", ["fromAddress", "fromDateTime"], "fromDateTime"],
    ["from-date", ["from_date_time"], "from_date_time"],
    ["HTTPServer", ["http_server_url"], "http_server_url"],
    ["max_results", ["maxresultz", "max_messages"], "max_messages"],
    ["date_from", ["from_date", "dateFromTime"], "from_date"],
    ["max_time", ["time_max", "time_min"], "time_max"],
    ["date_from", ["dateFrom", "date-from", "from_date"], "date-from"],
    ["max_result", ["max_results", "limit", "max_messages"], "max_results"],
    ["email_adress", ["email_address", "email"], "email_address"],
    ["page_tokens", ["page_token", "page_size"], "page_token"],
    ["phone_numbr", ["phone_number", "phone_type"], "phone_number"],
    ["ts", ["to", "thread_ts"], "thread_ts"],
    ["user_id", ["userId", "user-id", "user"], "user-id"],
    ["thread", ["thread_id", "threadId", "thread-id"], "thread-id"],
    ["include", ["include_private", "includePrivate"], "includePrivate"],
    ["qurey", ["queries", "query"], "query"],
  ] as const)("ranks candidates for %s independently of order", (unknown, fields, expected) => {
    expect(findBestMatch(unknown, [...fields])).toBe(expected);
    expect(findBestMatch(unknown, [...fields].reverse())).toBe(expected);
  });

  it.each([
    ["user", ["user_id", "user_name", "usre"]],
    ["max_results", ["max_messages", "max_items"]],
    ["cat", ["bat", "hat"]],
    ["title", ["titles", "titled"]],
    ["thread", ["thread_id", "threadId", "thread_ts"]],
  ] as const)("withholds tied suggestions for %s in either order", (unknown, fields) => {
    expect(findBestMatch(unknown, [...fields])).toBeNull();
    expect(findBestMatch(unknown, [...fields].reverse())).toBeNull();
  });

  it.each([
    ["a", ["b"]],
    ["ab", ["cd"]],
    ["id", ["limit"]],
    ["abcde", ["vwxyz"]],
    ["", ["query"]],
    ["query", []],
    ["thread_ids", ["message_ids"]],
    ["title", ["time"]],
    ["date", ["name"]],
    ["type", ["time"]],
    ["abcde", ["abxyz"]],
    ["abcd", ["abxy"]],
  ] as const)("rejects unrelated or empty names for %s", (unknown, fields) => {
    expect(findBestMatch(unknown, [...fields])).toBeNull();
  });

  it("keeps the distance cap of three when the names are long enough", () => {
    expect(findBestMatch("abcdefgh", ["abcdeXYZ"])).toBe("abcdeXYZ");
    expect(findBestMatch("abcdefghij", ["abcdefWXYZ"])).toBeNull();
  });
});
