import { describe, expect, it } from "vitest";

import {
  isLocalDevelopmentHostname,
  isLocalDevelopmentServerUrl,
  isLoopbackHostname,
  isReservedIpAddress,
} from "#shared/network-address.js";

describe("isLoopbackHostname", () => {
  it("accepts the IPv4 loopback block, IPv6 loopback, and the localhost namespace", () => {
    for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
      expect(isLoopbackHostname(host), host).toBe(true);
    }
  });

  it("rejects wildcard binds, public hosts, and non-loopback IPs", () => {
    for (const host of ["0.0.0.0", "::", "8.8.8.8", "example.com", "10.0.0.1"]) {
      expect(isLoopbackHostname(host), host).toBe(false);
    }
  });
});

describe("isLocalDevelopmentHostname", () => {
  it("accepts the exact local development hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]) {
      expect(isLocalDevelopmentHostname(host), host).toBe(true);
    }
  });

  it("rejects hosts outside the exact set, including broader loopback forms", () => {
    // Deliberately narrower than isLoopbackHostname: a 127.0.0.0/8 address or a
    // *.localhost name could resolve off-box, so it must not be a credential or
    // reuse target.
    for (const host of ["127.1.2.3", "app.localhost", "example.com", "10.0.0.1", "::"]) {
      expect(isLocalDevelopmentHostname(host), host).toBe(false);
    }
  });
});

describe("isLocalDevelopmentServerUrl", () => {
  it("accepts http(s) URLs on the exact local development hosts", () => {
    for (const url of [
      "http://localhost:2000/",
      "http://127.0.0.1:3000",
      "http://0.0.0.0:2000/",
      "https://[::1]:8080/x",
    ]) {
      expect(isLocalDevelopmentServerUrl(url), url).toBe(true);
    }
  });

  it("rejects broader loopback hosts, remote hosts, and junk", () => {
    for (const url of [
      "http://127.1.2.3:2000/",
      "http://app.localhost/",
      "http://evil.example/",
      "nope",
    ]) {
      expect(isLocalDevelopmentServerUrl(url), url).toBe(false);
    }
  });
});

describe("isReservedIpAddress", () => {
  it("blocks link-local (cloud metadata), private, CGNAT, ULA, and unspecified addresses", () => {
    for (const host of [
      "169.254.169.254", // cloud metadata (link-local)
      "10.0.0.1",
      "172.16.5.4",
      "192.168.1.1",
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "[fe80::1]", // IPv6 link-local (URL.hostname keeps brackets)
      "[fc00::1]", // IPv6 ULA
      "[::]",
      "::ffff:169.254.169.254", // IPv4-mapped IPv6 must not bypass the IPv4 ranges
    ]) {
      expect(isReservedIpAddress(host), host).toBe(true);
    }
  });

  it("allows public addresses, loopback, and plain hostnames", () => {
    for (const host of [
      "8.8.8.8",
      "127.0.0.1", // loopback is intentionally allowed (local-dev self-callbacks)
      "[::1]",
      "caller.example.com",
      "localhost",
    ]) {
      expect(isReservedIpAddress(host), host).toBe(false);
    }
  });
});
