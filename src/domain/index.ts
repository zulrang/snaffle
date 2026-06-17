/**
 * The domain layer: the core vocabulary of the deterministic delivery pipeline,
 * modelled type-first so that illegal states are unrepresentable. Pure and
 * runtime-agnostic — no I/O, no Pi SDK, no persistence. Infrastructure and the
 * orchestrator spine depend on these types, never the reverse.
 */

export * from "./agent";
export * from "./door";
export * from "./failure";
export * from "./gate";
export * from "./ids";
export * from "./lineage";
export * from "./provenance";
export * from "./scope";
export * from "./shared";
export * from "./transition";
