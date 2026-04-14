import { describe, it, expect } from "vitest";
import { analyzeSourceCode, analyzeABI } from "../../src/ingestion/contracts.js";

describe("analyzeSourceCode", () => {
  it("extracts contract name", () => {
    const source = `pragma solidity ^0.8.0;\ncontract MyVault { }`;
    const analysis = analyzeSourceCode(source);
    expect(analysis.name).toBe("MyVault");
  });

  it("extracts functions with visibility and mutability", () => {
    const source = `
      contract Test {
        function deposit() public payable { }
        function withdraw(uint256 amount) external { }
        function getBalance() public view returns (uint256) { return 0; }
      }
    `;
    const analysis = analyzeSourceCode(source);

    expect(analysis.functions).toHaveLength(3);
    expect(analysis.payableFunctions).toContain("deposit()");
    expect(analysis.stateChangingFunctions).toContain("deposit()");
    expect(analysis.stateChangingFunctions).toContain("withdraw(uint256)");
    expect(analysis.stateChangingFunctions).not.toContain("getBalance()");
  });

  it("detects selfdestruct", () => {
    const source = `contract Bad { function kill() public { selfdestruct(payable(msg.sender)); } }`;
    expect(analyzeSourceCode(source).hasSelfdestruct).toBe(true);
  });

  it("detects delegatecall", () => {
    const source = `contract Proxy { function fallback() external { address(impl).delegatecall(msg.data); } }`;
    expect(analyzeSourceCode(source).hasDelegatecall).toBe(true);
  });

  it("detects assembly usage", () => {
    const source = `contract Asm { function foo() public { assembly { mstore(0, 1) } } }`;
    expect(analyzeSourceCode(source).usesAssembly).toBe(true);
  });

  it("returns false for safe contract", () => {
    const source = `contract Safe { function add(uint a, uint b) public pure returns (uint) { return a + b; } }`;
    const analysis = analyzeSourceCode(source);
    expect(analysis.hasSelfdestruct).toBe(false);
    expect(analysis.hasDelegatecall).toBe(false);
    expect(analysis.usesAssembly).toBe(false);
  });
});

describe("analyzeABI", () => {
  it("parses function entries from ABI", () => {
    const abi = [
      {
        type: "function",
        name: "transfer",
        stateMutability: "nonpayable",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
      },
      {
        type: "event",
        name: "Transfer",
      },
    ];

    const functions = analyzeABI(abi);
    expect(functions).toHaveLength(1);
    expect(functions[0].name).toBe("transfer");
    expect(functions[0].signature).toBe("transfer(address,uint256)");
    expect(functions[0].inputs).toHaveLength(2);
    expect(functions[0].outputs).toHaveLength(1);
  });
});
