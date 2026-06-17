/**
 * Nominal ("branded") typing primitive.
 *
 * TypeScript is structural: a bare `string` lineage id is interchangeable with a
 * bare `string` generation id, which is exactly the class of bug a deterministic
 * control plane cannot afford. `Brand` attaches a phantom tag so two values with
 * the same runtime representation are nonetheless distinct at the type level.
 *
 * The brand lives only in the type system; at runtime a `Brand<string, "X">` is
 * just a string.
 */
declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Strip the brand back to its underlying representation. */
export type Unbrand<T> = T extends Brand<infer U, string> ? U : T;
