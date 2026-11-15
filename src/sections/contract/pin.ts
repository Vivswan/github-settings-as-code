/**
 * The compile-time tie between a hand-written live schema and the response type Octokit publishes for its
 * route. Types only: a pin is a type alias beside the schema or the type of a factory's schema parameter, so
 * nothing here reaches the bundle. A schema reads a SUBSET of the response, so the pin compares shapes: every
 * body Octokit's type admits must fit the schema's input type. A refinement (an ISO date, a transform) is the
 * schema's own and stays outside it.
 */

import type { Endpoints } from "@octokit/types";
import type { z } from "zod";

/** A declared endpoint, read for its route alone. */
interface Routed {
  readonly route: string;
}

/** The body Octokit publishes for a declared endpoint; `never` for a route it lags (src/upstream-gaps), which Pinned refuses. */
export type Body<E extends Routed> = E extends unknown
  ? E["route"] extends keyof Endpoints
    ? Endpoints[E["route"]]["response"]["data"]
    : never
  : never;

/** One item of a declared list endpoint, whose body is a bare array. */
export type Item<E extends Routed> = ElementOf<Body<E>>;

type ElementOf<T> = T extends readonly (infer Element)[] ? Element : never;

/** One item of an enveloped list (`{ total_count, <key>: [...] }`), as listAllEnveloped unwraps it. */
export type EnvelopedItem<E extends Routed, Key extends string> = Enveloped<Body<E>, Key>;

type Enveloped<T, Key extends string> = T extends unknown
  ? Key extends keyof T
    ? ElementOf<NonNullable<T[Key]>>
    : never
  : never;

/** A type's declared keys: an index signature is dropped, since it names no field. */
type Declared<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

type DeclaredKey<T> = keyof Declared<T> & (string | number);

/** Every key some variant of a union carries; the empty-object variant (`{ [key: string]: never }`) carries none. */
type AnyKey<T> = T extends unknown ? ([T[keyof T]] extends [never] ? never : keyof T) : never;

/** A key's value across the variants that carry it. */
type ValueAt<T, K extends PropertyKey> = T extends unknown
  ? K extends keyof T
    ? T[K]
    : string extends keyof T
      ? T[keyof T & string]
      : never
  : never;

type Plain<T> = Exclude<T, readonly unknown[]> & object;

type Listed<T> = Extract<T, readonly unknown[]>;

type Path<P extends string, K extends string | number> = P extends "" ? `${K}` : `${P}.${K}`;

/** Octokit's type as JSON carries it: an int64 field is typed `number | bigint` there, and no body holds a bigint. */
type OnTheWire<T> = T extends bigint
  ? never
  : T extends object
    ? { [K in keyof T]: OnTheWire<T[K]> }
    : T;

/**
 * Every place a hand shape `Hand` (a schema's INPUT) and Octokit's type `Theirs` part ways, as a union of
 * `path: reason` strings; `never` when they agree. Two questions, since assignability answers only the first:
 *
 *   Refused    -> a body Octokit's type admits that the schema would not parse (TypeScript's own assignability)
 *   Strangers  -> a key the schema declares that Octokit's type lacks in every variant (misspelled, renamed)
 */
export type Disagreements<Hand, Theirs> =
  | Refused<Hand, OnTheWire<Theirs>>
  | Strangers<Hand, OnTheWire<Theirs>, "">;

/** Distributes over Octokit's variants: each one alone must parse. */
type Refused<Hand, Theirs> = Theirs extends unknown
  ? [Theirs] extends [Hand]
    ? never
    : RefusedField<Plain<Hand>, Theirs> extends infer Field
      ? [Field] extends [never]
        ? "(body): Octokit's type admits a body this schema refuses"
        : Field
      : never
  : never;

/** The top-level fields behind a refusal, where the schema is one object; a union of shapes is refused whole. */
type RefusedField<Hand, Theirs> = {
  [K in DeclaredKey<Hand>]: [Pick<Theirs, K & keyof Theirs>] extends [Pick<Hand, K>]
    ? never
    : `${K}: Octokit's type admits a value this schema refuses`;
}[DeclaredKey<Hand>];

type Strangers<Hand, Theirs, P extends string> = unknown extends Hand
  ? never
  : unknown extends Theirs
    ? never
    :
        | StrangersIn<Plain<Hand>, Plain<Theirs>, P>
        | ([Listed<Hand>] extends [never]
            ? never
            : Strangers<Listed<Hand>[number], Listed<Theirs>[number], `${P}[]`>);

type StrangersIn<Hand, Theirs, P extends string> = [Theirs] extends [never]
  ? never
  : Hand extends unknown
    ?
        | (string extends keyof Hand
            ? Strangers<Hand[keyof Hand & string], ValueAt<Theirs, string>, `${P}{}`>
            : never)
        | {
            [K in DeclaredKey<Hand>]: K extends AnyKey<Theirs>
              ? Strangers<Hand[K], ValueAt<Theirs, K>, Path<P, K>>
              : string extends AnyKey<Theirs>
                ? Strangers<Hand[K], ValueAt<Theirs, K>, Path<P, K>>
                : `${Path<P, K>}: Octokit's type has no such field`;
          }[DeclaredKey<Hand>]
    : never;

/**
 * What a pin's schema must satisfy. `Lag` names the findings Octokit's description is behind GitHub on;
 * a name that is no longer a finding fails too, so a relaxation graduates when Octokit catches up.
 */
type Agrees<Theirs, Found, Lag extends string> = [Theirs] extends [never]
  ? { readonly "Octokit types no response for this route": true }
  : [Exclude<Found, Lag>] extends [never]
    ? [Lag] extends [Found]
      ? unknown
      : { readonly "relaxed, yet Octokit's type now agrees": Exclude<Lag, Found> }
    : { readonly "disagrees with Octokit's response type": Exclude<Found, Lag> };

/**
 * What a schema reading `Hand` must also be: nothing more when it agrees with `Theirs`, an unmeetable field
 * naming the findings otherwise. A factory that takes a schema beside its route asks for it in the parameter's
 * type (listSection, actions' endpointRouted), so a schema passed there is pinned with no alias to forget.
 * The findings are spelled out here instead of through Disagreements: tsc prints a union by the alias that
 * made it, which would hide the field names.
 */
export type Agreeing<Hand, Theirs, Lag extends string = never> = Agrees<
  Theirs,
  Refused<Hand, OnTheWire<Theirs>> | Strangers<Hand, OnTheWire<Theirs>, "">,
  Lag
>;

/**
 * The pin: `type _LiveLabelPin = Pinned<typeof LiveLabel, Item<typeof ENDPOINTS.list>>` fails typecheck,
 * naming each field, once the schema and Octokit's type for the route part ways.
 */
export type Pinned<
  Schema extends z.ZodType & Agreeing<z.input<Schema>, Theirs, Lag>,
  Theirs,
  Lag extends string = never,
> = [Schema, Theirs, Lag];
