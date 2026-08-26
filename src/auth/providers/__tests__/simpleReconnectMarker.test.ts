import { beforeEach, describe, expect, it, vi } from "vitest";

import { SimpleOAuthProvider } from "../simple.js";

const { access, unlink, mockLogger } = vi.hoisted(() => ({
  access: vi.fn(),
  unlink: vi.fn(),
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("fs/promises", () => ({
  access,
  unlink,
}));

vi.mock("../../../logging.js", () => ({
  getLogger: () => mockLogger,
}));

const PACKAGE_ID = "remote-connector-test";

function errno(code: string, message = "sensitive filesystem detail"): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe("SimpleOAuthProvider reconnect marker lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("readNeedsReconnectMarkerState", () => {
    it("returns present when the marker can be accessed", async () => {
      access.mockResolvedValue(undefined);

      await expect(
        SimpleOAuthProvider.readNeedsReconnectMarkerState(PACKAGE_ID),
      ).resolves.toEqual({ state: "present" });
    });

    it("returns absent only for ENOENT", async () => {
      access.mockRejectedValue(errno("ENOENT"));

      await expect(
        SimpleOAuthProvider.readNeedsReconnectMarkerState(PACKAGE_ID),
      ).resolves.toEqual({ state: "absent" });
    });

    it("returns read-error with errno for any other failure", async () => {
      access.mockRejectedValue(errno("EACCES"));

      await expect(
        SimpleOAuthProvider.readNeedsReconnectMarkerState(PACKAGE_ID),
      ).resolves.toEqual({ state: "read-error", code: "EACCES" });
    });
  });

  describe("clearNeedsReconnectMarker", () => {
    it("uses one unlink and emits no warning on success", async () => {
      unlink.mockResolvedValue(undefined);
      const provider = new SimpleOAuthProvider(PACKAGE_ID);

      await provider.clearNeedsReconnectMarker();

      expect(access).not.toHaveBeenCalled();
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("treats ENOENT as quiet success", async () => {
      unlink.mockRejectedValue(errno("ENOENT"));
      const provider = new SimpleOAuthProvider(PACKAGE_ID);

      await provider.clearNeedsReconnectMarker();

      expect(access).not.toHaveBeenCalled();
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("warns with exactly the errno code for other unlink failures", async () => {
      unlink.mockRejectedValue(errno("EACCES"));
      const provider = new SimpleOAuthProvider(PACKAGE_ID);

      await provider.clearNeedsReconnectMarker();

      expect(access).not.toHaveBeenCalled();
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Could not remove needsReconnect marker",
        { code: "EACCES" },
      );
    });
  });
});
