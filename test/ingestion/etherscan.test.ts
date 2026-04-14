import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the source code parser without hitting the real API
describe("parseSourceCode (via fetchContractSource)", () => {
  it("parses single-file Solidity source", async () => {
    const singleSource = `pragma solidity ^0.8.0;\ncontract Test { }`;

    // Mock fetch for single file
    const mockResponse = {
      ok: true,
      json: async () => ({
        status: "1",
        result: [
          {
            SourceCode: singleSource,
            ContractName: "Test",
            CompilerVersion: "v0.8.20",
            OptimizationUsed: "1",
            Runs: "200",
            ABI: "[]",
            ConstructorArguments: "",
            EVMVersion: "paris",
            LicenseType: "MIT",
          },
        ],
      }),
    };

    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    const { fetchContractSource } = await import(
      "../../src/ingestion/etherscan.js"
    );

    const info = await fetchContractSource("0x1234", "test-key");

    expect(info.name).toBe("Test");
    expect(info.sources).toHaveLength(1);
    expect(info.sources[0].filename).toBe("Test.sol");
    expect(info.sources[0].content).toBe(singleSource);
  });

  it("parses multi-file JSON source (double-brace format)", async () => {
    const multiSource = JSON.stringify({
      sources: {
        "contracts/Token.sol": { content: "contract Token {}" },
        "contracts/lib/Math.sol": { content: "library Math {}" },
      },
    });

    const mockResponse = {
      ok: true,
      json: async () => ({
        status: "1",
        result: [
          {
            SourceCode: `{${multiSource}}`,
            ContractName: "Token",
            CompilerVersion: "v0.8.20",
            OptimizationUsed: "0",
            Runs: "200",
            ABI: "[]",
            ConstructorArguments: "",
            EVMVersion: "paris",
            LicenseType: "",
          },
        ],
      }),
    };

    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    const { fetchContractSource } = await import(
      "../../src/ingestion/etherscan.js"
    );

    const info = await fetchContractSource("0x5678", "test-key");

    expect(info.sources).toHaveLength(2);
    expect(info.sources[0].filename).toBe("Token.sol");
    expect(info.sources[1].filename).toBe("lib/Math.sol");
  });

  it("throws on unverified contract", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        status: "1",
        result: [
          {
            SourceCode: "",
            ContractName: "",
            ABI: "Contract source code not verified",
          },
        ],
      }),
    };

    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    const { fetchContractSource } = await import(
      "../../src/ingestion/etherscan.js"
    );

    await expect(
      fetchContractSource("0xdead", "test-key")
    ).rejects.toThrow("not verified");
  });
});
