import type { BenchmarkEntry } from "../ingestion/defi-hacks.js";

// Curated benchmark dataset: 10 well-known exploits across vulnerability classes
// These are from DeFiHackLabs and have verified exploit reproductions
export const MINI_DATASET: BenchmarkEntry[] = [
  // Reentrancy
  {
    id: "reentrancy-001",
    name: "Rari Capital / Fuse",
    chain: "ethereum",
    blockNumber: 14684813,
    contractAddress: "0x419f13F5D3699C04AC55b3B2A3dCed6a4104D56A",
    vulnerabilityClass: "reentrancy",
    description: "Reentrancy via CEther market borrow function",
    date: "2022-04-30",
    valueImpacted: "$80M",
  },
  // Access Control
  {
    id: "access-control-001",
    name: "Ronin Bridge",
    chain: "ethereum",
    blockNumber: 14442835,
    contractAddress: "0x8407dc57739bCDA7aA53Ca6F12f82f9d51C2F21E",
    vulnerabilityClass: "access-control",
    description: "Compromised validator keys allowed unauthorized withdrawals",
    date: "2022-03-23",
    valueImpacted: "$624M",
  },
  // Price Manipulation
  {
    id: "price-manipulation-001",
    name: "Euler Finance",
    chain: "ethereum",
    blockNumber: 16817996,
    contractAddress: "0x27182842E098f60e3D576794A5bFFb0777E025d3",
    vulnerabilityClass: "price-manipulation",
    description: "Donation attack on eToken/dToken exchange rate",
    date: "2023-03-13",
    valueImpacted: "$197M",
  },
  // Flash Loan
  {
    id: "flash-loan-001",
    name: "bZx Protocol",
    chain: "ethereum",
    blockNumber: 9484688,
    contractAddress: "0x493C57C4763932315A328269E1ADaD09653B9081",
    vulnerabilityClass: "flash-loan",
    description: "Flash loan to manipulate oracle price and drain funds",
    date: "2020-02-15",
    valueImpacted: "$350K",
  },
  // Logic Error
  {
    id: "logic-error-001",
    name: "Compound cETH",
    chain: "ethereum",
    blockNumber: 13322797,
    contractAddress: "0x4Ddc2D193948926D02f9B1fE9e1daa0718270ED5",
    vulnerabilityClass: "logic-error",
    description: "Incorrect comptroller distribution logic sent excess COMP",
    date: "2021-09-29",
    valueImpacted: "$80M",
  },
  // Integer Overflow (pre-0.8.0)
  {
    id: "integer-001",
    name: "BeautyChain BEC",
    chain: "ethereum",
    blockNumber: 5571300,
    contractAddress: "0xC5d105E63711398aF9bbff092d4B6CdeF7C9BcB8",
    vulnerabilityClass: "integer-overflow",
    description: "Integer overflow in batchTransfer function",
    date: "2018-04-22",
    valueImpacted: "$900M (market cap)",
  },
  // Unchecked Return
  {
    id: "unchecked-001",
    name: "King of the Ether",
    chain: "ethereum",
    blockNumber: 1200000,
    contractAddress: "0xb336a86e2feb1e87a328fcb7dd4d04de3df254d0",
    vulnerabilityClass: "unchecked-return",
    description: "Unchecked send() return value in king-of-the-hill game",
    date: "2016-02-06",
    valueImpacted: "~2 ETH",
  },
  // Reentrancy (classic DAO)
  {
    id: "reentrancy-002",
    name: "The DAO",
    chain: "ethereum",
    blockNumber: 1718497,
    contractAddress: "0xBB9bc244D798123fDe783fCc1C72d3Bb8C189413",
    vulnerabilityClass: "reentrancy",
    description: "Classic reentrancy via splitDAO function",
    date: "2016-06-17",
    valueImpacted: "$60M",
  },
  // Price Manipulation (newer)
  {
    id: "price-manipulation-002",
    name: "Mango Markets",
    chain: "ethereum",
    blockNumber: 15733975,
    contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    vulnerabilityClass: "price-manipulation",
    description: "Oracle manipulation via thin liquidity on Mango perp markets",
    date: "2022-10-11",
    valueImpacted: "$114M",
  },
  // Delegatecall
  {
    id: "delegatecall-001",
    name: "Parity Multisig",
    chain: "ethereum",
    blockNumber: 4501969,
    contractAddress: "0x863DF6BFa4469f3ead0bE8f9F2AAE51c91A907b4",
    vulnerabilityClass: "delegatecall",
    description: "Unprotected delegatecall in library contract led to selfdestruct",
    date: "2017-11-06",
    valueImpacted: "$150M frozen",
  },
];
